import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Markdown } from '@astryxdesign/core';
import { CopyButton } from './CopyButton';
import { ChartView } from './Chart';
import { ResultTable } from './QueryResultView';
import { chartFitsResult } from './chartSpec';
import { api, type QueryResult, type SharedChatMessage } from './api';
import { AssistantMark } from './Sunglasses';
import { DeskViewpoints } from './DeskViewpoints';

/**
 * Read-only assistant turn body shared by /share/:id and the public timeline.
 * Mirrors the finished-message layout in AiChat: desk viewpoints, markdown,
 * collapsible Thinking, chart, SQL block, and query result (details when a chart is up).
 */
export function AssistantMessageBody({
  message,
  openInData = false,
  hydrateResult = true,
  collapseSql = false,
}: {
  message: SharedChatMessage;
  /** When true, offer “Open in Data” next to Copy (live chat / timeline in-app). */
  openInData?: boolean;
  /**
   * When false, skip live /api/query hydration (timeline feed). SQL and
   * Thinking still render; charts force a fetch so the figure can paint.
   */
  hydrateResult?: boolean;
  /** Timeline: SQL starts collapsed like Thinking; share/chat keep it open. */
  collapseSql?: boolean;
}) {
  const wantsChart = Boolean(message.chart);
  const shouldHydrate = hydrateResult || wantsChart;
  const [result, setResult] = useState<QueryResult | null>(message.result && !message.result.error ? message.result : null);
  const [loading, setLoading] = useState(shouldHydrate && !message.result && Boolean(message.sql));

  useEffect(() => {
    if (message.result || !message.sql || !shouldHydrate) {
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
  }, [message.result, message.sql, shouldHydrate]);

  const chart = message.chart && result?.columns && chartFitsResult(message.chart, result.columns)
    ? message.chart
    : null;

  const sqlBlock = message.sql ? (
    <>
      <div className="ai-sql-head">
        <span>SQL</span>
        <span className="ai-sql-actions">
          <CopyButton text={message.sql} />
          {openInData ? (
            <Link to="/data" search={{ sql: message.sql, item: 'query' }} className="ai-sql-open">
              Open in Data ↗
            </Link>
          ) : null}
        </span>
      </div>
      <pre>{message.sql}</pre>
    </>
  ) : null;

  return (
    <>
      {message.desk && <DeskViewpoints desk={message.desk} showOverview={false} />}
      {message.content && (
        <div className="ai-text">
          {message.desk ? <span className="ai-desk-overview-label">Overview</span> : null}
          <Markdown>{message.content}</Markdown>
        </div>
      )}
      {!message.content && message.desk?.overview && (
        <div className="ai-text">
          <span className="ai-desk-overview-label">Overview</span>
          <Markdown>{message.desk.overview}</Markdown>
        </div>
      )}
      {message.reasoning && (
        <details className="ai-thinking ai-thinking-done">
          <summary>Thinking</summary>
          <div className="ai-thinking-body">{message.reasoning}</div>
        </details>
      )}
      {chart && result && <ChartView result={result} spec={chart} />}
      {message.sql && (
        collapseSql ? (
          <details className="ai-sql ai-sql-collapsible">
            <summary className="ai-sql-head">
              <span>SQL</span>
              <span
                className="ai-sql-actions"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <CopyButton text={message.sql} />
                {openInData ? (
                  <Link to="/data" search={{ sql: message.sql, item: 'query' }} className="ai-sql-open">
                    Open in Data ↗
                  </Link>
                ) : null}
              </span>
            </summary>
            <pre>{message.sql}</pre>
          </details>
        ) : (
          <div className="ai-sql">{sqlBlock}</div>
        )
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

/** One read-only transcript row — same bubble chrome as AiChat / SharedChat. */
export function TranscriptMessage({
  message,
  openInData = false,
  hydrateResult = true,
  collapseSql = false,
  userAside = null,
  userLabel = null,
}: {
  message: SharedChatMessage;
  openInData?: boolean;
  hydrateResult?: boolean;
  collapseSql?: boolean;
  /**
   * Optional chrome beside the user bubble (timeline: avatar on the left).
   * Assistant turns keep the brand mark; omit on /share and /chat.
   */
  userAside?: ReactNode;
  /** Optional single-line name/@handle rendered above the user bubble. */
  userLabel?: ReactNode;
}) {
  if (message.role === 'user') {
    const body = message.content
      ? <div className="ai-text">{message.content}</div>
      : null;
    if (userAside || userLabel) {
      return (
        <div className="ai-msg ai-user timeline-user-turn">
          {userLabel}
          <div className="ai-bubble">{body}</div>
          {userAside}
        </div>
      );
    }
    return (
      <div className="ai-msg ai-user">
        <div className="ai-bubble">{body}</div>
      </div>
    );
  }

  return (
    <div className="ai-msg ai-assistant">
      <AssistantMark />
      <div className="ai-bubble">
        <AssistantMessageBody
          message={message}
          openInData={openInData}
          hydrateResult={hydrateResult}
          collapseSql={collapseSql}
        />
      </div>
    </div>
  );
}
