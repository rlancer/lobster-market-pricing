"""Helpers for marimo notebooks that talk to the options lake and Kalshi."""

from lobster_nb.env import load_repo_env, repo_root, secret_presence
from lobster_nb.kalshi import auth_configured, auth_headers, ping
from lobster_nb.lake import attach_lake, connect, r2_sql

__all__ = [
    "attach_lake",
    "auth_configured",
    "auth_headers",
    "connect",
    "load_repo_env",
    "ping",
    "r2_sql",
    "repo_root",
    "secret_presence",
]
