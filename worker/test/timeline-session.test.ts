import assert from "node:assert/strict";
import test from "node:test";
import {
  DESK_HANDLE,
  SESSION_CACHE_KEY,
  computeHomepageSession,
  deskTakeawayFromShare,
  expireHomepageSession,
  presentHomepageSession,
  resetHomepageSessionRefresh,
  serveHomepageSession,
  tapeAskPrompt,
  type HomepageSessionCache,
} from "../src/timeline-session.ts";

const THU_ET = Date.parse("2026-09-03T20:00:00.000Z");

function cacheDb(row?: { payload: string; expires_at: number }) {
  const store = new Map<string, { payload: string; expires_at: number }>();
  if (row) store.set(SESSION_CACHE_KEY, row);
  return {
    store,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              if (/SELECT payload/.test(sql)) {
                return store.get(String(args[0])) ?? null;
              }
              if (/FROM shared_chats/.test(sql)) return null;
              return null;
            },
            async run() {
              if (/INSERT INTO schema_cache/.test(sql)) {
                store.set(String(args[0]), {
                  payload: String(args[1]),
                  expires_at: Number(args[2]),
                });
              }
              if (/UPDATE schema_cache SET expires_at = 0/.test(sql)) {
                const existing = store.get(String(args[0]));
                if (existing) existing.expires_at = 0;
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

test("deskTakeawayFromShare only accepts @nowlobster with a real writeup", () => {
  const take = deskTakeawayFromShare({
    handle: DESK_HANDLE,
    share_id: "ShareDeskNowlobster000000001",
    published_at: THU_ET,
    messages: [
      { role: "user", content: "Hourly market overview: lead with SPX/QQQ." },
      {
        role: "assistant",
        content: "SPX holds the 6500 handle while QQQ lags. Unusual call buying in NVDA led the tape; risk stays defined until CPI.",
      },
    ],
  });
  assert.ok(take);
  assert.match(take!.text, /SPX holds the 6500 handle/);
  assert.equal(
    deskTakeawayFromShare({
      handle: "thelobster",
      share_id: "x",
      published_at: 1,
      messages: [{ role: "assistant", content: "SPX holds the 6500 handle while QQQ lags into the print today." }],
    }),
    null,
  );
});

test("presentHomepageSession labels today/tomorrow at serve time, not cache time", () => {
  const cached: HomepageSessionCache = {
    tape: [{ ticker: "SPY", name: "S&P 500", spot: 500, change_1d_pct: 0.4 }],
    events: [
      { date: "2026-09-03", title: "Consumer Price Index", kind: "macro", time: "08:30" },
      { date: "2026-09-04", title: "FOMC Meeting", kind: "fed", time: "14:00" },
    ],
    takeaway: null,
    computed_at: THU_ET,
  };
  const presented = presentHomepageSession(cached, THU_ET);
  assert.equal(presented.events[0]?.shortTitle, "CPI");
  assert.equal(presented.events[0]?.when, "today 8:30 AM ET");
  assert.equal(presented.events[1]?.shortTitle, "FOMC");
  assert.equal(presented.events[1]?.when, "tomorrow 2:00 PM ET");
  assert.match(presented.ask_prompt, /CPI/);
  assert.equal(presented.tape.length, 1);
});

test("tapeAskPrompt prefers a today-print, then the biggest mover", () => {
  assert.match(
    tapeAskPrompt(
      [{ ticker: "^VIX", name: "VIX", spot: 18, change_1d_pct: 4.2 }],
      [{ date: "2026-09-03", title: "CPI", shortTitle: "CPI", kind: "macro", when: "today 8:30 AM ET" }],
    ),
    /CPI/,
  );
  assert.match(
    tapeAskPrompt([{ ticker: "^VIX", name: "VIX", spot: 18, change_1d_pct: 4.2 }], []),
    /\^VIX/,
  );
});

test("serveHomepageSession returns the D1 row without hitting the lake", async () => {
  resetHomepageSessionRefresh();
  const cached: HomepageSessionCache = {
    tape: [{ ticker: "QQQ", name: "Nasdaq-100", spot: 480, change_1d_pct: -0.2 }],
    events: [{ date: "2026-09-03", title: "Employment Situation", kind: "macro", time: "08:30" }],
    takeaway: {
      handle: DESK_HANDLE,
      shareId: "abc",
      url: "/share/abc",
      publishedAt: THU_ET,
      text: "SPX holds the 6500 handle while QQQ lags into the print.",
    },
    computed_at: THU_ET,
  };
  const db = cacheDb({ payload: JSON.stringify(cached), expires_at: THU_ET + 60_000 });
  let lakeCalls = 0;
  const presented = await serveHomepageSession({
    env: { SCHEMA_DB: db as unknown as D1Database },
    now: THU_ET,
    queryLake: async () => {
      lakeCalls += 1;
      return [];
    },
    loadCalendar: async () => {
      throw new Error("calendar should not run on a fresh cache hit");
    },
  });
  assert.equal(lakeCalls, 0);
  assert.equal(presented.tape[0]?.ticker, "QQQ");
  assert.equal(presented.events[0]?.shortTitle, "Jobs");
  assert.equal(presented.takeaway?.handle, DESK_HANDLE);
});

test("stale cache serves immediately and refreshes in the background", async () => {
  resetHomepageSessionRefresh();
  const cached: HomepageSessionCache = {
    tape: [{ ticker: "SPY", name: "S&P 500", spot: 1, change_1d_pct: 0 }],
    events: [],
    takeaway: null,
    computed_at: THU_ET - 10 * 60 * 1000,
  };
  const db = cacheDb({ payload: JSON.stringify(cached), expires_at: THU_ET - 1 });
  let refreshed = false;
  const presented = await serveHomepageSession({
    env: { SCHEMA_DB: db as unknown as D1Database },
    now: THU_ET,
    queryLake: async () => {
      refreshed = true;
      return [{ symbol: "SPY", spot: 510, prev_close: 500 }];
    },
    loadCalendar: async () => ({ items: [] }),
    ctx: {
      waitUntil(promise) {
        void promise.then(() => {
          refreshed = true;
        });
      },
    },
  });
  assert.equal(presented.tape[0]?.ticker, "SPY");
  assert.equal(presented.tape[0]?.spot, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshed, true);
});

test("expireHomepageSession zeros expires_at so the next GET refreshes", async () => {
  const db = cacheDb({
    payload: JSON.stringify({ tape: [], events: [], takeaway: null, computed_at: 1 }),
    expires_at: 9_999_999,
  });
  await expireHomepageSession(db as unknown as D1Database);
  assert.equal(db.store.get(SESSION_CACHE_KEY)?.expires_at, 0);
});

test("computeHomepageSession degrades when tape and calendar fail", async () => {
  resetHomepageSessionRefresh();
  const db = cacheDb();
  const snap = await computeHomepageSession({
    env: { SCHEMA_DB: db as unknown as D1Database },
    now: THU_ET,
    queryLake: async () => {
      throw new Error("lake down");
    },
    loadCalendar: async () => {
      throw new Error("calendar down");
    },
  });
  assert.deepEqual(snap.tape, []);
  assert.deepEqual(snap.events, []);
  assert.equal(snap.takeaway, null);
});
