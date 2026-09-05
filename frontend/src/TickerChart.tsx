import { useEffect, useMemo, useState } from 'react';
import { Chart } from '@tanstack/charts/react';
import {
  HStack,
  Spinner,
  Tab,
  TabList,
  TabMenu,
  Text,
  VStack,
} from '@astryxdesign/core';
import { api, type OhlcBar } from './api';
import { defineTickerChart, tickerCloses } from './charts/tickerChart';
import { CHART_HOST_CLASS } from './charts/theme';
import {
  CHART_RANGES,
  type ChartRange,
  chartRangeLabel,
  rangeMove,
  sliceBars,
} from './tickerChartRange';
import { useAsOfDate } from './useAsOfDate';
import './Research.css';
import './charts.css';

const PRIMARY_CHART_RANGES: ChartRange[] = ['1D', 'MTD', 'YTD'];
const OVERFLOW_CHART_RANGES: ChartRange[] = ['1M', '3M', '6M', '1Y', 'ALL'];

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
  const { asOfDate, historical } = useAsOfDate();
  const liveIntraday = range === '1D' && !historical;
  const chartSpot = historical
    ? (sliceBars(bars, '1D', asOfDate)[0]?.close ?? null)
    : spot;

  useEffect(() => {
    if (!liveIntraday) {
      setIntraday(null);
      setIntradayError(null);
      setIntradayLoading(false);
      return;
    }
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
  }, [liveIntraday, ticker]);

  const data = useMemo(() => {
    if (liveIntraday) return intraday ?? [];
    return sliceBars(bars, range, asOfDate);
  }, [liveIntraday, range, bars, intraday, asOfDate]);
  const rows = useMemo(() => tickerCloses(data), [data]);
  const definition = useMemo(
    () => defineTickerChart({ rows, spot: chartSpot, isIntraday: liveIntraday }),
    [rows, chartSpot, liveIntraday],
  );
  const move = useMemo(() => rangeMove(data), [data]);
  const rangeLabel = chartRangeLabel(range);
  const isIntraday = liveIntraday;

  const rangeTabs = (ranges: ChartRange[]) => ranges.map((key) => (
    <Tab key={key} value={key} label={chartRangeLabel(key)} />
  ));

  const onRangeChange = (value: string) => setRange(value as ChartRange);

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
          <TabList
            size="sm"
            aria-label="Chart range"
            value={range}
            onChange={onRangeChange}
          >
            {rangeTabs(CHART_RANGES)}
          </TabList>
        </HStack>
        <HStack gap={1} className="research-chart-ranges-compact">
          <TabList
            size="sm"
            aria-label="Primary chart ranges"
            value={range}
            onChange={onRangeChange}
          >
            {rangeTabs(PRIMARY_CHART_RANGES)}
            <TabMenu
              label="More"
              options={OVERFLOW_CHART_RANGES.map((key) => ({
                value: key,
                label: chartRangeLabel(key),
              }))}
            />
          </TabList>
        </HStack>
      </HStack>
      {historical && data.length === 0 ? (
        <HStack gap={2} vAlign="center" className="research-chart-empty">
          <Text type="supporting">No lake bars on or before {asOfDate}.</Text>
        </HStack>
      ) : isIntraday && intradayLoading && data.length === 0 ? (
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
      ) : historical && range === '1D' ? (
        <VStack gap={2}>
          <Text type="supporting">
            Intraday history is not stored — showing the {asOfDate} daily bar.
          </Text>
          <div className="research-chart-plot">
            <Chart
              definition={definition}
              height={256}
              ariaLabel={`${ticker} ${rangeLabel} close chart as of ${asOfDate}`}
              className={CHART_HOST_CLASS}
            />
          </div>
        </VStack>
      ) : (
        <div className="research-chart-plot">
          <Chart
            definition={definition}
            height={256}
            ariaLabel={`${ticker} ${rangeLabel} ${isIntraday ? 'intraday' : 'close'} chart`}
            className={CHART_HOST_CLASS}
          />
        </div>
      )}
    </VStack>
  );
}
