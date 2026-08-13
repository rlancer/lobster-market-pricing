import { useEffect, useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { AppShell, HStack, Markdown, Spinner, Timestamp } from '@astryxdesign/core';
import './SharedChat.css';
import { CopyButton } from './CopyButton';
import { Sunglasses } from './Sunglasses';
import { ChartView } from './Chart';
import { ResultTable } from './QueryResultView';
import { chartFitsResult } from './chartSpec';
import { api, type QueryResult, type SharedChat, type SharedChatMessage } from './api';

/** Drop leftover smoke-test asides (ZZZ / 2099-01-01) from older transcripts. */
function stripSmokeTestNarration(content: string): string {
  const withoutNotes = content.replace(/\s*\(Note:[^)]*\b(?:ZZZ|2099-01-01)[^)]*\)/gi, "");
  return withoutNotes
    .split(/\n{2,}/)
    .filter((block) => !/\bZZZ\b/i.test(block) && !/\b2099-01-01\b/.test(block))
    .join("\n\n")
    .trim();
}

/**
 * Public share page (/share/:shareId) — renders a shared Copilot transcript
 * read-only. The link is the capability (unlisted, unguessable), so there is
 * no auth, no composer, no settings, and no localStorage reads here — it is a
 * standalone artifact a recipient who has never visited the site can open.
 * Rendered outside the workspace shell (see App.tsx: /share/* returns a bare
 * Outlet).
 */
function SharedAssistantBody({ message }: { message: SharedChatMessage }) {
  const [result, setResult] = useState<QueryResult | null>(message.result && !message.result.error ? message.result : null);
  const [loading, setLoading] = useState(!message.result && Boolean(message.sql));

  useEffect(() => {
    if (message.result || !message.sql) {
      setResult(message.result && !message.result.error ? message.result : null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.query(message.sql, 200)
      .then((queryResult) => {
        if (!cancelled && !queryResult.error) setResult(queryResult);
      })
      .catch(() => {
        // Snapshot-less shares still show SQL; a live query miss is not fatal.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [message.result, message.sql]);

  const chart = message.chart && result?.columns && chartFitsResult(message.chart, result.columns)
    ? message.chart
    : null;

  return (
    <>
      {message.content && <div className="ai-text"><Markdown>{stripSmokeTestNarration(message.content)}</Markdown></div>}
      {chart && result && <ChartView result={result} spec={chart} />}
      {message.sql && (
        <div className="ai-sql">
          <div className="ai-sql-head">
            <span>SQL</span>
            <span className="ai-sql-actions">
              <CopyButton text={message.sql} />
            </span>
          </div>
          <pre>{message.sql}</pre>
        </div>
      )}
      {loading && <div className="ai-empty">Loading query result…</div>}
      {result && (
        chart ? (
          <details className="ai-result-details">
            <summary>Query result ({result.row_count.toLocaleString()} rows)</summary>
            <ResultTable result={result} />
          </details>
        ) : (
          <ResultTable result={result} />
        )
      )}
    </>
  );
}

function SharedChatRoute() {
  const { shareId } = useParams({ strict: false }) as { shareId?: string };
  const [share, setShare] = useState<SharedChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);

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

  return (
    <AppShell
      className="share-app"
      height="fill"
      variant="section"
      contentPadding={0}
      mobileNav={false}
      topNav={(
        <HStack as="header" className="share-head" gap={4} vAlign="center">
          <Link to="/" className="share-brand" aria-label="Lobster Copilot home">
            <Sunglasses className="share-brand-logo" />
            <span className="share-brand-name"><b>Lobster</b><em>share</em></span>
          </Link>
          <span className="share-head-spacer" aria-hidden="true" />
          <Link to="/" className="share-open">
            Open in Copilot ↗
          </Link>
        </HStack>
      )}
    >
      <section className="share-content">
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
            <Link to="/" className="share-open">Open the Copilot</Link>
          </div>
        )}
        {!loading && !missing && share && (
          <>
            <header className="share-title-row">
              <h1 className="share-title">{share.title ?? 'Shared chat'}</h1>
              <p className="share-meta">
                <Timestamp value={share.created_at / 1000} format="date_time" />
                {share.model && <span>· {share.model}</span>}
                <span>· site-funded chat</span>
              </p>
            </header>
            <section className="share-msgs" aria-label="Shared conversation">
              {share.messages.map((m: SharedChatMessage, i: number) => (
                <div key={i} className={`ai-msg ai-${m.role}`}>
                  {m.role === 'assistant' && <span className="ai-msg-mark" aria-hidden="true">λ</span>}
                  <div className="ai-bubble">
                    {m.role === 'assistant'
                      ? <SharedAssistantBody message={m} />
                      : (m.content && <div className="ai-text">{m.content}</div>)}
                  </div>
                </div>
              ))}
            </section>
          </>
        )}
      </section>
    </AppShell>
  );
}

export default SharedChatRoute;
