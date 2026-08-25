// Live probe for the FRED inflation / price-index path (series observations →
// normalize). Dry-run: fetches + normalizes only — nothing is published.
//   node --experimental-strip-types tools/macro_probe.ts
// FRED needs the key: FRED_API_KEY in the environment (or loader/.dev.vars).
import { MACRO_SERIES, fetchMacroSeries } from "../src/macro.ts";
import { readFileSync } from "node:fs";

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
for (const [id, meta] of Object.entries(MACRO_SERIES)) {
  try {
    const rows = await fetchMacroSeries(id, { FRED_API_KEY, HTTP_RETRIES: 2 });
    const last = rows[rows.length - 1];
    results.push({
      series_id: id,
      kind: meta.kind,
      units: meta.units,
      rows: rows.length,
      sample: last ? { date: last.date, value: last.value } : null,
    });
  } catch (error) {
    results.push({
      series_id: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify(results, null, 2));
