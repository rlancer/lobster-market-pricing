import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listSecurityChats } from "../src/chat-tickers.ts";

describe("listSecurityChats", () => {
  it("returns only rows with share_id + title and binds security/now/limit", async () => {
    let sql = "";
    let binds: unknown[] = [];
    const db = {
      prepare(query: string) {
        sql = query;
        return {
          bind(...args: unknown[]) {
            binds = args;
            return {
              async all() {
                return {
                  results: [
                    {
                      chat_id: "chat-1",
                      security_id: "sec-aapl",
                      ticker: "AAPL",
                      first_seen_at: 1,
                      last_seen_at: 3,
                      mention_count: 2,
                      share_id: "share-1",
                      title: "  Why is AAPL consolidating?  ",
                    },
                    {
                      chat_id: "chat-2",
                      security_id: "sec-aapl",
                      ticker: "AAPL",
                      first_seen_at: 1,
                      last_seen_at: 2,
                      mention_count: 1,
                      share_id: "",
                      title: "orphan ticker link",
                    },
                    {
                      chat_id: "chat-3",
                      security_id: "sec-aapl",
                      ticker: "AAPL",
                      first_seen_at: 1,
                      last_seen_at: 1,
                      mention_count: 1,
                      share_id: "share-3",
                      title: "   ",
                    },
                  ],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const items = await listSecurityChats(db, "sec-aapl", 7, 1_700_000_000_000);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      chat_id: "chat-1",
      security_id: "sec-aapl",
      ticker: "AAPL",
      first_seen_at: 1,
      last_seen_at: 3,
      mention_count: 2,
      share_id: "share-1",
      title: "Why is AAPL consolidating?",
    });
    assert.match(sql, /shared_chats/);
    assert.match(sql, /timeline_posts/);
    assert.match(sql, /bot_profiles/);
    assert.match(sql, /LENGTH\(TRIM\(COALESCE\(title, ''\)\)\) > 0/);
    assert.deepEqual(binds, ["sec-aapl", 1_700_000_000_000, 7]);
  });

  it("caps limit between 1 and 100", async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare() {
        return {
          bind(...args: unknown[]) {
            binds.push(args);
            return { async all() { return { results: [] }; } };
          },
        };
      },
    } as unknown as D1Database;

    await listSecurityChats(db, "sec", 0);
    await listSecurityChats(db, "sec", 500);
    assert.equal(binds[0][2], 1);
    assert.equal(binds[1][2], 100);
  });
});
