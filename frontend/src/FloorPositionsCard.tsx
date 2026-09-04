import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Button,
  Card,
  Heading,
  HStack,
  List,
  ListItem,
  MetadataList,
  MetadataListItem,
  Skeleton,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Sparkles } from 'lucide-react';
import { api, type SchwabPortfolio } from './api';
import { authClient } from './auth';
import type { ChatAttachment } from './chatAttachments';
import {
  bookAskPrompt,
  flattenSchwabPositions,
  formatMoney,
  pnlTone,
  positionDescription,
  rankFloorPositions,
} from './floorPositions';
import { positionTicker } from './schwabPnlView';
import './FloorPositionsCard.css';
import './Portfolio.css';

type Phase = 'idle' | 'portfolio' | 'ready' | 'hidden';

function FloorBookSkeleton() {
  return (
    <Card variant="muted" padding={4} width="100%" aria-hidden="true">
      <VStack gap={3}>
        <Skeleton width="28%" height="var(--spacing-4)" />
        <Skeleton width="100%" height="calc(var(--size-element-lg) * 2)" radius={3} />
        <Skeleton width="72%" height="var(--spacing-4)" />
      </VStack>
    </Card>
  );
}

function KpiValue({
  value,
  tone,
}: {
  value: string;
  tone?: 'green' | 'red' | 'gray';
}) {
  return (
    <Text
      hasTabularNumbers
      weight="bold"
      className={tone ? `portfolio-pnl-${tone}` : undefined}
    >
      {value}
    </Text>
  );
}

/**
 * Personal Schwab-book scan at the top of the Floor. Hidden unless the
 * visitor is signed in and already connected — no connect CTA on the feed.
 */
export function FloorPositionsCard({
  onAsk,
}: {
  onAsk: (prompt: string, attachments?: readonly ChatAttachment[]) => void;
}) {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [phase, setPhase] = useState<Phase>('idle');
  const [book, setBook] = useState<SchwabPortfolio | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (!signedIn) {
      setPhase('hidden');
      setBook(null);
      return;
    }
    let cancelled = false;
    setPhase('idle');
    void api.schwabStatus()
      .then(async (status) => {
        if (cancelled) return;
        if (!status.configured || !status.connected) {
          setPhase('hidden');
          return;
        }
        setPhase('portfolio');
        const next = await api.schwabPortfolio();
        if (cancelled) return;
        setBook(next);
        setPhase('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setBook(null);
          setPhase('hidden');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isPending, signedIn]);

  const positions = useMemo(
    () => (book ? flattenSchwabPositions(book) : []),
    [book],
  );
  const visible = useMemo(
    () => rankFloorPositions(positions),
    [positions],
  );
  const askPrompt = useMemo(() => bookAskPrompt(positions), [positions]);
  const hiddenCount = Math.max(0, positions.length - visible.length);

  const ask = () => {
    onAsk(askPrompt, [{ kind: 'portfolio', source: 'schwab' }]);
  };

  if (phase === 'idle' || phase === 'hidden') return null;
  if (phase === 'portfolio' || !book) {
    return (
      <VStack as="section" gap={0} className="floor-book" aria-label="Your book">
        <FloorBookSkeleton />
      </VStack>
    );
  }

  const totals = book.totals;
  const moreLabel = hiddenCount === 1
    ? '1 more on Portfolio'
    : `${hiddenCount.toLocaleString()} more on Portfolio`;

  return (
    <VStack as="section" gap={0} className="floor-book" aria-label="Your book">
      <Card variant="muted" padding={4} width="100%">
        <VStack gap={3}>
          <HStack gap={3} vAlign="center" className="floor-book-head">
            <Heading level={2} className="floor-book-kicker">Your book</Heading>
            <HStack gap={2} vAlign="center" className="floor-book-actions">
              <Link
                to="/portfolio"
                search={{ book: 'schwab' }}
                className="floor-book-open"
              >
                Open book
              </Link>
              <Button
                variant="ghost"
                size="sm"
                label="Ask about the book"
                icon={<Sparkles size={14} aria-hidden="true" />}
                onClick={ask}
              />
            </HStack>
          </HStack>

          <VStack gap={0} className="floor-book-kpis" aria-label="Book summary">
            <MetadataList orientation="horizontal" label={{ position: 'top' }}>
              <MetadataListItem label="Equity">
                <KpiValue value={formatMoney(totals.equity)} />
              </MetadataListItem>
              <MetadataListItem label="Day PnL">
                <KpiValue value={formatMoney(totals.day_pnl)} tone={pnlTone(totals.day_pnl)} />
              </MetadataListItem>
              <MetadataListItem label="Open PnL">
                <KpiValue value={formatMoney(totals.open_pnl)} tone={pnlTone(totals.open_pnl)} />
              </MetadataListItem>
              <MetadataListItem label="Positions">
                <KpiValue value={totals.position_count.toLocaleString()} />
              </MetadataListItem>
            </MetadataList>
          </VStack>

          {visible.length === 0 ? (
            <Text type="supporting">
              {totals.account_count > 1
                ? `No open positions across ${totals.account_count} linked accounts.`
                : 'No open positions — cash only.'}
            </Text>
          ) : (
            <List
              density="compact"
              hasDividers
              header={`${visible.length.toLocaleString()} of ${positions.length.toLocaleString()} open`}
              className="floor-book-list"
            >
              {visible.map((row) => {
                const ticker = positionTicker(row);
                return (
                  <ListItem
                    key={row.id}
                    label={row.symbol}
                    description={positionDescription(row)}
                    endContent={(
                      <VStack gap={0}>
                        <Text
                          hasTabularNumbers
                          className={`portfolio-pnl-${pnlTone(row.day_pnl)}`}
                        >
                          {formatMoney(row.day_pnl)}
                        </Text>
                        <Text type="supporting" size="sm" hasTabularNumbers>
                          {formatMoney(row.market_value)}
                        </Text>
                      </VStack>
                    )}
                    onClick={() => {
                      void navigate({
                        to: '/research/$ticker',
                        params: { ticker },
                      });
                    }}
                  />
                );
              })}
            </List>
          )}

          {hiddenCount > 0 ? (
            <Link
              to="/portfolio"
              search={{ book: 'schwab' }}
              className="floor-book-more"
            >
              <Text type="supporting">{moreLabel}</Text>
            </Link>
          ) : null}
        </VStack>
      </Card>
    </VStack>
  );
}
