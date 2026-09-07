import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Spinner,
  Switch,
  Tab,
  TabList,
  Text,
  Token,
  useMediaQuery,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import {
  api,
  type BotProfile,
  type PaperPortfolio,
  type PaperPosition,
  type SchwabPortfolio,
  type SchwabPortfolioAccount,
  type SchwabStatus,
} from './api';
import { authClient } from './auth';
import { SignInEmptyState } from './SignInEmptyState';
import { BotTradesSection } from './BotTradesSection';
import { SchwabBookSection } from './SchwabBookSection';
import { SchwabTradesSection } from './SchwabTradesSection';
import { formatTradeLeg } from './SuggestedTrades';
import { useHideDollars } from './useHideDollars';
import './Portfolio.css';

type PositionRow = PaperPosition & Record<string, unknown>;
type BookMode = 'paper' | 'suggested' | 'schwab';
type SchwabPane = 'book' | 'trades';
type StatusFilter = 'all' | 'open' | 'closed';
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

/**
 * Signed-in portfolio hub — paper book, linked Schwab accounts, and
 * public bot suggested-trade performance. Anonymous visitors get a
 * sign-in empty state; public bot books stay on /u/{handle}.
 */
export default function PortfolioPage() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const navigate = useNavigate({ from: '/portfolio' });
  const { book, asof } = useSearch({ from: '/portfolio' });
  const bookMode: BookMode = book ?? 'paper';
  const setBookMode = (next: BookMode) => {
    void navigate({
      search: {
        book: next === 'paper' ? undefined : next,
        asof,
      },
    });
  };
  const [portfolio, setPortfolio] = useState<PaperPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [convictionFilter, setConvictionFilter] = useState<ConvictionFilter>('all');
  const [bots, setBots] = useState<BotProfile[]>([]);
  const [botHandle, setBotHandle] = useState<string | null>(null);

  const [schwabConfigured, setSchwabConfigured] = useState(false);
  const [schwabStatus, setSchwabStatus] = useState<SchwabStatus | null>(null);
  const [schwabBook, setSchwabBook] = useState<SchwabPortfolio | null>(null);
  const [schwabAccountId, setSchwabAccountId] = useState<string | null>(null);
  const [schwabNeedsConnect, setSchwabNeedsConnect] = useState(false);
  const [schwabNeedsReauth, setSchwabNeedsReauth] = useState(false);
  const [schwabPane, setSchwabPane] = useState<SchwabPane>('book');
  const { hideDollars, setHideDollars } = useHideDollars();
  const isMobile = useMediaQuery('(max-width: 47.99rem)');
  const pageGap = isMobile ? 3 : 5;
  const pagePaddingBlock = isMobile ? 2 : 6;
  const pagePaddingInline = isMobile ? 0 : 5;

  const loadPaper = useCallback(async (status: StatusFilter, conviction: ConvictionFilter) => {
    setLoading(true);
    setError(null);
    try {
      setPortfolio(await api.portfolio({
        status,
        conviction: conviction === 'all' ? undefined : conviction,
      }));
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSchwab = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSchwabNeedsConnect(false);
    setSchwabNeedsReauth(false);
    try {
      const book = await api.schwabPortfolio();
      setSchwabBook(book);
      setSchwabAccountId((prev) => {
        if (prev && book.accounts.some((a) => a.id === prev)) return prev;
        return book.accounts[0]?.id ?? null;
      });
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      setSchwabBook(null);
      if (/schwab_not_connected|409/i.test(message)) {
        setSchwabNeedsConnect(true);
        setError(null);
      } else if (/schwab_reauth_required|401/i.test(message)) {
        setSchwabNeedsReauth(true);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!signedIn || bookMode !== 'paper') return;
    void loadPaper(statusFilter, convictionFilter);
  }, [signedIn, bookMode, statusFilter, convictionFilter, loadPaper]);

  useEffect(() => {
    if (!signedIn || bookMode !== 'schwab' || !schwabConfigured) return;
    void loadSchwab();
  }, [signedIn, bookMode, schwabConfigured, loadSchwab]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const health = await api.health();
        if (cancelled) return;
        setSchwabConfigured(Boolean(health.auth?.schwab));
      } catch {
        if (!cancelled) setSchwabConfigured(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!signedIn || !schwabConfigured) {
      setSchwabStatus(null);
      return;
    }
    let active = true;
    api.schwabStatus().then((status) => {
      if (active) setSchwabStatus(status);
    }).catch(() => {
      if (active) setSchwabStatus(null);
    });
    return () => { active = false; };
  }, [signedIn, schwabConfigured]);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await api.bots();
        if (cancelled) return;
        setBots(items);
        setBotHandle((prev) => {
          if (prev && items.some((b) => b.handle === prev)) return prev;
          // Prefer yololobster when present — that's the high-conviction recs desk.
          const yolo = items.find((b) => b.handle === 'yololobster');
          return yolo?.handle ?? items[0]?.handle ?? null;
        });
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message ?? err));
      }
    })();
    return () => { cancelled = true; };
  }, [signedIn]);

  const close = async (id: string) => {
    setClosingId(id);
    setError(null);
    try {
      await api.closePosition(id);
      await loadPaper(statusFilter, convictionFilter);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setClosingId(null);
    }
  };

  const connectSchwab = () => {
    window.location.assign(
      api.schwabConnectUrl(`${window.location.origin}/portfolio`),
    );
  };

  const account = portfolio?.account;
  const allRows = (portfolio?.positions ?? []) as PositionRow[];
  const rows = convictionFilter === 'all'
    ? allRows
    : allRows.filter((row) => row.conviction === convictionFilter);

  const paperStats = (() => {
    if (!account) return null;
    if (convictionFilter === 'all') {
      return {
        cash: account.cash,
        equity: account.equity,
        open_pnl: account.open_pnl,
        realized_pnl: account.realized_pnl,
        filtered: false,
      };
    }
    let openPnl = 0;
    let realized = 0;
    let openMarkSum = 0;
    for (const row of rows) {
      if (row.status === 'open') {
        if (row.unrealized_pnl != null) openPnl += row.unrealized_pnl;
        if (row.mark_value != null) openMarkSum += row.mark_value;
        else if (row.entry_value != null) openMarkSum += row.entry_value;
      } else if (row.realized_pnl != null) {
        realized += row.realized_pnl;
      }
    }
    return {
      cash: account.cash,
      equity: account.cash + openMarkSum,
      open_pnl: openPnl,
      realized_pnl: realized,
      filtered: true,
    };
  })();

  const schwabAccount: SchwabPortfolioAccount | null =
    schwabBook?.accounts.find((a) => a.id === schwabAccountId)
    ?? schwabBook?.accounts[0]
    ?? null;
  const schwabSummary = schwabAccount
    ? {
        cash: schwabAccount.cash,
        equity: schwabAccount.equity,
        buying_power: schwabAccount.buying_power,
        day_pnl: schwabAccount.day_pnl,
        day_pnl_pct: schwabAccount.day_pnl_pct ?? null,
        open_pnl: schwabAccount.open_pnl,
      }
    : schwabBook
      ? {
          cash: schwabBook.totals.cash,
          equity: schwabBook.totals.equity,
          buying_power: schwabBook.totals.buying_power,
          day_pnl: schwabBook.totals.day_pnl,
          day_pnl_pct: schwabBook.totals.day_pnl_pct ?? null,
          open_pnl: schwabBook.totals.open_pnl,
        }
      : null;

  if (isPending) {
    return (
      <VStack
        className="portfolio-page"
        gap={pageGap}
        paddingBlock={pagePaddingBlock}
        paddingInline={pagePaddingInline}
      >
        <Spinner size="md" label="Loading session" />
      </VStack>
    );
  }

  if (!signedIn) {
    return (
      <SignInEmptyState title="Portfolio" className="portfolio-page">
        Sign in to see your paper book and linked Schwab accounts, then
        schedule a private bot to review risk on an interval.
      </SignInEmptyState>
    );
  }

  return (
    <VStack
      className="portfolio-page"
      gap={pageGap}
      paddingBlock={pagePaddingBlock}
      paddingInline={pagePaddingInline}
      maxWidth={1200}
    >
      <HStack gap={3} align="start" justify="between" wrap="wrap">
        <VStack gap={2}>
          <Heading level={1}>Portfolio</Heading>
          {isMobile ? null : (
            <Text type="supporting">
              Your paper book and linked Schwab accounts. Public bot
              suggested-trade books stay on the Suggested trades tab.
              Schedule a private{' '}
              <Link to="/my-bots" className="portfolio-link">portfolio bot</Link>
              {' '}to review risk on an interval.
            </Text>
          )}
        </VStack>
        <TabList
          size="sm"
          aria-label="Portfolio book"
          value={bookMode}
          onChange={(value) => {
            setError(null);
            setBookMode(value as BookMode);
          }}
        >
          <Tab value="suggested" label="Suggested trades" />
          <Tab value="paper" label="My paper book" />
          {schwabConfigured || bookMode === 'schwab' ? <Tab value="schwab" label="Schwab" /> : null}
        </TabList>
      </HStack>

      {bookMode === 'suggested' ? (
        <VStack gap={4}>
          {bots.length > 0 && botHandle ? (
            <TabList
              size="sm"
              aria-label="Bot book"
              value={botHandle}
              onChange={setBotHandle}
            >
              {bots.map((bot) => (
                <Tab key={bot.handle} value={bot.handle} label={`@${bot.handle}`} />
              ))}
            </TabList>
          ) : null}
          {error && bookMode === 'suggested' ? (
            <Text className="portfolio-error" role="alert">{error}</Text>
          ) : null}
          {botHandle ? (
            <BotTradesSection
              key={botHandle}
              handle={botHandle}
              convictionFilter={convictionFilter}
              onConvictionFilterChange={setConvictionFilter}
            />
          ) : (
            <Text type="supporting">No public bots available yet.</Text>
          )}
        </VStack>
      ) : bookMode === 'schwab' ? (
        isPending ? (
          <HStack gap={3} align="center" paddingBlock={8}>
            <Spinner size="md" label="Loading session" />
          </HStack>
        ) : !signedIn ? (
          <Text type="supporting">
            Sign in with Google, then connect Schwab from{' '}
            <Link to="/account" className="portfolio-link">Account</Link>
            {' '}to view live brokerage balances and positions here.
          </Text>
        ) : schwabNeedsConnect || (!schwabStatus?.connected && !schwabBook && !loading) ? (
          <VStack gap={3}>
            <Text type="supporting">
              Connect Charles Schwab to pull linked accounts, cash, and open
              positions into this book. Tokens stay on the server.
            </Text>
            <HStack gap={2} wrap="wrap">
              <Button
                size="sm"
                variant="primary"
                label="Connect Schwab"
                onClick={connectSchwab}
              />
              <Link to="/account" className="portfolio-link">Account settings</Link>
            </HStack>
          </VStack>
        ) : schwabNeedsReauth ? (
          <VStack gap={3}>
            <Text type="supporting">
              Your Schwab session expired. Reconnect to refresh brokerage data.
            </Text>
            <Button
              size="sm"
              variant="primary"
              label="Reconnect Schwab"
              onClick={connectSchwab}
            />
          </VStack>
        ) : (
          <VStack gap={isMobile ? 3 : 4}>
            {(schwabBook?.accounts.length ?? 0) > 1 && schwabAccount ? (
              <TabList
                size="sm"
                aria-label="Schwab account"
                value={schwabAccount.id}
                onChange={setSchwabAccountId}
              >
                {schwabBook!.accounts.map((acct) => (
                  <Tab
                    key={acct.id}
                    value={acct.id}
                    label={`${acct.account_number_masked}${acct.type ? ` · ${acct.type}` : ''}`}
                  />
                ))}
              </TabList>
            ) : null}

            <HStack gap={3} wrap="wrap" justify="between" vAlign="center">
              <TabList
                size="sm"
                aria-label="Schwab view"
                value={schwabPane}
                onChange={(value) => setSchwabPane(value as SchwabPane)}
              >
                <Tab value="book" label="Portfolio" />
                <Tab value="trades" label="Trade history" />
              </TabList>
              <Switch
                size="sm"
                label="Hide dollars"
                labelTooltip="Show percentages only so a screenshot omits cash amounts"
                value={hideDollars}
                onChange={setHideDollars}
              />
            </HStack>

            {loading && !schwabBook ? (
              <HStack gap={3} align="center" paddingBlock={8}>
                <Spinner size="md" label="Loading Schwab portfolio" />
              </HStack>
            ) : schwabPane === 'trades' ? (
              <SchwabTradesSection
                accountId={schwabAccount?.id ?? null}
                hideDollars={hideDollars}
              />
            ) : (
              <SchwabBookSection
                key={schwabAccount?.id ?? 'none'}
                account={schwabAccount}
                summary={schwabSummary}
                positions={schwabAccount?.positions ?? []}
                error={error}
                loading={loading}
                hideDollars={hideDollars}
                onRefresh={() => void loadSchwab()}
              />
            )}
          </VStack>
        )
      ) : isPending ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading session" />
        </HStack>
      ) : !signedIn ? (
        <Text type="supporting">
          Sign in with Google to open a personal paper book from your chats.
          Suggested trades stay public — switch back above, no account needed.
        </Text>
      ) : (
        <>
          <HStack gap={2} wrap="wrap" justify="between" vAlign="center">
            <TabList
              size="sm"
              aria-label="Status filter"
              value={statusFilter}
              onChange={(value) => setStatusFilter(value as StatusFilter)}
            >
              <Tab value="open" label="Open" />
              <Tab value="closed" label="Closed" />
              <Tab value="all" label="All" />
            </TabList>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <TabList
                size="sm"
                aria-label="Conviction filter"
                value={convictionFilter}
                onChange={(value) => setConvictionFilter(value as ConvictionFilter)}
              >
                <Tab value="all" label="All conviction" />
                <Tab value="high" label="High" />
                <Tab value="medium" label="Medium" />
                <Tab value="low" label="Low" />
              </TabList>
              <Button
                size="sm"
                variant="secondary"
                label="Refresh marks"
                isDisabled={loading}
                onClick={() => void loadPaper(statusFilter, convictionFilter)}
              />
            </HStack>
          </HStack>

          {paperStats ? (
            <HStack gap={6} wrap="wrap" className="portfolio-summary">
              <VStack gap={0}>
                <Text type="supporting" size="sm">Cash</Text>
                <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
                  {money(paperStats.cash)}
                </Text>
              </VStack>
              <VStack gap={0}>
                <Text type="supporting" size="sm">
                  {paperStats.filtered ? 'Filtered equity' : 'Equity'}
                </Text>
                <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
                  {money(paperStats.equity)}
                </Text>
              </VStack>
              <VStack gap={0}>
                <Text type="supporting" size="sm">Open PnL</Text>
                <Text
                  weight="semibold"
                  hasTabularNumbers
                  className={`portfolio-stat portfolio-pnl-${pnlTone(paperStats.open_pnl)}`}
                >
                  {money(paperStats.open_pnl)}
                </Text>
              </VStack>
              <VStack gap={0}>
                <Text type="supporting" size="sm">Realized</Text>
                <Text
                  weight="semibold"
                  hasTabularNumbers
                  className={`portfolio-stat portfolio-pnl-${pnlTone(paperStats.realized_pnl)}`}
                >
                  {money(paperStats.realized_pnl)}
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
              {convictionFilter === 'all'
                ? 'No open positions yet. Ask Chat for a trade idea while signed in — markable suggestions land here automatically.'
                : `No ${convictionFilter}-conviction positions in this status filter.`}
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
        </>
      )}
    </VStack>
  );
}
