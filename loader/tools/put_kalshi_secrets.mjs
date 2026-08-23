#!/usr/bin/env node
/**
 * Upload Kalshi API secrets to the cboe-to-r2 Worker from a local env file
 * or PEM file. Avoids interactive `wrangler secret put` (multi-line PEMs
 * break in many terminals).
 *
 * Desktop handoff:
 *   1. Put Key ID + PEM path in loader/.env (gitignored) — see .env.kalshi.example
 *   2. cd loader && node tools/put_kalshi_secrets.mjs
 *   3. Optional: node tools/put_kalshi_secrets.mjs --deploy
 *
 * Sources (first wins): --env-file, loader/.env, loader/.dev.vars, repo .env
 * PEM sources: KALSHI_PRIVATE_KEY_FILE path, or KALSHI_PRIVATE_KEY_PEM value
 *   (supports double-quoted multi-line or \n-escaped single line).
 *
 * Never prints secret values.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)); // loader/tools
const LOADER = join(ROOT, "..");
const REPO = join(LOADER, "..");

const args = process.argv.slice(2);
const wantDeploy = args.includes("--deploy");
const envFileArg = (() => {
  const i = args.indexOf("--env-file");
  return i >= 0 ? args[i + 1] : null;
})();
const pemFileArg = (() => {
  const i = args.indexOf("--pem");
  return i >= 0 ? args[i + 1] : null;
})();
const keyIdArg = (() => {
  const i = args.indexOf("--key-id");
  return i >= 0 ? args[i + 1] : null;
})();

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/** Minimal .env parser with double-quoted multi-line support. */
function parseEnvFile(text) {
  const out = {};
  let i = 0;
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (i < lines.length) {
    let line = lines[i];
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
        // Multi-line double-quoted value
        while (i < lines.length) {
          body += "\n" + lines[i];
          i += 1;
          if (body.endsWith('"') && !body.endsWith('\\"')) break;
        }
      }
      if (body.endsWith('"')) body = body.slice(0, -1);
      val = body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (val.startsWith("'")) {
      let body = val.slice(1);
      if (body.endsWith("'")) body = body.slice(0, -1);
      val = body;
    } else {
      val = val.split("#")[0].trim();
      val = val.replace(/\\n/g, "\n");
    }
    out[key] = val;
  }
  return out;
}

function loadEnv() {
  const candidates = [];
  if (envFileArg) candidates.push(resolve(envFileArg));
  candidates.push(join(LOADER, ".env"), join(LOADER, ".dev.vars"), join(REPO, ".env"));
  const merged = {};
  let used = null;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    Object.assign(merged, parseEnvFile(readFileSync(path, "utf8")));
    used = used || path;
  }
  return { env: merged, used };
}

function resolvePem(env) {
  if (pemFileArg) {
    const p = resolve(pemFileArg);
    if (!existsSync(p)) die(`PEM file not found: ${p}`);
    return readFileSync(p, "utf8").trim();
  }
  const fileRel = (env.KALSHI_PRIVATE_KEY_FILE || "").trim();
  if (fileRel) {
    const p = resolve(LOADER, fileRel);
    if (!existsSync(p)) die(`KALSHI_PRIVATE_KEY_FILE not found: ${p}`);
    return readFileSync(p, "utf8").trim();
  }
  const inline = (env.KALSHI_PRIVATE_KEY_PEM || "").trim();
  if (inline) return inline;
  die(
    "No PEM found. Set KALSHI_PRIVATE_KEY_FILE=./your.key in loader/.env,\n" +
      "or KALSHI_PRIVATE_KEY_PEM=\"-----BEGIN...\", or pass --pem ./your.key",
  );
}

function wranglerBin() {
  return join(LOADER, "node_modules", "wrangler", "bin", "wrangler.js");
}

function putSecret(name, value) {
  const bin = wranglerBin();
  if (!existsSync(bin)) {
    die(`wrangler not installed — run: cd loader && npm ci\n(missing ${bin})`);
  }
  // Pipe via stdin so multi-line PEMs never hit the interactive prompt.
  // Invoke Node directly (Windows-safe; npx.cmd splat issues).
  const result = spawnSync(process.execPath, [bin, "secret", "put", name], {
    cwd: LOADER,
    input: value,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    die(`wrangler secret put ${name} failed (exit ${result.status}):\n${err}`);
  }
  console.log(`OK  wrangler secret put ${name} (${value.length} chars, value not printed)`);
}

function deploy() {
  const bin = wranglerBin();
  console.log("Redeploying cboe-to-r2 so the DO sees the new secrets…");
  const result = spawnSync(process.execPath, [bin, "deploy"], {
    cwd: LOADER,
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) die(`wrangler deploy failed (exit ${result.status})`);
}

const { env, used } = loadEnv();
if (used) console.log(`Loaded env from ${used}`);
else console.log("No .env/.dev.vars found — using CLI flags only");

const keyId = (keyIdArg || env.KALSHI_ACCESS_KEY_ID || "").trim();
if (!keyId) {
  die("Missing KALSHI_ACCESS_KEY_ID (set in loader/.env or pass --key-id <uuid>)");
}

const pem = resolvePem(env);
if (!/BEGIN (RSA )?PRIVATE KEY/.test(pem)) {
  die("PEM does not look like a private key (expected BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY)");
}

console.log("Uploading Kalshi secrets to Worker cboe-to-r2 (values hidden)…");
putSecret("KALSHI_ACCESS_KEY_ID", keyId);
putSecret("KALSHI_PRIVATE_KEY_PEM", pem.endsWith("\n") ? pem : `${pem}\n`);

if (wantDeploy) deploy();
else {
  console.log("Done. Redeploy when ready:");
  console.log("  cd loader && npx wrangler deploy");
  console.log("Or re-run with --deploy");
}
