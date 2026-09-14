import { describe, expect, it } from "vitest";
import { kalshiParlayExecutorJob } from "./kalshi-parlay-executor.js";
import type { SchedulerEnv } from "../scheduler.js";

describe("kalshi-parlay-executor job adapter", () => {
  it("is batch, ungated, 5-minute cadence, and dry-runs when execute is off", async () => {
    const job = kalshiParlayExecutorJob({} as SchedulerEnv);
    expect(job.id).toBe("kalshi-parlay-executor");
    expect(job.scope).toBe("batch");
    expect(job.marketGated).toBe(false);
    expect(job.cadenceSeconds).toBe(300);
    expect(await job.universe()).toEqual(["KXMVE"]);
    const result = await job.run(["KXMVE"], {});
    expect(result.failures).toEqual([]);
    expect(result.runId).toBeNull();
  });
});
