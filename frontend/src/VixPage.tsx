import { useEffect, useMemo, useState } from 'react';
import { Chart } from '@tanstack/charts/react';
import {
  Card,
  Grid,
  Heading,
  HStack,
  Spinner,
  Tab,
  TabList,
  Text,
  Token,
  ToggleButton,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { api, type VixCurvePoint, type VixCurveShape, type VixIndexPrint, type VixTerm } from './api';
import { AsOfDateField } from './AsOfDateField';
import { CHART_HOST_CLASS } from './charts/theme';
import { defineVixTermChart, vixTermPlotRows } from './charts/vixTermChart';
import { useAsOfDate } from './useAsOfDate';
import { usePageMeta } from './usePageMeta';
import {
  changeTone,
  defaultOverlayDate,
  formatVixPct,
  formatVixPts,
  formatVixPx,
  shortVixDate,
} from './vixPage';
import './VixPage.css';
import './charts.css';

type Pane = 'term' | 'history';

type ContractRow = VixCurvePoint & { id: string; vs_prior_pct: number | null } & Record<string, unknown>;
type HistoryRow = { id: string; date: string } & Record<string, unknown>;

function shapeToken(shape: VixCurveShape): { label: string; color: 'teal' | 'orange' | 'yellow' | 'gray' } {
  if (shape === 'contango') return { label: 'Contango', color: 'teal' };
  if (shape === 'backwardation') return { label: 'Backwardation', color: 'orange' };
  if (shape === 'mixed') return { label: 'Mixed', color: 'yellow' };
  return { label: 'Unknown', color: 'gray' };
}

function ChangeText({ value }: { value: number | null }) {
  return (
    <Text hasTabularNumbers className={`vix-change ${changeTone(value)}`}>
      {formatVixPct(value)}
    </Text>
  );
}

function IndexCard({ print, note }: { print: VixIndexPrint; note?: string }) {
  return (
    <Card variant="muted" padding={4}>
      <VStack gap={1}>
        <Text type="supporting">{print.name}</Text>
        <Text className="vix-index-last">{formatVixPx(print.last)}</Text>
        <ChangeText value={print.change_pct} />
        {note ? <Text type="supporting">{note}</Text> : null}
      </VStack>
    </Card>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'up' | 'down' | 'flat';
}) {
  return (
    <Card padding={4}>
      <VStack gap={1}>
        <Text type="supporting">{label}</Text>
        <Text className={`vix-metric-value ${tone && tone !== 'flat' ? `vix-change ${tone}` : ''}`}>
          {value}
        </Text>
        <Text type="supporting">{hint}</Text>
      </VStack>
    </Card>
  );
}

function contractRows(curve: VixCurvePoint[]): ContractRow[] {
  return curve.map((point, index) => {
    const prior = index > 0 ? curve[index - 1] : null;
    const vsPrior = prior?.last != null && point.last != null && prior.last !== 0
      ? ((point.last - prior.last) / prior.last) * 100
      : null;
    return {
      ...point,
      id: `${point.kind}:${point.symbol}:${point.tenor}`,
      vs_prior_pct: vsPrior,
    };
  });
}

function historyRows(term: VixTerm): { rows: HistoryRow[]; maxTenor: number } {
  let maxTenor = 0;
  const rows: HistoryRow[] = term.history.map((curve) => {
    const row: HistoryRow = { id: curve.date, date: curve.date };
    for (const point of curve.points) {
      if (point.tenor > maxTenor) maxTenor = point.tenor;
      row[point.tenor === 0 ? 'spot' : `m${point.tenor}`] = point.last;
    }
    return row;
  });
  return { rows, maxTenor };
}

export default function VixPage() {
  const { asOf, historical } = useAsOfDate();
  const [term, setTerm] = useState<VixTerm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('term');
  const [overlay, setOverlay] = useState<string[]>([]);

  usePageMeta({
    description:
      'VX futures term structure — front two monthals for tradable vol, cash VIX as context only.',
  });

  useEffect(() => {
    let active = true;
    setError(null);
    api.vixTerm({ asof: asOf })
      .then((next) => {
        if (!active) return;
        setTerm(next);
        const prev = defaultOverlayDate(next.as_of, next.settlement_dates);
        setOverlay(prev ? [prev] : []);
      })
      .catch((e) => {
        if (!active) return;
        setTerm(null);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => { active = false; };
  }, [asOf]);

  const stale = Boolean(asOf && term && term.as_of !== asOf);
  const view = term && !stale ? term : null;
  const primaryLabel = view
    ? (view.source === 'quotes' && !historical ? 'Live' : view.as_of)
    : 'Live';
  const plotRows = useMemo(
    () => view
      ? vixTermPlotRows({
        primaryLabel,
        curve: view.curve,
        history: view.history,
        overlayDates: overlay,
      })
      : [],
    [view, primaryLabel, overlay],
  );
  const chart = useMemo(
    () => (plotRows.length ? defineVixTermChart(plotRows) : null),
    [plotRows],
  );
  const contracts = view ? contractRows(view.curve) : [];
  const history = view ? historyRows(view) : { rows: [], maxTenor: 0 };
  const overlayChoices = (view?.settlement_dates ?? []).filter((date) => date !== view?.as_of).slice(0, 12);

  return (
    <VStack className="vix-page content-column" gap={4}>
      <VStack gap={2}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <Heading level={1}>VIX term structure</Heading>
          {view ? <Token {...shapeToken(view.metrics.shape)} size="sm" /> : null}
        </HStack>
        <Text type="supporting">
          Cash VIX is a calculated index, not a tradable contract. Calculation noise can look like
          a crush or spike that VX futures never printed. Read the front two VX monthals for
          changes in vol; the rest of the curve is the term structure.
        </Text>
        <AsOfDateField description="Replay official VX settlements as of this ET date." />
      </VStack>

      {!view && !error ? (
        <HStack gap={3} vAlign="center">
          <Spinner size="md" label="Loading VIX term structure" />
        </HStack>
      ) : null}
      {error ? <Text>{error}</Text> : null}

      {view ? (
        <VStack gap={4}>
          <Grid
            gap={3}
            columns={{ minWidth: 160, max: 4, repeat: 'fit' }}
            aria-label="Vol indexes"
          >
            <IndexCard print={view.indexes.vix} note="Not tradable" />
            <IndexCard print={view.indexes.vix9d} />
            <IndexCard print={view.indexes.vix3m} />
            <IndexCard print={view.indexes.vvix} />
          </Grid>

          <Grid
            gap={3}
            columns={{ minWidth: 160, max: 5, repeat: 'fit' }}
            aria-label="Curve metrics"
          >
            <MetricCard
              label="M1–M2"
              value={`${formatVixPts(view.metrics.m1_m2_pts)}  ${formatVixPct(view.metrics.m1_m2_pct)}`}
              hint="Front two VX monthals — tradable vol"
              tone={changeTone(view.metrics.m1_m2_pct)}
            />
            <MetricCard
              label="M2–M3"
              value={formatVixPct(view.metrics.m2_m3_pct)}
              hint="Second to third monthly"
              tone={changeTone(view.metrics.m2_m3_pct)}
            />
            <MetricCard
              label="M4–M7"
              value={formatVixPct(view.metrics.m4_m7_pct)}
              hint="Mid-curve contango (month 7 vs 4)"
              tone={changeTone(view.metrics.m4_m7_pct)}
            />
            <MetricCard
              label="Cash vs M1"
              value={formatVixPct(view.metrics.vix_vs_m1_pct)}
              hint="Spot VIX basis vs the front monthly — not a vol change"
            />
            <MetricCard
              label="VIX vs VIX3M"
              value={formatVixPct(view.metrics.vix_vs_vix3m_pct)}
              hint="Cash 30-day vs 3-month vol indexes"
            />
          </Grid>

          <TabList
            size="sm"
            aria-label="VIX views"
            value={pane}
            onChange={(value) => setPane(value as Pane)}
          >
            <Tab value="term" label="Term months" />
            <Tab value="history" label="Historical prices" />
          </TabList>

          {pane === 'term' ? (
            <VStack gap={3}>
              {overlayChoices.length > 0 ? (
                <VStack gap={2}>
                  <Text type="supporting">Overlay settlement dates</Text>
                  <HStack gap={2} wrap="wrap" className="vix-dates">
                    {overlayChoices.map((date) => (
                      <ToggleButton
                        key={date}
                        size="sm"
                        label={shortVixDate(date)}
                        isPressed={overlay.includes(date)}
                        onPressedChange={(pressed) => {
                          setOverlay((current) => {
                            if (!pressed) return current.filter((item) => item !== date);
                            if (current.includes(date) || current.length >= 8) return current;
                            return [...current, date];
                          });
                        }}
                      />
                    ))}
                  </HStack>
                </VStack>
              ) : null}

              <VStack gap={2} className="vix-chart">
                {chart && plotRows.length > 0 ? (
                  <VStack gap={0} className="vix-chart-plot">
                    <Chart
                      definition={chart}
                      height={288}
                      ariaLabel="VX futures term structure"
                      className={CHART_HOST_CLASS}
                    />
                  </VStack>
                ) : (
                  <Text type="supporting">No VX monthals in the lake for this date yet.</Text>
                )}
                <Text type="supporting">
                  {view.source === 'quotes'
                    ? `Delayed CFE monthals as of ${view.as_of}. X-axis is constant-maturity tenor (Spot, M1, M2…), not calendar month.`
                    : `Official VX settlements as of ${view.as_of}. X-axis is constant-maturity tenor (Spot, M1, M2…).`}
                </Text>
              </VStack>

              {contracts.length > 0 ? (
                <Table
                  className="vix-table"
                  data={contracts}
                  idKey="id"
                  density="compact"
                  dividers="grid"
                  hasHover
                  textOverflow="truncate"
                  columns={[
                    {
                      key: 'label',
                      header: 'Month',
                      width: proportional(1.2),
                      renderCell: (row) => <Text weight="semibold">{row.label}</Text>,
                    },
                    {
                      key: 'symbol',
                      header: 'Symbol',
                      width: pixel(88),
                      renderCell: (row) => <Text hasTabularNumbers>{row.symbol}</Text>,
                    },
                    {
                      key: 'last',
                      header: 'Last',
                      width: pixel(80),
                      align: 'end',
                      renderCell: (row) => <Text hasTabularNumbers>{formatVixPx(row.last)}</Text>,
                    },
                    {
                      key: 'change_pct',
                      header: '1d',
                      width: pixel(88),
                      align: 'end',
                      renderCell: (row) => <ChangeText value={row.change_pct} />,
                    },
                    {
                      key: 'vs_prior_pct',
                      header: 'vs prior',
                      width: pixel(88),
                      align: 'end',
                      renderCell: (row) => <ChangeText value={row.vs_prior_pct} />,
                    },
                    {
                      key: 'dte',
                      header: 'DTE',
                      width: pixel(64),
                      align: 'end',
                      renderCell: (row) => (
                        <Text hasTabularNumbers>{row.dte == null ? '—' : String(row.dte)}</Text>
                      ),
                    },
                    {
                      key: 'volume',
                      header: 'Vol',
                      width: pixel(88),
                      align: 'end',
                      renderCell: (row) => (
                        <Text hasTabularNumbers>
                          {row.volume == null ? '—' : Math.round(row.volume).toLocaleString()}
                        </Text>
                      ),
                    },
                    {
                      key: 'open_interest',
                      header: 'OI',
                      width: pixel(88),
                      align: 'end',
                      renderCell: (row) => (
                        <Text hasTabularNumbers>
                          {row.open_interest == null ? '—' : Math.round(row.open_interest).toLocaleString()}
                        </Text>
                      ),
                    },
                  ]}
                />
              ) : null}
            </VStack>
          ) : (
            <VStack gap={2}>
              <Text type="supporting">
                Official daily settlements, constant-maturity (Spot / M1 / M2…). Newest first.
              </Text>
              {history.rows.length === 0 ? (
                <Text type="supporting">No settlement history in the lake yet.</Text>
              ) : (
                <Table
                  className="vix-table"
                  data={history.rows}
                  idKey="id"
                  density="compact"
                  dividers="grid"
                  hasHover
                  textOverflow="truncate"
                  columns={[
                    {
                      key: 'date',
                      header: 'Date',
                      width: pixel(108),
                      renderCell: (row) => <Text weight="semibold">{row.date as string}</Text>,
                    },
                    {
                      key: 'spot',
                      header: 'Spot',
                      width: pixel(72),
                      align: 'end',
                      renderCell: (row) => <Text hasTabularNumbers>{formatVixPx(row.spot as number | null)}</Text>,
                    },
                    ...Array.from({ length: history.maxTenor }, (_, i) => {
                      const tenor = i + 1;
                      const key = `m${tenor}`;
                      return {
                        key,
                        header: `M${tenor}`,
                        width: pixel(72),
                        align: 'end' as const,
                        renderCell: (row: HistoryRow) => (
                          <Text hasTabularNumbers>{formatVixPx(row[key] as number | null)}</Text>
                        ),
                      };
                    }),
                  ]}
                />
              )}
            </VStack>
          )}

          {view.errors.length > 0 ? (
            <Text type="supporting">Notes: {view.errors.join('; ')}</Text>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
}
