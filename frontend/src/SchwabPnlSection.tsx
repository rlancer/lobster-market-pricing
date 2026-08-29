import { useCallback, useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  HStack,
  Spinner,
  Text,
  Token,
  ToggleButton,
  ToggleButtonGroup,
  VStack,
} from '@astryxdesign/core';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import {
  api,
  type SchwabDistribution,
  type SchwabPnlFill,
  type SchwabPnlPoint,
  type SchwabPnlRange,
  type SchwabPnlResponse,
} from './api';
import { formatChartTick } from './tickerChartRange';
import './Portfolio.css';

const PNL_RANGES: SchwabPnlRange[] = ['MTD', 'YTD', '1M', '3M', '6M', '1Y'];

type FillRow = SchwabPnlFill & Record<string, unknown>;
type DistRow = SchwabDistribution & Record<string, unknown>;

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

function sideTone(side: SchwabPnlFill['side']): 'green' | 'red' | 'gray' {
  if (side === 'buy') return 'green';
  if (side === 'sell') return 'red';
  return 'gray';
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

/**
 * Realized trading PnL curve for a linked Schwab account.
 * Period presets mirror research chart ranges (MTD / YTD / trailing).
 */
export function SchwabPnlSection({
  accountId,
}: {
  accountId: string | null;
}) {
  const [range, setRange] = useState<SchwabPnlRange>('YTD');
  const [points, setPoints] = useState<SchwabPnlPoint[]>([]);
  const [summary, setSummary] = useState<SchwabPnlResponse['summary'] | null>(null);
  const [fills, setFills] = useState<SchwabPnlFill[]>([]);
  const [distributions, setDistributions] = useState<SchwabDistribution[]>([]);
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
  const [lookbackTruncated, setLookbackTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextRange: SchwabPnlRange, nextAccount: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.schwabPnl({
        range: nextRange,
        account: nextAccount ?? undefined,
      });
      setPoints(res.points);
      setSummary(res.summary);
      setFills(Array.isArray(res.fills) ? res.fills : []);
      setDistributions(Array.isArray(res.distributions) ? res.distributions : []);
      setWindowLabel(`${res.start} → ${res.end}`);
      setLookbackTruncated(Boolean(res.lookback_truncated));
      setMayBeTruncated(Boolean(res.may_be_truncated) && !res.lookback_truncated);
    } catch (err) {
      setError(formatApiError(err));
      setPoints([]);
      setSummary(null);
      setFills([]);
      setDistributions([]);
      setWindowLabel(null);
      setLookbackTruncated(false);
      setMayBeTruncated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, accountId);
  }, [accountId, range, load]);

  const periodPnl = summary?.period_pnl ?? 0;
  const hasActivity =
    (summary?.closing_trade_count ?? 0) > 0 ||
    points.some((p) => p.daily_pnl !== 0) ||
    fills.length > 0 ||
    distributions.length > 0;
  const fillRows = fills as FillRow[];
  const distRows = distributions as DistRow[];
  const periodStart = windowLabel?.split(' → ')[0] ?? 'this period';

  return (
    <VStack gap={4} className="portfolio-pnl-section">
      <Text type="supporting">
        Realized trading PnL for positions opened in this period (FIFO). Closes of
        older lots are listed separately so losses from before the window are not
        carried into the chart. Option assignment that delivers stock without an
        option close in Schwab’s TRADE feed is booked as a zero-cash cover so
        short premium is realized. Open mark-to-market, deposits, and withdrawals
        are not included.
      </Text>

      <HStack gap={3} wrap="wrap" justify="between" align="end">
        <VStack gap={0}>
          <Text type="supporting" size="sm">{range} realized</Text>
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
        <ToggleButtonGroup
          label="PnL range"
          type="single"
          size="sm"
          value={range}
          onChange={(value) => {
            if (typeof value === 'string') setRange(value as SchwabPnlRange);
          }}
        >
          {PNL_RANGES.map((key) => (
            <ToggleButton key={key} value={key} label={key} />
          ))}
        </ToggleButtonGroup>
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

      {loading && points.length === 0 && fills.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading Schwab PnL" />
        </HStack>
      ) : !hasActivity ? (
        <Text type="supporting">
          No closed trades with recoverable cost basis in this period.
        </Text>
      ) : (
        <VStack gap={2} className="portfolio-pnl-chart">
          <div className="portfolio-pnl-plot">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
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
                    name === 'cumulative_pnl' ? 'Cumulative' : 'Day',
                  ]}
                />
                <ReferenceLine y={0} stroke="var(--color-border)" />
                <Area
                  type="stepAfter"
                  dataKey="cumulative_pnl"
                  stroke="var(--accent)"
                  fill="var(--accent)"
                  fillOpacity={0.12}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </VStack>
      )}

      {summary && !loading ? (
        <HStack gap={6} wrap="wrap" className="portfolio-summary">
          <VStack gap={0}>
            <Text type="supporting" size="sm">Trades in period</Text>
            <Text hasTabularNumbers weight="semibold">
              {summary.trade_count.toLocaleString()}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Closing fills</Text>
            <Text hasTabularNumbers weight="semibold">
              {summary.closing_trade_count.toLocaleString()}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Period PnL</Text>
            <Text
              hasTabularNumbers
              weight="semibold"
              className={`portfolio-pnl-${pnlTone(summary.period_pnl)}`}
            >
              {moneySigned(summary.period_pnl)}
            </Text>
          </VStack>
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
          {(summary.distributions_total !== 0 || distributions.length > 0) ? (
            <VStack gap={0}>
              <Text type="supporting" size="sm">Dividends / interest</Text>
              <Text
                hasTabularNumbers
                weight="semibold"
                className={`portfolio-pnl-${pnlTone(summary.distributions_total)}`}
              >
                {moneySigned(summary.distributions_total)}
              </Text>
            </VStack>
          ) : null}
        </HStack>
      ) : null}

      {summary && summary.prior_open_pnl !== 0 && !loading ? (
        <Text type="supporting">
          Prior-lot closes are realized P&L on positions opened before{' '}
          {periodStart} and closed inside it — excluded from the chart so
          pre-period losses are not carried forward.
        </Text>
      ) : null}

      {!loading && fillRows.length > 0 ? (
        <VStack gap={2} className="portfolio-pnl-breakdown">
          <Text weight="semibold">Closing fills</Text>
          <Text type="supporting">
            Trades that realized P&L in this window. Fees are from the closing
            fill. Rows tagged prior-lot are excluded from the chart total.
          </Text>
          <Table
            className="portfolio-table"
            data={fillRows}
            idKey="id"
            density="compact"
            dividers="rows"
            hasHover
            textOverflow="truncate"
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
                key: 'side',
                header: 'Side',
                width: pixel(72),
                renderCell: (row) => (
                  <Token color={sideTone(row.side)} label={row.side} size="sm" />
                ),
              },
              {
                key: 'symbol',
                header: 'Symbol',
                width: proportional(1.1),
                renderCell: (row) => (
                  <Text weight="semibold" hasTabularNumbers>{row.symbol ?? '—'}</Text>
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
                header: 'Price',
                width: pixel(88),
                renderCell: (row) => (
                  <Text hasTabularNumbers>{money(row.price)}</Text>
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
                  <Text
                    hasTabularNumbers
                    weight="semibold"
                    className={`portfolio-pnl-${pnlTone(row.realized_pnl)}`}
                  >
                    {moneySigned(row.realized_pnl)}
                  </Text>
                ),
              },
              {
                key: 'opened',
                header: 'Opened',
                width: pixel(110),
                renderCell: (row) => (
                  <Timestamp value={row.opened} format="date" type="body" />
                ),
              },
              {
                key: 'prior_open',
                header: 'Lot',
                width: pixel(88),
                renderCell: (row) => (
                  row.prior_open
                    ? <Token color="gray" label="prior" size="sm" />
                    : <Token color="green" label="period" size="sm" />
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
        </VStack>
      ) : null}

      {!loading && distRows.length > 0 ? (
        <VStack gap={2} className="portfolio-pnl-breakdown">
          <Text weight="semibold">Dividends & interest</Text>
          <Text type="supporting">
            Distributions credited in this window. Not included in the realized
            trading chart above.
          </Text>
          <Table
            className="portfolio-table"
            data={distRows}
            idKey="id"
            density="compact"
            dividers="rows"
            hasHover
            textOverflow="truncate"
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
                key: 'symbol',
                header: 'Symbol',
                width: proportional(1),
                renderCell: (row) => (
                  <Text weight="semibold" hasTabularNumbers>{row.symbol ?? '—'}</Text>
                ),
              },
              {
                key: 'amount',
                header: 'Amount',
                width: pixel(100),
                renderCell: (row) => (
                  <Text
                    hasTabularNumbers
                    weight="semibold"
                    className={`portfolio-pnl-${pnlTone(row.amount)}`}
                  >
                    {row.amount == null ? '—' : moneySigned(row.amount)}
                  </Text>
                ),
              },
              {
                key: 'type',
                header: 'Type',
                width: pixel(140),
                renderCell: (row) => (
                  <Text type="supporting">{row.type ?? '—'}</Text>
                ),
              },
              {
                key: 'description',
                header: 'Description',
                width: proportional(2),
                renderCell: (row) => (
                  <Text type="supporting">{row.description ?? '—'}</Text>
                ),
              },
            ]}
          />
        </VStack>
      ) : null}
    </VStack>
  );
}
