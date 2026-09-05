/**
 * CLI: node --import tsx tools/assert-bot-overview-e2e.ts <trigger.json> <tools.json>
 * Used by .github/workflows/bot-overview-e2e.yml — never prints secrets.
 */
import { readFileSync } from "node:fs";
import { judgeOverviewRun, type OverviewToolEvent } from "../src/bot-overview-e2e.ts";

const triggerPath = process.argv[2];
const toolsPath = process.argv[3];
if (!triggerPath || !toolsPath) {
  console.error("usage: assert-bot-overview-e2e.ts <trigger.json> <tools.json>");
  process.exit(2);
}

const trigger = JSON.parse(readFileSync(triggerPath, "utf8")) as {
  ok?: boolean;
  share_id?: string;
  error?: string;
};
const toolsBody = JSON.parse(readFileSync(toolsPath, "utf8")) as {
  items?: Array<{ tool_name?: string; ok?: boolean; sql?: string | null; summary?: string | null }>;
};

const tools: OverviewToolEvent[] = (toolsBody.items ?? []).map((row) => ({
  tool_name: String(row.tool_name ?? ""),
  ok: row.ok === true,
  sql: row.sql ?? null,
  summary: row.summary ?? null,
}));

const verdict = judgeOverviewRun({
  triggerOk: trigger.ok === true,
  shareId: trigger.share_id ?? null,
  error: trigger.error ?? null,
  tools,
});

console.log(JSON.stringify({
  ok: verdict.ok,
  share_id: trigger.share_id ?? null,
  reasons: verdict.reasons,
  tools: tools.map((row) => row.tool_name),
}, null, 2));

if (!verdict.ok) {
  process.exit(1);
}
