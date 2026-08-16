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
import './Research.css';

export type ChartRange = '1M' | '3M' | '6M' | '1Y' | 'ALL';

const RANGE_BARS: Record<ChartRange, number | null> = {
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252,
  ALL: null,
};

const RANGES: ChartRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

function fmtNum(v: number | null | undefined, d = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sliceBars(bars: OhlcBar[], range: ChartRange): OhlcBar[] {
  const n = RANGE_BARS[range];
  if (n == null || bars.length <= n) return bars;
  return bars.slice(-n);
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
        <Text type="supporting" className="research-chart-label">Close</Text>
        <ToggleButtonGroup
          label="Chart range"
          type="single"
          size="sm"
          value={range}
          onChange={(value) => {
            if (typeof value === 'string') setRange(value as ChartRange);
          }}
        >
          {RANGES.map((key) => (
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
