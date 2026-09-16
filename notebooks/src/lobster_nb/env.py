"""Repo-root .env loading for notebooks. Never log secret values."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

_SECRET_NAMES = (
    "R2_DATA_CATALOG_TOKEN",
    "R2_SQL_TOKEN",
    "WRANGLER_R2_SQL_AUTH_TOKEN",
    "KALSHI_ACCESS_KEY_ID",
    "KALSHI_PRIVATE_KEY_PEM",
    "KALSHI_PRIVATE_KEY_FILE",
)


def repo_root() -> Path:
    # notebooks/src/lobster_nb/env.py → repo root
    return Path(__file__).resolve().parents[3]


def load_repo_env() -> Path:
    """Load root `.env` if present. Existing process env (mise task) wins."""
    path = repo_root() / ".env"
    if path.is_file():
        load_dotenv(path, override=False)
    return path


def secret_presence(names: tuple[str, ...] = _SECRET_NAMES) -> dict[str, bool]:
    """Booleans only — never return secret values."""
    load_repo_env()
    out: dict[str, bool] = {}
    for name in names:
        raw = os.environ.get(name, "")
        out[name] = bool(raw.strip())
    return out
