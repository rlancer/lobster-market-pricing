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
  ToggleButton,
  ToggleButtonGroup,
  VStack,
} from '@astryxdesign/core';
import {
  api,
  type SchwabPnlPoint,
  type SchwabPnlRange,
  type SchwabPnlResponse,
} from './api';
import { formatChartTick } from './tickerChartRange';
import './Portfolio.css';

const PNL_RANGES: SchwabPnlRange[] = ['MTD', 'YTD', '1M', '3M', '6M', '1Y'];

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

function pnlTone(n: number | null | undefined): 'green' | 'red' | 'gray' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gray';
  return n > 0 ? 'green' : 'red';
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
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
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
      setWindowLabel(`${res.start} → ${res.end}`);
      setMayBeTruncated(Boolean(res.may_be_truncated));
    } catch (err) {
      setError(formatApiError(err));
      setPoints([]);
      setSummary(null);
      setWindowLabel(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range, accountId);
  }, [accountId, range, load]);

  const periodPnl = summary?.period_pnl ?? 0;
  const hasActivity = (summary?.closing_trade_count ?? 0) > 0 || points.some((p) => p.daily_pnl !== 0);

  return (
    <VStack gap={4} className="portfolio-pnl-section">
      <Text type="supporting">
        Realized trading PnL from closed Schwab trades (FIFO). Open mark-to-market,
        deposits, and withdrawals are not included. Schwab history is capped at
        ~1 year per request.
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

      {mayBeTruncated ? (
        <Text type="supporting">
          Schwab may have truncated trade history (~3000 rows). Some closes may
          lack cost basis in this window.
        </Text>
      ) : null}

      {(summary?.unmatched_close_count ?? 0) > 0 ? (
        <Text type="supporting">
          {summary!.unmatched_close_count.toLocaleString()} closing trade
          {summary!.unmatched_close_count === 1 ? '' : 's'} lacked an in-window
          open and were excluded from realized PnL.
        </Text>
      ) : null}

      {loading && points.length === 0 ? (
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
            <Text type="supporting" size="sm">Trades in ledger</Text>
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
        </HStack>
      ) : null}
    </VStack>
  );
}
