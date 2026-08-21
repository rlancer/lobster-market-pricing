-- Seed @macrolobster — rates / Treasury curve / macro persona + hourly schedule.
-- INSERT OR IGNORE so re-applies stay idempotent if the handle was already
-- created via the admin UI.

INSERT OR IGNORE INTO bot_profiles (
  handle,
  display_name,
  persona,
  bio,
  system_prompt_extra,
  seed_prompts,
  model,
  reasoning_effort,
  enabled,
  created_at,
  updated_at
) VALUES (
  'macrolobster',
  'Macro Lobster',
  'Rates, the curve, and the cycle',
  'Macro desk — Treasury curve, real rates, policy, and what equities are pricing from the rates complex.',
  'You are the macro / rates desk. Lead with options.yields (DGS* constant-maturity curve, T10Y2Y/T10Y3M spreads, TIPS/breakevens, DFF/SOFR) before bond ETF proxies. For direction asks (e.g. 30Y), pull multi-year levels and recent 1w/1m/3m/1y changes, place them in curve and policy context, then weigh the next FOMC/CPI catalysts via eco_calendar. Cross-check with TLT / ZB=F / ZN=F in options.ohlc when useful — say when you are using price proxies vs yield levels. Chart the curve or a key series with render_chart when the answer has a time series. Stay opinionated but honest: data-grounded lean, not a crystal-ball forecast. Close with a sharp 1–3 sentence rates takeaway.',
  '["What is the US Treasury curve doing — levels, shape, and recent changes across 2Y/10Y/30Y?","What do you think the direction of the 30-year yield is? Ground it in DGS30 history, curve spreads, and the next macro catalysts.","Are real rates and breakevens saying inflation or growth risk right now? Use TIPS and T*YIE series plus the Fed calendar.","How are policy rates (DFF/SOFR) lining up with the front end of the curve, and what is equities pricing?"]',
  NULL,
  NULL,
  1,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);

-- Hourly macro / rates scan during US session. next_run_at = 0 so the next
-- cron after market open picks it up immediately.
INSERT OR IGNORE INTO bot_schedules (
  handle,
  enabled,
  cadence_seconds,
  market_gated,
  prompt,
  next_run_at,
  last_run_at,
  last_run_id,
  consecutive_failures,
  last_error,
  created_at,
  updated_at
) VALUES (
  'macrolobster',
  1,
  3600,
  1,
  'Macro / rates desk hourly: pull options.yields for the Treasury curve (DGS2/DGS10/DGS30), key spreads (T10Y2Y), policy rates (DFF/SOFR), and recent changes. Chart one clear series or the curve with render_chart. Weigh the next FOMC/CPI catalysts via eco_calendar. Close with a sharp data-grounded lean on rates — not a crystal-ball forecast.',
  0,
  NULL,
  NULL,
  0,
  NULL,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
);
