import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Spinner,
  Text,
  Token,
  VStack,
} from '@astryxdesign/core';
import { DateRangeInput, type DateRange } from '@astryxdesign/core/DateRangeInput';
import type { ISODateString } from '@astryxdesign/core/Calendar';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Selector } from '@astryxdesign/core/Selector';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import {
  api,
  type SchwabAccountSummary,
  type SchwabStatus,
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
 * Live Schwab TRADE history explorer. Reads through the Worker (tokens never
 * leave the server). Foundation for later performance tracking — no persistence yet.
 */
export function SchwabTradesSection() {
  const [status, setStatus] = useState<SchwabStatus | null>(null);
  const [range, setRange] = useState<DateRange | null>(() => defaultRange());
  const [symbol, setSymbol] = useState('');
  const [accountHash, setAccountHash] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SchwabAccountSummary[]>([]);
  const [trades, setTrades] = useState<SchwabTrade[]>([]);
  const [mayBeTruncated, setMayBeTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('schwab');
    if (flag === 'connected') setBanner('Schwab account connected.');
    else if (flag === 'error') {
      const detail = params.get('schwab_error');
      setBanner(detail ? `Could not connect Schwab (${detail}).` : 'Could not connect Schwab.');
    }
    if (flag) {
      params.delete('schwab');
      params.delete('schwab_error');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', next);
    }
  }, []);

  useEffect(() => {
    let active = true;
    api.schwabStatus()
      .then((s) => { if (active) setStatus(s); })
      .catch((err) => {
        if (active) setError(String((err as Error)?.message ?? err));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

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
      setAccounts(res.accounts);
      setAccountHash(res.account);
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
    if (!status?.connected) return;
    void loadTrades(range, accountHash, symbol);
    // Initial load when connected; subsequent loads via Apply / account change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot on connect
  }, [status?.connected]);

  if (!status) {
    return (
      <HStack gap={3} align="center" paddingBlock={6}>
        {loading ? <Spinner size="md" label="Checking Schwab" /> : null}
        {error ? <Text className="portfolio-error" role="alert">{error}</Text> : null}
      </HStack>
    );
  }

  if (!status.configured) {
    return (
      <Text type="supporting">
        Schwab is not configured on this deployment.
      </Text>
    );
  }

  if (!status.connected) {
    return (
      <VStack gap={3}>
        <Text type="supporting">
          Connect Charles Schwab on Account to explore live trade history here.
          Tokens stay on the server.
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            size="sm"
            variant="primary"
            label="Connect Schwab"
            onClick={() => {
              window.location.assign(api.schwabConnectUrl(`${window.location.origin}/portfolio`));
            }}
          />
          <Link to="/account" className="portfolio-link">Account settings</Link>
        </HStack>
      </VStack>
    );
  }

  const rows = trades as TradeRow[];
  const accountOptions = accounts.map((a) => ({ value: a.hash, label: a.label }));

  return (
    <VStack gap={4}>
      {banner ? <Text type="supporting">{banner}</Text> : null}
      <VStack gap={1}>
        <Heading level={2}>Schwab trades</Heading>
        <Text type="supporting">
          Live TRADE history from your linked brokerage account (up to 366 days
          per request). Not stored yet — refresh to re-fetch.
        </Text>
      </VStack>

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
              value: {
                start: isoDaysAgo(30) as ISODateString,
                end: isoToday() as ISODateString,
              },
            },
            {
              label: 'Last 90 days',
              value: defaultRange(),
            },
            {
              label: 'Last 365 days',
              value: {
                start: isoDaysAgo(365) as ISODateString,
                end: isoToday() as ISODateString,
              },
            },
          ]}
        />
        {accountOptions.length > 1 ? (
          <Selector
            label="Account"
            size="sm"
            width={160}
            options={accountOptions}
            value={accountHash ?? undefined}
            onChange={(value) => {
              setAccountHash(value);
              void loadTrades(range, value, symbol);
            }}
          />
        ) : accountOptions.length === 1 ? (
          <VStack gap={0}>
            <Text type="supporting" size="sm">Account</Text>
            <Text type="body">{accountOptions[0]!.label}</Text>
          </VStack>
        ) : null}
        <TextInput
          label="Symbol"
          size="sm"
          width={140}
          value={symbol}
          onChange={setSymbol}
          placeholder="Optional"
          isOptional
          hasClear
        />
        <Button
          size="sm"
          variant="primary"
          label={loading ? 'Loading…' : 'Apply'}
          isDisabled={loading}
          onClick={() => void loadTrades(range, accountHash, symbol)}
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
