import { useMemo, useState } from 'react';
import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { HStack, Text, ToggleButton, ToggleButtonGroup, VStack } from '@astryxdesign/core';
import type { OhlcBar } from './api';
import {
  CHART_RANGES,
  type ChartRange,
  rangeMove,
  sliceBars,
} from './tickerChartRange';
import './Research.css';

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
}: {
  bars: OhlcBar[];
  spot: number | null;
}) {
  const [range, setRange] = useState<ChartRange>('3M');
  const data = useMemo(() => sliceBars(bars, range), [bars, range]);
  const move = useMemo(() => rangeMove(data), [data]);
  const rangeLabel = range === 'ALL' ? 'All' : range;

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
        <ToggleButtonGroup
          label="Chart range"
          type="single"
          size="sm"
          value={range}
          onChange={(value) => {
            if (typeof value === 'string') setRange(value as ChartRange);
          }}
        >
          {CHART_RANGES.map((key) => (
            <ToggleButton key={key} value={key} label={key === 'ALL' ? 'All' : key} />
          ))}
        </ToggleButtonGroup>
      </HStack>
      <div className="research-chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              minTickGap={48}
              tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }}
              tickFormatter={(d: string) => (typeof d === 'string' ? d.slice(5) : String(d))}
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
              labelFormatter={(d) => `Close · ${String(d)}`}
              formatter={(v) => [fmtNum(v as number, 2), 'close']}
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
    </VStack>
  );
}
