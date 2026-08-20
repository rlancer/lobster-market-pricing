import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChatComposer,
  ChatSendButton,
  Heading,
  HStack,
  List,
  ListItem,
  Markdown,
  Spinner,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Button } from '@astryxdesign/core/Button';
import { AssistantMark } from './Sunglasses';
import { stashPendingPrompt, startNewChatId } from './chatSession';
import type { ChatTickerLink, OhlcBar, ChainContract, TickerResearch } from './api';
import { TickerChart } from './TickerChart';
import { TickerOptionsChain } from './TickerOptionsChain';
import { observeOnce } from './researchLazy';
import './Research.css';

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Format a 0–1 lake fraction (expense ratio, yield, holding weight). */
function fmtFracPct(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(digits)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(digits)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(digits)}M`;
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function fmtSpot(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function changeClass(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={0} className="research-stat">
      <Text type="supporting" className="research-stat-label">{label}</Text>
      <Text className="research-stat-value">{value}</Text>
    </VStack>
  );
}

export function ResearchBriefView({
  research,
  relatedChats,
  commentary,
  commentaryLoading = false,
  ohlc = [],
  ohlcLoading = false,
  contracts = [],
  expirations = [],
  chainLoading = false,
  chainArmed = false,
  onCommentaryVisible,
  onChainRequest,
  chainExpiration,
  chainNearSpot = 50,
  onChainExpirationChange,
  onChainNearSpotChange,
}: {
  research: TickerResearch;
  relatedChats?: ChatTickerLink[];
  commentary?: string | null;
  commentaryLoading?: boolean;
  ohlc?: OhlcBar[];
  ohlcLoading?: boolean;
  contracts?: ChainContract[];
  expirations?: string[];
  chainLoading?: boolean;
  /** True after the user asked to load the chain. */
  chainArmed?: boolean;
  onCommentaryVisible?: () => void;
  onChainRequest?: () => void;
  chainExpiration?: string;
  chainNearSpot?: number;
  onChainExpirationChange?: (expiration: string) => void;
  onChainNearSpotChange?: (nearSpot: number) => void;
}) {
  const navigate = useNavigate();
  const [followUp, setFollowUp] = useState('');
  const { identity, price, technicals, fundamentals, shorting, earnings, news, filings = [], realized_vol, etf } = research;
  const etfHoldings = etf?.holdings ?? [];
  const resolvedCommentary = commentary?.trim() || research.commentary?.trim() || null;
  const insufficientCommentary =
    research.commentary_source === 'insufficient'
    || Boolean(resolvedCommentary && /^not enough data\b/i.test(resolvedCommentary));
  const spot = price.spot;
  const commentaryId = `research-lobster-${identity.ticker}`;
  const chainId = `research-chain-${identity.ticker}`;

  useEffect(() => {
    if (!onCommentaryVisible || !research.computed_at) return;
    return observeOnce(commentaryId, onCommentaryVisible);
  }, [onCommentaryVisible, commentaryId, research.computed_at]);

  const askFollowUp = (raw: string) => {
    const question = raw.trim();
    if (!question) return;
    const prior = resolvedCommentary
      ? `You just commented on ${identity.ticker}:\n"${resolvedCommentary}"\n\nFollow-up: ${question}`
      : `About ${identity.ticker}: ${question}`;
    stashPendingPrompt(prior);
    startNewChatId();
    setFollowUp('');
    void navigate({ to: '/chat' });
  };

  const hasRailMeta =
    earnings.length > 0 ||
    news.length > 0 ||
    filings.length > 0 ||
    Boolean(relatedChats && relatedChats.length > 0);

  return (
    <VStack className="research-brief" gap={3}>
      <VStack gap={1} className="research-hero">
        <HStack gap={3} vAlign="end" className="research-title-row">
          <Heading level={1}>{identity.ticker}</Heading>
          {identity.name ? <Text type="supporting">{identity.name}</Text> : null}
          {!research.computed_at ? <Spinner size="sm" /> : null}
        </HStack>
        <HStack gap={3} vAlign="end" className="research-price-row">
          <Text className="research-spot">{fmtSpot(spot)}</Text>
          <Text className={`research-change ${changeClass(price.change_1d_pct)}`}>
            {fmtPct(price.change_1d_pct)} 1d
          </Text>
          <Text type="supporting" className="research-change-secondary">
            {fmtPct(price.change_5d_pct)} 5d · {fmtPct(price.change_21d_pct)} 21d
          </Text>
        </HStack>
        <Text type="supporting" className="research-id-line">
          {identity.sector ? `${identity.sector} · ` : ''}
          {identity.figi ? `FIGI ${identity.figi}` : (research.computed_at ? 'FIGI pending' : 'Loading brief…')}
          {` · via ${identity.source}`}
        </Text>
      </VStack>

      <HStack gap={4} wrap="wrap" className="research-stats">
        {etf ? (
          <>
            <Stat label="Expense" value={fmtFracPct(etf.expense_ratio)} />
            <Stat label="Net expense" value={fmtFracPct(etf.net_expense_ratio)} />
            <Stat label="Net assets" value={fmtNum(etf.net_assets)} />
            <Stat label="Yield" value={fmtFracPct(etf.trailing_yield)} />
            <Stat label="Family" value={etf.family ?? '—'} />
            <Stat label="Category" value={etf.category ?? '—'} />
            {etf.asset_class ? <Stat label="Asset class" value={etf.asset_class} /> : null}
            {etf.inception_date ? <Stat label="Inception" value={etf.inception_date} /> : null}
          </>
        ) : (
          <>
            <Stat label="Mkt cap" value={fmtNum(fundamentals.market_cap)} />
            <Stat label="P/E" value={fmtNum(fundamentals.trailing_pe)} />
            <Stat label="Fwd P/E" value={fmtNum(fundamentals.forward_pe)} />
            <Stat label="D/E" value={fmtNum(fundamentals.debt_to_equity)} />
            <Stat
              label="Margins"
              value={fundamentals.profit_margins != null ? fmtPct(fundamentals.profit_margins * 100) : '—'}
            />
            {shorting?.short_interest != null ? (
              <Stat label="Short int" value={fmtNum(shorting.short_interest)} />
            ) : null}
            {shorting?.days_to_cover != null ? (
              <Stat label="Days to cover" value={fmtNum(shorting.days_to_cover, 2)} />
            ) : null}
            {shorting?.short_ratio != null ? (
              <Stat label="Short vol %" value={fmtPct(shorting.short_ratio * 100)} />
            ) : null}
          </>
        )}
        <Stat
          label="Vol vs 20d"
          value={price.volume_relative_20d != null ? `${(price.volume_relative_20d * 100).toFixed(0)}%` : '—'}
        />
        <Stat label="Trend" value={technicals.trend} />
        <Stat label="Flow" value={technicals.accumulation} />
        {realized_vol?.realized_vol_30d != null && (
          <Stat label="RV30" value={fmtNum(realized_vol.realized_vol_30d, 3)} />
        )}
      </HStack>

      {research.computed_at ? (
        // Responsive contract:
        //   > 56rem  main (chart / holdings) | rail 22rem (The Lobster's Take + news)
        //   <= 56rem stack: main, then take and headlines; chain stays full width below
        <section className="research-columns">
          <VStack gap={3} className="research-main">
            {etf && etfHoldings.length > 0 ? (
              <VStack gap={2} className="research-section research-etf-holdings">
                <Heading level={3}>Holdings</Heading>
                <Text type="supporting">
                  Top {etfHoldings.length} components by weight
                  {etf.name ? ` · ${etf.name}` : ''}.
                </Text>
                <div className="research-holdings-wrap">
                  <table className="research-holdings-table">
                    <thead>
                      <tr>
                        <th scope="col">#</th>
                        <th scope="col">Symbol</th>
                        <th scope="col">Name</th>
                        <th scope="col" className="right">Weight</th>
                      </tr>
                    </thead>
                    <tbody>
                      {etfHoldings.map((h) => {
                        const sym = h.holding_symbol?.trim().toUpperCase() || null;
                        return (
                          <tr key={`${h.rank ?? ''}-${sym ?? h.holding_name ?? ''}`}>
                            <td>{h.rank ?? '—'}</td>
                            <td>
                              {sym ? (
                                <Link
                                  to="/research/$ticker"
                                  params={{ ticker: sym }}
                                  className="research-chip-link research-holding-link"
                                >
                                  {sym}
                                </Link>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{h.holding_name ?? '—'}</td>
                            <td className="right">{fmtFracPct(h.weight)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </VStack>
            ) : null}

            <VStack gap={2} className="research-section" id={`research-chart-${identity.ticker}`}>
              {ohlcLoading && ohlc.length === 0 ? (
                <HStack gap={2} vAlign="center" className="research-chart research-chart-empty">
                  <Spinner size="sm" />
                  <Text type="supporting">Loading chart…</Text>
                </HStack>
              ) : ohlc.length === 0 && !ohlcLoading ? (
                <HStack gap={2} vAlign="center" className="research-chart research-chart-empty">
                  <Text type="supporting">No daily bars in the lake for this ticker yet.</Text>
                </HStack>
              ) : (
                <TickerChart bars={ohlc} spot={spot} ticker={identity.ticker} />
              )}
            </VStack>
          </VStack>

          <aside className="research-rail" aria-label="The Lobster's Take and headlines">
            <VStack gap={4} className="research-section">
              <VStack gap={3} className="research-commentary-chat" id={commentaryId}>
                <Heading level={3}>The Lobster's Take</Heading>
                <HStack gap={3} vAlign="start" className="research-chat-msg">
                  <AssistantMark className="research-chat-avatar" />
                  <VStack gap={2} className="research-chat-bubble-wrap">
                    {commentaryLoading && !resolvedCommentary && (
                      <HStack gap={2} vAlign="center" className="research-chat-bubble">
                        <Spinner size="sm" />
                        <Text type="supporting">Writing the take…</Text>
                      </HStack>
                    )}
                    {resolvedCommentary && insufficientCommentary && (
                      <Text type="supporting" className="research-chat-bubble">
                        {resolvedCommentary}
                      </Text>
                    )}
                    {resolvedCommentary && !insufficientCommentary && (
                      <div className="research-chat-bubble">
                        <div className="ai-text"><Markdown>{resolvedCommentary}</Markdown></div>
                      </div>
                    )}
                    {!commentaryLoading && !resolvedCommentary && (
                      <Text type="supporting" className="research-chat-bubble">
                        The take for {identity.ticker} loads when this column is in view.
                      </Text>
                    )}
                  </VStack>
                </HStack>
                <ChatComposer
                  value={followUp}
                  onChange={setFollowUp}
                  onSubmit={askFollowUp}
                  placeholder={`Ask a follow-up about ${identity.ticker}…`}
                  density="compact"
                  elevation="none"
                  sendButton={<ChatSendButton />}
                />
              </VStack>

              {hasRailMeta ? (
                <VStack gap={3} className="research-secondary">
                  {news.length > 0 && (
                    <VStack gap={2}>
                      <Heading level={3}>News</Heading>
                      <List density="compact" hasDividers className="research-news-list">
                        {news.map((item) => (
                          <ListItem
                            key={item.link}
                            label={item.title}
                            href={item.link}
                            target="_blank"
                            rel="noreferrer"
                          />
                        ))}
                      </List>
                    </VStack>
                  )}
                  {filings.length > 0 && (
                    <VStack gap={2}>
                      <Heading level={3}>
                        {etf ? 'Prospectus & filings' : 'SEC filings'}
                      </Heading>
                      <List density="compact" hasDividers className="research-news-list">
                        {filings.map((item) => {
                          const label = [
                            item.form_type,
                            item.filed_at,
                            item.description && item.description !== item.form_type
                              ? item.description
                              : null,
                          ]
                            .filter(Boolean)
                            .join(' · ');
                          return (
                            <ListItem
                              key={item.accession || item.edgar_url}
                              label={label}
                              href={item.edgar_url}
                              target="_blank"
                              rel="noreferrer"
                            />
                          );
                        })}
                      </List>
                    </VStack>
                  )}
                  {earnings.length > 0 && (
                    <VStack gap={2}>
                      <Heading level={3}>Earnings</Heading>
                      {earnings.slice(0, 3).map((row) => (
                        <Text key={`${row.earnings_date}-${row.fiscal_q ?? ''}`} type="supporting">
                          {row.earnings_date}{row.time ? ` ${row.time}` : ''}
                          {row.fiscal_q ? ` · ${row.fiscal_q}` : ''}
                          {row.eps_forecast != null ? ` · EPS est ${row.eps_forecast}` : ''}
                        </Text>
                      ))}
                    </VStack>
                  )}
                  {relatedChats && relatedChats.length > 0 && (
                    <VStack gap={2}>
                      <Heading level={3}>Related chats</Heading>
                      {relatedChats.map((chat) => (
                        <Link key={chat.chat_id} to="/chat/$chatId" params={{ chatId: chat.chat_id }} className="research-chat-link">
                          {chat.ticker} · {chat.mention_count} mention{chat.mention_count === 1 ? '' : 's'}
                        </Link>
                      ))}
                    </VStack>
                  )}
                </VStack>
              ) : null}
            </VStack>
          </aside>
        </section>
      ) : null}

      {research.computed_at ? (
        <VStack gap={3} className="research-section research-chain-section" id={chainId}>
          <Heading level={3}>Options chain</Heading>
          {!chainArmed ? (
            <VStack gap={2} className="research-chain research-chain-deferred">
              <Text type="supporting">
                Chain is deferred — load one expiration near spot when you need it.
              </Text>
              <Button
                label="Load options chain"
                variant="secondary"
                size="sm"
                onClick={() => onChainRequest?.()}
              />
            </VStack>
          ) : chainLoading && contracts.length === 0 ? (
            <HStack gap={2} vAlign="center" className="research-chain">
              <Spinner size="sm" />
              <Text type="supporting">Loading chain…</Text>
            </HStack>
          ) : (
            <TickerOptionsChain
              contracts={contracts}
              expirations={expirations}
              spot={spot}
              expiration={chainExpiration}
              nearSpot={chainNearSpot}
              onExpirationChange={onChainExpirationChange}
              onNearSpotChange={onChainNearSpotChange}
              loading={chainLoading}
            />
          )}
        </VStack>
      ) : null}

      <Text type="supporting" className="research-foot">
        {research.computed_at
          ? `${research.cache_hit ? 'Cached' : 'Fresh'} · ${new Date(research.computed_at).toLocaleString()}`
          : 'Loading brief…'}
      </Text>
    </VStack>
  );
}

export function ResearchLoading({ label = 'Loading research…' }: { label?: string }) {
  return (
    <HStack gap={3} vAlign="center" className="research-state">
      <Spinner size="md" />
      <Text type="supporting">{label}</Text>
    </HStack>
  );
}
