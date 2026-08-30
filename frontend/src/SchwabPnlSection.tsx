import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Button,
  HStack,
  Spinner,
  Tab,
  TabList,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import {
  api,
  type OhlcBar,
  type SchwabDistribution,
  type SchwabPnlFill,
  type SchwabPnlPoint,
  type SchwabPnlRange,
  type SchwabPnlResponse,
  type SchwabPortfolioPosition,
  type SchwabTrade,
} from './api';
import { formatChartTick } from './tickerChartRange';
import {
  applyEquityMarkPath,
  applyOptionMarkPath,
  buildActivityRows,
  composeSeries,
  composeTotals,
  DEFAULT_PNL_INCLUDE,
  densifyWithOhlc,
  equityOpenLot,
  filterActivity,
  includedOpenMark,
  optionLegDailyPath,
  optionLotsFromFills,
  parseOccContract,
  tickerOpenMark,
  type ActivityRow,
  type LegDailyPoint,
  type OptionLot,
  type PnlInclude,
} from './schwabPnlView';
import './Portfolio.css';

const PNL_RANGES: SchwabPnlRange[] = ['MTD', 'YTD', '1M', '3M', '6M', '1Y'];

type ActivityTableRow = ActivityRow & Record<string, unknown>;

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function moneySigned(n: number): string {
  const abs = money(Math.abs(n));
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return abs;
}

function qty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function pnlTone(n: number | null | undefined): 'green' | 'red' | 'gray' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gray';
  return n > 0 ? 'green' : 'red';
}

function sideTone(side: ActivityRow['side']): 'green' | 'red' | 'gray' {
  if (side === 'buy') return 'green';
  if (side === 'sell') return 'red';
  return 'gray';
}

function kindTone(kind: ActivityRow['kind']): 'green' | 'orange' | 'gray' {
  if (kind === 'stock') return 'gray';
  if (kind === 'option') return 'orange';
  return 'green';
}

function kindLabel(row: ActivityRow): string {
  if (row.kind === 'stock') return 'Stock';
  if (row.kind === 'option') {
    if (row.option_right === 'put') return 'Put';
    if (row.option_right === 'call') return 'Call';
    return 'Option';
  }
  return 'Div';
}

function strikeLabel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    maximumFractionDigits: 3,
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
  });
}

function formatApiError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err);
  const m = /^API (\d+): (.+)$/s.exec(raw);
  if (!m) return raw;
  const status = m[1]!;
  const body = m[2]!;
  try {
    const j = JSON.parse(body) as { error?: string; detail?: string };
    if (j.detail) return `${j.error ?? `HTTP ${status}`}: ${j.detail}`;
    if (j.error) return j.error;
  } catch {
    /* keep raw */
  }
  return raw.length > 280 ? `${raw.slice(0, 280)}…` : raw;
}

function markerColor(kind: ActivityRow['kind']): string {
  if (kind === 'option') return 'var(--color-warning, var(--accent))';
  if (kind === 'dividend') return 'var(--color-success)';
  return 'var(--accent)';
}

function activityFillId(row: ActivityRow): string | null {
  if (row.id.startsWith('fill-')) return row.id.slice('fill-'.length);
  if (row.id.startsWith('trade-')) return row.id.slice('trade-'.length);
  return null;
}

function legLabel(lot: OptionLot): string {
  const occ = parseOccContract(lot.symbol);
  const side = lot.quantity < 0 ? 'Short' : 'Long';
  const qtyAbs = Math.abs(lot.quantity);
  if (!occ) return `${side} ${qtyAbs} · ${lot.symbol}`;
  const right = occ.right === 'P' ? 'Put' : 'Call';
  return `${side} ${qtyAbs} ${occ.root} ${strikeLabel(occ.strike)} ${right}`;
}

function markSourceLabel(source: LegDailyPoint['source']): string {
  if (source === 'schwab') return 'Schwab option';
  if (source === 'intrinsic') return 'Schwab intrinsic';
  return 'Linear fill→exit';
}

type LegDailyTableRow = LegDailyPoint & Record<string, unknown>;

/**
 * Realized trading PnL curve for a linked Schwab account.
 * Ticker scopes equity + options on the same root (CAR stock and CAR puts).
 */
export function SchwabPnlSection({
  accountId,
  initialSymbol = '',
  positions = [],
}: {
  accountId: string | null;
  /** Root ticker from a position click (`CAR`, not the OCC symbol). */
  initialSymbol?: string;
  positions?: SchwabPortfolioPosition[];
}) {
  const [range, setRange] = useState<SchwabPnlRange>('YTD');
  const [symbolDraft, setSymbolDraft] = useState(initialSymbol);
  const [symbol, setSymbol] = useState(initialSymbol.trim().toUpperCase());
  const [include, setInclude] = useState<PnlInclude>(DEFAULT_PNL_INCLUDE);
  const [points, setPoints] = useState<SchwabPnlPoint[]>([]);
  const [summary, setSummary] = useState<SchwabPnlResponse['summary'] | null>(null);
  const [fills, setFills] = useState<SchwabPnlFill[]>([]);
  const [distributions, setDistributions] = useState<SchwabDistribution[]>([]);
  const [trades, setTrades] = useState<SchwabTrade[]>([]);
  const [openMarkFromApi, setOpenMarkFromApi] = useState<
    SchwabPnlResponse['open_mark']
  >(null);
  const [ohlc, setOhlc] = useState<OhlcBar[]>([]);
  const [optionOhlc, setOptionOhlc] = useState<Record<string, OhlcBar[]>>({});
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [windowEnd, setWindowEnd] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
  const [lookbackTruncated, setLookbackTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Activity-row expand: which option fill id's daily mark path is open. */
  const [expandedLegId, setExpandedLegId] = useState<string | null>(null);

  useEffect(() => {
    const next = initialSymbol.trim().toUpperCase();
    setSymbolDraft(next);
    setSymbol(next);
  }, [initialSymbol]);

  const applySymbol = useCallback((raw: string) => {
    setSymbol(raw.trim().toUpperCase());
  }, []);

  const load = useCallback(async (
    nextRange: SchwabPnlRange,
    nextAccount: string | null,
    nextSymbol: string,
  ) => {
    setLoading(true);
    setError(null);
    setOhlc([]);
    setOptionOhlc({});
    try {
      const res = await api.schwabPnl({
        range: nextRange,
        account: nextAccount ?? undefined,
        symbol: nextSymbol.trim() || undefined,
      });
      setPoints(res.points);
      setSummary(res.summary);
      setFills(Array.isArray(res.fills) ? res.fills : []);
      setDistributions(Array.isArray(res.distributions) ? res.distributions : []);
      setTrades(Array.isArray(res.trades) ? res.trades : []);
      setOpenMarkFromApi(res.open_mark ?? null);
      setWindowStart(res.start);
      setWindowEnd(res.end);
      setWindowLabel(`${res.start} → ${res.end}`);
      setLookbackTruncated(Boolean(res.lookback_truncated));
      setMayBeTruncated(Boolean(res.may_be_truncated) && !res.lookback_truncated);
      const schwabBars = Array.isArray(res.ohlc) ? res.ohlc : [];
      setOptionOhlc(res.option_ohlc && typeof res.option_ohlc === 'object' ? res.option_ohlc : {});
      // Portfolio marks are Schwab-only (see AGENTS.md). Do not fall back to
      // lake/Yahoo — it often has no bars for the hold (CAR Apr 2026).
      setOhlc(schwabBars);
    } catch (err) {
      setError(formatApiError(err));
      setPoints([]);
      setSummary(null);
      setFills([]);
      setDistributions([]);
      setTrades([]);
      setOpenMarkFromApi(null);
      setOhlc([]);
      setOptionOhlc({});
      setWindowStart(null);
      setWindowEnd(null);
      setWindowLabel(null);
      setLookbackTruncated(false);
      setMayBeTruncated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, accountId, symbol);
  }, [accountId, range, symbol, load]);

  const openMark = useMemo(() => {
    if (!symbol) return null;
    if (openMarkFromApi && openMarkFromApi.count > 0) return openMarkFromApi;
    return tickerOpenMark(positions, symbol);
  }, [openMarkFromApi, positions, symbol]);

  const lot = useMemo(
    () => equityOpenLot(positions, trades, symbol),
    [positions, trades, symbol],
  );
  const optionLots = useMemo(
    () => optionLotsFromFills(fills, positions),
    [fills, positions],
  );

  const legDailyById = useMemo(() => {
    const start = windowStart ?? '';
    const end = windowEnd ?? '';
    const map = new Map<string, LegDailyPoint[]>();
    if (!start || !end) return map;
    for (const lot of optionLots) {
      const path = optionLegDailyPath(lot, optionOhlc, start, end, ohlc);
      if (path.length > 0) map.set(lot.id, path);
    }
    return map;
  }, [optionLots, optionOhlc, ohlc, windowStart, windowEnd]);

  useEffect(() => {
    setExpandedLegId(null);
  }, [symbol, range, accountId]);

  const marked = useMemo(() => {
    const start = windowStart ?? '';
    const end = windowEnd ?? '';
    const dense = densifyWithOhlc(points, ohlc, start, end);
    const equity = applyEquityMarkPath(dense, ohlc, lot, start, end);
    const option = applyOptionMarkPath(
      equity.points,
      optionOhlc,
      optionLots,
      start,
      end,
      ohlc,
    );
    return {
      points: option.points,
      equityPainted: equity.painted,
      optionPainted: option.painted,
      equityInWindow: equity.inWindowMtm,
      optionInWindow: option.inWindowMtm,
      optionClosedPnl: option.closedPnl,
    };
  }, [points, ohlc, optionOhlc, lot, optionLots, windowStart, windowEnd]);

  const markForTotals = useMemo(() => {
    if (!openMark) return null;
    return {
      equity_pnl: marked.equityPainted
        ? openMark.equity_pnl - marked.equityInWindow
        : openMark.equity_pnl,
      option_pnl: marked.optionPainted
        ? openMark.option_pnl - (marked.optionInWindow - marked.optionClosedPnl)
        : openMark.option_pnl,
    };
  }, [openMark, marked]);

  const startCumulative = useMemo(() => {
    let start = 0;
    if (marked.equityPainted && include.stocks) {
      start += (openMark?.equity_pnl ?? 0) - marked.equityInWindow;
    }
    if (marked.optionPainted && include.options) {
      start += (openMark?.option_pnl ?? 0) - (marked.optionInWindow - marked.optionClosedPnl);
    }
    return start;
  }, [marked, include.stocks, include.options, openMark]);

  const lastPointPnl = useMemo(() => {
    if (marked.equityPainted || marked.optionPainted) {
      const equity = marked.equityPainted || !include.stocks ? 0 : (openMark?.equity_pnl ?? 0);
      const option = marked.optionPainted || !include.options ? 0 : (openMark?.option_pnl ?? 0);
      return equity + option;
    }
    return includedOpenMark(openMark, include);
  }, [marked.equityPainted, marked.optionPainted, include, openMark]);

  const series = useMemo(
    () => composeSeries(marked.points, include, lastPointPnl, startCumulative),
    [marked.points, include, lastPointPnl, startCumulative],
  );
  const totals = useMemo(
    () => composeTotals(marked.points, include, markForTotals, {
      startCumulative,
      lastPointPnl,
    }),
    [marked.points, include, markForTotals, startCumulative, lastPointPnl],
  );
  const activity = useMemo(
    () => filterActivity(buildActivityRows({ trades, fills, distributions }), include),
    [trades, fills, distributions, include],
  );
  const markers = useMemo(
    () => activity.map((row) => {
      const point = series.find((p) => p.date === row.date);
      return {
        date: row.date,
        cumulative: point?.cumulative ?? 0,
        kind: row.kind,
        label: row.symbol ?? row.description ?? row.kind,
      };
    }),
    [activity, series],
  );

  const periodPnl = totals.period;
  const hasActivity = activity.length > 0
    || series.some((p) => p.daily !== 0)
    || lastPointPnl !== 0
    || startCumulative !== 0;
  const activityRows = activity as ActivityTableRow[];
  const periodStart = windowLabel?.split(' → ')[0] ?? 'this period';
  const tickerLabel = symbol || 'this account';

  const toggleInclude = (key: keyof PnlInclude) => {
    setInclude((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.stocks && !next.options && !next.dividends && !next.fees) return prev;
      return next;
    });
  };

  return (
    <VStack gap={4} className="portfolio-pnl-section">
      <Text type="supporting">
        {symbol
          ? `Full ${symbol} P&L — realized stock and options on that root, plus the live open mark.`
          : 'Realized P&L for the whole account.'}
        {' '}
        Type a ticker to unify equity and option fills (for example CAR).
        Include chips choose what lands on the chart — stocks, options,
        dividends, and/or fees. Deposits and withdrawals stay off the curve.
        {' '}
        <Link to="/docs/schwab-pnl" className="portfolio-link">How this is calculated</Link>.
      </Text>

      <HStack gap={3} wrap="wrap" align="end" justify="between">
        <HStack gap={3} wrap="wrap" align="end">
          <TextInput
            label="Ticker"
            size="sm"
            width={140}
            value={symbolDraft}
            onChange={(v: string) => setSymbolDraft(v.toUpperCase())}
            placeholder="CAR"
            isOptional
            hasClear
            onKeyDown={(e: { key: string; preventDefault: () => void }) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applySymbol(symbolDraft);
              }
            }}
          />
          <Button
            size="sm"
            variant="primary"
            label={loading ? 'Loading…' : 'Apply'}
            isDisabled={loading}
            onClick={() => applySymbol(symbolDraft)}
          />
        </HStack>
        <TabList
          size="sm"
          aria-label="PnL range"
          value={range}
          onChange={(value) => setRange(value as SchwabPnlRange)}
        >
          {PNL_RANGES.map((key) => (
            <Tab key={key} value={key} label={key} />
          ))}
        </TabList>
      </HStack>

      <HStack gap={2} wrap="wrap" role="group" aria-label="Include in performance">
        {([
          ['stocks', 'Stocks'],
          ['options', 'Options'],
          ['dividends', 'Dividends'],
          ['fees', 'Fees'],
        ] as const).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={include[key] ? 'primary' : 'ghost'}
            label={label}
            onClick={() => toggleInclude(key)}
          />
        ))}
      </HStack>

      <HStack gap={3} wrap="wrap" justify="between" align="end">
        <VStack gap={0}>
          <Text type="supporting" size="sm">
            {range} · {tickerLabel}
          </Text>
          <Text
            weight="semibold"
            hasTabularNumbers
            className={`portfolio-stat portfolio-pnl-${pnlTone(periodPnl)}`}
          >
            {moneySigned(periodPnl)}
          </Text>
          {windowLabel ? (
            <Text type="supporting" size="sm">{windowLabel}</Text>
          ) : null}
        </VStack>
      </HStack>

      {error ? (
        <Text className="portfolio-error" role="alert">{error}</Text>
      ) : null}

      {lookbackTruncated ? (
        <Text type="supporting" role="status">
          Cost-basis lookback was unavailable, so only trades inside this chart
          window were loaded. Closes of positions opened earlier may be missing
          from realized PnL.
        </Text>
      ) : null}

      {mayBeTruncated ? (
        <Text type="supporting">
          Schwab may have truncated trade history (~3000 rows). Some closes may
          lack cost basis in this window.
        </Text>
      ) : null}

      {(summary?.unmatched_close_count ?? 0) > 0 ? (
        <Text type="supporting">
          {summary!.unmatched_close_count.toLocaleString()} closing trade
          {summary!.unmatched_close_count === 1 ? '' : 's'} in this window lacked
          a matching open and were excluded from realized PnL.
        </Text>
      ) : null}

      {loading && points.length === 0 && activity.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading Schwab PnL" />
        </HStack>
      ) : !hasActivity ? (
        <Text type="supporting">
          No {symbol ? `${symbol} ` : ''}activity in this period for the
          selected sleeves.
        </Text>
      ) : (
        <VStack gap={2} className="portfolio-pnl-chart">
          <div className="portfolio-pnl-plot">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid
                  stroke="var(--color-border)"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={48}
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  tickFormatter={formatChartTick}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                  tickFormatter={(v: number) =>
                    v.toLocaleString(undefined, {
                      style: 'currency',
                      currency: 'USD',
                      maximumFractionDigits: 0,
                    })
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--panel)',
                    border: 'var(--border-width) solid var(--color-border)',
                    borderRadius: 'var(--radius-element)',
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-primary)',
                  }}
                  labelFormatter={(d) => String(d)}
                  formatter={(v, name) => [
                    money(v as number),
                    name === 'cumulative' ? 'Cumulative' : 'Day',
                  ]}
                />
                <ReferenceLine y={0} stroke="var(--color-border)" />
                <Bar
                  dataKey="daily"
                  name="daily"
                  fill="var(--accent)"
                  fillOpacity={0.35}
                  isAnimationActive={false}
                  maxBarSize={10}
                />
                <Area
                  type="stepAfter"
                  dataKey="cumulative"
                  name="cumulative"
                  stroke="var(--accent)"
                  fill="var(--accent)"
                  fillOpacity={0.12}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
                <Scatter
                  data={markers}
                  dataKey="cumulative"
                  fill="var(--accent)"
                  shape={(props: { cx?: number; cy?: number; payload?: { kind?: ActivityRow['kind'] } }) => {
                    const kind = props.payload?.kind ?? 'stock';
                    return (
                      <circle
                        cx={props.cx}
                        cy={props.cy}
                        r={3.5}
                        fill={markerColor(kind)}
                      />
                    );
                  }}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Text type="supporting">
            Bars are that day&apos;s P&amp;L; the step line is the running total.
            Dots are the included fills and dividends
            {symbol
              ? '. Stock and option marks follow Schwab daily closes. Assignment marks the short option at intrinsic value, so receiving shares does not create a one-day P&amp;L jump.'
              : '.'}
          </Text>
        </VStack>
      )}

      {summary && !loading ? (
        <HStack gap={6} wrap="wrap" className="portfolio-summary">
          <VStack gap={0}>
            <Text type="supporting" size="sm">Activity</Text>
            <Text hasTabularNumbers weight="semibold">
              {activity.length.toLocaleString()}
            </Text>
          </VStack>
          {include.stocks ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">Stocks</Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.stocks)}`}
              >
                {moneySigned(totals.stocks)}
              </Text>
            </VStack>
          ) : null}
          {include.options ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">Options</Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.options)}`}
              >
                {moneySigned(totals.options)}
              </Text>
            </VStack>
          ) : null}
          {include.dividends ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">Dividends</Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.dividends)}`}
              >
                {moneySigned(totals.dividends)}
              </Text>
            </VStack>
          ) : null}
          {include.fees ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">
                {include.stocks || include.options ? 'Fees (in trading)' : 'Fees'}
              </Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.fees)}`}
              >
                {moneySigned(totals.fees)}
              </Text>
            </VStack>
          ) : null}
          {summary.prior_open_pnl !== 0 ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">Prior-lot closes</Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(summary.prior_open_pnl)}`}
              >
                {moneySigned(summary.prior_open_pnl)}
              </Text>
            </VStack>
          ) : null}
        </HStack>
      ) : null}

      {summary && summary.prior_open_pnl !== 0 && !loading ? (
        <Text type="supporting">
          Prior-lot closes are realized P&amp;L on positions opened before{' '}
          {periodStart} and closed inside it — excluded from the chart so
          pre-period losses are not carried forward.
        </Text>
      ) : null}

      {!loading && activityRows.length > 0 ? (
        <VStack gap={2} className="portfolio-pnl-breakdown">
          <Text weight="semibold">
            {symbol ? `${symbol} activity` : 'Activity'}
          </Text>
          <Text type="supporting">
            Every included fill and dividend in this window. Options show put
            or call, strike, and fill price so assignment vs premium is easy
            to check. Expand an option row to see that leg&apos;s daily
            mark-to-market (Schwab option closes, or Schwab underlying
            intrinsic when option history is missing). Realized is set when a
            close matched an open lot.
          </Text>
          <Table
            className="portfolio-table"
            data={activityRows}
            idKey="id"
            density="compact"
            dividers="rows"
            hasHover
            textOverflow="truncate"
            columns={[
              {
                key: 'marks',
                header: 'Marks',
                width: pixel(88),
                renderCell: (row) => {
                  const fillId = activityFillId(row);
                  const path = fillId ? legDailyById.get(fillId) : undefined;
                  if (row.kind !== 'option' || !fillId || !path || path.length === 0) {
                    return <Text type="supporting">—</Text>;
                  }
                  const open = expandedLegId === fillId;
                  return (
                    <Button
                      size="sm"
                      variant={open ? 'primary' : 'ghost'}
                      label={open ? 'Hide' : 'Daily'}
                      onClick={() => setExpandedLegId(open ? null : fillId)}
                    />
                  );
                },
              },
              {
                key: 'date',
                header: 'Date',
                width: pixel(110),
                renderCell: (row) => (
                  <Timestamp value={row.date} format="date" type="body" />
                ),
              },
              {
                key: 'kind',
                header: 'Kind',
                width: pixel(80),
                renderCell: (row) => (
                  <Token color={kindTone(row.kind)} label={kindLabel(row)} size="sm" />
                ),
              },
              {
                key: 'side',
                header: 'Side',
                width: pixel(72),
                renderCell: (row) => (
                  row.side
                    ? <Token color={sideTone(row.side)} label={row.side} size="sm" />
                    : <Text type="supporting">—</Text>
                ),
              },
              {
                key: 'symbol',
                header: 'Symbol',
                width: proportional(1.2),
                renderCell: (row) => (
                  <Text weight="semibold" hasTabularNumbers>{row.symbol ?? '—'}</Text>
                ),
              },
              {
                key: 'strike',
                header: 'Strike',
                width: pixel(80),
                renderCell: (row) => (
                  <Text hasTabularNumbers>
                    {row.kind === 'option' ? strikeLabel(row.strike) : '—'}
                  </Text>
                ),
              },
              {
                key: 'quantity',
                header: 'Qty',
                width: pixel(72),
                renderCell: (row) => (
                  <Text hasTabularNumbers>{qty(row.quantity)}</Text>
                ),
              },
              {
                key: 'price',
                header: 'Fill',
                width: pixel(88),
                renderCell: (row) => (
                  <Text hasTabularNumbers>{money(row.price)}</Text>
                ),
              },
              {
                key: 'net_amount',
                header: 'Net',
                width: pixel(100),
                renderCell: (row) => (
                  <Text hasTabularNumbers>{money(row.net_amount)}</Text>
                ),
              },
              {
                key: 'fees',
                header: 'Fees',
                width: pixel(72),
                renderCell: (row) => (
                  <Text hasTabularNumbers>{money(row.fees)}</Text>
                ),
              },
              {
                key: 'realized_pnl',
                header: 'Realized',
                width: pixel(100),
                renderCell: (row) => (
                  row.realized_pnl == null ? (
                    <Text type="supporting">—</Text>
                  ) : (
                    <Text
                      hasTabularNumbers
                      weight="semibold"
                      className={`portfolio-pnl-${pnlTone(row.realized_pnl)}`}
                    >
                      {moneySigned(row.realized_pnl)}
                    </Text>
                  )
                ),
              },
              {
                key: 'prior_open',
                header: 'Lot',
                width: pixel(72),
                renderCell: (row) => (
                  row.kind === 'dividend' ? (
                    <Text type="supporting">—</Text>
                  ) : row.realized_pnl == null ? (
                    <Token color="gray" label="open" size="sm" />
                  ) : row.prior_open ? (
                    <Token color="gray" label="prior" size="sm" />
                  ) : (
                    <Token color="green" label="period" size="sm" />
                  )
                ),
              },
              {
                key: 'description',
                header: 'Description',
                width: proportional(1.4),
                renderCell: (row) => (
                  <Text type="supporting">{row.description ?? '—'}</Text>
                ),
              },
            ]}
          />
          {legDailyById.size > 0 ? (
            <VStack gap={2}>
              <Text weight="semibold">Option leg daily marks</Text>
              <Text type="supporting">
                Session mark and day P&amp;L for each option lot on the chart.
                Expand a leg (or tap Daily on its activity row) to audit the
                path — same marks the Performance curve uses.
              </Text>
              <CollapsibleGroup
                type="single"
                value={expandedLegId ?? ''}
                onChange={(value) => {
                  if (typeof value === 'string' && value.length > 0) {
                    setExpandedLegId(value);
                  } else if (Array.isArray(value) && value[0]) {
                    setExpandedLegId(value[0]!);
                  } else {
                    setExpandedLegId(null);
                  }
                }}
                hasDividers
              >
                {optionLots
                  .filter((lot) => legDailyById.has(lot.id))
                  .map((lot) => {
                    const path = legDailyById.get(lot.id) ?? [];
                    const rows: LegDailyTableRow[] = path.map((p) => ({ ...p }));
                    const source = path[0]?.source ?? 'linear';
                    const total = path.at(-1)?.cumulative_pnl ?? 0;
                    return (
                      <Collapsible
                        key={lot.id}
                        value={lot.id}
                        trigger={(
                          <HStack gap={3} align="center" wrap="wrap">
                            <Text weight="semibold">{legLabel(lot)}</Text>
                            <Token
                              color="gray"
                              label={markSourceLabel(source)}
                              size="sm"
                            />
                            <Text
                              hasTabularNumbers
                              className={`portfolio-pnl-${pnlTone(total)}`}
                            >
                              {moneySigned(total)}
                            </Text>
                          </HStack>
                        )}
                      >
                        <Table
                          className="portfolio-table"
                          data={rows}
                          idKey="date"
                          density="compact"
                          dividers="rows"
                          hasHover
                          columns={[
                            {
                              key: 'date',
                              header: 'Date',
                              width: pixel(110),
                              renderCell: (row) => (
                                <Timestamp value={row.date} format="date" type="body" />
                              ),
                            },
                            {
                              key: 'mark',
                              header: 'Mark',
                              width: pixel(88),
                              renderCell: (row) => (
                                <Text hasTabularNumbers>{money(row.mark)}</Text>
                              ),
                            },
                            {
                              key: 'daily_pnl',
                              header: 'Day P&L',
                              width: pixel(110),
                              renderCell: (row) => (
                                <Text
                                  hasTabularNumbers
                                  weight="semibold"
                                  className={`portfolio-pnl-${pnlTone(row.daily_pnl)}`}
                                >
                                  {moneySigned(row.daily_pnl)}
                                </Text>
                              ),
                            },
                            {
                              key: 'cumulative_pnl',
                              header: 'Cumulative',
                              width: pixel(110),
                              renderCell: (row) => (
                                <Text
                                  hasTabularNumbers
                                  className={`portfolio-pnl-${pnlTone(row.cumulative_pnl)}`}
                                >
                                  {moneySigned(row.cumulative_pnl)}
                                </Text>
                              ),
                            },
                            {
                              key: 'source',
                              header: 'Source',
                              width: proportional(1),
                              renderCell: (row) => (
                                <Text type="supporting">
                                  {markSourceLabel(row.source)}
                                </Text>
                              ),
                            },
                          ]}
                        />
                      </Collapsible>
                    );
                  })}
              </CollapsibleGroup>
            </VStack>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
}
