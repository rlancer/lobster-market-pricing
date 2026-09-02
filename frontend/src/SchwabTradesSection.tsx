import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  HStack,
  Spinner,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { DateRangeInput, type DateRange } from '@astryxdesign/core/DateRangeInput';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import {
  api,
  type SchwabTrade,
  type SchwabTradesResponse,
} from './api';

type TradeRow = SchwabTrade & Record<string, unknown>;

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

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function defaultRange(): DateRange {
  return {
    start: isoDaysAgo(90) as ISODateString,
    end: isoToday() as ISODateString,
  };
}

function sideTone(side: SchwabTrade['side']): 'green' | 'red' | 'gray' {
  if (side === 'buy') return 'green';
  if (side === 'sell') return 'red';
  return 'gray';
}

/**
 * Historical TRADE explorer for a linked Schwab account.
 * Parent Portfolio Schwab tab owns connect / account selection.
 */
export function SchwabTradesSection({
  accountId,
}: {
  /** Opaque portfolio account id (`schwab-0-1234`). */
  accountId: string | null;
}) {
  const [range, setRange] = useState<DateRange | null>(() => defaultRange());
  const [symbol, setSymbol] = useState('');
  const [trades, setTrades] = useState<SchwabTrade[]>([]);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTrades = useCallback(async (
    nextRange: DateRange | null,
    nextAccount: string | null,
    nextSymbol: string,
  ) => {
    if (!nextRange?.start || !nextRange?.end) {
      setError('Pick a start and end date (max 366 days).');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res: SchwabTradesResponse = await api.schwabTrades({
        start: nextRange.start,
        end: nextRange.end,
        account: nextAccount ?? undefined,
        symbol: nextSymbol.trim() || undefined,
      });
      setTrades(res.trades);
      setMayBeTruncated(Boolean(res.may_be_truncated));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTrades(range, accountId, symbol);
    // Reload when the selected Schwab account changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional account-driven reload
  }, [accountId]);

  const rows = trades as TradeRow[];

  return (
    <VStack gap={4}>
      <Text type="supporting">
        Live TRADE history from Schwab (up to 366 days per request). A ticker
        such as CAR includes that equity and options on the same root. Use
        Performance for the realized PnL chart.
      </Text>

      <HStack gap={3} wrap="wrap" align="end">
        <DateRangeInput
          label="Trade dates"
          size="sm"
          value={range}
          onChange={setRange}
          hasClear={false}
          max={isoToday() as ISODateString}
          width={280}
          presets={[
            {
              label: 'Last 30 days',
              getRange: () => ({
                start: isoDaysAgo(30) as ISODateString,
                end: isoToday() as ISODateString,
              }),
            },
            {
              label: 'Last 90 days',
              getRange: () => defaultRange(),
            },
            {
              label: 'Last 365 days',
              getRange: () => ({
                start: isoDaysAgo(365) as ISODateString,
                end: isoToday() as ISODateString,
              }),
            },
          ]}
        />
        <TextInput
          label="Symbol"
          size="sm"
          width={140}
          value={symbol}
          onChange={setSymbol}
          placeholder="CAR"
          isOptional
          hasClear
        />
        <Button
          size="sm"
          variant="primary"
          label={loading ? 'Loading…' : 'Apply'}
          isDisabled={loading}
          onClick={() => void loadTrades(range, accountId, symbol)}
        />
      </HStack>

      {error ? (
        <Text className="portfolio-error" role="alert">{error}</Text>
      ) : null}

      {mayBeTruncated ? (
        <Text type="supporting">
          Schwab may have truncated this window (~3000 rows). Narrow the date
          range or filter by symbol.
        </Text>
      ) : null}

      {loading && rows.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading Schwab trades" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          No trades in this range{symbol.trim() ? ` for ${symbol.trim().toUpperCase()}` : ''}.
        </Text>
      ) : (
        <Table
          className="portfolio-table"
          data={rows}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'trade_date',
              header: 'Date',
              width: pixel(120),
              renderCell: (row) => (
                row.trade_date
                  ? <Timestamp value={row.trade_date} format="date" type="body" />
                  : <Text>—</Text>
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
              width: proportional(1.2),
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
              key: 'asset_type',
              header: 'Asset',
              width: pixel(88),
              renderCell: (row) => (
                <Text type="supporting">{row.asset_type ?? '—'}</Text>
              ),
            },
            {
              key: 'description',
              header: 'Description',
              width: proportional(1.6),
              renderCell: (row) => (
                <Text type="supporting">{row.description ?? '—'}</Text>
              ),
            },
          ]}
        />
      )}

      {!loading && rows.length > 0 ? (
        <Text type="supporting">{rows.length.toLocaleString()} trade{rows.length === 1 ? '' : 's'}</Text>
      ) : null}
    </VStack>
  );
}
