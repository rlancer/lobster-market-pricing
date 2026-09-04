# Cloud Agent base image for the lobster-market-pricing monorepo.
#
# Pin Node to the repo's mise.toml version (24.12.0), which is also the current
# Node.js Active LTS line. The full (non-slim) Debian Bookworm image already
# ships git + curl + build tooling; we only add Python 3 for the loader's
# helper scripts (loader/tools/*.py). Repository dependencies are installed by
# the `install` phase in environment.json, not here, so the image stays cache-
# friendly and branch-agnostic.
FROM node:24.12.0-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

USER node
