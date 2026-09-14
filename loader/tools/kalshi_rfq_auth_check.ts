/**
 * Diagnose Kalshi Trade API vs communications (RFQ) permission.
 * Never creates an RFQ, never accepts/confirms. Prints HTTP status only.
 *
 * Sources (first wins): process env, loader/.env, loader/.dev.vars, repo .env
 *
 *   cd loader && node --experimental-strip-types tools/kalshi_rfq_auth_check.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KALSHI_API_BASE,
  kalshiAuthConfigured,
  kalshiRequest,
  type KalshiEnv,
} from "../src/kalshi.ts";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const LOADER = join(TOOLS, "..");
const REPO = join(LOADER, "..");

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    i += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1);
    if (val.startsWith('"')) {
      let body = val.slice(1);
      if (!body.endsWith('"') || body.length === 0) {
        while (i < lines.length) {
          body += "\n" + (lines[i] ?? "");
          i += 1;
          if (body.endsWith('"') && !body.endsWith('\\"')) break;
        }
      }
      if (body.endsWith('"')) body = body.slice(0, -1);
      val = body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      val = val.split("#")[0]?.trim() ?? "";
      val = val.replace(/\\n/g, "\n");
    }
    out[key] = val;
  }
  return out;
}

function loadFileEnv(): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const path of [join(LOADER, ".env"), join(LOADER, ".dev.vars"), join(REPO, ".env")]) {
    if (!existsSync(path)) continue;
    Object.assign(merged, parseEnvFile(readFileSync(path, "utf8")));
    console.log(`loaded ${path} (values not printed)`);
  }
  return merged;
}

function resolvePem(fileEnv: Record<string, string>): string {
  const fromProc = (process.env.KALSHI_PRIVATE_KEY_PEM || "").trim();
  if (fromProc) return fromProc;
  const fileRel = (process.env.KALSHI_PRIVATE_KEY_FILE || fileEnv.KALSHI_PRIVATE_KEY_FILE || "").trim();
  if (fileRel) {
    const p = fileRel.startsWith("/") ? fileRel : join(LOADER, fileRel);
    if (!existsSync(p)) throw new Error(`KALSHI_PRIVATE_KEY_FILE not found (${p})`);
    return readFileSync(p, "utf8").trim();
  }
  return (fileEnv.KALSHI_PRIVATE_KEY_PEM || "").trim();
}

async function statusOf(method: string, url: string, env: KalshiEnv, label: string): Promise<number> {
  const result = await kalshiRequest(method, url, env, label);
  const snippet = result.text.replace(/\s+/g, " ").slice(0, 80);
  console.log(`${label}: HTTP ${result.status}${snippet ? ` ${snippet}` : ""}`);
  return result.status;
}

const fileEnv = loadFileEnv();
const env: KalshiEnv = {
  KALSHI_ACCESS_KEY_ID: process.env.KALSHI_ACCESS_KEY_ID || fileEnv.KALSHI_ACCESS_KEY_ID,
  KALSHI_PRIVATE_KEY_PEM: resolvePem(fileEnv),
  KALSHI_MIN_REQUEST_GAP_MS: 0,
  HTTP_RETRIES: 0,
};

const hasKey = !!(env.KALSHI_ACCESS_KEY_ID || "").trim();
const hasPem = !!(env.KALSHI_PRIVATE_KEY_PEM || "").trim();
console.log(`auth configured: ${kalshiAuthConfigured(env)} (key_id=${hasKey} pem=${hasPem} lens omitted)`);

if (!kalshiAuthConfigured(env)) {
  console.error(
    "Missing KALSHI_ACCESS_KEY_ID and/or KALSHI_PRIVATE_KEY_PEM in process env, loader/.env, or KALSHI_PRIVATE_KEY_FILE.",
  );
  process.exit(2);
}

const base = DEFAULT_KALSHI_API_BASE.replace(/\/$/, "");
const market = await statusOf("GET", `${base}/markets?limit=1&status=open`, env, "GET /markets");
const rfqs = await statusOf(
  "GET",
  `${base}/communications/rfqs?user_filter=self&status=open&limit=1`,
  env,
  "GET /communications/rfqs",
);

if (market >= 200 && market < 300 && rfqs >= 200 && rfqs < 300) {
  console.log("ok: trading communications reachable (no RFQ created)");
  process.exit(0);
}
if (rfqs === 401 || rfqs === 403) {
  console.log("communications forbidden — key can GET markets but cannot RFQ (need trading permission)");
  process.exit(3);
}
process.exit(1);
