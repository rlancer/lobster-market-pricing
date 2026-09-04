import { useCallback, useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  Button,
  Card,
  Heading,
  HStack,
  Skeleton,
  Text,
  Timestamp,
  VStack,
} from '@astryxdesign/core';
import { Sparkles } from 'lucide-react';
import { api, type TimelineRailHighlight } from './api';
import {
  DESK_HANDLE,
  changeDirection,
  deskTakeaway,
  fmtPct,
  fmtSpot,
  pickTape,
  pickUpcomingEvents,
  sessionHasContent,
  tapeAskPrompt,
  type DeskTakeaway,
  type UpcomingEvent,
} from './sessionSnapshot';
import './SessionCard.css';

function SessionCardSkeleton() {
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

/**
 * Live session snapshot at the top of the home feed — index tape, next print,
 * and the latest @nowlobster takeaway. Visible on mobile (the rail is not).
 */
export function SessionCard({
  onAsk,
}: {
  onAsk: (prompt: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [tape, setTape] = useState<TimelineRailHighlight[]>([]);
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [takeaway, setTakeaway] = useState<DeskTakeaway | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      api.timelineRail().catch(() => null),
      api.econCalendar(14).catch(() => null),
      api.timeline({ handle: DESK_HANDLE, limit: 1 }).catch(() => null),
    ]).then(([rail, calendar, desk]) => {
      if (cancelled) return;
      setTape(pickTape(rail?.highlights ?? []));
      setEvents(pickUpcomingEvents(calendar?.items ?? [], Date.now()));
      setTakeaway(deskTakeaway(desk?.items?.[0]));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ask = useCallback(() => {
    onAsk(tapeAskPrompt(tape, events));
  }, [onAsk, tape, events]);

  if (loading) {
    return (
      <VStack as="section" gap={0} className="session-card" aria-label="Session">
        <SessionCardSkeleton />
      </VStack>
    );
  }
  if (!sessionHasContent(tape, events, takeaway)) return null;

  return (
    <VStack as="section" gap={0} className="session-card" aria-label="Session">
      <Card variant="muted" padding={4} width="100%">
        <VStack gap={3}>
          <HStack gap={3} vAlign="center" className="session-head">
            <Heading level={2} className="session-kicker">Session</Heading>
            <Button
              variant="ghost"
              size="sm"
              className="session-ask"
              label="Ask about the tape"
              icon={<Sparkles size={14} aria-hidden="true" />}
              onClick={ask}
            />
          </HStack>

          {tape.length > 0 && (
            <HStack
              gap={2}
              wrap="wrap"
              className="session-tape"
              aria-label="Index tape"
            >
              {tape.map((item) => {
                const direction = changeDirection(item.change_1d_pct);
                return (
                  <Link
                    key={item.ticker}
                    to="/research/$ticker"
                    params={{ ticker: item.ticker }}
                    className="session-tape-item"
                    aria-label={`${item.ticker} ${fmtPct(item.change_1d_pct)}, ${fmtSpot(item.spot)}`}
                  >
                    <VStack gap={0}>
                      <Text weight="semibold" className="session-tape-ticker">{item.ticker}</Text>
                      <Text className={`session-tape-change ${direction}`}>
                        {fmtPct(item.change_1d_pct)}
                      </Text>
                      <Text type="supporting">{fmtSpot(item.spot)}</Text>
                    </VStack>
                  </Link>
                );
              })}
            </HStack>
          )}

          {events.length > 0 && (
            <HStack gap={3} wrap="wrap" className="session-events" aria-label="Upcoming prints">
              {events.map((event) => (
                <Text key={`${event.date}-${event.title}`} type="supporting">
                  {event.shortTitle}
                  {' · '}
                  {event.when}
                </Text>
              ))}
            </HStack>
          )}

          {takeaway && (
            <VStack gap={1} className="session-desk">
              <HStack gap={2} vAlign="center" className="session-desk-byline">
                <Link
                  to="/u/$handle"
                  params={{ handle: takeaway.handle }}
                  className="session-desk-handle"
                >
                  @{takeaway.handle}
                </Link>
                <Timestamp value={takeaway.publishedAt / 1000} format="auto" isLive />
              </HStack>
              <Link
                to="/share/$shareId"
                params={{ shareId: takeaway.shareId }}
                className="session-desk-takeaway"
              >
                <Text>{takeaway.text}</Text>
              </Link>
            </VStack>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}
