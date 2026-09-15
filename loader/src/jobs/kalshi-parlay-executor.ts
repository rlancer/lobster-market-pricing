import type { BatchJob, SchedulerEnv } from "../scheduler.js";
import {
  kalshiAuthConfigured,
  publishKalshiMarketRows,
  type KalshiEnv,
} from "../kalshi.js";
import {
  collectKalshiParlayTape,
} from "../kalshi-parlay-tape.js";
import { KALSHI_PARLAY_FILL_SOURCE } from "../kalshi-parlay-fills.js";
import { parlayExecuteEnabled, parlayLiveEnabled, parlayMaxAcceptsPerPass } from "../kalshi-parlay-filter.js";
import { rfqContracts } from "../kalshi-rfq-quotes.js";
import {
  emptyParlayPass,
  parlayExecutorPassDetail,
  runKalshiParlayExecutorPass,
  type ParlayExecutorDecision,
} from "../kalshi-parlay-executor.js";

function num(env: SchedulerEnv, key: string, dflt: number): number {
  const v = Number(env && env[key]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

function sizeFlags(env: SchedulerEnv): { contracts: number; max_accepts_per_pass: number } {
  return {
    contracts: rfqContracts(env as unknown as KalshiEnv),
    max_accepts_per_pass: parlayMaxAcceptsPerPass(env),
  };
}

function idleDetail(env: SchedulerEnv): Record<string, unknown> {
  return parlayExecutorPassDetail(
    emptyParlayPass("execute_off"),
    { execute: false, live: parlayLiveEnabled(env), ...sizeFlags(env) },
  );
}

async function withParlayTape(
  env: KalshiEnv,
  decisions: ParlayExecutorDecision[],
  detail: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!env.PIPELINE_KALSHI_MARKETS_URL || !kalshiAuthConfigured(env)) return detail;
  try {
    const rows = await collectKalshiParlayTape(env, decisions);
    const published = await publishKalshiMarketRows(rows, env, "parlay-tape");
    return {
      ...detail,
      tape_rows: rows.length,
      tape_fills: rows.filter((row) => row.source === KALSHI_PARLAY_FILL_SOURCE).length,
      tape_published: published.published,
    };
  } catch (error) {
    return {
      ...detail,
      tape_error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Same-game sports parlay RFQ executor. Batch, ungated, 5-minute cadence.
// Live: KALSHI_PARLAY_EXECUTE=1 and KALSHI_PARLAY_LIVE=1, 10 contracts
// ($10 notional), at most one accept per pass. Scans every open sports MVE
// from the Trade API (not the lake volume-80 cap). Never the full catalog.
// The hourly KXMVE research probe stays separate and never accepts.
// Each pass also publishes portfolio combo fills + this pass's RFQ two-ways
// onto options.kalshi_markets so the public backtest can grade last night.
export function kalshiParlayExecutorJob(env: SchedulerEnv): BatchJob {
  return {
    id: "kalshi-parlay-executor",
    marketGated: false,
    cadenceSeconds: Math.floor(num(env, "KALSHI_PARLAY_CADENCE_SECONDS", 300)),
    scope: "batch",
    universe: () => ["KXMVE"],
    run: async (_items, e) => {
      if (!parlayExecuteEnabled(e)) {
        return { runId: null, failures: [], detail: idleDetail(e) };
      }
      const kalshiEnv: KalshiEnv = { ...(e as unknown as KalshiEnv) };
      try {
        const pass = await runKalshiParlayExecutorPass(kalshiEnv);
        const detail = parlayExecutorPassDetail(pass, {
          execute: true,
          live: parlayLiveEnabled(e),
          ...sizeFlags(e),
        });
        return {
          runId: null,
          failures: [],
          detail: await withParlayTape(kalshiEnv, pass.decisions, detail),
        };
      } catch (error) {
        return {
          runId: null,
          failures: [{
            symbol: "KXMVE",
            error: String((error && (error as Error).message) || error),
          }],
        };
      }
    },
  };
}
