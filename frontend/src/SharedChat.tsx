import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { HStack, Spinner, Timestamp, VStack } from '@astryxdesign/core';
import './SharedChat.css';
import { ChatContextStrip } from './ChatContextStrip';
import { framesFromMessages, TranscriptMessage } from './ChatTranscript';
import { api, type SharedChat, type SharedChatMessage } from './api';
import { coalesceAssistantMessages } from './coalesceAssistantMessages';
import { PostShareButton, messageShareFragment, messageShareUrl } from './PostShareButton';
import { TimelineFollowUp } from './TimelineFollowUp';
import { UserAvatar } from './UserAvatar';
import { usePageMeta } from './usePageMeta';
import { SITE_NAME } from './pageMeta';

/**
 * Public share page (/share/:shareId) — renders a shared Copilot transcript
 * with an optional follow-up composer. The link is the capability (unlisted,
 * unguessable). Asking a follow-up requires sign-in + a public handle so the
 * forked chat can show who continued the thread.
 */
function SharedChatRoute() {
  const { shareId } = useParams({ strict: false }) as { shareId?: string };
  const [share, setShare] = useState<SharedChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

  // Worker returns shareDisplayTitle (LLM headline when stored; else clipped
  // first user turn). Trust that — do not re-derive from the raw prompt.
  const shareTitle = share?.title?.trim() || '';
  usePageMeta(
    share
      ? {
          title: `${shareTitle || 'Shared chat'} · ${SITE_NAME}`,
          description: share.author
            ? `A Copilot chat shared by @${share.author.handle} on Lobster MP.`
            : 'A shared Copilot transcript on Lobster MP.',
        }
      : missing
        ? {
            title: `Share not found · ${SITE_NAME}`,
            description: 'This share link is missing or expired.',
          }
        : null,
  );

  useEffect(() => {
    if (!shareId) {
      setLoading(false);
      setMissing(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMissing(false);
    api
      .sharedChat(shareId)
      .then((s) => {
        if (!cancelled) setShare(s);
      })
      .catch(() => {
        // Unknown and expired ids both 404 on the Worker — and a network
        // error should look the same to a recipient: nothing to show.
        if (!cancelled) setMissing(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shareId]);

  // First open of a pre-meta share awaits enrich on the Worker; if the first
  // paint still looks like the raw prompt (or tags are empty), refetch once.
  useEffect(() => {
    if (!shareId || !share) return;
    const userContent = share.messages?.find((message) => message.role === 'user')?.content?.trim();
    const titleLooksAuto = Boolean(
      userContent
      && share.title?.trim()
      && share.title.trim().toLowerCase() === userContent.toLowerCase(),
    );
    const missingTags = (share.tickers?.length ?? 0) === 0;
    if (!titleLooksAuto && !missingTags) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api.sharedChat(shareId).then((s) => {
        if (cancelled) return;
        const improvedTitle = s.title?.trim() && s.title.trim() !== share.title?.trim();
        const improvedTags = (s.tickers?.length ?? 0) > (share.tickers?.length ?? 0);
        if (improvedTitle || improvedTags) setShare(s);
      }).catch(() => { /* keep current share */ });
    }, 2_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [shareId, share]);

  // Deep-link `#m-N` lands on that turn after the transcript paints.
  useEffect(() => {
    if (loading || missing || !share) return;
    const raw = window.location.hash.replace(/^#/, '');
    if (!/^m-\d+$/.test(raw)) return;
    const timer = window.setTimeout(() => {
      document.getElementById(raw)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [loading, missing, share]);

  return (
    <section className="share-content content-column">
      {loading && (
        <div className="share-state">
          <Spinner size="md" />
          <span>Loading share…</span>
        </div>
      )}
      {!loading && missing && (
        <div className="share-state">
          <h1 className="share-state-title">Share not found</h1>
          <p>
            This link doesn&apos;t point to a shared chat — it may have expired or been removed.
          </p>
          <Link to="/" className="share-home">Back to Timeline</Link>
        </div>
      )}
      {!loading && !missing && share && (
        <>
          <header className="share-title-row">
            <HStack gap={3} vAlign="start" className="share-title-bar">
              <h1 className="share-title">{shareTitle || 'Shared chat'}</h1>
              <PostShareButton
                url={`/share/${share.share_id}`}
                title={shareTitle || 'Shared chat'}
              />
            </HStack>
            {(share.tickers?.length ?? 0) > 0 && (
              <HStack gap={2} vAlign="center" className="share-tickers" aria-label="Tags">
                {share.tickers!.map((ticker) => (
                  <Link
                    key={ticker}
                    to="/research/$ticker"
                    params={{ ticker }}
                    className="share-ticker"
                  >
                    {ticker}
                  </Link>
                ))}
              </HStack>
            )}
            <p className="share-meta">
              {(share.bot || share.author) && (
                <Link
                  to="/u/$handle"
                  params={{ handle: (share.bot ?? share.author)!.handle }}
                  className="share-author"
                >
                  @{(share.bot ?? share.author)!.handle}
                </Link>
              )}
              <Timestamp value={share.created_at / 1000} format="date_time" />
              {share.model && <span>· {share.model}</span>}
              {share.bot && <span>· {share.bot.persona}</span>}
              {share.on_timeline && <span>· on the timeline</span>}
            </p>
          </header>
          {(() => {
            const messages = coalesceAssistantMessages(share.messages);
            const frames = framesFromMessages(messages);
            const postHandle = (share.bot ?? share.author)?.handle;
            return (
              <>
                {frames.length > 0 && (
                  <ChatContextStrip frames={frames} />
                )}
                <section className="share-msgs" aria-label="Shared conversation">
                  {messages.map((m: SharedChatMessage, i: number) => {
                    const turnAuthor = m.role === 'user' ? m.author : undefined;
                    const showTurnAuthor = Boolean(
                      turnAuthor?.handle
                      && postHandle
                      && turnAuthor.handle.toLowerCase() !== postHandle.toLowerCase(),
                    );
                    return (
                      <TranscriptMessage
                        key={i}
                        message={m}
                        openInData
                        collapseSql
                        anchorId={messageShareFragment(i)}
                        shareUrl={messageShareUrl(`/share/${share.share_id}`, i)}
                        shareTitle={shareTitle || 'Shared chat'}
                        userLabel={showTurnAuthor ? (
                          <HStack gap={1} vAlign="center" className="timeline-turn-author">
                            <UserAvatar
                              avatarUrl={turnAuthor!.avatar_url}
                              className="timeline-turn-avatar"
                              alt=""
                            />
                            <span>
                              {turnAuthor!.name?.trim() || turnAuthor!.handle}
                              {' '}
                              <span className="timeline-turn-handle">@{turnAuthor!.handle}</span>
                            </span>
                          </HStack>
                        ) : null}
                      />
                    );
                  })}
                </section>
                <VStack gap={0} className="share-followup">
                  <TimelineFollowUp
                    shareId={share.share_id}
                    postHandle={postHandle}
                  />
                </VStack>
              </>
            );
          })()}
        </>
      )}
    </section>
  );
}

export default SharedChatRoute;
