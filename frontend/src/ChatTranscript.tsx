import { useEffect, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { HStack, Markdown } from '@astryxdesign/core';
import { CopyButton } from './CopyButton';
import { ChartView } from './Chart';
import { ResultTable } from './QueryResultView';
import { chartFitsResult } from './chartSpec';
import { api, type QueryResult, type SharedChatMessage } from './api';
import { PostShareButton } from './PostShareButton';
import { AssistantMark } from './Sunglasses';
import { DeskViewpoints, isDeskBrief } from './DeskViewpoints';
import { SuggestedTradesView } from './SuggestedTrades';

const TOOL_LABELS: Record<string, string> = {
  run_query: 'SQL query',
  check_schema: 'Check schema',
  list_frames: 'List frames',
  filter_frame: 'Filter frame',
  refresh_frame: 'Refresh frame',
  render_chart: 'Render chart',
  get_news: 'News',
  eco_calendar: 'Eco calendar',
  web_search: 'Web search',
  research_ticker: 'Ticker research',
  lookup_symbols: 'Identify symbols',
  publish_desk: 'Desk viewpoints',
  suggest_trades: 'Suggested trades',
  get_paper_portfolio: 'Paper portfolio',
  get_schwab_portfolio: 'Schwab portfolio',
  get_schwab_quotes: 'Schwab quotes',
  get_bot_trades: 'Bot trade performance',
};

/**
 * Finished assistant turn body shared by live chat, /share/:id, and the
 * public timeline. Desk viewpoints, markdown, Thinking, Tools used, chart,
 * SQL, and query result (details when a chart is up).
 */
export function AssistantMessageBody({
  message,
  openInData = false,
  hydrateResult = true,
  collapseSql = false,
  hideThinking = false,
  hideTools = false,
  chatId,
  enableTrack = true,
}: {
  message: SharedChatMessage;
  /** When true, offer “Open in Data” next to Copy (live chat / timeline in-app). */
  openInData?: boolean;
  /**
   * When false, skip live /api/query hydration (clamped timeline feed). SQL and
   * Thinking still render; charts force a fetch so the figure can paint.
   */
  hydrateResult?: boolean;
  /** Timeline / settled chat: SQL starts collapsed like Thinking. */
  collapseSql?: boolean;
  /** Live streaming: TurnProgress already shows the open Thinking panel. */
  hideThinking?: boolean;
  /** Live streaming: TurnProgress already shows the tool feed. */
  hideTools?: boolean;
  /** Live chat id for paper-portfolio Track dedupe. */
  chatId?: string | null;
  /** Hide Track on surfaces that should stay read-only. */
  enableTrack?: boolean;
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

  const desk = message.desk && isDeskBrief(message.desk) ? message.desk : null;
  const overviewRaw = (desk?.overview || message.content || '').trim();
  const overview = /^(placeholder|tbd|todo|n\/?a|none|\.{1,3})$/i.test(overviewRaw) ? '' : overviewRaw;
  const tools = !hideTools && message.tools?.length ? message.tools : null;

  return (
    <>
      {desk && <DeskViewpoints desk={desk} showOverview={false} />}
      {(() => {
        if (!overview) return null;
        return (
          <div className="ai-text">
            {desk ? <span className="ai-desk-overview-label">Overview</span> : null}
            <Markdown>{overview}</Markdown>
          </div>
        );
      })()}
      {message.trades && (
        <SuggestedTradesView
          trades={message.trades}
          chatId={chatId}
          enableTrack={enableTrack}
        />
      )}
      {!hideThinking && message.reasoning && (
        <details className="ai-thinking ai-thinking-done">
          <summary>Thinking</summary>
          <div className="ai-thinking-body">{message.reasoning}</div>
        </details>
      )}
      {tools && (
        <details className="ai-thinking ai-thinking-done ai-tools-used">
          <summary>Tools used ({tools.length})</summary>
          <div className="ai-tool-feed">
            {tools.map((tool, index) => (
              <div
                className={`ai-tool-row${tool.ok === undefined ? '' : tool.ok ? ' ok' : ' fail'}`}
                key={`${tool.name}-${index}`}
              >
                <span className="ai-tool-name">
                  <span className="ai-tool-state" aria-hidden="true">
                    {tool.ok === undefined ? '·' : tool.ok ? '✓' : '✗'}
                  </span>
                  {TOOL_LABELS[tool.name] ?? tool.name.replaceAll('_', ' ')}
                </span>
                {tool.args && <code className="ai-tool-args">{tool.args}</code>}
                {tool.summary && (
                  <span className="ai-tool-summary" title={tool.summary}>{tool.summary}</span>
                )}
              </div>
            ))}
          </div>
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
      {message.role === 'assistant'
        && !overview
        && (message.sql || result || chart || message.trades || desk)
        && (
          <div className="ai-no-answer">The model produced the data above but no written answer for this turn.</div>
        )}
    </>
  );
}

/** Collect the latest session frames from a transcript (Sources strip). */
export function framesFromMessages(messages: SharedChatMessage[]): NonNullable<SharedChatMessage['frames']> {
  let frames: NonNullable<SharedChatMessage['frames']> = [];
  for (const message of messages) {
    if (message.frames?.length) frames = message.frames;
  }
  return frames;
}

/** One transcript row — same bubble chrome as live AiChat / SharedChat / timeline. */
export function TranscriptMessage({
  message,
  openInData = false,
  hydrateResult = true,
  collapseSql = false,
  hideThinking = false,
  chatId,
  enableTrack = true,
  userAside = null,
  userLabel = null,
  footer = null,
  header = null,
  anchorId,
  shareUrl,
  shareTitle,
}: {
  message: SharedChatMessage;
  openInData?: boolean;
  hydrateResult?: boolean;
  collapseSql?: boolean;
  hideThinking?: boolean;
  chatId?: string | null;
  enableTrack?: boolean;
  /**
   * Optional chrome beside the user bubble (timeline: avatar on the left).
   * Assistant turns keep the brand mark; omit on /share and /chat.
   */
  userAside?: ReactNode;
  /** Optional single-line name/@handle rendered above the user bubble. */
  userLabel?: ReactNode;
  /** Optional chrome below the assistant body (live chat: timestamp / model). */
  footer?: ReactNode;
  /** Optional chrome above the assistant body (live chat: TurnProgress). */
  header?: ReactNode;
  /** Deep-link target id (e.g. `m-2` for `/share/:id#m-2`). */
  anchorId?: string;
  /** When set, render a per-turn Copy link / Share via… control. */
  shareUrl?: string;
  shareTitle?: string;
}) {
  const shareControl = shareUrl ? (
    <PostShareButton
      url={shareUrl}
      title={shareTitle || 'Shared chat'}
      label="Share reply"
      tooltip="Share this reply"
    />
  ) : null;

  if (message.role === 'user') {
    const body = message.content
      ? <div className="ai-text">{message.content}</div>
      : null;
    if (userAside || userLabel) {
      return (
        <div id={anchorId} className="ai-msg ai-user timeline-user-turn">
          {userLabel}
          <HStack gap={2} vAlign="end" className="transcript-turn-row">
            <div className="ai-bubble">{body}</div>
            {shareControl}
            {userAside}
          </HStack>
        </div>
      );
    }
    return (
      <div id={anchorId} className="ai-msg ai-user">
        <div className="ai-bubble">{body}</div>
        {shareControl ? <div className="ai-msg-share">{shareControl}</div> : null}
      </div>
    );
  }

  return (
    <div id={anchorId} className="ai-msg ai-assistant">
      <AssistantMark />
      <div className="ai-bubble">
        {header}
        <AssistantMessageBody
          message={message}
          openInData={openInData}
          hydrateResult={hydrateResult}
          collapseSql={collapseSql}
          hideThinking={hideThinking}
          chatId={chatId}
          enableTrack={enableTrack}
        />
        {(footer || shareControl) ? (
          <HStack gap={2} vAlign="center" className="transcript-turn-actions">
            {shareControl}
            {footer}
          </HStack>
        ) : null}
      </div>
    </div>
  );
}
