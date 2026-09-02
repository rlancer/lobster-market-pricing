import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentsPromptAddon,
  parseAttachmentsFromBody,
  PORTFOLIO_SOURCE_LABELS,
} from "../src/chat-attachments.ts";

test("parseAttachmentsFromBody keeps portfolio handles and drops junk", () => {
  assert.deepEqual(parseAttachmentsFromBody(null), []);
  assert.deepEqual(parseAttachmentsFromBody({}), []);
  assert.deepEqual(parseAttachmentsFromBody({ attachments: "nope" }), []);
  assert.deepEqual(
    parseAttachmentsFromBody({
      attachments: [
        { kind: "portfolio", source: "schwab" },
        { kind: "portfolio", source: "paper", account_id: "  acct-1  " },
        { kind: "portfolio", source: "ibkr" },
        { kind: "document", id: "x" },
        { kind: "portfolio", source: "schwab" },
        null,
        12,
      ],
    }),
    [
      { kind: "portfolio", source: "schwab" },
      { kind: "portfolio", source: "paper", account_id: "acct-1" },
    ],
  );
});

test("attachmentsPromptAddon instructs get_portfolio for each source", () => {
  const body = attachmentsPromptAddon([
    { kind: "portfolio", source: "schwab" },
    { kind: "portfolio", source: "paper", account_id: "a1" },
  ]);
  assert.match(body, /Attached context/);
  assert.match(body, new RegExp(PORTFOLIO_SOURCE_LABELS.schwab));
  assert.match(body, /get_portfolio with source="schwab"/);
  assert.match(body, /get_portfolio with source="paper"/);
  assert.match(body, /account_id="a1"/);
  assert.match(body, /never invent holdings/i);
  assert.match(body, /ONLY via get_portfolio/i);
  assert.match(body, /never run_query/i);
  assert.match(body, /at most 2–3 material names/i);
  assert.equal(attachmentsPromptAddon([]), "");
});
