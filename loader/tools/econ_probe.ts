// Live probe for the macro/FOMC calendar path (FRED releases + Fed calendar →
// normalize). Dry-run: fetches + normalizes only — nothing is published.
//   node tools/econ_probe.ts
// FRED needs the key: FRED_API_KEY in the environment (or loader/.dev.vars).
import { ECON_FRED_RELEASES, ECON_SOURCE_FED, fetchFredRelease, fetchFedCalendar } from "../src/econ.ts";
import { readFileSync } from "node:fs";

// Bare-node probe: FRED_API_KEY is read from loader/.dev.vars (same file the
// Worker uses) when not already in the environment. Never echoed.
function fredKeyFromFile(): string {
  try {
    const vars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
    const m = /^FRED_API_KEY=(\S+)/m.exec(vars);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const FRED_API_KEY = process.env.FRED_API_KEY || fredKeyFromFile();

const results: Array<Record<string, unknown>> = [];
for (const [id, name] of Object.entries(ECON_FRED_RELEASES)) {
  try {
    const rows = await fetchFredRelease(Number(id), { FRED_API_KEY, HTTP_RETRIES: 2 });
    results.push({
      source: `fred:${id}`,
      release: name,
      rows: rows.length,
      sample: rows.slice(0, 3).map((r) => r.event_date),
    });
  } catch (error) {
    results.push({ source: `fred:${id}`, error: error instanceof Error ? error.message : String(error) });
  }
}
try {
  const rows = await fetchFedCalendar({ HTTP_RETRIES: 2 });
  results.push({
    source: ECON_SOURCE_FED,
    rows: rows.length,
    sample: rows.slice(0, 3).map((r) => `${r.event_date} ${r.title}`),
  });
} catch (error) {
  results.push({ source: ECON_SOURCE_FED, error: error instanceof Error ? error.message : String(error) });
}

console.log(JSON.stringify(results, null, 2));