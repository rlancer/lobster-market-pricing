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
import {
  api,
  type BotProfile,
  type PaperPortfolio,
  type PaperPosition,
  type SchwabPortfolio,
  type SchwabPortfolioAccount,
  type SchwabPortfolioPosition,
  type SchwabStatus,
} from './api';
import { authClient } from './auth';
import { BotTradesSection } from './BotTradesSection';
import { SchwabPnlSection } from './SchwabPnlSection';
import { SchwabTradesSection } from './SchwabTradesSection';
import { positionTicker } from './schwabPnlView';
import { formatTradeLeg } from './SuggestedTrades';
import './Portfolio.css';

type PositionRow = PaperPosition & Record<string, unknown>;
type SchwabPositionRow = SchwabPortfolioPosition & Record<string, unknown>;
type BookMode = 'paper' | 'suggested' | 'schwab';
type SchwabPane = 'positions' | 'performance' | 'trades';
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

function qty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
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
 * Portfolio hub — public bot suggested-trade performance by default
 * (no sign-in), optional signed-in paper book, and linked Schwab
 * brokerage accounts when connected from Account.
 */
export default function PortfolioPage() {
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  // Public lobster books first — paper / Schwab are opt-in after Google.
  const [bookMode, setBookMode] = useState<BookMode>('suggested');
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
  const [schwabPane, setSchwabPane] = useState<SchwabPane>('positions');
  const [schwabTicker, setSchwabTicker] = useState('');

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
  }, []);

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

  // Suggested trades are public — do not gate the page on session resolve.
  // Paper / Schwab wait on isPending inside their branches below.

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
  const schwabRows = (schwabAccount?.positions ?? []) as SchwabPositionRow[];
  const schwabSummary = schwabAccount
    ? {
        cash: schwabAccount.cash,
        equity: schwabAccount.equity,
        buying_power: schwabAccount.buying_power,
        day_pnl: schwabAccount.day_pnl,
        open_pnl: schwabAccount.open_pnl,
      }
    : schwabBook
      ? {
          cash: schwabBook.totals.cash,
          equity: schwabBook.totals.equity,
          buying_power: schwabBook.totals.buying_power,
          day_pnl: schwabBook.totals.day_pnl,
          open_pnl: schwabBook.totals.open_pnl,
        }
      : null;

  return (
    <VStack className="portfolio-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
      <HStack gap={3} align="start" justify="between" wrap="wrap">
        <VStack gap={2}>
          <Heading level={1}>Portfolio</Heading>
          <Text type="supporting">
            Public lobster suggested-trade performance — no sign-in required.
            Signed-in books: paper tracking and linked Schwab accounts.
          </Text>
        </VStack>
        <HStack gap={2} wrap="wrap" role="tablist" aria-label="Portfolio book">
          <Button
            size="sm"
            variant={bookMode === 'suggested' ? 'primary' : 'ghost'}
            label="Suggested trades"
            onClick={() => {
              setError(null);
              setBookMode('suggested');
            }}
          />
          <Button
            size="sm"
            variant={bookMode === 'paper' ? 'primary' : 'ghost'}
            label="My paper book"
            onClick={() => {
              setError(null);
              setBookMode('paper');
            }}
          />
          {schwabConfigured ? (
            <Button
              size="sm"
              variant={bookMode === 'schwab' ? 'primary' : 'ghost'}
              label="Schwab"
              onClick={() => {
                setError(null);
                setBookMode('schwab');
              }}
            />
          ) : null}
        </HStack>
      </HStack>

      {bookMode === 'suggested' ? (
        <VStack gap={4}>
          {bots.length > 0 ? (
            <HStack gap={2} wrap="wrap" aria-label="Bot book">
              {bots.map((bot) => (
                <Button
                  key={bot.handle}
                  size="sm"
                  variant={botHandle === bot.handle ? 'primary' : 'ghost'}
                  label={`@${bot.handle}`}
                  onClick={() => setBotHandle(bot.handle)}
                />
              ))}
            </HStack>
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
          <VStack gap={4}>
            {(schwabBook?.accounts.length ?? 0) > 1 ? (
              <HStack gap={2} wrap="wrap" aria-label="Schwab account">
                {schwabBook!.accounts.map((acct) => (
                  <Button
                    key={acct.id}
                    size="sm"
                    variant={schwabAccount?.id === acct.id ? 'primary' : 'ghost'}
                    label={`${acct.account_number_masked}${acct.type ? ` · ${acct.type}` : ''}`}
                    onClick={() => setSchwabAccountId(acct.id)}
                  />
                ))}
              </HStack>
            ) : null}

            <HStack gap={2} wrap="wrap" justify="between">
              <HStack gap={2} wrap="wrap" role="tablist" aria-label="Schwab view">
                <Button
                  size="sm"
                  variant={schwabPane === 'positions' ? 'primary' : 'ghost'}
                  label="Positions"
                  onClick={() => setSchwabPane('positions')}
                />
                <Button
                  size="sm"
                  variant={schwabPane === 'performance' ? 'primary' : 'ghost'}
                  label="Performance"
                  onClick={() => setSchwabPane('performance')}
                />
                <Button
                  size="sm"
                  variant={schwabPane === 'trades' ? 'primary' : 'ghost'}
                  label="Trade history"
                  onClick={() => setSchwabPane('trades')}
                />
              </HStack>
              {schwabPane === 'positions' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  label="Refresh"
                  isDisabled={loading}
                  onClick={() => void loadSchwab()}
                />
              ) : null}
            </HStack>

            {schwabPane === 'trades' ? (
              <SchwabTradesSection accountId={schwabAccount?.id ?? null} />
            ) : schwabPane === 'performance' ? (
              <SchwabPnlSection
                accountId={schwabAccount?.id ?? null}
                initialSymbol={schwabTicker}
                positions={schwabAccount?.positions ?? []}
              />
            ) : (
              <>
            {schwabSummary ? (
              <HStack gap={6} wrap="wrap" className="portfolio-summary">
                <VStack gap={0}>
                  <Text type="supporting" size="sm">Cash</Text>
                  <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
                    {money(schwabSummary.cash)}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="supporting" size="sm">Equity</Text>
                  <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
                    {money(schwabSummary.equity)}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="supporting" size="sm">Buying power</Text>
                  <Text weight="semibold" hasTabularNumbers className="portfolio-stat">
                    {money(schwabSummary.buying_power)}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="supporting" size="sm">Day PnL</Text>
                  <Text
                    weight="semibold"
                    hasTabularNumbers
                    className={`portfolio-stat portfolio-pnl-${pnlTone(schwabSummary.day_pnl)}`}
                  >
                    {money(schwabSummary.day_pnl)}
                  </Text>
                </VStack>
                <VStack gap={0}>
                  <Text type="supporting" size="sm">Open PnL</Text>
                  <Text
                    weight="semibold"
                    hasTabularNumbers
                    className={`portfolio-stat portfolio-pnl-${pnlTone(schwabSummary.open_pnl)}`}
                  >
                    {money(schwabSummary.open_pnl)}
                  </Text>
                </VStack>
              </HStack>
            ) : null}

            {error ? (
              <Text className="portfolio-error" role="alert">{error}</Text>
            ) : null}

            {loading && !schwabBook ? (
              <HStack gap={3} align="center" paddingBlock={8}>
                <Spinner size="md" label="Loading Schwab portfolio" />
              </HStack>
            ) : schwabRows.length === 0 ? (
              <Text type="supporting">
                {schwabAccount
                  ? `No open positions in ${schwabAccount.account_number_masked}.`
                  : 'No linked Schwab accounts returned.'}
              </Text>
            ) : (
              <Table
                className="portfolio-table"
                data={schwabRows}
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
                    renderCell: (row) => (
                      <VStack gap={1}>
                        <Button
                          size="sm"
                          variant="ghost"
                          label={row.symbol}
                          onClick={() => {
                            setSchwabTicker(positionTicker(row));
                            setSchwabPane('performance');
                          }}
                        />
                        {row.description ? (
                          <Text type="supporting" size="sm" className="portfolio-legs">
                            {row.description}
                          </Text>
                        ) : null}
                      </VStack>
                    ),
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
                      <Text
                        hasTabularNumbers
                        size="sm"
                        className={`portfolio-pnl-${pnlTone(row.day_pnl)}`}
                      >
                        {money(row.day_pnl)}
                      </Text>
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
              </>
            )}
          </VStack>
        )
      ) : isPending ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading session" />
        </HStack>
      ) : !signedIn ? (
        <Text type="supporting">
          Sign in with Google to open a personal paper book from your Copilot chats.
          Suggested trades stay public — switch back above, no account needed.
        </Text>
      ) : (
        <>
          <HStack gap={2} wrap="wrap" justify="between">
            <HStack gap={2} wrap="wrap" aria-label="Status filter">
              {(['open', 'closed', 'all'] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={statusFilter === s ? 'primary' : 'ghost'}
                  label={s === 'all' ? 'All' : s === 'open' ? 'Open' : 'Closed'}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
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
