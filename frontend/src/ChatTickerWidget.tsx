import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { HStack, IconButton, Spinner, Text, Tooltip, VStack } from '@astryxdesign/core';
import { X } from 'lucide-react';
import { api, type ChatTickerLink, type TickerResearch } from './api';
import { ResearchBriefView, ResearchLoading } from './ResearchBrief';
import './Research.css';

/**
 * Chat-attached ticker research widget. Lists securities linked to this chat
 * (via Copilot `research_ticker`) and expands the active brief inline.
 * Chips toggle; an explicit close control dismisses the panel on mobile.
 */
export function ChatTickerWidget({
  chatId,
  refreshKey,
}: {
  chatId: string;
  /** Bump when a research_ticker tool completes so the strip refreshes. */
  refreshKey: number;
}) {
  const [links, setLinks] = useState<ChatTickerLink[]>([]);
  const [active, setActive] = useState<string | null>(null);
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
        // Keep the open panel only if that ticker is still linked; never
        // auto-expand on first load (especially painful on mobile).
        setActive((current) => {
          if (current && res.items.some((item) => item.ticker === current)) return current;
          return null;
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
    if (!active) {
      setBrief(null);
      return;
    }
    let alive = true;
    setLoadingBrief(true);
    api.research(active)
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
  }, [active, chatId]);

  if (!loadingLinks && links.length === 0) return null;

  const closePanel = () => setActive(null);

  return (
    <VStack className="chat-research" gap={0}>
      <div className="ai-frames chat-research-strip">
        <span className="ai-frames-label">Tickers</span>
        {loadingLinks && <Spinner size="sm" />}
        {links.map((link) => (
          <Tooltip
            key={link.security_id}
            content={
              active === link.ticker
                ? 'Close research'
                : (link.name ? `${link.name} · ${link.mention_count}×` : `${link.mention_count} mentions`)
            }
            hasHoverIndication={false}
          >
            <button
              type="button"
              className={`ai-frame-chip chat-ticker-chip${active === link.ticker ? ' active' : ''}`}
              aria-pressed={active === link.ticker}
              onClick={() => setActive((current) => (current === link.ticker ? null : link.ticker))}
            >
              <b>{link.ticker}</b>
            </button>
          </Tooltip>
        ))}
        {active && (
          <HStack gap={2} vAlign="center" className="chat-research-actions">
            <Link to="/research/$ticker" params={{ ticker: active }} className="chat-research-open">
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
      </div>
      {active && (
        <div className="chat-research-panel">
          <HStack gap={2} vAlign="center" className="chat-research-panel-bar">
            <Text type="supporting" className="chat-research-panel-title">{active}</Text>
            <IconButton
              variant="ghost"
              size="sm"
              label="Close research"
              icon={<X size={16} />}
              tooltip="Close"
              onClick={closePanel}
            />
          </HStack>
          {loadingBrief && <ResearchLoading label={`Researching ${active}…`} />}
          {!loadingBrief && brief && <ResearchBriefView research={brief} compact />}
          {!loadingBrief && !brief && <Text type="supporting">No research available.</Text>}
        </div>
      )}
    </VStack>
  );
}
