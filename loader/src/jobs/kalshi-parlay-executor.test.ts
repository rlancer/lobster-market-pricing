import { describe, expect, it } from "vitest";
import { kalshiParlayExecutorJob } from "./kalshi-parlay-executor.js";
import type { SchedulerEnv } from "../scheduler.js";

describe("kalshi-parlay-executor job adapter", () => {
  it("is batch, ungated, 5-minute cadence, and idles when execute is off", async () => {
    const job = kalshiParlayExecutorJob({} as SchedulerEnv);
    expect(job.id).toBe("kalshi-parlay-executor");
    expect(job.scope).toBe("batch");
    expect(job.marketGated).toBe(false);
    expect(job.cadenceSeconds).toBe(300);
    expect(await job.universe()).toEqual(["KXMVE"]);
    const result = await job.run(["KXMVE"], {});
    expect(result.failures).toEqual([]);
    expect(result.runId).toBeNull();
    expect(result.detail).toMatchObject({
      execute: false,
      live: false,
      contracts: 5,
      max_accepts_per_pass: 1,
      book: "same_game_underdog",
      max_spend: 100,
      idle_reason: "execute_off",
      attempted: 0,
      would_accept: 0,
      accepted: 0,
      open_combos: 0,
      same_game_two_leg: 0,
      considered: [],
    });
  });
});
