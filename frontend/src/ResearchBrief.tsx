import { Link } from '@tanstack/react-router';
import {
  Heading,
  HStack,
  MetadataList,
  MetadataListItem,
  Spinner,
  Text,
  VStack,
} from '@astryxdesign/core';
import type { ChatTickerLink, TickerResearch } from './api';
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

export function ResearchBriefView({
  research,
  relatedChats,
  commentary,
  commentaryLoading = false,
  compact = false,
}: {
  research: TickerResearch;
  relatedChats?: ChatTickerLink[];
  /** Lobster take — loaded separately so price can paint first. */
  commentary?: string | null;
  commentaryLoading?: boolean;
  compact?: boolean;
}) {
  const { identity, price, technicals, fundamentals, earnings, news, realized_vol, etf } = research;
  const resolvedCommentary = commentary?.trim() || research.commentary?.trim() || null;

  return (
    <VStack className={`research-brief${compact ? ' compact' : ''}`} gap={compact ? 3 : 5}>
      <VStack gap={1} className="research-hero">
        <HStack gap={3} vAlign="end" className="research-title-row">
          <Heading level={compact ? 3 : 1}>{identity.ticker}</Heading>
          {identity.name ? <Text type="supporting">{identity.name}</Text> : null}
        </HStack>
        <HStack gap={3} vAlign="end" className="research-price-row">
          <Text className="research-spot">{fmtSpot(price.spot)}</Text>
          <Text className={`research-change ${changeClass(price.change_1d_pct)}`}>
            {fmtPct(price.change_1d_pct)} 1d
          </Text>
          {!compact && (
            <Text type="supporting" className="research-change-secondary">
              {fmtPct(price.change_5d_pct)} 5d · {fmtPct(price.change_21d_pct)} 21d
            </Text>
          )}
        </HStack>
        <Text type="supporting" className="research-id-line">
          {identity.figi ? `FIGI ${identity.figi}` : 'FIGI pending'}
          {identity.composite_figi ? ` · composite ${identity.composite_figi}` : ''}
          {identity.sector ? ` · ${identity.sector}` : ''}
          {` · via ${identity.source}`}
        </Text>
      </VStack>

      <VStack gap={2} className="research-section research-commentary">
        <Heading level={3}>Lobster commentary</Heading>
        {commentaryLoading && !resolvedCommentary && (
          <HStack gap={2} vAlign="center">
            <Spinner size="sm" />
            <Text type="supporting">Writing the take…</Text>
          </HStack>
        )}
        {resolvedCommentary && <Text className="research-commentary-body">{resolvedCommentary}</Text>}
        {!commentaryLoading && !resolvedCommentary && (
          <Text type="supporting">No commentary yet.</Text>
        )}
      </VStack>

      <MetadataList className="research-meta" columns="multi" label={{ position: "top" }}>
        <MetadataListItem label="Vol vs 20d">{price.volume_relative_20d != null ? `${(price.volume_relative_20d * 100).toFixed(0)}%` : '—'}</MetadataListItem>
        <MetadataListItem label="Trend">{technicals.trend}</MetadataListItem>
        <MetadataListItem label="Consolidation">{technicals.consolidation ? `yes${technicals.consolidation_range_pct != null ? ` (${technicals.consolidation_range_pct.toFixed(1)}%)` : ''}` : 'no'}</MetadataListItem>
        <MetadataListItem label="Flow">{technicals.accumulation}</MetadataListItem>
        {!compact && (
          <MetadataListItem label="63d range">
            {fmtSpot(price.low_63d)} – {fmtSpot(price.high_63d)}
          </MetadataListItem>
        )}
      </MetadataList>

      {!compact && (
        <VStack gap={2} className="research-section">
          <Heading level={3}>Technicals</Heading>
          {technicals.notes.map((note) => (
            <Text key={note}>{note}</Text>
          ))}
          {realized_vol ? (
            <Text type="supporting">
              Realized vol 30d {fmtNum(realized_vol.realized_vol_30d, 3)} · 90d {fmtNum(realized_vol.realized_vol_90d, 3)}
              {realized_vol.as_of_date ? ` (as of ${realized_vol.as_of_date})` : ''}
            </Text>
          ) : null}
        </VStack>
      )}

      <VStack gap={2} className="research-section">
        <Heading level={3}>Fundamentals</Heading>
        <MetadataList columns="multi" label={{ position: "top" }}>
          <MetadataListItem label="Market cap">{fmtNum(fundamentals.market_cap)}</MetadataListItem>
          <MetadataListItem label="Trailing P/E">{fmtNum(fundamentals.trailing_pe)}</MetadataListItem>
          <MetadataListItem label="Forward P/E">{fmtNum(fundamentals.forward_pe)}</MetadataListItem>
          <MetadataListItem label="Total debt">{fmtNum(fundamentals.total_debt)}</MetadataListItem>
          <MetadataListItem label="D/E">{fmtNum(fundamentals.debt_to_equity)}</MetadataListItem>
          <MetadataListItem label="Margins">{fundamentals.profit_margins != null ? fmtPct(fundamentals.profit_margins * 100) : '—'}</MetadataListItem>
        </MetadataList>
        {etf ? (
          <Text type="supporting">
            ETF {etf.family ?? etf.name ?? identity.ticker}
            {etf.net_assets != null ? ` · AUM ${fmtNum(etf.net_assets)}` : ''}
            {etf.expense_ratio != null ? ` · expense ${(etf.expense_ratio * 100).toFixed(2)}%` : ''}
          </Text>
        ) : null}
      </VStack>

      {earnings.length > 0 && (
        <VStack gap={2} className="research-section">
          <Heading level={3}>Earnings</Heading>
          {earnings.slice(0, compact ? 2 : 4).map((row) => (
            <Text key={`${row.earnings_date}-${row.fiscal_q ?? ''}`}>
              {row.earnings_date}{row.time ? ` ${row.time}` : ''}
              {row.fiscal_q ? ` · ${row.fiscal_q}` : ''}
              {row.eps_forecast != null ? ` · EPS est ${row.eps_forecast}` : ''}
              {row.last_year_eps != null ? ` · LY ${row.last_year_eps}` : ''}
            </Text>
          ))}
        </VStack>
      )}

      {news.length > 0 && (
        <VStack gap={2} className="research-section">
          <Heading level={3}>News</Heading>
          {news.slice(0, compact ? 3 : 6).map((item) => (
            <a key={item.link} className="research-news-link" href={item.link} target="_blank" rel="noreferrer">
              {item.title}
            </a>
          ))}
        </VStack>
      )}

      {relatedChats && relatedChats.length > 0 && (
        <VStack gap={2} className="research-section">
          <Heading level={3}>Related chats</Heading>
          {relatedChats.map((chat) => (
            <Link key={chat.chat_id} to="/chat/$chatId" params={{ chatId: chat.chat_id }} className="research-chat-link">
              {chat.ticker} · {chat.mention_count} mention{chat.mention_count === 1 ? '' : 's'}
            </Link>
          ))}
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
