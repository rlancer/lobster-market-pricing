/**
 * Firm-pipeline experiment: TradingAgents-style stages on the same frozen
 * as-of tape as desk-approaches.
 *
 * desk-approaches varies *session topology* (solo / role-play / shared /
 * fresh). This study holds isolation + structured handoffs fixed and varies
 * *pipeline stages* from Xiao et al. 2024 (arXiv:2412.20138): analyst reports
 * → bull/bear research → trader → risk committee → fund manager.
 *
 * We do not copy their eval. They scored P&L on AAPL/GOOGL/AMZN vs MACD/SMA.
 * That confounds memorization of 2024 names with protocol. We grade 5d/20d
 * direction on invented tickers, same cases as desk-approaches.
 */

import {
  DESK_SPECIALIST_SUMMARIES,
  DESK_VIEWPOINT_LABELS,
  type DeskViewpointId,
} from "./chat-desk";
import {
  DESK_EXPERIMENT_AS_OF_RULES,
  DESK_VERDICT_CLOSE_ABORT_MS,
  DESK_VERDICT_CLOSE_MAX_TOKENS,
  DESK_VERDICT_INSTRUCTIONS,
  deskExperimentUserPacket,
  deskSoloSystemPrompt,
  extractDeskVerdict,
  leanFromReturn,
  type ChatTurn,
  type CompleteFn,
  type DeskVerdict,
} from "./desk-experiment";
import {
  DESK_EXPERIMENT_AS_OF_INDEX,
  DESK_EXPERIMENT_SEED,
  DESK_EXPERIMENT_START_DATE,
  DESK_EXPERIMENT_TRADING_DAYS,
  buildDeskExperimentCases,
  formatDeskSnapshot,
  type DeskExperimentCase,
} from "./desk-experiment-cases";

export const FIRM_PIPELINE_SLUG = "firm-pipeline";
export const FIRM_PIPELINE_DESIGN_ID = "firm-pipeline-v1";
export const FIRM_PIPELINE_RUNNER_VERSION = 1;
/** Full pipeline is ~4 parallel waves; 45 min leaves room for DeepSeek seats. */
export const FIRM_CELL_TIMEOUT_MS = 45 * 60_000;
/**
 * Desk-approaches aborts a seat at 6 min. DeepSeek high-reasoning in this
 * pipeline already hit that cap (bull_bear_debate × bolt-coil). 12 min still
 * sits under the 45 min cell budget.
 */
export const FIRM_SEAT_ABORT_MS = 12 * 60_000;

export const FIRM_ANALYST_IDS = [
  "fundamental",
  "technical",
  "options",
  "news",
] as const;
export type FirmAnalystId = (typeof FIRM_ANALYST_IDS)[number];

export const FIRM_APPROACH_IDS = [
  "solo",
  "reports_then_trader",
  "bull_bear_debate",
  "firm_risk_committee",
] as const;
export type FirmApproachId = (typeof FIRM_APPROACH_IDS)[number];

export type FirmSeatId =
  | FirmAnalystId
  | "bull"
  | "bear"
  | "trader"
  | "risk_aggressive"
  | "risk_conservative"
  | "fund_manager"
  | "solo";

export interface FirmApproachMeta {
  id: FirmApproachId;
  label: string;
  description: string;
  session_mode: "one" | "reports_then_trader" | "bull_bear" | "firm_pipeline";
}

export const FIRM_APPROACHES: FirmApproachMeta[] = [
  {
    id: "solo",
    label: "Solo trader",
    description:
      "One session, one voice, full snapshot. Same control as desk-approaches solo so the two studies can be read together.",
    session_mode: "one",
  },
  {
    id: "reports_then_trader",
    label: "Analyst reports → trader",
    description:
      "Four isolated analysts (fundamental, technical, options, news) write structured reports in parallel. The trader sees those reports plus a fact-check snapshot — no bull/bear debate, no risk committee.",
    session_mode: "reports_then_trader",
  },
  {
    id: "bull_bear_debate",
    label: "Bull vs bear research",
    description:
      "Same analyst reports, then isolated bull and bear researchers argue from those reports (they never see each other). The trader synthesizes the dialectic into the verdict.",
    session_mode: "bull_bear",
  },
  {
    id: "firm_risk_committee",
    label: "Full firm pipeline",
    description:
      "TradingAgents-lite: analyst reports → bull/bear briefs → trader draft (no JSON yet) → isolated aggressive and conservative risk guardians → fund manager emits the verdict. Risk is a later committee, not a parallel specialist.",
    session_mode: "firm_pipeline",
  },
];

export const FIRM_ANALYST_LABELS: Record<FirmAnalystId, string> = {
  fundamental: DESK_VIEWPOINT_LABELS.fundamental,
  technical: DESK_VIEWPOINT_LABELS.technical,
  options: DESK_VIEWPOINT_LABELS.options,
  news: "News",
};

export const FIRM_ANALYST_SUMMARIES: Record<FirmAnalystId, string> = {
  fundamental: DESK_SPECIALIST_SUMMARIES.fundamental,
  technical: DESK_SPECIALIST_SUMMARIES.technical,
  options: DESK_SPECIALIST_SUMMARIES.options,
  news:
    "Dated headlines and tone in the snapshot news list only. Separate confirmed items from rumor. Do not invent a print, filing, or macro event that is not in the pack.",
};

export interface FirmSessionTrace {
  id: string;
  specialist: FirmSeatId;
  messages: ChatTurn[];
  text: string;
}

export interface FirmPipelineRun {
  approach_id: FirmApproachId;
  case_id: string;
  sessions: FirmSessionTrace[];
  session_count: number;
  llm_calls: number;
  answer: string;
  reports: Partial<Record<FirmAnalystId, string>>;
  bull_brief: string | null;
  bear_brief: string | null;
  trader_draft: string | null;
  risk_aggressive: string | null;
  risk_conservative: string | null;
  verdict: DeskVerdict | null;
  parse_error: string | null;
  latency_ms: number;
}

async function call(
  complete: CompleteFn,
  messages: ChatTurn[],
  maxOutputTokens = 1_200,
  kind: "prose" | "verdict" = "prose",
): Promise<{ text: string; latency_ms: number }> {
  return complete({ messages, maxOutputTokens, kind });
}

export function firmAnalystSystemPrompt(id: FirmAnalystId): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    `You are the ${FIRM_ANALYST_LABELS[id]} analyst only.`,
    FIRM_ANALYST_SUMMARIES[id],
    "Write a concise structured report: facts from the snapshot, then a lean for your seat, then what would change your mind.",
    "Do not speak for other analysts. Do not emit the verdict JSON — the trader or chair will do that.",
  ].join("\n");
}

export function firmResearcherSystemPrompt(side: "bull" | "bear"): string {
  const stance = side === "bull"
    ? "You are the bullish researcher. Argue the long / add case. Attack weak bearish claims. Do not steelman the other side as your conclusion."
    : "You are the bearish researcher. Argue the fade / reduce case. Attack weak bullish claims. Do not steelman the other side as your conclusion.";
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    stance,
    "You see structured analyst reports and a fact-check snapshot. You do not see the opposing researcher.",
    "Write a brief, not a novel. Do not emit verdict JSON.",
  ].join("\n");
}

export function firmTraderSystemPrompt(mode: "verdict" | "draft"): string {
  const close = mode === "verdict"
    ? ["Write a short Markdown plan, then the verdict JSON.", DESK_VERDICT_INSTRUCTIONS].join("\n")
    : [
      "Write a trading draft in Markdown: proposed 5d and 20d lean in prose, size instinct (stand-down / small / full), and what would change your mind.",
      "Do not emit verdict JSON — risk guardians and the fund manager close that.",
    ].join("\n");
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    "You are the trader. Weigh the structured reports (and researcher briefs when present). Do not re-run every specialist from scratch.",
    close,
  ].join("\n");
}

export function firmRiskSystemPrompt(style: "aggressive" | "conservative"): string {
  const seat = style === "aggressive"
    ? "You are the risk-seeking guardian. If the evidence supports the draft, argue for a fuller expression. Stand down only when the tape is genuinely empty."
    : "You are the risk-conservative guardian. Shrink or veto the draft when evidence is thin, event risk is near, or liquidity is poor. A missed rally is cheaper than a gap.";
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    seat,
    "You see analyst reports, researcher briefs, and the trader draft. Comment on the draft. Do not emit verdict JSON.",
  ].join("\n");
}

export function firmFundManagerSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    "You are the fund manager. Weigh the trader draft against the risk briefs. You may keep, shrink, or reverse the draft.",
    "Write a short Markdown close, then the verdict JSON.",
    DESK_VERDICT_INSTRUCTIONS,
  ].join("\n");
}

export function firmPipelineSystemPrompt(): string {
  return [
    DESK_EXPERIMENT_AS_OF_RULES,
    DESK_VERDICT_INSTRUCTIONS,
    "Approaches differ in firm pipeline stages (solo / analyst reports then trader / bull-bear research then trader / full risk committee), not in the snapshot.",
  ].join("\n");
}

function factCheckAppendix(experimentCase: DeskExperimentCase): string {
  return [
    "FACT CHECK (numbers only — do not re-run the whole analysis from this dump):",
    formatDeskSnapshot(experimentCase.snapshot),
  ].join("\n");
}

function formatReports(reports: Partial<Record<FirmAnalystId, string>>): string {
  return FIRM_ANALYST_IDS.map((id) => (
    `### ${FIRM_ANALYST_LABELS[id]} report\n${reports[id] ?? "(missing)"}`
  )).join("\n\n");
}

function downstreamUserPacket(
  experimentCase: DeskExperimentCase,
  reports: Partial<Record<FirmAnalystId, string>>,
  extra: string[],
): string {
  return [
    "QUESTION:",
    experimentCase.prompt,
    "",
    "STRUCTURED ANALYST REPORTS:",
    formatReports(reports),
    ...extra,
    "",
    factCheckAppendix(experimentCase),
  ].join("\n");
}

async function runAnalysts(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<{
  reports: Partial<Record<FirmAnalystId, string>>;
  sessions: FirmSessionTrace[];
}> {
  const packet = deskExperimentUserPacket(experimentCase);
  const seats = await Promise.all(FIRM_ANALYST_IDS.map(async (id) => {
    const messages: ChatTurn[] = [
      { role: "system", content: firmAnalystSystemPrompt(id) },
      { role: "user", content: packet },
    ];
    const result = await call(complete, messages);
    return { id, messages, text: result.text };
  }));
  const reports: Partial<Record<FirmAnalystId, string>> = {};
  const sessions: FirmSessionTrace[] = [];
  for (const seat of seats) {
    reports[seat.id] = seat.text;
    sessions.push({
      id: seat.id,
      specialist: seat.id,
      messages: seat.messages,
      text: seat.text,
    });
  }
  return { reports, sessions };
}

async function runResearchers(
  experimentCase: DeskExperimentCase,
  reports: Partial<Record<FirmAnalystId, string>>,
  complete: CompleteFn,
): Promise<{ bull: string; bear: string; sessions: FirmSessionTrace[] }> {
  const packet = downstreamUserPacket(experimentCase, reports, []);
  const [bull, bear] = await Promise.all((["bull", "bear"] as const).map(async (side) => {
    const messages: ChatTurn[] = [
      { role: "system", content: firmResearcherSystemPrompt(side) },
      { role: "user", content: packet },
    ];
    const result = await call(complete, messages);
    return { side, messages, text: result.text };
  }));
  return {
    bull: bull.text,
    bear: bear.text,
    sessions: [
      { id: "bull", specialist: "bull", messages: bull.messages, text: bull.text },
      { id: "bear", specialist: "bear", messages: bear.messages, text: bear.text },
    ],
  };
}

async function runTraderSeat(
  experimentCase: DeskExperimentCase,
  reports: Partial<Record<FirmAnalystId, string>>,
  researchers: { bull: string; bear: string } | null,
  complete: CompleteFn,
  mode: "verdict" | "draft",
): Promise<FirmSessionTrace> {
  const extra = researchers
    ? [
      "",
      "RESEARCHER BRIEFS (isolated; they have not read each other):",
      `### Bull\n${researchers.bull}`,
      `### Bear\n${researchers.bear}`,
    ]
    : [];
  const messages: ChatTurn[] = [
    { role: "system", content: firmTraderSystemPrompt(mode) },
    { role: "user", content: downstreamUserPacket(experimentCase, reports, extra) },
  ];
  const result = await call(
    complete,
    messages,
    mode === "verdict" ? 1_600 : 1_200,
    mode === "verdict" ? "verdict" : "prose",
  );
  return { id: "trader", specialist: "trader", messages, text: result.text };
}

async function runRiskSeats(
  experimentCase: DeskExperimentCase,
  reports: Partial<Record<FirmAnalystId, string>>,
  researchers: { bull: string; bear: string },
  traderDraft: string,
  complete: CompleteFn,
): Promise<{ aggressive: FirmSessionTrace; conservative: FirmSessionTrace }> {
  const extra = [
    "",
    "RESEARCHER BRIEFS:",
    `### Bull\n${researchers.bull}`,
    `### Bear\n${researchers.bear}`,
    "",
    "TRADER DRAFT:",
    traderDraft,
  ];
  const packet = downstreamUserPacket(experimentCase, reports, extra);
  const [aggressive, conservative] = await Promise.all(
    (["aggressive", "conservative"] as const).map(async (style) => {
      const messages: ChatTurn[] = [
        { role: "system", content: firmRiskSystemPrompt(style) },
        { role: "user", content: packet },
      ];
      const result = await call(complete, messages);
      const id = style === "aggressive" ? "risk_aggressive" : "risk_conservative";
      return {
        id,
        specialist: id,
        messages,
        text: result.text,
      } satisfies FirmSessionTrace;
    }),
  );
  return { aggressive, conservative };
}

function finalize(
  experimentCase: DeskExperimentCase,
  approachId: FirmApproachId,
  sessions: FirmSessionTrace[],
  answer: string,
  started: number,
  extras: Partial<Pick<
    FirmPipelineRun,
    "reports" | "bull_brief" | "bear_brief" | "trader_draft" | "risk_aggressive" | "risk_conservative"
  >>,
): FirmPipelineRun {
  const verdict = extractDeskVerdict(answer);
  return {
    approach_id: approachId,
    case_id: experimentCase.id,
    sessions,
    session_count: sessions.length,
    llm_calls: sessions.length,
    answer,
    reports: extras.reports ?? {},
    bull_brief: extras.bull_brief ?? null,
    bear_brief: extras.bear_brief ?? null,
    trader_draft: extras.trader_draft ?? null,
    risk_aggressive: extras.risk_aggressive ?? null,
    risk_conservative: extras.risk_conservative ?? null,
    verdict,
    parse_error: verdict ? null : "could not parse lean_5d/lean_20d JSON",
    latency_ms: Date.now() - started,
  };
}

async function runSolo(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<FirmPipelineRun> {
  const started = Date.now();
  const messages: ChatTurn[] = [
    { role: "system", content: deskSoloSystemPrompt() },
    { role: "user", content: deskExperimentUserPacket(experimentCase) },
  ];
  const result = await call(complete, messages, 2_400, "verdict");
  return finalize(experimentCase, "solo", [{
    id: "solo",
    specialist: "solo",
    messages,
    text: result.text,
  }], result.text, started, {});
}

async function runReportsThenTrader(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<FirmPipelineRun> {
  const started = Date.now();
  const { reports, sessions } = await runAnalysts(experimentCase, complete);
  const trader = await runTraderSeat(experimentCase, reports, null, complete, "verdict");
  sessions.push(trader);
  return finalize(experimentCase, "reports_then_trader", sessions, trader.text, started, { reports });
}

async function runBullBear(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<FirmPipelineRun> {
  const started = Date.now();
  const { reports, sessions } = await runAnalysts(experimentCase, complete);
  const researchers = await runResearchers(experimentCase, reports, complete);
  sessions.push(...researchers.sessions);
  const trader = await runTraderSeat(
    experimentCase,
    reports,
    { bull: researchers.bull, bear: researchers.bear },
    complete,
    "verdict",
  );
  sessions.push(trader);
  return finalize(experimentCase, "bull_bear_debate", sessions, trader.text, started, {
    reports,
    bull_brief: researchers.bull,
    bear_brief: researchers.bear,
  });
}

async function runFirmCommittee(
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<FirmPipelineRun> {
  const started = Date.now();
  const { reports, sessions } = await runAnalysts(experimentCase, complete);
  const researchers = await runResearchers(experimentCase, reports, complete);
  sessions.push(...researchers.sessions);
  const draft = await runTraderSeat(
    experimentCase,
    reports,
    { bull: researchers.bull, bear: researchers.bear },
    complete,
    "draft",
  );
  sessions.push(draft);
  const risk = await runRiskSeats(
    experimentCase,
    reports,
    { bull: researchers.bull, bear: researchers.bear },
    draft.text,
    complete,
  );
  sessions.push(risk.aggressive, risk.conservative);

  const extra = [
    "",
    "RESEARCHER BRIEFS:",
    `### Bull\n${researchers.bull}`,
    `### Bear\n${researchers.bear}`,
    "",
    "TRADER DRAFT:",
    draft.text,
    "",
    "RISK COMMITTEE:",
    `### Aggressive\n${risk.aggressive.text}`,
    `### Conservative\n${risk.conservative.text}`,
  ];
  const fmMessages: ChatTurn[] = [
    { role: "system", content: firmFundManagerSystemPrompt() },
    { role: "user", content: downstreamUserPacket(experimentCase, reports, extra) },
  ];
  const fm = await call(complete, fmMessages, 1_600, "verdict");
  sessions.push({
    id: "fund_manager",
    specialist: "fund_manager",
    messages: fmMessages,
    text: fm.text,
  });
  return finalize(experimentCase, "firm_risk_committee", sessions, fm.text, started, {
    reports,
    bull_brief: researchers.bull,
    bear_brief: researchers.bear,
    trader_draft: draft.text,
    risk_aggressive: risk.aggressive.text,
    risk_conservative: risk.conservative.text,
  });
}

export async function runFirmPipelineApproach(
  approachId: FirmApproachId,
  experimentCase: DeskExperimentCase,
  complete: CompleteFn,
): Promise<FirmPipelineRun> {
  if (approachId === "solo") return runSolo(experimentCase, complete);
  if (approachId === "reports_then_trader") return runReportsThenTrader(experimentCase, complete);
  if (approachId === "bull_bear_debate") return runBullBear(experimentCase, complete);
  return runFirmCommittee(experimentCase, complete);
}

export function firmApproachById(id: string): FirmApproachMeta | undefined {
  return FIRM_APPROACHES.find((row) => row.id === id);
}

export function firmPipelineTextReps() {
  return FIRM_APPROACHES.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description,
    body: `${row.id}\n${row.label}\n${row.session_mode}\n${row.description}`,
  }));
}

const CORE_VIEWPOINT_IDS = ["fundamental", "technical", "options"] as const satisfies readonly DeskViewpointId[];

/** Public methodology payload (same frozen cases as desk-approaches). */
export function firmPipelineDesignPublic() {
  const cases = buildDeskExperimentCases();
  return {
    design_id: FIRM_PIPELINE_DESIGN_ID,
    slug: FIRM_PIPELINE_SLUG,
    runner_version: FIRM_PIPELINE_RUNNER_VERSION,
    production_note:
      "Inspired by TradingAgents (Xiao et al., arXiv:2412.20138): a simulated trading firm with specialized analysts, bull/bear researchers, a trader, and a later risk committee. Production Chat is still one CopilotAgent role-playing specialists — this study does not change that. It asks whether those *stages* beat a solo take on the same frozen invented-ticker tape.",
    paper: {
      citation: "Xiao, Sun, Luo, Wang. TradingAgents: Multi-Agents LLM Financial Trading Framework. arXiv:2412.20138.",
      keep: [
        "Role specialization (analysts vs researchers vs trader vs risk).",
        "Structured reports as the handoff, not an ever-growing chat (their 'telephone effect').",
        "Bull vs bear as an explicit dialectic, not a sequential specialist list.",
        "Risk as a committee *after* the trader draft — not a parallel desk seat.",
      ],
      reject: [
        "P&L backtests on AAPL/GOOGL/AMZN in 2024 — models can recall those names.",
        "Baselines that are only MACD/SMA/B&H. Those do not ablate the protocol.",
        "Live tool use and look-ahead-prone news APIs. The snapshot is frozen.",
        "Sharpe/drawdown as the primary grade on a four-case as-of bench. Direction on held-out 5d/20d is the grade.",
      ],
    },
    as_of_rules: DESK_EXPERIMENT_AS_OF_RULES,
    verdict_instructions: DESK_VERDICT_INSTRUCTIONS,
    system_prompt: firmPipelineSystemPrompt(),
    deadband_pct: 1.5,
    seed: DESK_EXPERIMENT_SEED,
    seed_hex: `0x${DESK_EXPERIMENT_SEED.toString(16)}`,
    start_date: DESK_EXPERIMENT_START_DATE,
    trading_days: DESK_EXPERIMENT_TRADING_DAYS,
    as_of_index: DESK_EXPERIMENT_AS_OF_INDEX,
    scoring: {
      rule:
        "A cell is correct only when both lean_5d and lean_20d match the held-out tape. Neutral is the grade when the subsequent move is inside the deadband — not a hedge for a missed direction. Same cases and deadband as desk-approaches-v2.",
      deadband_pct: 1.5,
      both_horizons_required: true,
    },
    runner: {
      execution:
        "Independent seats in a wave run in parallel (analysts, then researchers, then risk). GitHub Actions runs the matrix in-process; a full firm cell is too many DeepSeek seats for one Worker HTTP request.",
      seat_abort_ms: FIRM_SEAT_ABORT_MS,
      verdict_close_abort_ms: DESK_VERDICT_CLOSE_ABORT_MS,
      verdict_close_max_tokens: DESK_VERDICT_CLOSE_MAX_TOKENS,
      cell_timeout_ms: FIRM_CELL_TIMEOUT_MS,
      openrouter_system:
        "OpenRouter rejects role:system inside messages. System turns fold into generateText({ system }).",
      verdict_close_out:
        "If the first verdict turn has no parseable lean_5d/lean_20d JSON, one generateText follow-up with reasoning none.",
      completion_text:
        "Grade the union of text and reasoningText. DeepSeek high reasoning often puts the take in the reasoning channel.",
    },
    specialists: FIRM_ANALYST_IDS.map((id) => ({
      id,
      label: FIRM_ANALYST_LABELS[id],
      summary: FIRM_ANALYST_SUMMARIES[id],
    })),
    stages: [
      { id: "analysts", label: "Analyst team", summary: "Fundamental, technical, options, news — isolated, parallel, structured reports." },
      { id: "research", label: "Research team", summary: "Bull and bear briefs from the reports. Isolated so they cannot collapse into agreement." },
      { id: "trader", label: "Trader", summary: "Synthesizes reports (and briefs). Draft-only when a risk committee follows." },
      { id: "risk", label: "Risk committee", summary: "Aggressive vs conservative guardians on the draft — after the trader, not beside the analysts." },
      { id: "fund_manager", label: "Fund manager", summary: "Closes the verdict JSON." },
    ],
    approach_inputs: FIRM_APPROACHES.map((row) => {
      if (row.id === "solo") {
        return { id: row.id, system_prompt: deskSoloSystemPrompt() };
      }
      if (row.id === "reports_then_trader") {
        return {
          id: row.id,
          specialist_system: Object.fromEntries(
            FIRM_ANALYST_IDS.map((id) => [id, firmAnalystSystemPrompt(id)]),
          ),
          chair_system: firmTraderSystemPrompt("verdict"),
        };
      }
      if (row.id === "bull_bear_debate") {
        return {
          id: row.id,
          specialist_system: Object.fromEntries(
            FIRM_ANALYST_IDS.map((id) => [id, firmAnalystSystemPrompt(id)]),
          ),
          bull_system: firmResearcherSystemPrompt("bull"),
          bear_system: firmResearcherSystemPrompt("bear"),
          chair_system: firmTraderSystemPrompt("verdict"),
        };
      }
      return {
        id: row.id,
        specialist_system: Object.fromEntries(
          FIRM_ANALYST_IDS.map((id) => [id, firmAnalystSystemPrompt(id)]),
        ),
        bull_system: firmResearcherSystemPrompt("bull"),
        bear_system: firmResearcherSystemPrompt("bear"),
        chair_system: firmTraderSystemPrompt("draft"),
        risk_aggressive_system: firmRiskSystemPrompt("aggressive"),
        risk_conservative_system: firmRiskSystemPrompt("conservative"),
        fund_manager_system: firmFundManagerSystemPrompt(),
      };
    }),
    approaches: FIRM_APPROACHES,
    cases: cases.map((row) => ({
      id: row.id,
      ticker: row.snapshot.ticker,
      name: row.snapshot.name,
      as_of: row.snapshot.as_of,
      prompt: row.prompt,
      notes: row.notes,
      expected_5d: leanFromReturn(row.outcome.return_5d_pct),
      expected_20d: leanFromReturn(row.outcome.return_20d_pct),
      return_5d_pct: row.outcome.return_5d_pct,
      return_20d_pct: row.outcome.return_20d_pct,
      what_happened: row.outcome.what_happened,
      snapshot_text: formatDeskSnapshot(row.snapshot),
      user_packet: deskExperimentUserPacket(row),
    })),
    shared_with_desk_approaches: {
      design: "desk-approaches-v2",
      viewpoint_ids: CORE_VIEWPOINT_IDS,
      note: "Same four invented-ticker cases and 1.5% deadband. desk-approaches tests session structure; this study tests pipeline stages.",
    },
  };
}
