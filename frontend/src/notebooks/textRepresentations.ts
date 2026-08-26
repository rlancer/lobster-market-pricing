/**
 * Text context packs for the notebook. `tool_summary` mirrors the AI's
 * worker-side `summarizeResult` shape (period table + stats + samples), which
 * is the baseline we compare against image encodings.
 */

import {
  type SynthUniverse,
  type TickerSeries,
  tickerStats,
  universeStats,
} from './syntheticSeries.ts';

export type TextRepId = 'tool_summary' | 'stats_table' | 'csv_closes';

export interface TextRep {
  id: TextRepId;
  label: string;
  description: string;
  approxTokens: number;
  body: string;
}

function formatRow(columns: string[], row: Record<string, unknown>): string {
  return columns
    .map((c) => {
      const v = row[c];
      if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
      return String(v ?? '');
    })
    .join(' | ');
}

function periodStatsTableLines(universe: SynthUniverse): string[] {
  const stats = universeStats(universe).slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const lines = [
    'Period performance (by ticker; close=close, date=date):',
    'ticker | start | end | total_return_pct | daily_std_pct | max_date | min_date | sharp_drop_date',
    '-------|-------|-----|------------------|---------------|----------|----------|----------------',
  ];
  for (const s of stats) {
    lines.push(
      `${s.ticker} | ${s.startClose.toFixed(2)} | ${s.endClose.toFixed(2)} | `
        + `${s.totalReturnPct.toFixed(2)} | ${s.dailyReturnStdPct.toFixed(2)} | `
        + `${s.maxCloseDate} | ${s.minCloseDate} | ${s.crashDay ?? '—'}`,
    );
  }
  return lines;
}

/** Closest mirror of production AI tool summaries today. */
export function toolSummaryText(universe: SynthUniverse): string {
  const lines: string[] = [
    'DATASET: synthetic_equity_panel',
    `seed=${universe.seed} trading_days=${universe.tradingDays} start=${universe.startDate}`,
    `tickers=${universe.series.map((s) => s.ticker).join(',')}`,
    '',
    ...periodStatsTableLines(universe),
    '',
  ];

  for (const series of universe.series) {
    const stats = tickerStats(series);
    const columns = ['date', 'open', 'high', 'low', 'close', 'volume'];
    const rows = series.bars.map((b) => ({ ...b }));
    const meanClose = rows.reduce((a, r) => a + r.close, 0) / rows.length;
    lines.push(`=== ${series.ticker} (${series.name}, ${series.sector}) ===`);
    lines.push(`Columns: ${columns.join(', ')}`);
    lines.push(`Row count: ${rows.length}`);
    lines.push('---');
    lines.push('Stats:');
    lines.push(
      `  close: count=${rows.length} nulls=0 min=${stats.minClose.toFixed(2)} `
        + `max=${stats.maxClose.toFixed(2)} mean=${meanClose.toFixed(2)}`,
    );
    lines.push(
      `  total_return_pct=${stats.totalReturnPct.toFixed(2)} `
        + `daily_return_std_pct=${stats.dailyReturnStdPct.toFixed(3)}`,
    );
    lines.push(
      `  max_close_date=${stats.maxCloseDate} min_close_date=${stats.minCloseDate}`
        + (stats.crashDay ? ` sharp_drop_date=${stats.crashDay}` : ''),
    );
    lines.push('---');
    lines.push('Sample:');
    lines.push('head (8):');
    for (const row of rows.slice(0, 8)) lines.push(formatRow(columns, row));
    lines.push('mid (4):');
    const mid = Math.max(0, Math.floor(rows.length / 2) - 2);
    for (const row of rows.slice(mid, mid + 4)) lines.push(formatRow(columns, row));
    lines.push('tail (8):');
    for (const row of rows.slice(-8)) lines.push(formatRow(columns, row));
    lines.push('');
  }
  return lines.join('\n');
}

export function statsTableText(universe: SynthUniverse): string {
  const stats = universeStats(universe).slice().sort((a, b) => b.totalReturnPct - a.totalReturnPct);
  const lines = [
    'SYNTHETIC PANEL — PERIOD PERFORMANCE',
    `seed=${universe.seed} days=${universe.tradingDays} start=${universe.startDate}`,
    '',
    'ticker | sector | start | end | total_return_pct | daily_std_pct | max_date | min_date | sharp_drop_date',
    '-------|--------|-------|-----|------------------|---------------|----------|----------|----------------',
  ];
  for (const s of stats) {
    lines.push(
      `${s.ticker} | ${s.sector} | ${s.startClose.toFixed(2)} | ${s.endClose.toFixed(2)} | `
        + `${s.totalReturnPct.toFixed(2)} | ${s.dailyReturnStdPct.toFixed(3)} | ${s.maxCloseDate} | `
        + `${s.minCloseDate} | ${s.crashDay ?? '—'}`,
    );
  }
  return lines.join('\n');
}

export function csvClosesText(universe: SynthUniverse): string {
  const tickers = universe.series.map((s) => s.ticker);
  const dates = universe.series[0]!.bars.map((b) => b.date);
  const byTicker = new Map<string, TickerSeries>();
  for (const s of universe.series) byTicker.set(s.ticker, s);

  const lines = [`date,${tickers.join(',')}`];
  for (let i = 0; i < dates.length; i++) {
    const cells = [dates[i]!];
    for (const t of tickers) cells.push(byTicker.get(t)!.bars[i]!.close.toFixed(2));
    lines.push(cells.join(','));
  }
  return lines.join('\n');
}

export function buildTextRepresentations(universe: SynthUniverse): TextRep[] {
  const specs: Omit<TextRep, 'approxTokens'>[] = [
    {
      id: 'tool_summary',
      label: 'Tool summary (current AI style)',
      description:
        'Per-ticker column stats plus head/mid/tail samples — the production summarizeResult shape, densified for the wide panel.',
      body: toolSummaryText(universe),
    },
    {
      id: 'stats_table',
      label: 'Period stats table',
      description: 'One row per ticker with total return, volatility, and extrema dates.',
      body: statsTableText(universe),
    },
    {
      id: 'csv_closes',
      label: 'Full closes CSV',
      description: 'Wide date×ticker close matrix. Faithful but expensive in tokens.',
      body: csvClosesText(universe),
    },
  ];
  return specs.map((s) => ({ ...s, approxTokens: Math.ceil(s.body.length / 4) }));
}
