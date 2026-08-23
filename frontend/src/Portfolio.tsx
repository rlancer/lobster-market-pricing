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
import { api, type PaperPortfolio, type PaperPosition } from './api';
import { authClient } from './auth';
import { formatTradeLeg } from './SuggestedTrades';
import './Portfolio.css';

type PositionRow = PaperPosition & Record<string, unknown>;

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

/**
 * Signed-in paper book — track Copilot suggestions and mark PnL from the lake.
 */
export default function PortfolioPage() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('open');

  const load = useCallback(async (status: 'all' | 'open' | 'closed') => {
    setLoading(true);
    setError(null);
    try {
      setPortfolio(await api.portfolio({ status }));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void load(statusFilter);
  }, [signedIn, statusFilter, load]);

  const close = async (id: string) => {
    setClosingId(id);
    setError(null);
    try {
      await api.closePosition(id);
      await load(statusFilter);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setClosingId(null);
    }
  };

  if (isPending) {
    return (
      <VStack className="portfolio-page" gap={5} paddingBlock={6} paddingInline={5}>
        <Spinner size="md" label="Loading session" />
      </VStack>
    );
  }

  if (!signedIn) {
    return (
      <VStack className="portfolio-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
        <Heading level={1}>Paper portfolio</Heading>
        <Text type="supporting">
          Sign in with Google to track Copilot suggested trades and mark their PnL against the lake.
        </Text>
      </VStack>
    );
  }

  const account = portfolio?.account;
  const rows = (portfolio?.positions ?? []) as PositionRow[];

  return (
    <VStack className="portfolio-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
      <HStack gap={3} align="start" justify="between" wrap="wrap">
        <VStack gap={2}>
          <Heading level={1}>Paper portfolio</Heading>
          <Text type="supporting">
            Copilot suggestions with concrete legs open here automatically for your chats.
            Marks use lake mid/spot. Starting cash $100,000.
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
            onClick={() => void load(statusFilter)}
          />
        </HStack>
      </HStack>

      {account ? (
        <HStack gap={6} wrap="wrap" className="portfolio-summary">
          <VStack gap={0}>
            <Text type="supporting" size="sm">Cash</Text>
            <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
              {money(account.cash)}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Equity</Text>
            <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
              {money(account.equity)}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Open PnL</Text>
            <Text
              weight="semibold"
              hasTabularNumbers
              className={`portfolio-stat portfolio-pnl-${pnlTone(account.open_pnl)}`}
            >
              {money(account.open_pnl)}
            </Text>
          </VStack>
          <VStack gap={0}>
            <Text type="supporting" size="sm">Realized</Text>
            <Text
              weight="semibold"
              hasTabularNumbers
              className={`portfolio-stat portfolio-pnl-${pnlTone(account.realized_pnl)}`}
            >
              {money(account.realized_pnl)}
            </Text>
          </VStack>
        </HStack>
      ) : null}

      {error ? (
        <Text className="portfolio-error" role="alert">{error}</Text>
      ) : null}

      {loading && !portfolio ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading portfolio" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          No open positions yet. Ask Chat for a trade idea while signed in — markable
          suggestions land here automatically.
          {' '}
          <Link to="/chat" className="portfolio-link">Open Chat</Link>
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
              key: 'opened_at_iso',
              header: 'Opened',
              width: pixel(110),
              renderCell: (row) => (
                <Text type="supporting" size="sm">
                  {row.opened_at_iso.slice(0, 10)}
                </Text>
              ),
            },
            {
              key: 'id',
              header: '',
              width: pixel(88),
              renderCell: (row) => (
                row.status === 'open' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    label={closingId === row.id ? '…' : 'Close'}
                    isDisabled={closingId === row.id}
                    onClick={() => void close(row.id)}
                  />
                ) : null
              ),
            },
          ]}
        />
      )}
    </VStack>
  );
}
