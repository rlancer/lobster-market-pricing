import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Heading, HStack, IconButton, Spinner, Text, VStack } from '@astryxdesign/core';
import { X } from 'lucide-react';
import { api, type ChatTickerLink } from './api';
import { CopyButton } from './CopyButton';
import { EntityLink } from './EntityLink';
import './Research.css';

export interface FrameMetadata {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
}

type Active = { kind: 'frame'; name: string } | null;

/**
 * Unified chat context strip — session frames and linked tickers as one row of
 * bubbles. Ticker chips link to the ticker detail page; frame chips expand a
 * panel (only one frame panel open at a time).
 *
 * `variant="rail"` stacks under a Sources heading for the desktop chat column;
 * the default strip stays a compact row above the transcript (mobile / timeline).
 *
 * Live chat passes `chatId` to load ticker links from the API. Timeline / share
 * pass static `tickers` (and optional frames snapshotted onto the transcript).
 */
export function ChatContextStrip({
  chatId,
  tickers,
  frames,
  refreshKey = 0,
  variant = 'strip',
  onPresenceChange,
}: {
  /** When set, load linked tickers from /api/chats/:id/tickers. */
  chatId?: string;
  /** Static ticker symbols (timeline / share) — used when chatId is absent. */
  tickers?: string[];
  frames: FrameMetadata[];
  /** Bump when a research_ticker tool completes so the strip refreshes. */
  refreshKey?: number;
  variant?: 'strip' | 'rail';
  /** Fires when the strip goes from empty ↔ non-empty (after links resolve). */
  onPresenceChange?: (present: boolean) => void;
}) {
  const navigate = useNavigate();
  const [links, setLinks] = useState<ChatTickerLink[]>([]);
  const [active, setActive] = useState<Active>(null);
  const [loadingLinks, setLoadingLinks] = useState(Boolean(chatId));

  const staticTickers = (tickers ?? [])
    .map((ticker) => ticker.trim().toUpperCase())
    .filter(Boolean);

  useEffect(() => {
    if (!chatId) {
      setLinks([]);
      setLoadingLinks(false);
      return;
    }
    let alive = true;
    setLoadingLinks(true);
    api.chatTickers(chatId)
      .then((res) => {
        if (!alive) return;
        setLinks(res.items);
      })
      .catch(() => {
        if (alive) setLinks([]);
      })
      .finally(() => {
        if (alive) setLoadingLinks(false);
      });
    return () => { alive = false; };
  }, [chatId, refreshKey]);

  useEffect(() => {
    setActive((current) => {
      if (current?.kind === 'frame' && !frames.some((frame) => frame.name === current.name)) {
        return null;
      }
      return current;
    });
  }, [frames]);

  const tickerCount = chatId ? links.length : staticTickers.length;

  useEffect(() => {
    onPresenceChange?.(frames.length > 0 || tickerCount > 0);
  }, [frames.length, tickerCount, onPresenceChange]);

  const activeFrame = active?.kind === 'frame'
    ? frames.find((frame) => frame.name === active.name) ?? null
    : null;

  if (!loadingLinks && tickerCount === 0 && frames.length === 0) return null;

  const closePanel = () => setActive(null);

  const toggleFrame = (name: string) => {
    setActive((current) => (
      current?.kind === 'frame' && current.name === name
        ? null
        : { kind: 'frame', name }
    ));
  };

  const frameAgeLabel = (fetchedAt: number) => {
    const ageMin = Math.round((Date.now() - fetchedAt) / 60000);
    return ageMin < 1 ? 'fresh' : `${ageMin}m ago`;
  };

  const tickerChips = chatId
    ? links.map((link) => (
      <EntityLink
        key={`ticker:${link.security_id}`}
        value={link.ticker}
        className="ai-frame-chip chat-context-chip chat-ticker-link entity-link"
      >
        <b>{link.ticker}</b>
      </EntityLink>
    ))
    : staticTickers.map((ticker) => (
      <EntityLink
        key={`ticker:${ticker}`}
        value={ticker}
        className="ai-frame-chip chat-context-chip chat-ticker-link entity-link"
      >
        <b>{ticker}</b>
      </EntityLink>
    ));

  const chips = (
    <div className={`ai-frames chat-research-strip${variant === 'rail' ? ' is-rail' : ''}`}>
      {frames.map((frame) => (
        <button
          key={`frame:${frame.name}`}
          type="button"
          className={`ai-frame-chip chat-context-chip${activeFrame?.name === frame.name ? ' active' : ''}`}
          aria-pressed={activeFrame?.name === frame.name}
          aria-label={`Session data ${frame.name}`}
          onClick={() => toggleFrame(frame.name)}
        >
          <b>{frame.name}</b>
        </button>
      ))}
      {loadingLinks && <Spinner size="sm" />}
      {tickerChips}
      {activeFrame && variant === 'strip' && (
        <HStack gap={2} vAlign="center" className="chat-research-actions">
          <button
            type="button"
            className="chat-research-open"
            onClick={() => navigate({ to: '/data', search: { sql: activeFrame.sql, item: 'query' } })}
          >
            Open in Data ↗
          </button>
          <IconButton
            variant="ghost"
            size="sm"
            label="Close session data"
            icon={<X size={16} />}
            tooltip="Close"
            onClick={closePanel}
          />
        </HStack>
      )}
    </div>
  );

  const panel = activeFrame ? (
    <div className="chat-research-panel">
      <HStack gap={2} vAlign="center" className="chat-research-panel-bar">
        <Text type="supporting" className="chat-research-panel-title">{activeFrame.name}</Text>
        <IconButton
          variant="ghost"
          size="sm"
          label="Close session data"
          icon={<X size={16} />}
          tooltip="Close"
          onClick={closePanel}
        />
      </HStack>
      <VStack gap={3} className="chat-frame-panel-body">
        <Text type="supporting" className="chat-frame-meta">
          {activeFrame.row_count.toLocaleString()} rows · {activeFrame.columns.length} cols · {frameAgeLabel(activeFrame.fetched_at)}
        </Text>
        {activeFrame.columns.length > 0 && (
          <Text type="supporting" className="chat-frame-columns">
            {activeFrame.columns.join(', ')}
          </Text>
        )}
        {activeFrame.sql && (
          <div className="ai-sql">
            <div className="ai-sql-head">
              <span>SQL</span>
              <span className="ai-sql-actions">
                <CopyButton text={activeFrame.sql} />
                <button
                  type="button"
                  onClick={() => navigate({ to: '/data', search: { sql: activeFrame.sql, item: 'query' } })}
                >
                  Open in Data ↗
                </button>
              </span>
            </div>
            <pre>{activeFrame.sql}</pre>
          </div>
        )}
      </VStack>
    </div>
  ) : null;

  if (variant === 'rail') {
    return (
      <VStack className="chat-research chat-research-rail" gap={2}>
        <Heading level={2} className="companion-rail-heading">Sources</Heading>
        {chips}
        {panel}
      </VStack>
    );
  }

  return (
    <VStack className="chat-research" gap={0}>
      {chips}
      {panel}
    </VStack>
  );
}
