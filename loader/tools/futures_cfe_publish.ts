// One-shot CFE publish for CI provisioning. Reads PIPELINE_FUTURES_*_URL +
// PIPELINE_AUTH_TOKEN from the environment (never logs them) and runs both
// settlements + quotes passes through src/futures.ts.
import {
  CFE_PASS_QUOTES,
  CFE_PASS_SETTLEMENTS,
  publishCfePass,
} from "../src/futures.ts";

const settlementsUrl = process.env.PIPELINE_FUTURES_SETTLEMENTS_URL || "";
const quotesUrl = process.env.PIPELINE_FUTURES_QUOTES_URL || "";
const auth = process.env.PIPELINE_AUTH_TOKEN || "";

if (!settlementsUrl && !quotesUrl) {
  console.error("need PIPELINE_FUTURES_SETTLEMENTS_URL and/or PIPELINE_FUTURES_QUOTES_URL");
  process.exit(1);
}
if (!auth) {
  console.error("need PIPELINE_AUTH_TOKEN");
  process.exit(1);
}

const env = {
  PIPELINE_FUTURES_SETTLEMENTS_URL: settlementsUrl,
  PIPELINE_FUTURES_QUOTES_URL: quotesUrl,
  PIPELINE_AUTH_TOKEN: auth,
  HTTP_RETRIES: 2,
  runId: () => `ci-cfe-${Date.now()}`,
};

if (settlementsUrl) {
  const r = await publishCfePass(CFE_PASS_SETTLEMENTS, env);
  console.log(JSON.stringify({ pass: r.pass, row_count: r.row_count, published: r.published, run_id: r.run_id }));
}
if (quotesUrl) {
  const r = await publishCfePass(CFE_PASS_QUOTES, env);
  console.log(JSON.stringify({ pass: r.pass, row_count: r.row_count, published: r.published, run_id: r.run_id }));
}
