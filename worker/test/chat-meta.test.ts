import assert from "node:assert/strict";
import test from "node:test";
import {
  formatChatMetaTranscript,
  parseChatMetaResponse,
  sanitizeChatMeta,
} from "../src/chat-meta.ts";
import { isAutoDerivedTitle, shareDisplayTitle } from "../src/user-chats.ts";

test("parseChatMetaResponse accepts JSON and sanitizes tickers", () => {
  const meta = parseChatMetaResponse(
    'Sure\n{"title":"  SPX soft, QQQ leads the tape  ","tickers":["spy","QQQ","not a ticker!!","SPY"]}\n',
  );
  assert.equal(meta.title, "SPX soft, QQQ leads the tape");
  assert.deepEqual(meta.tickers, ["SPY", "QQQ"]);
});

test("sanitizeChatMeta drops junk tickers", () => {
  assert.deepEqual(
    sanitizeChatMeta({ title: "Desk take", tickers: ["TLT", "not a ticker!!", "HYG"] }),
    { title: "Desk take", tickers: ["TLT", "HYG"] },
  );
});

test("parseChatMetaResponse rejects junk", () => {
  assert.deepEqual(parseChatMetaResponse("no json here"), { title: null, tickers: [] });
  assert.deepEqual(parseChatMetaResponse("{"), { title: null, tickers: [] });
});

test("formatChatMetaTranscript keeps role lines and trims", () => {
  const text = formatChatMetaTranscript([
    { role: "user", content: "  Chart NVDA  " },
    { role: "assistant", content: "NVDA is up." },
    { role: "system", content: "ignore" },
  ]);
  assert.equal(text, "user: Chart NVDA\n\nassistant: NVDA is up.");
});

test("shareDisplayTitle prefers LLM headlines over first-user clips", () => {
  const prompt =
    "Hourly market overview: what's happening right now? Lead with SPX/QQQ/IWM posture, sector leadership or rotation, and the unusual options flow or single-name catalysts that explain the tape. Close with a sharp desk takeaway.";
  const messages = [
    { role: "user", content: prompt },
    { role: "assistant", content: "SPX soft; tech leads." },
  ];
  assert.equal(
    shareDisplayTitle(messages, "SPX soft; tech leads the open"),
    "SPX soft; tech leads the open",
  );
  // Legacy mid-word truncate still heals to the opening sentence.
  assert.equal(
    shareDisplayTitle(messages, prompt.slice(0, 120)),
    "Hourly market overview: what's happening right now?",
  );
  assert.equal(isAutoDerivedTitle(prompt.slice(0, 120), prompt), true);
  assert.equal(isAutoDerivedTitle("SPX soft; tech leads the open", prompt), false);
});
