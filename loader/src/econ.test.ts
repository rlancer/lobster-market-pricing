import { describe, expect, it, vi } from "vitest";
import {
  ECON_FRED_RELEASES,
  ECON_SOURCE_FED,
  econSourceList,
  normalizeEconRecords,
  publishEconSource,
} from "./econ.js";

// Fixture: FRED release/dates payload for one release (CPI, release_id=10),
// real scheduled dates (historical + forward).
const FRED_PAYLOAD = {
  release_dates: [
    { release_id: 10, date: "2026-01-13" },
    { release_id: 10, date: "2026-02-13" },
    { release_id: 10, date: "2026-08-12" },
    { release_id: 10, date: "2026-12-10" },
  ],
};

// Fixture: Fed calendar events — a mix of FOMC/Beige types plus data-entry
// title variants (" FOMC Minutes", "FOMC meeting") that must collapse onto the
// canonical titles, and a non-matching type that must be dropped. Times are
// Fed ET wall-clock strings ("2:00 p.m." → "14:00").
const FED_PAYLOAD = {
  events: [
    { title: "FOMC Meeting", type: "FOMC", month: "2026-09", days: "16", time: "2:00 p.m." },
    { title: " FOMC Minutes", type: "FOMC", month: "2026-10", days: "7", time: "2:00 p.m." },
    { title: "FOMC meeting", type: "FOMC", month: "2026-01", days: "28", time: "8:30 a.m." },
    { title: "Beige Book", type: "Beige", month: "2026-09", days: "2", time: "2:00 p.m." },
    { title: "H.4.1", type: "Stat", month: "2026-09", days: "1" }, // dropped
  ],
};

// A fixed "now" so the fetch window (now-730d .. now+400d) covers all fixtures.
const NOW = Date.UTC(2026, 7, 10, 12);

function stubFetch(onUrl: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
    onUrl(String(input), init),
  );
}

describe("econSourceList", () => {
  it("is one source per allowlisted FRED release plus the Fed calendar", () => {
    const list = econSourceList();
    expect(list).toEqual([
      ...Object.keys(ECON_FRED_RELEASES).map((id) => `fred:${id}`),
      ECON_SOURCE_FED,
    ]);
    expect(list.filter((s) => s.startsWith("fred:"))).toHaveLength(
      Object.keys(ECON_FRED_RELEASES).length,
    );
    expect(list.includes(ECON_SOURCE_FED)).toBe(true);
  });
});

describe("publishEconSource", () => {
  it("requires PIPELINE_ECON_URL", async () => {
    await expect(publishEconSource("fred:10")).rejects.toThrow(/PIPELINE_ECON_URL/);
  });

  it("fetches a FRED release, normalizes macro rows, and posts them", async () => {
    const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    stubFetch((url, init) => {
      if (url.includes("stlouisfed.org")) {
        return new Response(JSON.stringify(FRED_PAYLOAD), { status: 200 });
      }
      posts.push({
        url,
        body: JSON.parse(String(init?.body)),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishEconSource("fred:10", {
        PIPELINE_ECON_URL: "https://pipeline.test/econ",
        PIPELINE_AUTH_TOKEN: "tok",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-abc",
        now: () => NOW,
      });
      expect(result).toMatchObject({ item: "fred:10", row_count: 4, published: true, run_id: "run-abc" });

      expect(posts).toHaveLength(1);
      const post = posts[0];
      expect(post.url).toBe("https://pipeline.test/econ");
      expect(post.headers["authorization"]).toBe("Bearer tok");
      expect(post.headers["idempotency-key"]).toBe("econ:run-abc:fred:10");
      const rows = post.body as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(4);
      expect(rows[0]).toMatchObject({ event_date: "2026-01-13", title: "Consumer Price Index", kind: "macro", source: "fred", run_id: "run-abc" });
      // Column order matches ECON_FIELDS.
      expect(Object.keys(rows[0])).toEqual(["event_date", "title", "kind", "source", "run_id", "fetched_at"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches the Fed calendar, collapses title variants, and drops non-FOMC/Beige types", async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      if (url.includes("federalreserve.gov")) {
        return new Response(JSON.stringify(FED_PAYLOAD), { status: 200 });
      }
      posts.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishEconSource(ECON_SOURCE_FED, {
        PIPELINE_ECON_URL: "https://pipeline.test/econ",
        PIPELINE_AUTH_TOKEN: "tok",
        HTTP_RETRIES: 0,
        runId: () => "run-1",
        now: () => NOW,
      });
      expect(result).toMatchObject({ item: ECON_SOURCE_FED, row_count: 4, published: true });

      const rows = posts[0].body as Array<Record<string, unknown>>;
      // "H.4.1" (type Stat) dropped; " FOMC Minutes" and "FOMC meeting"
      // normalized to "FOMC Minutes" / "FOMC Meeting".
      expect(rows.map((r) => r.title).sort()).toEqual([
        "Beige Book",
        "FOMC Meeting",
        "FOMC Meeting",
        "FOMC Minutes",
      ]);
      expect(rows.every((r) => r.kind === "fed" && r.source === "federalreserve")).toBe(true);
      // Decision-day date derived from month + days; ET time normalized to HH:MM.
      const meeting = rows.find((r) => r.title === "FOMC Meeting" && r.event_date === "2026-09-16");
      expect(meeting).toBeTruthy();
      expect(meeting!.event_time).toBe("14:00");
      // a.m. path: "FOMC meeting" (2026-01-28) → "08:30".
      const am = rows.find((r) => r.event_date === "2026-01-28");
      expect(am!.event_time).toBe("08:30");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not publish when a source yields zero rows", async () => {
    const posts: unknown[] = [];
    stubFetch((url, init) => {
      if (url.includes("stlouisfed.org")) {
        return new Response(JSON.stringify({ release_dates: [] }), { status: 200 });
      }
      posts.push(init);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      const result = await publishEconSource("fred:10", {
        PIPELINE_ECON_URL: "https://pipeline.test/econ",
        FRED_API_KEY: "fredkey",
        HTTP_RETRIES: 0,
        runId: () => "run-1",
        now: () => NOW,
      });
      expect(result).toMatchObject({ row_count: 0, published: false });
      expect(posts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when FRED is requested without a key (per-source isolation records it)", async () => {
    const posts: unknown[] = [];
    stubFetch((url, init) => {
      posts.push(init);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      await expect(
        publishEconSource("fred:46", {
          PIPELINE_ECON_URL: "https://pipeline.test/econ",
          HTTP_RETRIES: 0,
        }),
      ).rejects.toThrow(/FRED_API_KEY/);
      expect(posts).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("normalizeEconRecords", () => {
  it("emits records in ECON_FIELDS order with run_id and fetched_at", () => {
    const rows = normalizeEconRecords(
      [{ event_date: "2026-09-16", title: "FOMC Meeting", kind: "fed", source: "federalreserve", event_time: "14:00" }],
      "run-1",
      "2026-08-10T12:00:00.000Z",
    );
    expect(rows[0]).toEqual({
      event_date: "2026-09-16",
      title: "FOMC Meeting",
      kind: "fed",
      source: "federalreserve",
      event_time: "14:00",
      run_id: "run-1",
      fetched_at: "2026-08-10T12:00:00.000Z",
    });
  });
});