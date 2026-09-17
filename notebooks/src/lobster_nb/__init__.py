"""Helpers for marimo notebooks that talk to the options lake and Kalshi."""

from lobster_nb.env import load_repo_env, repo_root, secret_presence
from lobster_nb.kalshi import (
    auth_configured,
    auth_headers,
    cache_live_tape,
    get_json,
    load_cached_candles,
    load_cached_live_tape,
    ping,
    pull_open_two_leg_sports,
)
from lobster_nb.lake import attach_lake, connect, r2_sql
from lobster_nb.parlay import PRODUCTION_KNOBS, ParlayKnobs, self_check
from lobster_nb.parlay_backtest import (
    backtest_parlay_books,
    coverage_over_time,
    hydrate_settlements,
    lake_score_table,
    load_lake_sports_tape,
    load_lake_tape,
    perturbation_table,
    record_strategy_runs,
    score_live_combos,
    tape_self_check,
)

__all__ = [
    "PRODUCTION_KNOBS",
    "ParlayKnobs",
    "attach_lake",
    "auth_configured",
    "auth_headers",
    "backtest_parlay_books",
    "cache_live_tape",
    "connect",
    "coverage_over_time",
    "get_json",
    "hydrate_settlements",
    "lake_score_table",
    "load_cached_candles",
    "load_cached_live_tape",
    "load_lake_sports_tape",
    "load_lake_tape",
    "load_repo_env",
    "perturbation_table",
    "ping",
    "pull_open_two_leg_sports",
    "record_strategy_runs",
    "repo_root",
    "score_live_combos",
    "secret_presence",
    "self_check",
    "tape_self_check",
    "r2_sql",
]
