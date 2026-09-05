import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Chart } from '@tanstack/charts/react';
import {
  Banner,
  Button,
  EmptyState,
  Heading,
  HStack,
  List,
  ListItem,
  Section,
  SegmentedControl,
  SegmentedControlItem,
  Spinner,
  Tab,
  TabList,
  Text,
  Token,
  ToggleButton,
  ToggleButtonGroup,
  useMediaQuery,
  VStack,
  MetadataList,
  MetadataListItem,
} from '@astryxdesign/core';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { LineChart } from 'lucide-react';
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
import { definePnlChart, type PnlChartMarker } from './charts/pnlChart';
import { CHART_HOST_CLASS } from './charts/theme';
import { etDateString } from './tickerChartRange';
import './charts.css';
import {
  applyEquityMarkPath,
  applyOptionMarkPath,
  buildActivityRows,
  calendarWindowStart,
  composeSeries,
  composeTotals,
  DEFAULT_PNL_INCLUDE,
  densifyWithOhlc,
  equityLotsFromFills,
  filterActivity,
  formatSignedPercent,
  includedOpenMark,
  optionLegDailyPath,
  optionLotsFromFills,
  parseOccContract,
  performanceFocusWindow,
  periodPnlSince,
  pnlPercent,
  scopedPortfolioBasis,
  tickerOpenMark,
  type ActivityRow,
  type LegDailyPoint,
  type OptionLot,
  type PnlInclude,
  type ReturnWindow,
} from './schwabPnlView';
import './Portfolio.css';

const PNL_RANGES: SchwabPnlRange[] = ['MTD', 'YTD', '1M', '3M', '6M', '1Y'];

type ChartMetric = 'daily' | 'cumulative';
type ChartWindow = 'focus' | 'range';
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

function sessionDateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
  ).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
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

function returnTokenColor(n: number | null | undefined): 'green' | 'red' | 'gray' {
  return pnlTone(n);
}

function ReturnBubbles({
  windows,
}: {
  windows: Array<{ key: ReturnWindow; pct: number | null; pnl: number | null }>;
}) {
  return (
    <HStack gap={2} wrap="wrap" role="group" aria-label="Portfolio return">
      {windows.map((window) => (
        <Token
          key={window.key}
          size="sm"
          color={returnTokenColor(window.pnl ?? window.pct)}
          label={`${window.key} ${formatSignedPercent(window.pct)}`}
          description={`${window.key} return ${formatSignedPercent(window.pct)}`}
        />
      ))}
    </HStack>
  );
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
  if (source === 'black_scholes') return 'Black–Scholes on Schwab stock';
  if (source === 'schwab') return 'Schwab option prints';
  if (source === 'intrinsic') return 'Intrinsic from Schwab stock closes';
  return 'Linear timing estimate';
}

function markSourceExplanation(source: LegDailyPoint['source']): string {
  if (source === 'black_scholes') {
    return 'Each session mark is Black–Scholes on that day’s Schwab stock close, using implied vol from the fill (held constant), Schwab’s current dividend yield when available, and never below intrinsic. Last-trade option prints are ignored — they are often stale. A crash still moves the book with delta; once both spread legs are deep in the money they move together so net daily P&L is small.';
  }
  if (source === 'schwab') {
    return 'Marks are Schwab option price-history closes — actual option prints from Schwab.';
  }
  if (source === 'intrinsic') {
    return 'Schwab option prints were missing or too stale to explain the exit, so each mark is intrinsic value from the Schwab underlying close. Once both spread legs are deep in the money they move together, so the net book can jump on the crash and then go nearly flat.';
  }
  return 'Schwab had neither a usable fill IV nor enough underlying closes. Marks are spaced from fill to exit only to estimate timing; the final FIFO realized total is unchanged.';
}

type LegDailyTableRow = LegDailyPoint & Record<string, unknown>;

/**
 * Realized trading PnL curve for a linked Schwab account.
 * Ticker scopes equity + options on the same root (CAR stock and CAR puts).
 */
export function SchwabPnlSection({
  accountId,
  initialSymbol = '',
  symbol: controlledSymbol,
  onSymbolChange,
  hideSymbolInput = false,
  positions = [],
  accountEquity = null,
  accountDayPnl = null,
  accountDayPnlPct = null,
  afterChart,
}: {
  accountId: string | null;
  /** Root ticker from a position click (`CAR`, not the OCC symbol). */
  initialSymbol?: string;
  /** Controlled root ticker. When set, the parent owns search/filter state. */
  symbol?: string;
  onSymbolChange?: (symbol: string) => void;
  /** Hide the local ticker field when the parent already renders search. */
  hideSymbolInput?: boolean;
  positions?: SchwabPortfolioPosition[];
  /** Live account equity for DTD / period-return percentages. */
  accountEquity?: number | null;
  /** Live Schwab day P&L (mark-to-market), not realized trading P&L. */
  accountDayPnl?: number | null;
  /** Schwab currentDayProfitLossPercentage when the API sent it. */
  accountDayPnlPct?: number | null;
  /** Open positions (or other book UI) rendered directly under the chart. */
  afterChart?: ReactNode;
}) {
  const [range, setRange] = useState<SchwabPnlRange>('YTD');
  const isControlled = controlledSymbol !== undefined;
  const [internalDraft, setInternalDraft] = useState(initialSymbol);
  const [internalSymbol, setInternalSymbol] = useState(initialSymbol.trim().toUpperCase());
  const symbolDraft = isControlled ? (controlledSymbol ?? '') : internalDraft;
  const symbol = (isControlled ? controlledSymbol : internalSymbol).trim().toUpperCase();
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
  const [dividendYield, setDividendYield] = useState(0);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [windowEnd, setWindowEnd] = useState<string | null>(null);
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
  const [lookbackTruncated, setLookbackTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedLegId, setSelectedLegId] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<ChartMetric>('daily');
  const [chartWindow, setChartWindow] = useState<ChartWindow>('focus');
  const [ytdSnapshot, setYtdSnapshot] = useState<{
    key: string;
    points: SchwabPnlPoint[];
    openMark: SchwabPnlResponse['open_mark'];
  } | null>(null);
  const requestSequence = useRef(0);
  const ytdKeyRef = useRef('');
  const isMobile = useMediaQuery('(max-width: 47.99rem)');

  const returnKey = `${accountId ?? ''}|${symbol}`;

  useEffect(() => {
    if (isControlled) return;
    const next = initialSymbol.trim().toUpperCase();
    setInternalDraft(next);
    setInternalSymbol(next);
  }, [initialSymbol, isControlled]);

  const applySymbol = useCallback((raw: string) => {
    const next = raw.trim().toUpperCase();
    if (isControlled) {
      onSymbolChange?.(next);
      return;
    }
    setInternalSymbol(next);
    setInternalDraft(next);
  }, [isControlled, onSymbolChange]);

  const load = useCallback(async (
    nextRange: SchwabPnlRange,
    nextAccount: string | null,
    nextSymbol: string,
  ) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    setPoints([]);
    setSummary(null);
    setFills([]);
    setDistributions([]);
    setTrades([]);
    setOpenMarkFromApi(null);
    setOhlc([]);
    setOptionOhlc({});
    setDividendYield(0);
    setWindowStart(null);
    setWindowEnd(null);
    setWindowLabel(null);
    setLookbackTruncated(false);
    setMayBeTruncated(false);
    try {
      const res = await api.schwabPnl({
        range: nextRange,
        account: nextAccount ?? undefined,
        symbol: nextSymbol.trim() || undefined,
      });
      if (requestId !== requestSequence.current) return;
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
      setDividendYield(
        res.dividend_yield != null && Number.isFinite(res.dividend_yield)
          ? Math.max(0, res.dividend_yield)
          : 0,
      );
      // Portfolio marks are Schwab-only (see AGENTS.md). Do not fall back to
      // lake/Yahoo — it often has no bars for the hold (CAR Apr 2026).
      setOhlc(schwabBars);
      if (nextRange === 'YTD') {
        ytdKeyRef.current = `${nextAccount ?? ''}|${nextSymbol}`;
        setYtdSnapshot({
          key: ytdKeyRef.current,
          points: res.points,
          openMark: res.open_mark ?? null,
        });
      }
    } catch (err) {
      if (requestId !== requestSequence.current) return;
      setError(formatApiError(err));
      setPoints([]);
      setSummary(null);
      setFills([]);
      setDistributions([]);
      setTrades([]);
      setOpenMarkFromApi(null);
      setOhlc([]);
      setOptionOhlc({});
      setDividendYield(0);
      setWindowStart(null);
      setWindowEnd(null);
      setWindowLabel(null);
      setLookbackTruncated(false);
      setMayBeTruncated(false);
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, accountId, symbol);
    return () => {
      requestSequence.current += 1;
    };
  }, [accountId, range, symbol, load]);

  useEffect(() => {
    if (range === 'YTD') return;
    const key = `${accountId ?? ''}|${symbol}`;
    if (ytdKeyRef.current === key) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.schwabPnl({
          range: 'YTD',
          account: accountId ?? undefined,
          symbol: symbol || undefined,
        });
        if (cancelled) return;
        ytdKeyRef.current = key;
        setYtdSnapshot({
          key,
          points: res.points,
          openMark: res.open_mark ?? null,
        });
      } catch {
        if (!cancelled && ytdKeyRef.current !== key) setYtdSnapshot(null);
      }
    })();
    return () => { cancelled = true; };
  }, [accountId, range, symbol]);

  const openMark = useMemo(() => {
    if (!symbol) return null;
    if (openMarkFromApi) return openMarkFromApi;
    return tickerOpenMark(positions, symbol);
  }, [openMarkFromApi, positions, symbol]);

  const optionLots = useMemo(
    () => (symbol ? optionLotsFromFills(fills, positions, symbol) : []),
    [fills, positions, symbol],
  );
  const assignmentEquityFillIds = useMemo(
    () => new Set(optionLots
      .map((lot) => lot.assignment_equity_fill_id)
      .filter((id): id is string => Boolean(id))),
    [optionLots],
  );
  const equityLots = useMemo(
    () => equityLotsFromFills(
      positions,
      trades,
      fills,
      symbol,
      assignmentEquityFillIds,
    ),
    [positions, trades, fills, symbol, assignmentEquityFillIds],
  );

  const legDailyById = useMemo(() => {
    const start = windowStart ?? '';
    const end = windowEnd ?? '';
    const map = new Map<string, LegDailyPoint[]>();
    if (!start || !end) return map;
    for (const lot of optionLots) {
      const path = optionLegDailyPath(
        lot,
        optionOhlc,
        start,
        end,
        ohlc,
        dividendYield,
      );
      if (path.length > 0) map.set(lot.id, path);
    }
    return map;
  }, [optionLots, optionOhlc, ohlc, dividendYield, windowStart, windowEnd]);

  useEffect(() => {
    setSelectedLegId(null);
    setChartWindow('focus');
  }, [symbol, range, accountId]);

  const marked = useMemo(() => {
    const start = windowStart ?? '';
    const end = windowEnd ?? '';
    const dense = densifyWithOhlc(points, ohlc, start, end);
    const equity = applyEquityMarkPath(dense, ohlc, equityLots, start, end);
    const option = applyOptionMarkPath(
      equity.points,
      optionOhlc,
      optionLots,
      start,
      end,
      ohlc,
      dividendYield,
    );
    return {
      points: option.points,
      equityPainted: equity.painted,
      optionPainted: option.painted,
      equityInWindow: equity.inWindowMtm,
      equityClosedPnl: equity.closedPnl,
      optionInWindow: option.inWindowMtm,
      optionClosedPnl: option.closedPnl,
    };
  }, [
    points,
    ohlc,
    optionOhlc,
    equityLots,
    optionLots,
    dividendYield,
    windowStart,
    windowEnd,
  ]);

  const markForTotals = useMemo(() => {
    if (!openMark) return null;
    return {
      equity_pnl: marked.equityPainted
        ? openMark.equity_pnl - (marked.equityInWindow - marked.equityClosedPnl)
        : openMark.equity_pnl,
      option_pnl: marked.optionPainted
        ? openMark.option_pnl - (marked.optionInWindow - marked.optionClosedPnl)
        : openMark.option_pnl,
    };
  }, [openMark, marked]);

  const startCumulative = useMemo(() => {
    let start = 0;
    if (marked.equityPainted && include.stocks) {
      start += (openMark?.equity_pnl ?? 0)
        - (marked.equityInWindow - marked.equityClosedPnl);
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
  const focusWindow = useMemo(
    () => performanceFocusWindow(
      series,
      activity,
      include.options ? optionLots : [],
      windowStart ?? '',
      windowEnd ?? '',
    ),
    [series, activity, include.options, optionLots, windowStart, windowEnd],
  );
  const focusIsNarrower = Boolean(
    focusWindow
    && (focusWindow.start > windowStart! || focusWindow.end < windowEnd!),
  );
  const effectiveChartWindow: ChartWindow =
    chartWindow === 'focus' && focusIsNarrower ? 'focus' : 'range';
  const chartSeries = useMemo(() => {
    if (effectiveChartWindow !== 'focus' || !focusWindow) return series;
    return series.filter((point) => (
      point.date >= focusWindow.start && point.date <= focusWindow.end
    ));
  }, [series, effectiveChartWindow, focusWindow]);
  const chartMarkers = useMemo((): PnlChartMarker[] => (
    activity
      .filter((row) => (
        chartSeries.length > 0
        && row.date >= chartSeries[0]!.date
        && row.date <= chartSeries.at(-1)!.date
      ))
      .map((row) => {
        const point = chartSeries.find((candidate) => candidate.date === row.date);
        return {
          date: row.date,
          daily: point?.daily ?? 0,
          cumulative: point?.cumulative ?? 0,
          kind: row.kind,
          label: row.symbol ?? row.description ?? row.kind,
        };
      })
  ), [activity, chartSeries]);
  const chartValues = chartSeries.map((point) => point[chartMetric]);
  const chartMin = Math.min(0, ...chartValues);
  const chartMax = Math.max(0, ...chartValues);
  const chartPad = Math.max((chartMax - chartMin) * 0.08, 1);
  const chartDomain: [number, number] = [chartMin - chartPad, chartMax + chartPad];
  const chartDefinition = useMemo(
    () => definePnlChart({
      series: chartSeries,
      markers: chartMarkers,
      metric: chartMetric,
      domain: chartDomain,
    }),
    [chartSeries, chartMarkers, chartMetric, chartMin, chartMax, chartPad],
  );
  const largestDay = chartSeries.reduce<(typeof chartSeries)[number] | null>(
    (largest, point) => (
      !largest || Math.abs(point.daily) > Math.abs(largest.daily) ? point : largest
    ),
    null,
  );
  const markableLots = optionLots.filter((lot) => legDailyById.has(lot.id));
  const activeLegId = markableLots.some((lot) => lot.id === selectedLegId)
    ? selectedLegId
    : markableLots[0]?.id ?? null;
  const activeLeg = markableLots.find((lot) => lot.id === activeLegId) ?? null;
  const activeLegPath = activeLegId ? legDailyById.get(activeLegId) ?? [] : [];
  const activeLegRows = activeLegPath as LegDailyTableRow[];
  const activeLegSource = activeLegPath[0]?.source ?? 'linear';
  const activeLegTotal = activeLegPath.at(-1)?.cumulative_pnl ?? 0;

  const periodPnl = totals.period;
  const returnBasis = useMemo(
    () => scopedPortfolioBasis(positions, symbol, {
      equity: accountEquity,
      day_pnl: accountDayPnl,
    }),
    [positions, symbol, accountEquity, accountDayPnl],
  );
  const ytdComposed = useMemo(() => {
    if (range === 'YTD') return series;
    if (!ytdSnapshot || ytdSnapshot.key !== returnKey) return [];
    return composeSeries(
      ytdSnapshot.points,
      include,
      includedOpenMark(ytdSnapshot.openMark, include),
    );
  }, [range, series, ytdSnapshot, returnKey, include]);
  const returnAsOf = windowEnd ?? etDateString();
  const mtdSource = range === 'YTD' ? series : ytdComposed;
  const mtdPnl = range === 'MTD'
    ? totals.period
    : (mtdSource.length === 0
      ? null
      : periodPnlSince(mtdSource, calendarWindowStart('MTD', returnAsOf)));
  const ytdPnl = range === 'YTD'
    ? totals.period
    : (ytdComposed.at(-1)?.cumulative ?? null);
  const dtdPnl = returnBasis.day_pnl;
  const dtdPct = !symbol && accountDayPnlPct != null && Number.isFinite(accountDayPnlPct)
    ? accountDayPnlPct
    : pnlPercent(dtdPnl, returnBasis.equity);
  const returnWindows = [
    { key: 'DTD' as const, pnl: dtdPnl, pct: dtdPct },
    { key: 'MTD' as const, pnl: mtdPnl, pct: pnlPercent(mtdPnl, returnBasis.equity) },
    { key: 'YTD' as const, pnl: ytdPnl, pct: ytdPnl == null ? null : pnlPercent(ytdPnl, returnBasis.equity) },
  ];
  const hasActivity = activity.length > 0
    || series.some((p) => p.daily !== 0)
    || lastPointPnl !== 0
    || startCumulative !== 0;
  const activityRows = activity as ActivityTableRow[];
  const periodStart = windowLabel?.split(' → ')[0] ?? 'this period';
  const tickerLabel = symbol || 'this account';

  const includeKeys = (['stocks', 'options', 'dividends', 'fees'] as const)
    .filter((key) => include[key]);
  const setIncludeKeys = (keys: string[]) => {
    if (keys.length === 0) return;
    setInclude({
      stocks: keys.includes('stocks'),
      options: keys.includes('options'),
      dividends: keys.includes('dividends'),
      fees: keys.includes('fees'),
    });
  };
  const revealLeg = (id: string) => {
    setSelectedLegId(id);
    window.requestAnimationFrame(() => {
      document.querySelector('.portfolio-leg-audit')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  return (
    <VStack gap={isMobile ? 2 : 4} className="portfolio-pnl-section">
      {hideSymbolInput ? null : (
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
      )}

      <HStack gap={3} wrap="wrap" align="end" justify="between">
        {hideSymbolInput ? (
          <ToggleButtonGroup
            type="multiple"
            size="sm"
            label="Include in performance"
            value={[...includeKeys]}
            onChange={setIncludeKeys}
          >
            <ToggleButton value="stocks" label="Stocks" />
            <ToggleButton value="options" label="Options" />
            <ToggleButton value="dividends" label="Dividends" />
            <ToggleButton value="fees" label="Fees" />
          </ToggleButtonGroup>
        ) : (
          <HStack gap={3} wrap="wrap" align="end">
            <TextInput
              label="Ticker"
              size="sm"
              width={140}
              value={symbolDraft}
              onChange={(v: string) => setInternalDraft(v.toUpperCase())}
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
        )}
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

      {hideSymbolInput ? null : (
        <ToggleButtonGroup
          type="multiple"
          size="sm"
          label="Include in performance"
          value={[...includeKeys]}
          onChange={setIncludeKeys}
        >
          <ToggleButton value="stocks" label="Stocks" />
          <ToggleButton value="options" label="Options" />
          <ToggleButton value="dividends" label="Dividends" />
          <ToggleButton value="fees" label="Fees" />
        </ToggleButtonGroup>
      )}

      <HStack gap={3} wrap="wrap" justify="between" align="end">
        <VStack gap={1}>
          <Text type="supporting" size="sm">
            {range} · {tickerLabel}
          </Text>
          <HStack gap={3} wrap="wrap" vAlign="end">
            <Text
              type="display-3"
              weight="bold"
              hasTabularNumbers
              className={`portfolio-stat portfolio-pnl-${pnlTone(periodPnl)}`}
            >
              {moneySigned(periodPnl)}
            </Text>
            <Text
              type="large"
              weight="semibold"
              hasTabularNumbers
              className={`portfolio-pnl-${pnlTone(periodPnl)}`}
            >
              {formatSignedPercent(pnlPercent(periodPnl, returnBasis.equity))}
            </Text>
          </HStack>
          {windowLabel ? (
            <Text type="supporting" size="sm">{windowLabel}</Text>
          ) : null}
          <ReturnBubbles windows={returnWindows} />
        </VStack>
      </HStack>

      {error ? (
        <Banner status="error" title="Could not load Schwab performance" description={error} />
      ) : null}

      {lookbackTruncated ? (
        <Banner
          status="warning"
          title="Incomplete cost basis"
          description="Closes of positions opened before the available Schwab lookback may be missing from realized PnL."
        />
      ) : null}

      {mayBeTruncated ? (
        <Banner
          status="warning"
          title="Trade history may be truncated"
          description="Schwab may have truncated trade history (~3000 rows). Some closes may lack cost basis in this window."
        />
      ) : null}

      {(summary?.unmatched_close_count ?? 0) > 0 ? (
        <Banner
          status="info"
          title={`${summary!.unmatched_close_count.toLocaleString()} unmatched close${summary!.unmatched_close_count === 1 ? '' : 's'}`}
          description="Those trades lacked a matching open in this window and were excluded from realized PnL."
        />
      ) : null}

      {loading && points.length === 0 && activity.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading Schwab PnL" />
        </HStack>
      ) : !hasActivity ? (
        <EmptyState
          headingLevel={3}
          isCompact
          icon={<LineChart size={24} />}
          title={symbol ? `No ${symbol} activity in this period` : 'No activity in this period'}
          description="Try another range or turn on a different sleeve — stocks, options, dividends, or fees."
        />
      ) : (
        <Section variant="muted" padding={isMobile ? 1 : 3}>
          <VStack gap={isMobile ? 2 : 3} className="portfolio-pnl-chart">
            <HStack gap={3} wrap="wrap" justify="between" align="end">
              <VStack gap={0}>
                <Text weight="semibold">
                  {chartMetric === 'daily' ? 'Day P&L' : 'Cumulative P&L'}
                </Text>
                <Text type="supporting" size="sm">
                  {effectiveChartWindow === 'focus' && focusWindow
                    ? `Trade window · ${focusWindow.start} → ${focusWindow.end}`
                    : `${range} window · ${windowLabel ?? 'loading'}`}
                </Text>
              </VStack>
              <HStack gap={2} wrap="wrap">
                {focusIsNarrower ? (
                  <SegmentedControl
                    value={effectiveChartWindow}
                    onChange={(value) => setChartWindow(value as ChartWindow)}
                    label="Chart date window"
                    size="sm"
                  >
                    <SegmentedControlItem value="focus" label="Trade window" />
                    <SegmentedControlItem value="range" label={`Full ${range}`} />
                  </SegmentedControl>
                ) : null}
                <SegmentedControl
                  value={chartMetric}
                  onChange={(value) => setChartMetric(value as ChartMetric)}
                  label="Chart P&L measure"
                  size="sm"
                >
                  <SegmentedControlItem value="daily" label="Day" />
                  <SegmentedControlItem value="cumulative" label="Cumulative" />
                </SegmentedControl>
              </HStack>
            </HStack>
            {isMobile ? null : (
            <Text type="supporting">
              {chartMetric === 'daily'
                ? largestDay
                  ? `Each bar is one session. Largest visible move: ${moneySigned(largestDay.daily)} on ${largestDay.date}.`
                  : 'Each bar is one session.'
                : `The step line is the running total through the visible window. The ${range} headline above always uses the full selected period.`}
            </Text>
            )}
            <VStack className="portfolio-pnl-plot">
              <Chart
                definition={chartDefinition}
                height={isMobile ? 240 : 280}
                ariaLabel={chartMetric === 'daily' ? 'Day P&L' : 'Cumulative P&L'}
                className={CHART_HOST_CLASS}
              />
            </VStack>
            {isMobile ? null : (
            <Text type="supporting" size="sm">
              Dots are included fills and dividends. Chart focus changes only
              the dates shown — it never changes the {range} headline.
            </Text>
            )}
          </VStack>
        </Section>
      )}

      {afterChart}

      {summary && !loading ? (
        <MetadataList orientation="horizontal" label={{ position: 'top' }}>
          <MetadataListItem label="Activity">
            <Text hasTabularNumbers weight="semibold">
              {activity.length.toLocaleString()}
            </Text>
          </MetadataListItem>
          {include.stocks ? (
            <MetadataListItem label="Stocks">
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.stocks)}`}
              >
                {moneySigned(totals.stocks)}
              </Text>
            </MetadataListItem>
          ) : null}
          {include.options ? (
            <MetadataListItem label="Options">
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.options)}`}
              >
                {moneySigned(totals.options)}
              </Text>
            </MetadataListItem>
          ) : null}
          {include.dividends ? (
            <MetadataListItem label="Dividends">
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.dividends)}`}
              >
                {moneySigned(totals.dividends)}
              </Text>
            </MetadataListItem>
          ) : null}
          {include.fees ? (
            <MetadataListItem
              label={include.stocks || include.options ? 'Fees (in trading)' : 'Fees'}
            >
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(totals.fees)}`}
              >
                {moneySigned(totals.fees)}
              </Text>
            </MetadataListItem>
          ) : null}
          {summary.prior_open_pnl !== 0 ? (
            <MetadataListItem label="Prior-lot closes">
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(summary.prior_open_pnl)}`}
              >
                {moneySigned(summary.prior_open_pnl)}
              </Text>
            </MetadataListItem>
          ) : null}
        </MetadataList>
      ) : null}

      {summary && summary.prior_open_pnl !== 0 && !loading ? (
        <Text type="supporting">
          Prior-lot closes are realized P&amp;L on positions opened before{' '}
          {periodStart} and closed inside it — excluded from the chart so
          pre-period losses are not carried forward.
        </Text>
      ) : null}

      {!loading && activeLeg ? (
        <Section variant="muted" padding={3}>
          <VStack gap={3} className="portfolio-leg-audit">
            <VStack gap={0}>
              <Heading level={3}>Option leg audit · daily MTM</Heading>
              <Text type="supporting">
                Select a leg to see the exact session marks used by the
                Performance curve. This is mark-to-market timing, not a second
                realized P&amp;L calculation.
              </Text>
            </VStack>
            <TabList
              size="sm"
              value={activeLegId!}
              onChange={(value) => setSelectedLegId(value)}
              hasDivider
              aria-label="Option leg"
            >
              {markableLots.map((lot) => (
                <Tab key={lot.id} value={lot.id} label={legLabel(lot)} />
              ))}
            </TabList>
            <HStack gap={5} wrap="wrap" justify="between" align="end">
              <VStack gap={0}>
                <Text type="supporting" size="sm">Mark source</Text>
                <Token
                  color={activeLegSource === 'black_scholes'
                    ? 'blue'
                    : activeLegSource === 'schwab'
                      ? 'green'
                      : activeLegSource === 'intrinsic' ? 'orange' : 'gray'}
                  label={markSourceLabel(activeLegSource)}
                  size="sm"
                />
              </VStack>
              <VStack gap={0}>
                <Text type="supporting" size="sm">Hold</Text>
                <Text hasTabularNumbers>
                  {activeLegPath[0]?.date} → {activeLegPath.at(-1)?.date}
                </Text>
              </VStack>
              <VStack gap={0}>
                <Text type="supporting" size="sm">Leg MTM total</Text>
                <Text
                  hasTabularNumbers
                  weight="semibold"
                  className={`portfolio-pnl-${pnlTone(activeLegTotal)}`}
                >
                  {moneySigned(activeLegTotal)}
                </Text>
              </VStack>
            </HStack>
            <Text type="supporting">{markSourceExplanation(activeLegSource)}</Text>
            {isMobile ? (
              <List density="compact" hasDividers header="Session marks">
                {activeLegPath.map((point) => (
                  <ListItem
                    key={point.date}
                    label={point.date}
                    description={`Mark ${money(point.mark)} · Day MTM ${moneySigned(point.daily_pnl)}`}
                    endContent={(
                      <Text
                        hasTabularNumbers
                        className={`portfolio-pnl-${pnlTone(point.cumulative_pnl)}`}
                      >
                        {moneySigned(point.cumulative_pnl)}
                      </Text>
                    )}
                  />
                ))}
              </List>
            ) : (
              <Table
                className="portfolio-table"
                data={activeLegRows}
                idKey="date"
                density="compact"
                dividers="rows"
                hasHover
                columns={[
                  {
                    key: 'date',
                    header: 'Session',
                    width: pixel(120),
                    renderCell: (row) => (
                      <Text>{sessionDateLabel(row.date)}</Text>
                    ),
                  },
                  {
                    key: 'mark',
                    header: 'Option mark',
                    width: proportional(1),
                    renderCell: (row) => (
                      <Text hasTabularNumbers>{money(row.mark)}</Text>
                    ),
                  },
                  {
                    key: 'daily_pnl',
                    header: 'Day MTM',
                    width: proportional(1),
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
                    header: 'Running MTM',
                    width: proportional(1),
                    renderCell: (row) => (
                      <Text
                        hasTabularNumbers
                        className={`portfolio-pnl-${pnlTone(row.cumulative_pnl)}`}
                      >
                        {moneySigned(row.cumulative_pnl)}
                      </Text>
                    ),
                  },
                ]}
              />
            )}
          </VStack>
        </Section>
      ) : null}

      {!loading && activityRows.length > 0 ? (
        <VStack gap={2} className="portfolio-pnl-breakdown">
          <Heading level={3}>
            {symbol ? `${symbol} activity` : 'Activity'}
          </Heading>
          <Text type="supporting">
            FIFO realized is the cash and cost-basis result recorded when a lot
            closes. Daily MTM in the leg audit above explains when that value
            accrued on the chart. Select Marks on an option close to connect
            the activity row to its mark path.
          </Text>
          {isMobile ? (
            <List
              density="compact"
              hasDividers
              header={`${activityRows.length.toLocaleString()} included events`}
            >
              {activityRows.map((row) => {
                const fillId = activityFillId(row);
                const hasMarks = Boolean(fillId && legDailyById.has(fillId));
                const optionDetail = row.kind === 'option'
                  ? ` · ${strikeLabel(row.strike)} ${row.option_right ?? 'option'}`
                  : '';
                const fillDetail = row.quantity != null || row.price != null
                  ? `Qty ${qty(row.quantity)} at ${money(row.price)}`
                  : row.description ?? 'Cash activity';
                const realized = row.realized_pnl == null
                  ? 'FIFO realized —'
                  : `FIFO realized ${moneySigned(row.realized_pnl)}`;
                return (
                  <ListItem
                    key={row.id}
                    label={`${row.date} · ${row.side ?? kindLabel(row)}${optionDetail}`}
                    description={(
                      <VStack gap={0}>
                        <Text weight="semibold">{row.symbol ?? row.description ?? '—'}</Text>
                        <Text type="supporting">
                          {fillDetail} · Net {money(row.net_amount)} · {realized}
                        </Text>
                        {hasMarks ? (
                          <Text type="supporting">Tap to show this leg&apos;s daily MTM.</Text>
                        ) : null}
                      </VStack>
                    )}
                    endContent={hasMarks ? (
                      <Token
                        color={activeLegId === fillId ? 'orange' : 'gray'}
                        label="Marks"
                        size="sm"
                      />
                    ) : null}
                    isSelected={activeLegId === fillId}
                    onClick={hasMarks && fillId ? () => revealLeg(fillId) : undefined}
                  />
                );
              })}
            </List>
          ) : (
            <Table
              className="portfolio-table"
              data={activityRows}
              idKey="id"
              density="compact"
              dividers="rows"
              hasHover
              textOverflow="wrap"
              columns={[
                {
                  key: 'date',
                  header: 'Date',
                  width: pixel(110),
                  renderCell: (row) => (
                    <Text>{sessionDateLabel(row.date)}</Text>
                  ),
                },
                {
                  key: 'symbol',
                  header: 'Activity',
                  width: proportional(1.5),
                  renderCell: (row) => (
                    <VStack gap={0}>
                      <HStack gap={1} wrap="wrap">
                        <Token color={kindTone(row.kind)} label={kindLabel(row)} size="sm" />
                        {row.side ? (
                          <Token color={sideTone(row.side)} label={row.side} size="sm" />
                        ) : null}
                      </HStack>
                      <Text weight="semibold" hasTabularNumbers>
                        {row.symbol ?? '—'}
                        {row.kind === 'option'
                          ? ` · ${strikeLabel(row.strike)} ${row.option_right ?? ''}`
                          : ''}
                      </Text>
                      {row.description ? (
                        <Text type="supporting" size="sm">{row.description}</Text>
                      ) : null}
                    </VStack>
                  ),
                },
                {
                  key: 'quantity',
                  header: 'Fill',
                  width: pixel(110),
                  renderCell: (row) => (
                    <VStack gap={0}>
                      <Text hasTabularNumbers>Qty {qty(row.quantity)}</Text>
                      <Text type="supporting" hasTabularNumbers>{money(row.price)}</Text>
                    </VStack>
                  ),
                },
                {
                  key: 'net_amount',
                  header: 'Cash',
                  width: pixel(110),
                  renderCell: (row) => (
                    <VStack gap={0}>
                      <Text hasTabularNumbers>{money(row.net_amount)}</Text>
                      <Text type="supporting" hasTabularNumbers>
                        Fees {money(row.fees)}
                      </Text>
                    </VStack>
                  ),
                },
                {
                  key: 'realized_pnl',
                  header: 'FIFO realized',
                  width: pixel(120),
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
                  width: pixel(76),
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
                  key: 'marks',
                  header: 'Daily MTM',
                  width: pixel(110),
                  renderCell: (row) => {
                    const fillId = activityFillId(row);
                    const hasMarks = Boolean(fillId && legDailyById.has(fillId));
                    if (!hasMarks) return <Text type="supporting">—</Text>;
                    return (
                      <Button
                        size="sm"
                        variant={activeLegId === fillId ? 'primary' : 'ghost'}
                        label="Marks"
                        onClick={() => revealLeg(fillId!)}
                      />
                    );
                  },
                },
              ]}
            />
          )}
        </VStack>
      ) : null}
    </VStack>
  );
}
