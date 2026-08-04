# Task: Calculate option Greeks with Black-Scholes and backfill DuckDB

## Goal
The S&P 500 options screener at `~/Desktop/screener_glm52` currently stores
Greeks (`delta`, `gamma`, `theta`, `vega`, `rho`) as returned by Yahoo Finance,
which are often `NULL` for short-dated or illiquid contracts. Compute these
Greeks yourself from the Black-Scholes model using data already in the DuckDB
database and write them back into the `option_contracts` table.

## Project context
- Storage: single embedded DuckDB file at `data/options.duckdb`
- Schema lives in `backend/screener/db.py`. The relevant table:

  ```sql
  CREATE TABLE option_contracts (
      symbol            VARCHAR,
      expiration        DATE,
      type              VARCHAR,       -- 'call' | 'put'
      strike            DOUBLE,
      last              DOUBLE,
      bid               DOUBLE,
      ask               DOUBLE,
      volume            BIGINT,
      open_interest     BIGINT,
      implied_vol       DOUBLE,        -- annualized, e.g. 0.32
      delta             DOUBLE,
      gamma             DOUBLE,
      theta             DOUBLE,
      vega              DOUBLE,
      rho               DOUBLE,
      in_the_money      BOOLEAN,
      fetched_at        TIMESTAMP
  );
  CREATE TABLE underlyings (
      symbol            VARCHAR,
      name              VARCHAR,
      sector            VARCHAR,
      spot              DOUBLE,        -- underlying spot price S
      fetched_at        TIMESTAMP
  );
  ```

- The backend is a Python `uv` project under `backend/`. Run Python via
  `cd backend && uv run python ...` (this uses the project venv; bare `python`
  hits the Windows Store stub). `duckdb` is already a dependency.
- Tool versions are pinned in `mise.toml` (Python 3.12). `mise` is available.

## What to build
Create `backend/screener/greeks.py` that:

1. Connects to the DuckDB (use `from screener.db import connect`).
2. Pulls every `option_contracts` row joined to `underlyings` to get:
   - `S` = spot, `K` = strike, `T` = time to expiry in years,
     `sigma` = `implied_vol`, `type` = call/put.
   - Compute `T = (expiration - today).days / 365.25`. Use `datetime.date.today()`.
     Skip rows where `T <= 0` (expired) or where `sigma`/`S`/`K` is NULL or <= 0.
   - Use a risk-free rate `r`. Fetch the current yield: prefer the 3-month or
     1-year US Treasury yield. Simplest robust option: hard-code a sensible
     constant (e.g. `r = 0.043`) but expose it as a CLI flag `--rate` defaulting
     to that. If you want to be fancier, you may fetch it from `yfinance`'s
     `^IRX` (13-week) or `^TNX` (10-year) as a one-off, but the constant is fine
     and must remain overridable via `--rate`.
   - Assume zero dividends (`q = 0`) for the BS formula, but note it in a
     comment and in the `--help` text.
3. Computes Black-Scholes Greeks per row. Use a numerically stable
   implementation (standard CDF via `math.erf`):

   ```
   d1 = (ln(S/K) + (r + sigma^2/2)*T) / (sigma*sqrt(T))
   d2 = d1 - sigma*sqrt(T)
   # present-value factors
   disc = exp(-r*T)
   # call
   delta_call = N(d1)
   gamma_call = N'(d1) / (S*sigma*sqrt(T))
   vega_call  = S * N'(d1) * sqrt(T)          # per 1.0 vol; divide by 100 for per-1%-vol if desired
   theta_call = -(S*N'(d1)*sigma)/(2*sqrt(T)) - r*K*disc*N(d2)   # per year
   rho_call   =  K*T*disc*N(d2)
   # put (use put-call parity relations)
   delta_put = delta_call - 1
   gamma_put = gamma_call
   vega_put  = vega_call
   theta_put = theta_call + r*K*disc                          # = -(S*N'(d1)*sigma)/(2*sqrt(T)) + r*K*disc*N(-d2)
   rho_put   = -K*T*disc*N(-d2)
   ```
   Where `N(x)` is the standard normal CDF and `N'(x) = exp(-x^2/2)/sqrt(2*pi)`.

   Units/conventions to match Yahoo so the UI stays consistent:
   - `delta`, `gamma`, `vega`, `rho` as above.
   - `theta` is **per calendar day**: divide the annual theta by 365.
   - `vega` is per **1.00 (100%)** change in volatility (do NOT divide by 100);
     i.e. the formula value above is what you store.
   - `rho` is per **1.00 (100%)** change in rate (do NOT divide by 100).

4. Writes the computed values back with an `UPDATE` keyed on
   `(symbol, expiration, type, strike)` (that tuple is unique per contract).
   Do this in batches (e.g. `executemany` of parameterized UPDATEs, or build a
   temp table and `UPDATE FROM`). Parameterize — never f-string user/symbol
   values, though here all values are numeric/ours.

5. Provides a CLI under `backend/screener/greeks.py`:
   - `--rate R`  risk-free rate (default 0.043)
   - `--only SYMBOL [SYMBOL...]`  limit to symbols
   - `--null-only`  only backfill rows where the greeks are currently NULL
     (default: recompute ALL rows so values are consistent/corrected)
   - `--dry-run`  compute and print a sample (first ~20 rows) but do not write
   - `--limit N`  process only N contracts (debug)

   Make it runnable as `cd backend && uv run python -m screener.greeks ...`.

6. Prints a summary at the end:
   - rows considered, rows skipped (and why: expired/missing inputs),
     rows updated
   - the `--rate` used
   - a before/after count of NULL greeks in `option_contracts`.

## Add a mise task
Add a `[tasks.greeks]` entry to `mise.toml` mirroring the existing tasks, e.g.:

```toml
[tasks.greeks]
description = "Recompute Black-Scholes Greeks in DuckDB. e.g. mise run greeks -- --rate 0.043"
run = "cd backend && uv run python -m screener.greeks"
```

(Recall mise tasks pass extra args after `--`, so `mise run greeks -- --dry-run`
becomes `uv run python -m screener.greeks --dry-run`.)

## Quality bar
- Pure-Python, no new dependencies (`math` only). Do NOT `pip install` anything.
- No external API calls required (the `--rate` constant is fine).
- Idempotent: running twice produces the same result.
- Don't touch `download.py` or the download flow.
- Keep the DuckDB connection in read/write mode (the default `connect()`).

## Definition of done
1. `backend/screener/greeks.py` exists and `cd backend && uv run python -m screener.greeks --dry-run --limit 20` prints a sane sample table (symbol/exp/type/strike/IV + the 5 computed greeks) without error.
2. `mise run greeks -- --dry-run` works.
3. A real run (`mise run greeks`) reduces NULL greeks in `option_contracts` to
   ~0 (only rows with missing IV/spot/strike or expired remain NULL). Verify with:
   `cd backend && uv run python -c "import duckdb; c=duckdb.connect('../data/options.duckdb'); print(c.execute('SELECT COUNT(*) total, SUM(CASE WHEN delta IS NULL THEN 1 ELSE 0 END) null_delta FROM option_contracts').fetchone())"`
4. Spot-check: pick one NVDA call, hand-compute delta with the same
   S/K/T/sigma/r and confirm it matches the stored value to ~3 decimals.
5. Update `README.md` with a short "Recomputing Greeks" subsection under Notes.

## Verification hint
You have a browser skill (webwright) and a running app
(`mise run backend` + `mise run frontend`). After backfilling, you can open the
NVDA chain view and confirm the Δ/Γ/Θ/ν columns are populated where they were
previously `–`.
