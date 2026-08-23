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
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { api, type BotTradePosition, type BotTradesBook } from './api';
import { formatTradeLeg } from './SuggestedTrades';
import './Portfolio.css';

type PositionRow = BotTradePosition & Record<string, unknown>;
type StatusFilter = 'open' | 'closed' | 'all';
type ConvictionFilter = 'all' | 'high' | 'medium' | 'low';

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  });
}

function pnlTone(n: number | null | undefined): 'green' | 'red' | 'gray' {
  if (n == null || !Number.isFinite(n) || n === 0) return 'gray';
  return n > 0 ? 'green' : 'red';
}

function biasColor(bias: string | null): 'green' | 'red' | 'gray' {
  if (bias === 'bullish') return 'green';
  if (bias === 'bearish') return 'red';
  return 'gray';
}

function convictionColor(conviction: string | null): 'green' | 'orange' | 'gray' {
  if (conviction === 'high') return 'green';
  if (conviction === 'medium') return 'orange';
  return 'gray';
}

export type BotTradesSectionProps = {
  handle: string;
  /** Controlled conviction filter (portfolio page). */
  convictionFilter?: ConvictionFilter;
  onConvictionFilterChange?: (value: ConvictionFilter) => void;
};

/**
 * Public bot suggested-trade performance on /u/{handle} and /portfolio —
 * lake-marked PnL for ideas from suggest_trades (separate from signed-in paper cash).
 */
export function BotTradesSection({
  handle,
  convictionFilter: controlledConviction,
  onConvictionFilterChange,
}: BotTradesSectionProps) {
  const [book, setBook] = useState<BotTradesBook | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [localConviction, setLocalConviction] = useState<ConvictionFilter>('all');
  const convictionFilter = controlledConviction ?? localConviction;
  const setConvictionFilter = onConvictionFilterChange ?? setLocalConviction;

  const load = useCallback(async (status: StatusFilter, conviction: ConvictionFilter) => {
    setLoading(true);
    setError(null);
    try {
      setBook(await api.botTrades(handle, {
        status,
        conviction: conviction === 'all' ? undefined : conviction,
      }));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setBook(null);
    } finally {
      setLoading(false);
    }
  }, [handle]);

  useEffect(() => {
    void load(statusFilter, convictionFilter);
  }, [load, statusFilter, convictionFilter]);

  const summary = book?.summary;
  const rows = (book?.positions ?? []) as PositionRow[];

  return (
    <VStack gap={3} className="profile-bot-trades" as="section" aria-label="Suggested trade performance">
      <HStack gap={3} align="start" justify="between" wrap="wrap">
        <VStack gap={1}>
          <Heading level={2}>Suggested trades</Heading>
          <Text type="supporting">
            Ideas @{handle} published via suggest_trades, marked against the lake when quotes exist.
            Expired or unquoted legs still list here without PnL. Not a cash paper book.
          </Text>
        </VStack>
        <HStack gap={2} wrap="wrap">
          {(['open', 'closed', 'all'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={statusFilter === s ? 'primary' : 'ghost'}
              label={s === 'all' ? 'All' : s === 'open' ? 'Open' : 'Closed'}
              onClick={() => setStatusFilter(s)}
            />
          ))}
          <Button
            size="sm"
            variant="secondary"
            label="Refresh marks"
            isDisabled={loading}
            onClick={() => void load(statusFilter, convictionFilter)}
          />
        </HStack>
      </HStack>

      <HStack gap={2} wrap="wrap" aria-label="Conviction filter">
        {(['all', 'high', 'medium', 'low'] as const).map((c) => (
          <Button
            key={c}
            size="sm"
            variant={convictionFilter === c ? 'primary' : 'ghost'}
            label={c === 'all' ? 'All conviction' : c}
            onClick={() => setConvictionFilter(c)}
          />
        ))}
      </HStack>

      {summary ? (
        <HStack gap={6} wrap="wrap" className="portfolio-summary">
          <VStack gap={0}>
            <Text type="supporting" size="sm">Open</Text>
            <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
              {summary.open_count}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Closed</Text>
            <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
              {summary.closed_count}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Open PnL</Text>
            <Text
              weight="semibold"
              hasTabularNumbers
              className={`portfolio-stat portfolio-pnl-${pnlTone(summary.open_pnl)}`}
            >
              {money(summary.open_pnl)}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Realized</Text>
            <Text
              weight="semibold"
              hasTabularNumbers
              className={`portfolio-stat portfolio-pnl-${pnlTone(summary.realized_pnl)}`}
            >
              {money(summary.realized_pnl)}
            </Text>
          </VStack>
        </HStack>
      ) : null}

      {error ? (
        <Text className="portfolio-error" role="alert">{error}</Text>
      ) : null}

      {loading && !book ? (
        <HStack gap={3} align="center" paddingBlock={4}>
          <Spinner size="md" label="Loading bot trades" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          {convictionFilter === 'all'
            ? 'No tracked suggestions yet. When this bot publishes markable trades, they land here with live marks.'
            : `No ${convictionFilter}-conviction suggestions in this status filter.`}
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
              key: 'ticker',
              header: 'Ticker',
              width: pixel(72),
              renderCell: (row) => (
                <Text weight="semibold" hasTabularNumbers>{row.ticker}</Text>
              ),
            },
            {
              key: 'bias',
              header: 'Bias',
              width: pixel(88),
              renderCell: (row) => (
                row.bias ? (
                  <Token label={row.bias} color={biasColor(row.bias)} size="sm" />
                ) : (
                  <Text type="supporting" size="sm">—</Text>
                )
              ),
            },
            {
              key: 'conviction',
              header: 'Conviction',
              width: pixel(96),
              renderCell: (row) => (
                row.conviction ? (
                  <Token
                    label={row.conviction}
                    color={convictionColor(row.conviction)}
                    size="sm"
                  />
                ) : (
                  <Text type="supporting" size="sm">—</Text>
                )
              ),
            },
            {
              key: 'structure',
              header: 'Structure',
              width: proportional(2),
              renderCell: (row) => (
                <VStack gap={1}>
                  <Text weight="semibold">{row.structure}</Text>
                  {row.legs?.length ? (
                    <Text type="supporting" size="sm" className="portfolio-legs">
                      {row.legs.map(formatTradeLeg).join(' · ')}
                    </Text>
                  ) : null}
                </VStack>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              width: pixel(88),
              renderCell: (row) => (
                <Token
                  label={row.status}
                  color={row.status === 'open' ? 'blue' : 'gray'}
                  size="sm"
                />
              ),
            },
            {
              key: 'entry_value',
              header: 'Entry',
              width: pixel(100),
              renderCell: (row) => (
                <Text hasTabularNumbers size="sm">{money(row.entry_value)}</Text>
              ),
            },
            {
              key: 'mark_value',
              header: 'Mark',
              width: pixel(100),
              renderCell: (row) => (
                <Text hasTabularNumbers size="sm">{money(row.mark_value)}</Text>
              ),
            },
            {
              key: 'unrealized_pnl',
              header: 'PnL',
              width: pixel(100),
              renderCell: (row) => {
                const pnl = row.status === 'open' ? row.unrealized_pnl : row.realized_pnl;
                return (
                  <Text
                    hasTabularNumbers
                    size="sm"
                    className={`portfolio-pnl-${pnlTone(pnl)}`}
                  >
                    {money(pnl)}
                  </Text>
                );
              },
            },
            {
              key: 'share_id',
              header: 'Chat',
              width: pixel(88),
              renderCell: (row) => (
                row.share_id ? (
                  <Link
                    to="/share/$shareId"
                    params={{ shareId: row.share_id }}
                    className="portfolio-link"
                  >
                    View
                  </Link>
                ) : (
                  <Text type="supporting" size="sm">—</Text>
                )
              ),
            },
          ]}
        />
      )}
    </VStack>
  );
}
