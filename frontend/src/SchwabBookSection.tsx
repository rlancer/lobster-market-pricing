import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  Grid,
  Heading,
  HStack,
  IconButton,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Text,
  Token,
  Toolbar,
  Typeahead,
  TypeaheadItem,
  useMediaQuery,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import type { SearchableItem, SearchSource } from '@astryxdesign/core/Typeahead';
import { Briefcase, RefreshCw, Search } from 'lucide-react';
import type { SchwabPortfolioAccount, SchwabPortfolioPosition } from './api';
import { SchwabPnlSection } from './SchwabPnlSection';
import {
  formatSignedPercent,
  pnlPercent,
  positionDayPercent,
  positionMatchesQuery,
  positionTicker,
  positionTickerOptions,
} from './schwabPnlView';
import './Portfolio.css';

type SchwabPositionRow = SchwabPortfolioPosition & Record<string, unknown>;
type PositionSearchItem = SearchableItem<{
  description: string | null;
  fromBook: boolean;
}>;

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function qty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function pnlTone(n: number | null | undefined): 'green' | 'red' | 'gray' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gray';
  return n > 0 ? 'green' : 'red';
}

function toSearchItem(
  ticker: string,
  description: string | null,
  fromBook: boolean,
): PositionSearchItem {
  return {
    id: ticker,
    label: ticker,
    auxiliaryData: { description, fromBook },
  };
}

function createPositionSource(
  positions: SchwabPortfolioPosition[],
): SearchSource<PositionSearchItem> {
  const options = positionTickerOptions(positions);
  const items = options.map((row) => toSearchItem(
    row.ticker,
    row.count > 1
      ? `${row.count} open lots${row.description ? ` · ${row.description}` : ''}`
      : row.description,
    true,
  ));
  return {
    search(query: string) {
      const want = query.trim().toUpperCase();
      const matches = want
        ? items.filter((item) => (
          item.id.includes(want)
          || (item.auxiliaryData?.description ?? '').toUpperCase().includes(want)
        ))
        : items;
      if (want && !matches.some((item) => item.id === want)) {
        return [toSearchItem(want, 'Scope performance to this ticker', false), ...matches];
      }
      return matches;
    },
    bootstrap() {
      return items;
    },
  };
}

function KpiCard({
  label,
  value,
  tone,
  percent,
}: {
  label: string;
  value: string;
  tone?: 'green' | 'red' | 'gray';
  percent?: string;
}) {
  return (
    <Card padding={3}>
      <VStack gap={1}>
        <Text type="supporting" size="sm">{label}</Text>
        <Text
          type="large"
          weight="bold"
          hasTabularNumbers
          className={tone ? `portfolio-pnl-${tone}` : undefined}
        >
          {value}
        </Text>
        {percent ? (
          <Token
            size="sm"
            color={tone === 'green' ? 'green' : tone === 'red' ? 'red' : 'gray'}
            label={percent}
          />
        ) : null}
      </VStack>
    </Card>
  );
}

/**
 * Combined Schwab book: account KPIs, performance chart, and open positions.
 * Searching a ticker scopes the chart and the table to that root.
 */
export function SchwabBookSection({
  account,
  summary,
  positions,
  error,
  loading,
  onRefresh,
}: {
  account: SchwabPortfolioAccount | null;
  summary: {
    cash: number | null;
    equity: number | null;
    buying_power: number | null;
    day_pnl: number | null;
    day_pnl_pct?: number | null;
    open_pnl: number | null;
  } | null;
  positions: SchwabPortfolioPosition[];
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [symbol, setSymbol] = useState('');
  const isMobile = useMediaQuery('(max-width: 47.99rem)');
  const searchSource = useMemo(() => createPositionSource(positions), [positions]);
  const selected = useMemo(
    () => (symbol ? toSearchItem(symbol, null, true) : null),
    [symbol],
  );
  const visibleRows = useMemo(
    () => positions.filter((row) => positionMatchesQuery(row, symbol)) as SchwabPositionRow[],
    [positions, symbol],
  );

  const setTicker = (next: string) => {
    setSymbol(next.trim().toUpperCase());
  };

  const dayPct = summary
    ? (summary.day_pnl_pct ?? pnlPercent(summary.day_pnl, summary.equity))
    : null;
  const kpiItems = summary
    ? [
        { label: 'Cash', value: money(summary.cash) },
        { label: 'Equity', value: money(summary.equity) },
        { label: 'Buying power', value: money(summary.buying_power) },
        {
          label: 'Day PnL',
          value: money(summary.day_pnl),
          tone: pnlTone(summary.day_pnl),
          percent: dayPct != null ? formatSignedPercent(dayPct) : undefined,
        },
        { label: 'Open PnL', value: money(summary.open_pnl), tone: pnlTone(summary.open_pnl) },
      ] as const
    : [];

  const openPositions = (
    <VStack gap={2} as="section" aria-label="Open positions">
      <HStack gap={2} wrap="wrap" justify="between" vAlign="center">
        <Heading level={2}>Open positions</Heading>
        {symbol ? (
          <Token color="blue" size="sm" label={symbol} />
        ) : (
          <Text type="supporting" size="sm">
            {positions.length.toLocaleString()} open
          </Text>
        )}
      </HStack>

      {visibleRows.length === 0 ? (
        <EmptyState
          headingLevel={3}
          isCompact
          icon={<Briefcase size={24} />}
          title={symbol
            ? `No open ${symbol} positions`
            : account
              ? `No open positions in ${account.account_number_masked}`
              : 'No linked Schwab accounts returned.'}
          description={symbol
            ? 'Clear the search to see the whole book, or pick another ticker to scope performance.'
            : 'Connected accounts with no holdings still show account P&L above.'}
          actions={symbol ? (
            <Button
              size="sm"
              variant="secondary"
              label="Clear search"
              onClick={() => setTicker('')}
            />
          ) : undefined}
        />
      ) : isMobile ? (
        <List density="compact" hasDividers header={`${visibleRows.length.toLocaleString()} positions`}>
          {visibleRows.map((row) => {
            const root = positionTicker(row);
            return (
              <ListItem
                key={row.id}
                isSelected={symbol === root}
                label={row.symbol}
                description={row.description ?? row.asset_type ?? undefined}
                endContent={(
                  <VStack gap={0} align="end">
                    <Text
                      hasTabularNumbers
                      className={`portfolio-pnl-${pnlTone(row.open_pnl)}`}
                    >
                      {money(row.open_pnl)}
                    </Text>
                    <Text
                      type="supporting"
                      size="sm"
                      hasTabularNumbers
                      className={`portfolio-pnl-${pnlTone(row.day_pnl)}`}
                    >
                      {formatSignedPercent(positionDayPercent(row))} DTD
                    </Text>
                  </VStack>
                )}
                onClick={() => setTicker(symbol === root ? '' : root)}
              />
            );
          })}
        </List>
      ) : (
        <Table
          className="portfolio-table"
          data={visibleRows}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'symbol',
              header: 'Symbol',
              width: pixel(120),
              renderCell: (row) => {
                const root = positionTicker(row);
                return (
                  <VStack gap={1}>
                    <Button
                      size="sm"
                      variant={symbol === root ? 'primary' : 'ghost'}
                      label={row.symbol}
                      onClick={() => setTicker(symbol === root ? '' : root)}
                    />
                    {row.description ? (
                      <Text type="supporting" size="sm" className="portfolio-legs">
                        {row.description}
                      </Text>
                    ) : null}
                  </VStack>
                );
              },
            },
            {
              key: 'asset_type',
              header: 'Type',
              width: pixel(100),
              renderCell: (row) => (
                row.asset_type ? (
                  <Token label={row.asset_type} color="gray" size="sm" />
                ) : (
                  <Text type="supporting" size="sm">—</Text>
                )
              ),
            },
            {
              key: 'quantity',
              header: 'Qty',
              width: pixel(88),
              renderCell: (row) => (
                <Text hasTabularNumbers size="sm">{qty(row.quantity)}</Text>
              ),
            },
            {
              key: 'average_price',
              header: 'Avg',
              width: pixel(100),
              renderCell: (row) => (
                <Text hasTabularNumbers size="sm">{money(row.average_price)}</Text>
              ),
            },
            {
              key: 'market_value',
              header: 'Mark',
              width: proportional(1),
              renderCell: (row) => (
                <Text hasTabularNumbers size="sm">{money(row.market_value)}</Text>
              ),
            },
            {
              key: 'day_pnl',
              header: 'Day PnL',
              width: pixel(100),
              renderCell: (row) => (
                <VStack gap={0}>
                  <Text
                    hasTabularNumbers
                    size="sm"
                    className={`portfolio-pnl-${pnlTone(row.day_pnl)}`}
                  >
                    {money(row.day_pnl)}
                  </Text>
                  <Text
                    type="supporting"
                    size="sm"
                    hasTabularNumbers
                    className={`portfolio-pnl-${pnlTone(row.day_pnl)}`}
                  >
                    {formatSignedPercent(positionDayPercent(row))}
                  </Text>
                </VStack>
              ),
            },
            {
              key: 'open_pnl',
              header: 'Open PnL',
              width: pixel(100),
              renderCell: (row) => (
                <Text
                  hasTabularNumbers
                  size="sm"
                  className={`portfolio-pnl-${pnlTone(row.open_pnl)}`}
                >
                  {money(row.open_pnl)}
                </Text>
              ),
            },
          ]}
        />
      )}
    </VStack>
  );

  return (
    <VStack gap={isMobile ? 3 : 5} className="portfolio-schwab-book">
      {error ? (
        <Banner status="error" title="Could not load Schwab portfolio" description={error} />
      ) : null}

      {summary && isMobile ? (
        <MetadataList orientation="horizontal" label={{ position: 'top' }}>
          {kpiItems.map((item) => (
            <MetadataListItem key={item.label} label={item.label}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text
                  hasTabularNumbers
                  weight="bold"
                  className={'tone' in item ? `portfolio-pnl-${item.tone}` : undefined}
                >
                  {item.value}
                </Text>
                {'percent' in item && item.percent ? (
                  <Token
                    size="sm"
                    color={item.tone === 'green' ? 'green' : item.tone === 'red' ? 'red' : 'gray'}
                    label={item.percent}
                  />
                ) : null}
              </HStack>
            </MetadataListItem>
          ))}
        </MetadataList>
      ) : summary ? (
        <Grid gap={3} columns={{ minWidth: 160, max: 5, repeat: 'fit' }}>
          {kpiItems.map((item) => (
            <KpiCard
              key={item.label}
              label={item.label}
              value={item.value}
              tone={'tone' in item ? item.tone : undefined}
              percent={'percent' in item ? item.percent : undefined}
            />
          ))}
        </Grid>
      ) : null}

      <Toolbar
        label="Schwab book"
        size="sm"
        startContent={(
          <Typeahead
            label="Position"
            isLabelHidden
            size="sm"
            width={isMobile ? '100%' : 280}
            startIcon={Search}
            searchSource={searchSource}
            value={selected}
            onChange={(item) => setTicker(item?.id ?? '')}
            placeholder="Filter a position…"
            hasEntriesOnFocus
            hasClear
            isOptional
            maxMenuItems={10}
            emptySearchResultsText="No matching positions"
            renderItem={(item) => (
              <TypeaheadItem
                item={item}
                description={item.auxiliaryData?.description ?? undefined}
                group={item.auxiliaryData?.fromBook ? 'Open positions' : 'Ticker'}
              />
            )}
          />
        )}
        endContent={(
          <IconButton
            size="sm"
            variant="ghost"
            label="Refresh"
            tooltip="Refresh balances and positions"
            icon={<RefreshCw size={16} />}
            isDisabled={loading}
            onClick={onRefresh}
          />
        )}
      />

      <VStack gap={isMobile ? 2 : 3}>
        {isMobile ? null : (
          <VStack gap={1}>
            <Heading level={2}>Performance</Heading>
            <Text type="supporting">
              {symbol
                ? `Full ${symbol} P&L — realized stock and options on that root, plus the live open mark.`
                : 'Realized P&L for the whole account. Search a ticker to unify equity and option fills.'}
              {' '}
              <Link to="/docs/schwab-pnl" className="portfolio-link">How this is calculated</Link>.
            </Text>
          </VStack>
        )}
        <SchwabPnlSection
          accountId={account?.id ?? null}
          symbol={symbol}
          onSymbolChange={setTicker}
          hideSymbolInput
          positions={positions}
          accountEquity={summary?.equity ?? null}
          accountDayPnl={summary?.day_pnl ?? null}
          accountDayPnlPct={summary?.day_pnl_pct ?? null}
          afterChart={openPositions}
        />
      </VStack>
    </VStack>
  );
}
