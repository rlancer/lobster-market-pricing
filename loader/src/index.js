import { Container, getContainer } from "@cloudflare/containers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import manifest from "../symbols/sp500.json";

const LOADER_ID = "cboe-loader-v3";

export class CboeLoaderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  pingEndpoint = "/health";
  enableInternet = true;
  envVars = {
    MAX_SYMBOLS: "503",
    MAX_BATCH_RECORDS: "250",
    HTTP_RETRIES: "3",
    RETRY_BACKOFF_SECONDS: "1",
    WRITE_MODE: "pipeline",
  };
}

function authorized(request, env) {
  const configured = env.LOADER_TOKEN;
  if (!configured) return false;
  return request.headers.get("authorization") === `Bearer ${configured}`;
}

// Headers the container needs to reach the Cloudflare Pipelines ingest
// streams. PIPELINE_*_URL / PIPELINE_AUTH_TOKEN are Wrangler secrets — the
// subdomain of each ingest URL IS the credential, so these must never be
// committed (see SECURITY-AUDIT.md, CRITICAL). Empty values are omitted.
function pipelineHeaders(env) {
  const out = new Headers();
  const map = {
    "x-pipeline-runs-url": env.PIPELINE_RUNS_URL,
    "x-pipeline-contracts-url": env.PIPELINE_CONTRACTS_URL,
    "x-pipeline-underlyings-url": env.PIPELINE_UNDERLYINGS_URL,
    "x-pipeline-errors-url": env.PIPELINE_ERRORS_URL,
    // Forward the Pipeline auth token so the loader attaches
    // `Authorization: Bearer <token>` to every ingest POST. Without this the
    // ingest URLs are unauthenticated write endpoints.
    "x-pipeline-auth-token": env.PIPELINE_AUTH_TOKEN,
  };
  for (const [name, value] of Object.entries(map)) {
    if (value) out.set(name, value);
  }
  return out;
}

// Start a CBOE refresh in the container with an explicit symbol list. Mirrors
// the manual `POST /run` flow used by tools/load_sp500.py.
async function startRefresh(env, symbols) {
  const headers = pipelineHeaders(env);
  headers.set("Content-Type", "application/json");
  const res = await getContainer(env.CBOE_LOADER, LOADER_ID).fetch("/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ symbols }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`refresh run failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

// Scheduled/triggered S&P 500 refresh, run as a durable Cloudflare Workflow so
// a full 503-symbol load is observable and retried by the platform. OFF BY
// DEFAULT: the cron trigger only starts this when the ENABLE_SCHEDULED_REFRESH
// var is "true". A payload may override the symbol list (defaults to the
// committed 503-symbol manifest). Keep this off until the full-refresh
// validation in loader/NEXT_STEPS.md is complete.
export class ScheduledRefreshWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const symbols = Array.isArray(event.payload?.symbols)
      ? event.payload.symbols
      : manifest.symbols;
    const runId = await step.do(
      "start-refresh",
      { retries: { limit: 2, delay: "30 seconds" }, timeout: "12 hours" },
      async () => {
        const body = await startRefresh(this.env, symbols);
        return body?.run?.run_id ?? null;
      }
    );
    return { runId };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/status") {
      return getContainer(env.CBOE_LOADER, LOADER_ID).fetch(request);
    }
    if (url.pathname !== "/run" || request.method !== "POST") {
      return new Response("Not found\n", { status: 404 });
    }
    if (!authorized(request, env)) {
      return new Response("Unauthorized\n", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    const forwarded = new Request(request);
    const headers = pipelineHeaders(env);
    for (const [name, value] of headers) forwarded.headers.set(name, value);
    return getContainer(env.CBOE_LOADER, LOADER_ID).fetch(forwarded);
  },

  // Nightly scheduled refresh. The cron is declared in wrangler.jsonc but the
  // run itself is gated by ENABLE_SCHEDULED_REFRESH so it's inert until you
  // deliberately enable it after full-refresh validation.
  async scheduled(event, env, ctx) {
    if (env.ENABLE_SCHEDULED_REFRESH !== "true") {
      console.log("scheduled refresh disabled (ENABLE_SCHEDULED_REFRESH != true)");
      return;
    }
    ctx.waitUntil(env.SCHEDULED_REFRESH.create({}));
  },
};
