import assert from "node:assert/strict";
import test from "node:test";
import {
  maskAccountNumber,
  normalizeSchwabAccounts,
  SCHWAB_TRADER_BASE,
  fetchSchwabAccountsRaw,
  SchwabApiError,
} from "../src/schwab-portfolio.ts";

test("maskAccountNumber keeps last four digits", () => {
  assert.equal(maskAccountNumber("12345678"), "••••5678");
  assert.equal(maskAccountNumber("***1234"), "••••1234");
  assert.equal(maskAccountNumber(""), "Account");
});

test("normalizeSchwabAccounts maps securitiesAccount envelope", () => {
  const view = normalizeSchwabAccounts(
    [
      {
        securitiesAccount: {
          type: "MARGIN",
          accountNumber: "9876543210",
          currentBalances: {
            cashBalance: 1_250.5,
            liquidationValue: 50_000,
            buyingPower: 10_000,
          },
          positions: [
            {
              longQuantity: 10,
              shortQuantity: 0,
              averagePrice: 100,
              marketValue: 1_050,
              currentDayProfitLoss: 12.5,
              longOpenProfitLoss: 50,
              instrument: {
                symbol: "AAPL",
                assetType: "EQUITY",
                description: "APPLE INC",
              },
            },
            {
              longQuantity: 0,
              shortQuantity: 2,
              averagePrice: 3.5,
              marketValue: -700,
              currentDayProfitLoss: -20,
              shortOpenProfitLoss: -40,
              instrument: {
                symbol: "AAPL  250117C00200000",
                underlyingSymbol: "AAPL",
                assetType: "OPTION",
                description: "AAPL Jan 17 2025 200 Call",
              },
            },
          ],
        },
      },
    ],
    1_700_000_000_000,
  );

  assert.equal(view.connected, true);
  assert.equal(view.fetched_at, new Date(1_700_000_000_000).toISOString());
  assert.equal(view.accounts.length, 1);
  const acct = view.accounts[0]!;
  assert.equal(acct.account_number_masked, "••••3210");
  assert.equal(acct.type, "MARGIN");
  assert.equal(acct.cash, 1_250.5);
  assert.equal(acct.equity, 50_000);
  assert.equal(acct.buying_power, 10_000);
  assert.equal(acct.positions.length, 2);
  assert.equal(acct.positions[0]!.symbol, "AAPL");
  assert.equal(acct.positions[0]!.quantity, 10);
  assert.equal(acct.positions[0]!.open_pnl, 50);
  assert.equal(acct.positions[1]!.quantity, -2);
  assert.equal(acct.positions[1]!.open_pnl, -40);
  assert.equal(view.totals.position_count, 2);
  assert.equal(view.totals.day_pnl, -7.5);
  assert.equal(view.totals.open_pnl, 10);
  // Never leak raw account numbers into ids beyond masked digits.
  assert.ok(!JSON.stringify(view).includes("9876543210"));
});

test("fetchSchwabAccountsRaw requests positions and auth header", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("Authorization") });
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  await fetchSchwabAccountsRaw("tok-1", "Bearer", fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${SCHWAB_TRADER_BASE}/accounts?fields=positions`);
  assert.equal(calls[0]!.auth, "Bearer tok-1");
});

test("fetchSchwabAccountsRaw throws SchwabApiError on failure", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("nope", { status: 401 });
  await assert.rejects(
    () => fetchSchwabAccountsRaw("bad", "Bearer", fetchImpl),
    (err: unknown) => err instanceof SchwabApiError && err.status === 401,
  );
});
