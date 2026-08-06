"""Load the S&P manifest in resumable request groups.

Each group is an independent refresh run. The state file records completed groups;
rerunning with --resume skips only runs that returned a complete status.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import tempfile
import urllib.error
import urllib.request


DEFAULT_URL = "https://cboe-to-r2.robertlancer.workers.dev/run"
DEFAULT_MANIFEST = pathlib.Path("symbols/sp500.json")
DEFAULT_STATE = pathlib.Path(".sp500-symbol-load-state.json")


def post(url: str, token: str, symbols: list[str], pipeline_urls: dict[str, str]) -> dict:
    body = json.dumps({"symbols": symbols}).encode()
    headers = {"authorization": f"Bearer {token}", "content-type": "application/json"}
    headers.update({key: value for key, value in pipeline_urls.items() if value})
    request = urllib.request.Request(
        url,
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=3600) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        try:
            return json.loads(detail)
        except json.JSONDecodeError:
            raise RuntimeError(f"HTTP {error.code}: {detail}") from error


def save(path: pathlib.Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--state", type=pathlib.Path, default=DEFAULT_STATE)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--pipeline-runs-url", default=os.environ.get("PIPELINE_RUNS_URL", ""))
    parser.add_argument("--pipeline-contracts-url", default=os.environ.get("PIPELINE_CONTRACTS_URL", ""))
    parser.add_argument("--pipeline-underlyings-url", default=os.environ.get("PIPELINE_UNDERLYINGS_URL", ""))
    parser.add_argument("--pipeline-errors-url", default=os.environ.get("PIPELINE_ERRORS_URL", ""))
    parser.add_argument("--continue-on-failure", action="store_true")
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("--batch-size must be positive")
    token = os.environ.get("LOADER_TOKEN", "local-loader")
    pipeline_urls = {
        "x-pipeline-runs-url": args.pipeline_runs_url,
        "x-pipeline-contracts-url": args.pipeline_contracts_url,
        "x-pipeline-underlyings-url": args.pipeline_underlyings_url,
        "x-pipeline-errors-url": args.pipeline_errors_url,
    }

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    symbols = manifest["symbols"]
    groups = [symbols[i : i + args.batch_size] for i in range(0, len(symbols), args.batch_size)]
    state = json.loads(args.state.read_text(encoding="utf-8")) if args.resume and args.state.exists() else {
        "version": 1, "batch_size": args.batch_size, "manifest_count": len(symbols), "groups": {}
    }
    if args.resume and (state.get("batch_size") != args.batch_size or state.get("manifest_count") != len(symbols)):
        parser.error("checkpoint manifest or batch size does not match; use the original settings")
    state.setdefault("groups", {})
    for index, group in enumerate(groups):
        key = str(index)
        previous = state["groups"].get(key)
        if args.resume and previous and previous.get("status") == "complete":
            print(json.dumps({"event": "group_skipped", "group": index, "run_id": previous.get("run_id")}))
            continue
        print(json.dumps({"event": "group_started", "group": index, "symbols": len(group)}), flush=True)
        result = post(args.url, token, group, pipeline_urls)
        run = result.get("run", {})
        state["groups"][key] = {
            "symbols": group,
            "run_id": run.get("run_id"),
            "status": run.get("status", "failed"),
            "successful_symbols": run.get("successful_symbols", 0),
            "failed_symbols": run.get("failed_symbols", 0),
            "contract_count": run.get("contract_count", 0),
            "failures": result.get("failures", []),
        }
        save(args.state, state)
        print(json.dumps({"event": "group_finished", "group": index, **state["groups"][key]}), flush=True)
        if run.get("status") != "complete":
            print("Group failed; state saved. Re-run with --resume after fixing the error.", flush=True)
            if not args.continue_on_failure:
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
