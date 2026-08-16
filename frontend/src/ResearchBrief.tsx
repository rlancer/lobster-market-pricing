import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChatComposer,
  ChatSendButton,
  Heading,
  HStack,
  Spinner,
  Text,
  VStack,
} from '@astryxdesign/core';
import { AssistantMark } from './Sunglasses';
import { stashPendingPrompt, startNewChatId } from './chatSession';
import type { ChatTickerLink, OhlcBar, ChainContract, TickerResearch } from './api';
import { TickerChart } from './TickerChart';
import { TickerOptionsChain } from './TickerOptionsChain';
import './Research.css';

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
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
  onChainVisible,
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
  /** Fired once when the options-chain section approaches the viewport. */
  onChainVisible?: () => void;
  chainExpiration?: string;
  chainNearSpot?: number;
  onChainExpirationChange?: (expiration: string) => void;
  onChainNearSpotChange?: (nearSpot: number) => void;
}) {
  const navigate = useNavigate();
  const [followUp, setFollowUp] = useState('');
  const chainArmedRef = useRef(false);
  const { identity, price, technicals, fundamentals, earnings, news, realized_vol, etf } = research;
  const resolvedCommentary = commentary?.trim() || research.commentary?.trim() || null;
  const spot = price.spot;

  useEffect(() => {
    chainArmedRef.current = false;
  }, [identity.ticker]);

  useEffect(() => {
    if (!onChainVisible) return;
    if (typeof IntersectionObserver === 'undefined') {
      onChainVisible();
      return;
    }
    const node = document.getElementById(`research-chain-${identity.ticker}`);
    if (!(node instanceof Element)) {
      onChainVisible();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (chainArmedRef.current) return;
        if (entries.some((e) => e.isIntersecting)) {
          chainArmedRef.current = true;
          onChainVisible();
          observer.disconnect();
        }
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onChainVisible, identity.ticker]);

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

  return (
    <VStack className="research-brief" gap={3}>
      <VStack gap={1} className="research-hero">
        <HStack gap={3} vAlign="end" className="research-title-row">
          <Heading level={1}>{identity.ticker}</Heading>
          {identity.name ? <Text type="supporting">{identity.name}</Text> : null}
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
          {identity.figi ? `FIGI ${identity.figi}` : 'FIGI pending'}
          {` · via ${identity.source}`}
        </Text>
      </VStack>

      <HStack gap={4} wrap="wrap" className="research-stats">
        <Stat label="Mkt cap" value={fmtNum(fundamentals.market_cap)} />
        <Stat label="P/E" value={fmtNum(fundamentals.trailing_pe)} />
        <Stat label="Fwd P/E" value={fmtNum(fundamentals.forward_pe)} />
        <Stat label="D/E" value={fmtNum(fundamentals.debt_to_equity)} />
        <Stat
          label="Margins"
          value={fundamentals.profit_margins != null ? fmtPct(fundamentals.profit_margins * 100) : '—'}
        />
        <Stat
          label="Vol vs 20d"
          value={price.volume_relative_20d != null ? `${(price.volume_relative_20d * 100).toFixed(0)}%` : '—'}
        />
        <Stat label="Trend" value={technicals.trend} />
        <Stat label="Flow" value={technicals.accumulation} />
        {realized_vol?.realized_vol_30d != null && (
          <Stat label="RV30" value={fmtNum(realized_vol.realized_vol_30d, 3)} />
        )}
        {etf && (
          <Stat
            label="ETF AUM"
            value={etf.net_assets != null ? fmtNum(etf.net_assets) : (etf.family ?? etf.name ?? '—')}
          />
        )}
      </HStack>

      {ohlcLoading && ohlc.length === 0 ? (
        <HStack gap={2} vAlign="center" className="research-chart research-chart-empty">
          <Spinner size="sm" />
          <Text type="supporting">Loading chart…</Text>
        </HStack>
      ) : (
        <TickerChart bars={ohlc} spot={spot} />
      )}

      <VStack gap={3} className="research-section research-commentary-chat">
        <Heading level={3}>Lobster</Heading>
        <HStack gap={3} vAlign="start" className="research-chat-msg">
          <AssistantMark className="research-chat-avatar" />
          <VStack gap={2} className="research-chat-bubble-wrap">
            {commentaryLoading && !resolvedCommentary && (
              <HStack gap={2} vAlign="center" className="research-chat-bubble">
                <Spinner size="sm" />
                <Text type="supporting">Writing the take…</Text>
              </HStack>
            )}
            {resolvedCommentary && (
              <Text className="research-chat-bubble">{resolvedCommentary}</Text>
            )}
            {!commentaryLoading && !resolvedCommentary && (
              <Text type="supporting" className="research-chat-bubble">
                No commentary yet for {identity.ticker}.
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

      <VStack gap={3} className="research-section research-chain-section" id={`research-chain-${identity.ticker}`}>
        <Heading level={3}>Options chain</Heading>
        {chainLoading && contracts.length === 0 ? (
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

      {(earnings.length > 0 || news.length > 0 || (relatedChats && relatedChats.length > 0)) && (
        <VStack gap={3} className="research-section research-secondary">
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
          {news.length > 0 && (
            <VStack gap={2}>
              <Heading level={3}>News</Heading>
              {news.slice(0, 5).map((item) => (
                <a key={item.link} className="research-news-link" href={item.link} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
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
      )}

      <Text type="supporting" className="research-foot">
        {research.cache_hit ? 'Cached' : 'Fresh'} · {new Date(research.computed_at).toLocaleString()}
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
