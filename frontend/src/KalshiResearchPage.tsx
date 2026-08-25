/**
 * Kalshi event-market research detail — /research/kalshi/{marketTicker}.
 * Shows odds, series siblings, related lake symbol, and a link out to Kalshi.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import {
  Heading,
  HStack,
  List,
  ListItem,
  Spinner,
  Text,
  VStack,
} from '@astryxdesign/core';
import { api, type KalshiMarketItem, type KalshiMarketResearch } from './api';
import { EntityLink } from './EntityLink';
import { usePageMeta } from './usePageMeta';
import './Research.css';

function fmtYesProb(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(0)}%`;
}

function yesProb(item: KalshiMarketItem): number | null {
  if (item.yes_last != null && Number.isFinite(item.yes_last)) return item.yes_last;
  if (
    item.yes_bid != null
    && item.yes_ask != null
    && Number.isFinite(item.yes_bid)
    && Number.isFinite(item.yes_ask)
  ) {
    return (item.yes_bid + item.yes_ask) / 2;
  }
  if (item.yes_bid != null && Number.isFinite(item.yes_bid)) return item.yes_bid;
  if (item.yes_ask != null && Number.isFinite(item.yes_ask)) return item.yes_ask;
  return null;
}

function fmtCloseDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  return new Date(t).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtNum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={0} className="research-stat">
      <Text type="supporting" className="research-stat-label">{label}</Text>
      <Text className="research-stat-value">{value}</Text>
    </VStack>
  );
}

export default function KalshiResearchPage() {
  const params = useParams({ strict: false }) as { marketTicker?: string };
  const marketTicker = params.marketTicker?.trim().toUpperCase() ?? '';
  const [research, setResearch] = useState<KalshiMarketResearch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = research?.market?.title
    || research?.series_title
    || marketTicker;
  usePageMeta(
    marketTicker
      ? {
          description: `${title} — Kalshi event odds, series markets, and related lake symbols.`,
        }
      : null,
  );

  useEffect(() => {
    if (!marketTicker) {
      setResearch(null);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError(null);
    api.kalshiResearch(marketTicker)
      .then((brief) => {
        if (active) setResearch(brief);
      })
      .catch((e) => {
        if (!active) return;
        setResearch(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [marketTicker]);

  if (!marketTicker) {
    return (
      <VStack className="research-page" gap={3}>
        <Heading level={1}>Kalshi research</Heading>
        <Text type="supporting">Open a market from an event rail or suggested trade.</Text>
      </VStack>
    );
  }

  const market = research?.market ?? null;
  const related = research?.related_markets ?? [];
  const relatedSymbol = research?.related_symbol ?? market?.related_symbol ?? null;

  return (
    <VStack className="research-page" gap={3}>
      <VStack gap={1} className="research-hero">
        <Text type="supporting" className="research-id-line">
          <Link to="/research" className="research-chip-link">Research</Link>
          {' · Kalshi'}
          {research?.series_ticker ? ` · ${research.series_ticker}` : ''}
        </Text>
        <HStack gap={3} vAlign="end" className="research-title-row">
          <Heading level={1}>{market?.market_ticker ?? marketTicker}</Heading>
          {loading ? <Spinner size="sm" /> : null}
        </HStack>
        <Text type="supporting">{title}</Text>
        {market?.yes_subtitle ? (
          <Text type="supporting">{market.yes_subtitle}</Text>
        ) : null}
      </VStack>

      {error ? (
        <Text className="research-error" role="alert">{error}</Text>
      ) : null}

      {research && market ? (
        <HStack gap={4} wrap="wrap" className="research-stats">
          <Stat label="YES" value={fmtYesProb(yesProb(market))} />
          <Stat label="Bid / Ask" value={
            market.yes_bid != null || market.yes_ask != null
              ? `${fmtYesProb(market.yes_bid)} / ${fmtYesProb(market.yes_ask)}`
              : '—'
          } />
          <Stat label="Volume 24h" value={fmtNum(market.volume_24h)} />
          <Stat label="Open interest" value={fmtNum(market.open_interest)} />
          <Stat label="Status" value={market.status} />
          <Stat label="Closes" value={fmtCloseDate(market.close_time) ?? '—'} />
          <Stat label="Theme" value={market.theme} />
        </HStack>
      ) : null}

      {research?.kind === 'series' && !market ? (
        <Text type="supporting">
          Series overview — {related.length} live market{related.length === 1 ? '' : 's'} in{' '}
          {research.series_ticker}.
        </Text>
      ) : null}

      <HStack gap={3} wrap="wrap" className="research-external-links">
        {research?.url ? (
          <a
            href={research.url}
            className="research-chip-link"
            target="_blank"
            rel="noreferrer"
          >
            Trade on Kalshi
          </a>
        ) : null}
        {relatedSymbol ? (
          <EntityLink value={relatedSymbol} className="research-chip-link">
            Research {relatedSymbol}
          </EntityLink>
        ) : null}
        {research?.series_ticker && research.kind === 'market' ? (
          <Link
            to="/research/kalshi/$marketTicker"
            params={{ marketTicker: research.series_ticker }}
            className="research-chip-link"
          >
            Series {research.series_ticker}
          </Link>
        ) : null}
      </HStack>

      {related.length > 0 ? (
        <VStack gap={2} className="research-section">
          <Heading level={3}>
            {research?.kind === 'series' ? 'Markets in series' : 'Related markets'}
          </Heading>
          <List density="compact" hasDividers className="research-news-list">
            {related.map((item) => {
              const close = fmtCloseDate(item.close_time);
              const description = [
                item.yes_subtitle,
                item.market_ticker,
                close ? `closes ${close}` : null,
              ].filter(Boolean).join(' · ');
              return (
                <ListItem
                  key={item.market_ticker}
                  label={item.title}
                  description={description}
                  endContent={
                    <Text type="supporting" className="research-kalshi-yes">
                      YES {fmtYesProb(yesProb(item))}
                    </Text>
                  }
                  href={`/research/kalshi/${encodeURIComponent(item.market_ticker)}`}
                />
              );
            })}
          </List>
        </VStack>
      ) : null}

      {!loading && !error && !research ? (
        <Text type="supporting">No Kalshi market found for {marketTicker}.</Text>
      ) : null}
    </VStack>
  );
}
