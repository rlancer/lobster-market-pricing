import { Container, getContainer } from "@cloudflare/containers";

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
    const endpointHeaders = {
      "x-pipeline-runs-url": env.PIPELINE_RUNS_URL,
      "x-pipeline-contracts-url": env.PIPELINE_CONTRACTS_URL,
      "x-pipeline-underlyings-url": env.PIPELINE_UNDERLYINGS_URL,
      "x-pipeline-errors-url": env.PIPELINE_ERRORS_URL,
    };
    for (const [name, value] of Object.entries(endpointHeaders)) {
      if (value) forwarded.headers.set(name, value);
    }
    return getContainer(env.CBOE_LOADER, LOADER_ID).fetch(forwarded);
  },
};
