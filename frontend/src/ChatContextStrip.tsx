import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { HStack, IconButton, Spinner, Text, VStack } from '@astryxdesign/core';
import { X } from 'lucide-react';
import { api, type ChatTickerLink, type TickerResearch } from './api';
import { CopyButton } from './CopyButton';
import { ResearchBriefView, ResearchLoading } from './ResearchBrief';
import './Research.css';

export interface FrameMetadata {
  name: string;
  columns: string[];
  row_count: number;
  sql: string;
  fetched_at: number;
}

type Active =
  | { kind: 'ticker'; ticker: string }
  | { kind: 'frame'; name: string }
  | null;

/**
 * Unified chat context strip — session frames and linked tickers as one row of
 * bubbles (no section labels). Click a bubble to expand its detail panel;
 * only one panel is open at a time.
 */
export function ChatContextStrip({
  chatId,
  frames,
  refreshKey,
}: {
  chatId: string;
  frames: FrameMetadata[];
  /** Bump when a research_ticker tool completes so the strip refreshes. */
  refreshKey: number;
}) {
  const navigate = useNavigate();
  const [links, setLinks] = useState<ChatTickerLink[]>([]);
  const [active, setActive] = useState<Active>(null);
  const [brief, setBrief] = useState<TickerResearch | null>(null);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [loadingLinks, setLoadingLinks] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoadingLinks(true);
    api.chatTickers(chatId)
      .then((res) => {
        if (!alive) return;
        setLinks(res.items);
        // Keep the open ticker panel only if that ticker is still linked; never
        // auto-expand on first load (especially painful on mobile).
        setActive((current) => {
          if (current?.kind === 'ticker' && res.items.some((item) => item.ticker === current.ticker)) {
            return current;
          }
          if (current?.kind === 'ticker') return null;
          return current;
        });
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

  const activeTicker = active?.kind === 'ticker' ? active.ticker : null;
  const activeFrame = active?.kind === 'frame'
    ? frames.find((frame) => frame.name === active.name) ?? null
    : null;

  useEffect(() => {
    if (!activeTicker) {
      setBrief(null);
      return;
    }
    let alive = true;
    setLoadingBrief(true);
    api.research(activeTicker)
      .then((res) => {
        if (alive) setBrief(res);
      })
      .catch(() => {
        if (alive) setBrief(null);
      })
      .finally(() => {
        if (alive) setLoadingBrief(false);
      });
    return () => { alive = false; };
  }, [activeTicker, chatId]);

  if (!loadingLinks && links.length === 0 && frames.length === 0) return null;

  const closePanel = () => setActive(null);

  const toggleTicker = (ticker: string) => {
    setActive((current) => (
      current?.kind === 'ticker' && current.ticker === ticker
        ? null
        : { kind: 'ticker', ticker }
    ));
  };

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

  return (
    <VStack className="chat-research" gap={0}>
      <div className="ai-frames chat-research-strip">
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
        {links.map((link) => (
          <button
            key={`ticker:${link.security_id}`}
            type="button"
            className={`ai-frame-chip chat-context-chip${activeTicker === link.ticker ? ' active' : ''}`}
            aria-pressed={activeTicker === link.ticker}
            aria-label={`Ticker ${link.ticker}`}
            onClick={() => toggleTicker(link.ticker)}
          >
            <b>{link.ticker}</b>
          </button>
        ))}
        {activeTicker && (
          <HStack gap={2} vAlign="center" className="chat-research-actions">
            <Link to="/research/$ticker" params={{ ticker: activeTicker }} className="chat-research-open">
              Open research ↗
            </Link>
            <IconButton
              variant="ghost"
              size="sm"
              label="Close research"
              icon={<X size={16} />}
              tooltip="Close"
              onClick={closePanel}
            />
          </HStack>
        )}
        {activeFrame && (
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

      {activeTicker && (
        <div className="chat-research-panel">
          <HStack gap={2} vAlign="center" className="chat-research-panel-bar">
            <Text type="supporting" className="chat-research-panel-title">{activeTicker}</Text>
            <IconButton
              variant="ghost"
              size="sm"
              label="Close research"
              icon={<X size={16} />}
              tooltip="Close"
              onClick={closePanel}
            />
          </HStack>
          {loadingBrief && <ResearchLoading label={`Researching ${activeTicker}…`} />}
          {!loadingBrief && brief && <ResearchBriefView research={brief} compact />}
          {!loadingBrief && !brief && <Text type="supporting">No research available.</Text>}
        </div>
      )}

      {activeFrame && (
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
      )}
    </VStack>
  );
}
