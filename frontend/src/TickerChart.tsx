import { useEffect, useMemo, useState } from 'react';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  DropdownMenu,
  HStack,
  Spinner,
  Text,
  ToggleButton,
  ToggleButtonGroup,
  VStack,
} from '@astryxdesign/core';
import { api, type OhlcBar } from './api';
import {
  CHART_RANGES,
  type ChartRange,
  chartRangeLabel,
  formatChartTick,
  rangeMove,
  sliceBars,
} from './tickerChartRange';
import './Research.css';

const PRIMARY_CHART_RANGES: ChartRange[] = ['1D', 'MTD', 'YTD'];
const OVERFLOW_CHART_RANGES: ChartRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

function fmtNum(v: number | null | undefined, d = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtPct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtAbsChange(v: number): string {
  const sign = v >= 0 ? '+' : '−';
  return `${sign}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function changeClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

export function TickerChart({
  bars,
  spot,
  ticker,
}: {
  bars: OhlcBar[];
  spot: number | null;
  ticker: string;
}) {
  const [range, setRange] = useState<ChartRange>('YTD');
  const [intraday, setIntraday] = useState<OhlcBar[] | null>(null);
  const [intradayLoading, setIntradayLoading] = useState(false);
  const [intradayError, setIntradayError] = useState<string | null>(null);

  useEffect(() => {
    if (range !== '1D') return;
    let active = true;
    setIntradayLoading(true);
    setIntradayError(null);
    api.symbolDetail(ticker, { parts: 'ohlc_intraday' })
      .then((detail) => {
        if (!active) return;
        setIntraday(detail.ohlc ?? []);
      })
      .catch((e) => {
        if (!active) return;
        setIntraday([]);
        setIntradayError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setIntradayLoading(false);
      });
    return () => { active = false; };
  }, [range, ticker]);

  const data = useMemo(() => {
    if (range === '1D') return intraday ?? [];
    return sliceBars(bars, range);
  }, [range, bars, intraday]);
  const move = useMemo(() => rangeMove(data), [data]);
  const rangeLabel = chartRangeLabel(range);
  const isIntraday = range === '1D';
  const overflowRangeSelected = OVERFLOW_CHART_RANGES.includes(range);

  const rangeButtons = (ranges: ChartRange[]) => ranges.map((key) => (
    <ToggleButton key={key} value={key} label={chartRangeLabel(key)} />
  ));

  if (bars.length === 0) {
    return (
      <VStack gap={2} className="research-chart research-chart-empty">
        <Text type="supporting">No daily bars in the lake for this ticker yet.</Text>
      </VStack>
    );
  }

  return (
    <VStack gap={3} className="research-chart">
      <HStack gap={3} vAlign="center" className="research-chart-toolbar">
        <VStack gap={0} className="research-chart-move">
          <Text type="supporting" className="research-chart-label">{rangeLabel} move</Text>
          {move ? (
            <HStack gap={2} vAlign="end" className="research-chart-move-row">
              <Text className={`research-chart-pct ${changeClass(move.pct)}`}>
                {fmtPct(move.pct)}
              </Text>
              <Text type="supporting" className="research-chart-abs">
                {fmtAbsChange(move.abs)}
              </Text>
            </HStack>
          ) : (
            <Text className="research-chart-pct">—</Text>
          )}
        </VStack>
        <HStack className="research-chart-ranges-full">
          <ToggleButtonGroup
            label="Chart range"
            type="single"
            size="sm"
            value={range}
            onChange={(value) => {
              if (typeof value === 'string') setRange(value as ChartRange);
            }}
          >
            {rangeButtons(CHART_RANGES)}
          </ToggleButtonGroup>
        </HStack>
        <HStack gap={1} className="research-chart-ranges-compact">
          <ToggleButtonGroup
            label="Primary chart ranges"
            type="single"
            size="sm"
            value={range}
            onChange={(value) => {
              if (typeof value === 'string') setRange(value as ChartRange);
            }}
          >
            {rangeButtons(PRIMARY_CHART_RANGES)}
          </ToggleButtonGroup>
          <DropdownMenu
            button={{
              label: overflowRangeSelected ? chartRangeLabel(range) : 'More',
              variant: overflowRangeSelected ? 'secondary' : 'ghost',
              size: 'sm',
            }}
            menuWidth="8rem"
            items={OVERFLOW_CHART_RANGES.map((key) => ({
              label: chartRangeLabel(key),
              onClick: () => setRange(key),
            }))}
          />
        </HStack>
      </HStack>
      {isIntraday && intradayLoading && data.length === 0 ? (
        <HStack gap={2} vAlign="center" className="research-chart-empty">
          <Spinner size="sm" />
          <Text type="supporting">Loading intraday…</Text>
        </HStack>
      ) : isIntraday && !intradayLoading && data.length === 0 ? (
        <HStack gap={2} vAlign="center" className="research-chart-empty">
          <Text type="supporting">
            {intradayError ? 'Intraday bars unavailable right now.' : 'No intraday bars for this session yet.'}
          </Text>
        </HStack>
      ) : (
        <div className="research-chart-plot">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                minTickGap={isIntraday ? 36 : 48}
                tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                tickFormatter={formatChartTick}
              />
              <YAxis
                domain={['auto', 'auto']}
                axisLine={false}
                tickLine={false}
                width={48}
                tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
                tickFormatter={(v: number) => fmtNum(v, 0)}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--panel)',
                  border: 'var(--border-width) solid var(--color-border)',
                  borderRadius: 'var(--radius-element)',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-primary)',
                }}
                labelFormatter={(d) =>
                  isIntraday ? `Price · ${String(d)}` : `Close · ${String(d)}`
                }
                formatter={(v) => [fmtNum(v as number, 2), isIntraday ? 'price' : 'close']}
              />
              {spot != null && (
                <ReferenceLine
                  y={spot}
                  stroke="var(--accent)"
                  strokeDasharray="3 3"
                  label={{
                    value: `spot ${fmtNum(spot)}`,
                    position: 'insideTopRight',
                    fontSize: 10,
                    fill: 'var(--accent)',
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="close"
                stroke="var(--accent)"
                dot={false}
                strokeWidth={1.5}
                connectNulls
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </VStack>
  );
}
