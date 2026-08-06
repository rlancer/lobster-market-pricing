import { Container, getContainer } from "@cloudflare/containers";
import {
  CboeContinuousLoader,
  DRIVER_ID,
  LOADER_ID,
  buildRunRequest,
} from "./continuous-loader.js";

export { CboeContinuousLoader };

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

function driverStub(env) {
  return env.CBOE_CONTINUOUS_LOADER.get(
    env.CBOE_CONTINUOUS_LOADER.idFromName(DRIVER_ID),
  );
}

function loopEnabled(env) {
  return !!(env.CBOE_CONTINUOUS_LOADER && env.CONTINUOUS_LOADER_ENABLED !== "false");
}

// The loop bootstraps itself: the first request to the Worker arms the driver
// DO (one alarm -> next alarm -> ... forever). Arming is idempotent and cheap —
// it does not wake the 10-minute container. We route through the DO's `fetch`
// handler (which calls ensureArmed) rather than a method-RPC so arming is
// guaranteed to take effect.
function armDriver(env, ctx) {
  if (!loopEnabled(env)) return;
  const url = new URL("http://continuous-loader/loop/");
  ctx.waitUntil(
    driverStub(env)
      .fetch(url)
      .then((response) => response.text())
      .catch(() => {})
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Continuous-loader driver routes. /loop/trigger and /loop/arm are
    // write-like and protected by LOADER_TOKEN; /loop/status is read-only.
    if (url.pathname.startsWith("/loop/")) {
      if (!loopEnabled(env)) {
        return new Response("Continuous loader disabled\n", { status: 404 });
      }
      if (
        (url.pathname === "/loop/trigger" || url.pathname === "/loop/arm") &&
        !authorized(request, env)
      ) {
        return new Response("Unauthorized\n", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return driverStub(env).fetch(request);
    }

    if (url.pathname === "/health" || url.pathname === "/status") {
      armDriver(env, ctx);
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
    for (const [name, value] of Object.entries(buildRunRequest([], env).headers)) {
      if (name !== "content-type") forwarded.headers.set(name, value);
    }
    // Keep the existing one-shot /run behavior fully intact and backward
    // compatible, and arm the continuous loop on the way through.
    armDriver(env, ctx);
    return getContainer(env.CBOE_LOADER, LOADER_ID).fetch(forwarded);
  },
};
