import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Spinner,
  Text,
  TextInput,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Search } from 'lucide-react';
import { useIsAdmin } from './useAdmin';
import { api, type AdminSuggestedTrade } from './api';
import { EntityLink } from './EntityLink';
import { formatTradeLeg } from './SuggestedTrades';
import './Trades.css';

type AdminTradeRow = AdminSuggestedTrade & Record<string, unknown>;

function biasColor(bias: AdminSuggestedTrade['bias']): 'green' | 'red' | 'gray' {
  if (bias === 'bullish') return 'green';
  if (bias === 'bearish') return 'red';
  return 'gray';
}

function shortModel(model: string | null): string {
  if (!model) return '—';
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function matchesQuery(trade: AdminSuggestedTrade, query: string): boolean {
  if (!query) return true;
  const legs = (trade.legs ?? []).map(formatTradeLeg).join(' ');
  const haystack = [
    trade.ticker,
    trade.bias,
    trade.conviction,
    trade.structure,
    trade.rationale,
    trade.liquidity ?? '',
    trade.chat_id,
    trade.share_id ?? '',
    trade.bot_handle ?? '',
    trade.model ?? '',
    legs,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Admin-only directory of Copilot suggested trades from suggest_trades events.
 */
export default function TradesPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [trades, setTrades] = useState<AdminSuggestedTrade[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const loadPage = useCallback(async (before?: string | null) => {
    const appending = Boolean(before);
    if (appending) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await api.adminTrades({ limit: 100, before: before ?? undefined });
      setTrades((prev) => (appending ? [...prev, ...response.items] : response.items));
      setNextBefore(response.next_before);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      if (appending) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadPage();
  }, [isAdmin, loadPage]);

  const query = filter.trim().toLowerCase();
  const rows = useMemo(
    () => trades.filter((trade) => matchesQuery(trade, query)) as AdminTradeRow[],
    [trades, query],
  );

  if (isPending || !isAdmin) return null;

  return (
    <VStack className="trades-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
      <VStack gap={2}>
        <Heading level={1}>Suggested trades</Heading>
        <Text type="supporting">
          Every successful suggest_trades idea from Copilot (~30 day retention).
          Open a share when the chat was published.
        </Text>
      </VStack>

      <HStack gap={3} align="center" wrap="wrap">
        <TextInput
          label="Filter trades"
          isLabelHidden
          value={filter}
          onChange={setFilter}
          placeholder="Filter by ticker, bias, structure, bot, or chat"
          startIcon={Search}
          hasClear
          width="min(32rem, 100%)"
        />
        <Text type="supporting">
          {loading ? 'Loading…' : `${rows.length.toLocaleString()} shown`}
        </Text>
        <Button
          label="Refresh"
          variant="secondary"
          size="sm"
          onClick={() => void loadPage()}
          isDisabled={loading}
        />
      </HStack>

      {error && (
        <Text className="trades-error" role="alert">
          {error}
        </Text>
      )}

      {loading && trades.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading suggested trades" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          {trades.length === 0
            ? 'No suggested trades captured yet.'
            : 'No trades match that filter.'}
        </Text>
      ) : (
        <Table
          className="trades-table"
          data={rows}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'created_at_iso',
              header: 'When',
              width: pixel(140),
              renderCell: (trade) =>
                trade.created_at_iso ? (
                  <Timestamp value={trade.created_at_iso} format="relative" />
                ) : (
                  <Text type="supporting">—</Text>
                ),
            },
            {
              key: 'ticker',
              header: 'Ticker',
              width: pixel(88),
              renderCell: (trade) => (
                <EntityLink value={trade.ticker} className="entity-link" showExternals />
              ),
            },
            {
              key: 'bias',
              header: 'Bias',
              width: pixel(100),
              renderCell: (trade) => (
                <Token
                  label={trade.bias}
                  color={biasColor(trade.bias)}
                  size="sm"
                />
              ),
            },
            {
              key: 'conviction',
              header: 'Conviction',
              width: pixel(100),
              renderCell: (trade) => (
                <Text size="sm">{trade.conviction}</Text>
              ),
            },
            {
              key: 'structure',
              header: 'Structure',
              width: proportional(2),
              renderCell: (trade) => (
                <VStack gap={1}>
                  <Text weight="semibold">{trade.structure}</Text>
                  {trade.legs?.length ? (
                    <Text type="supporting" size="sm" className="trades-legs">
                      {trade.legs.map(formatTradeLeg).join(' · ')}
                    </Text>
                  ) : null}
                </VStack>
              ),
            },
            {
              key: 'rationale',
              header: 'Rationale',
              width: proportional(3),
              renderCell: (trade) => (
                <VStack gap={1}>
                  <Text className="trades-rationale">{trade.rationale}</Text>
                  {trade.liquidity ? (
                    <Text type="supporting" size="sm">
                      {trade.liquidity}
                    </Text>
                  ) : null}
                </VStack>
              ),
            },
            {
              key: 'share_id',
              header: 'Source',
              width: pixel(160),
              renderCell: (trade) => (
                <VStack gap={1}>
                  {trade.share_id ? (
                    <Link to="/share/$shareId" params={{ shareId: trade.share_id }} className="trades-link">
                      Share
                    </Link>
                  ) : (
                    <Text type="supporting" size="sm">
                      Unshared
                    </Text>
                  )}
                  {trade.bot_handle ? (
                    <Text type="supporting" size="sm">
                      @{trade.bot_handle}
                    </Text>
                  ) : (
                    <Text type="supporting" size="sm">
                      {shortModel(trade.model)}
                    </Text>
                  )}
                </VStack>
              ),
            },
          ]}
        />
      )}

      {nextBefore && !query ? (
        <HStack gap={3} align="center">
          <Button
            label={loadingMore ? 'Loading…' : 'Load more'}
            variant="secondary"
            size="sm"
            onClick={() => void loadPage(nextBefore)}
            isDisabled={loadingMore}
          />
        </HStack>
      ) : null}
    </VStack>
  );
}
