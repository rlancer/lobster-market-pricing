#!/usr/bin/env node
/**
 * Export a marimo notebook to executed HTML and upload it to the private
 * `lobster-marimo-exports` R2 bucket. html-wasm is not used: Iceberg attach
 * needs tokens that must not ship to the browser.
 *
 *   node notebooks/tools/export_marimo_to_r2.mjs
 *   node notebooks/tools/export_marimo_to_r2.mjs --slug lake-tape-backtest
 *
 * Auth: CLOUDFLARE_API_TOKEN or R2_DATA_CATALOG_TOKEN (R2 Storage Admin),
 * plus CLOUDFLARE_ACCOUNT_ID (or worker/wrangler.jsonc R2_SQL_ACCOUNT_ID).
 * Never prints secret values. Invokes wrangler via process.execPath (Windows-safe).
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const NOTEBOOKS = join(TOOLS, "..");
const REPO = join(NOTEBOOKS, "..");
const WORKER = join(REPO, "worker");
const BUCKET = "lobster-marimo-exports";

/** Keep in sync with worker/src/admin-marimo.ts MARIMO_NOTEBOOKS. */
const CATALOG = [
  {
    slug: "lake-tape-backtest",
    title: "Kalshi sports tape backtest",
    source: "notebooks/apps/lake_tape_backtest.py",
    notebook: join(NOTEBOOKS, "apps", "lake_tape_backtest.py"),
    htmlKey: "marimo/lake-tape-backtest.html",
    metaKey: "marimo/lake-tape-backtest.json",
  },
];

function die(message) {
  console.error(message);
  process.exit(1);
}

function loadDotenvKeys(file, keys) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const wanted = new Set(keys);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!wanted.has(name) || process.env[name]) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

function accountIdFromWrangler() {
  const text = readFileSync(join(WORKER, "wrangler.jsonc"), "utf8");
  const match = text.match(/"R2_SQL_ACCOUNT_ID"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? "";
}

function wranglerBin() {
  const bin = join(WORKER, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(bin)) die(`wrangler not installed — run: cd worker && npm ci\n(missing ${bin})`);
  return bin;
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    die(`${cmd} ${args.join(" ")} failed (exit ${result.status}):\n${err}`);
  }
  return result;
}

function gitSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const sha = (result.stdout || "").trim();
  return sha || null;
}

const args = process.argv.slice(2);
const slugArg = (() => {
  const i = args.indexOf("--slug");
  return i >= 0 ? args[i + 1] : null;
})();

loadDotenvKeys(join(REPO, ".env"), [
  "R2_DATA_CATALOG_TOKEN",
  "R2_SQL_TOKEN",
  "WRANGLER_R2_SQL_AUTH_TOKEN",
  "KALSHI_ACCESS_KEY_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
]);

if (!process.env.CLOUDFLARE_API_TOKEN && process.env.R2_DATA_CATALOG_TOKEN) {
  process.env.CLOUDFLARE_API_TOKEN = process.env.R2_DATA_CATALOG_TOKEN;
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  process.env.CLOUDFLARE_ACCOUNT_ID = accountIdFromWrangler();
}
if (!process.env.CLOUDFLARE_API_TOKEN) {
  die("CLOUDFLARE_API_TOKEN or R2_DATA_CATALOG_TOKEN is required to upload.");
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  die("CLOUDFLARE_ACCOUNT_ID is missing (wrangler.jsonc R2_SQL_ACCOUNT_ID also empty).");
}
if (!process.env.R2_DATA_CATALOG_TOKEN) {
  die("R2_DATA_CATALOG_TOKEN is required so marimo can attach Iceberg.");
}

const selected = slugArg ? CATALOG.filter((item) => item.slug === slugArg) : CATALOG;
if (slugArg && selected.length === 0) {
  die(`Unknown slug ${slugArg}. Known: ${CATALOG.map((item) => item.slug).join(", ")}`);
}

const outDir = join(NOTEBOOKS, ".cache", "export");
mkdirSync(outDir, { recursive: true });
const sha = gitSha();
const exportedAt = new Date().toISOString();
const uv = process.env.UV || "uv";

for (const item of selected) {
  if (!existsSync(item.notebook)) die(`Missing notebook ${item.notebook}`);
  const htmlPath = join(outDir, `${item.slug}.html`);
  const metaPath = join(outDir, `${item.slug}.json`);
  console.log(`Exporting ${item.slug} via marimo export html (executes Iceberg)…`);
  run(uv, [
    "run",
    "marimo",
    "export",
    "html",
    item.notebook,
    "-o",
    htmlPath,
    "-f",
    "--no-sandbox",
  ], { cwd: NOTEBOOKS, env: process.env, timeout: 300_000 });

  const bytes = statSync(htmlPath).size;
  writeFileSync(metaPath, `${JSON.stringify({
    slug: item.slug,
    title: item.title,
    source: item.source,
    exported_at: exportedAt,
    git_sha: sha,
    bytes,
  }, null, 2)}\n`);
  console.log(`Wrote ${htmlPath} (${bytes} bytes). Uploading to R2…`);

  const wrangler = wranglerBin();
  run(process.execPath, [
    wrangler,
    "r2",
    "object",
    "put",
    `${BUCKET}/${item.htmlKey}`,
    "--file",
    htmlPath,
    "--remote",
    "--content-type",
    "text/html; charset=utf-8",
    "-y",
  ], { cwd: WORKER, env: process.env, timeout: 120_000 });
  run(process.execPath, [
    wrangler,
    "r2",
    "object",
    "put",
    `${BUCKET}/${item.metaKey}`,
    "--file",
    metaPath,
    "--remote",
    "--content-type",
    "application/json",
    "-y",
  ], { cwd: WORKER, env: process.env, timeout: 60_000 });
  console.log(`Uploaded r2://${BUCKET}/${item.htmlKey} and ${item.metaKey}`);
}

console.log("Done. Admin UI: /admin/marimo");
