import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { api, type KalshiParlayBookScore, type KalshiParlayBooksSnapshot } from './api';
import { fmtPct, fmtProb, fmtUsd } from './notebooks/kalshiParlays';
import { fmtRr, pnlTone } from './notebooks/kalshiParlayBooks';
import './Notebooks.css';

type TocEntry = { id: string; num: string; label: string };

function padNum(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function Section({
  id,
  num,
  title,
  children,
}: {
  id: string;
  num: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="notebook-section">
      <Heading level={2}>
        <span className="notebook-sec-num">{num}</span>
        {title}
      </Heading>
      {children}
    </section>
  );
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ScoreCell({ score }: { score: KalshiParlayBookScore }) {
  return (
    <VStack gap={1}>
      <Token label={fmtUsd(score.pnl)} color={pnlTone(score.pnl)} size="sm" />
      <Text type="supporting">
        {score.taken} taken · {score.settled} settled · hits {fmtPct(score.hit_rate)}
      </Text>
      <Text type="supporting">
        avg {fmtProb(score.avg_price)} · R:R {fmtRr(score.avg_rr)} · BE {fmtPct(score.breakeven)}
      </Text>
    </VStack>
  );
}

export default function KalshiParlayBooksNotebookPage() {
  const [snapshot, setSnapshot] = useState<KalshiParlayBooksSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState('verdict');

  useEffect(() => {
    let cancelled = false;
    void api.kalshiParlayBooksExperiment()
      .then((data) => {
        if (!cancelled) setSnapshot(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toc = useMemo<TocEntry[]>(() => {
    const items = [
      { id: 'verdict', label: 'Verdict' },
      { id: 'books', label: 'Books' },
      { id: 'tickets', label: 'Tickets' },
      { id: 'method', label: 'Method' },
    ];
    return items.map((item, index) => ({ ...item, num: padNum(index) }));
  }, []);

  useEffect(() => {
    const ids = toc.map((t) => t.id);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const id = visible[0]?.target.id;
      if (id) setActive(id);
    }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [toc, snapshot]);

  const tocById = new Map(toc.map((t) => [t.id, t]));

  return (
    <div className="notebook-layout">
      <VStack gap={6}>
        <VStack gap={2} className="notebook-hero">
          <Text type="supporting">
            <Link to="/experiments">Experiments</Link>
            {' · '}
            Kalshi parlay books
          </Text>
          <Heading level={1}>Which parlay book actually pays?</Heading>
          <Text type="supporting">
            Head-to-head on the same settlement tape: the live corr-room YES
            filter versus payoff-shaped books (buy the cheap side of the $1
            binary). Last night production bought expensive NO. These pages
            grade what the intended YES book — and simpler underdog rules —
            would have done at those prices. Live trading stays off.
          </Text>
          <Text type="supporting">
            Companion:{' '}
            <Link to="/experiments/kalshi-parlay-payoffs">Payoff calibration</Link>
            {' · '}
            <Link to="/experiments/kalshi-parlays">Corr-room study</Link>
          </Text>
        </VStack>

        {error ? (
          <div className="notebook-banner">
            <Text>Could not load the live snapshot: {error}</Text>
          </div>
        ) : null}

        {!snapshot && !error ? (
          <Text type="supporting">Loading lake fills, RFQ two-ways, and settlement 0/1…</Text>
        ) : null}

        {snapshot ? (
          <>
            <Section id="verdict" num={tocById.get('verdict')?.num ?? '01'} title="Verdict">
              <VStack gap={3}>
                <Text>{snapshot.headline}</Text>
                {snapshot.bullets.map((bullet) => (
                  <Text key={bullet} type="supporting">{bullet}</Text>
                ))}
                <Text type="supporting">
                  Design {snapshot.design_id} · {snapshot.contracts} contracts ·
                  fills {snapshot.universes.fills.settled}/{snapshot.universes.fills.n} settled ·
                  RFQ {snapshot.universes.rfq.settled}/{snapshot.universes.rfq.n} settled ·
                  fetched {formatWhen(snapshot.fetched_at)}
                </Text>
                {snapshot.errors.length ? (
                  <Text type="supporting">{snapshot.errors.join(' · ')}</Text>
                ) : null}
              </VStack>
            </Section>

            <Section id="books" num={tocById.get('books')?.num ?? '02'} title="Books">
              <VStack gap={3}>
                <Text>
                  Each rule sees the same tickets. Fill P&amp;L uses last night&apos;s
                  portfolio prices. RFQ P&amp;L buys YES at the ask / NO at 1 − bid
                  when a two-way has settled. Combined is one ticket per ticker
                  (fill wins).
                </Text>
                <div className="notebook-results">
                  <table>
                    <thead>
                      <tr>
                        <th>Book</th>
                        <th>Live fills</th>
                        <th>RFQ two-ways</th>
                        <th>Combined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.books.map((row) => (
                        <tr
                          key={row.id}
                          className={row.id === 'underdog' ? 'notebook-row-winner' : undefined}
                        >
                          <td>
                            <strong>{row.name}</strong>
                            <div className="notebook-answer">{row.thesis}</div>
                          </td>
                          <td><ScoreCell score={row.fills} /></td>
                          <td><ScoreCell score={row.rfq} /></td>
                          <td><ScoreCell score={row.combined} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </VStack>
            </Section>

            <Section id="tickets" num={tocById.get('tickets')?.num ?? '03'} title="Tickets">
              <VStack gap={3}>
                <Text>
                  Combined tape, fills first. Corr-room needs aligned legs
                  (p, q, same-game). Underdog only looks at the two prices.
                </Text>
                {snapshot.tickets.length ? (
                  <div className="notebook-results">
                    <table>
                      <thead>
                        <tr>
                          <th>Ticket</th>
                          <th>Prices</th>
                          <th>Result</th>
                          <th>Corr-room</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.tickets.map((ticket) => (
                          <tr key={`${ticket.universe}-${ticket.market_ticker}-${ticket.quoted_at ?? ''}`}>
                            <td>
                              <strong>{ticket.title}</strong>
                              <div className="notebook-answer">
                                {ticket.universe} · <code>{ticket.market_ticker}</code>
                              </div>
                            </td>
                            <td className="num">
                              YES {fmtProb(ticket.yes_price)} · NO {fmtProb(ticket.no_price)}
                              <div className="notebook-answer">
                                {ticket.same_game === true ? 'same-game' : ticket.same_game === false ? 'cross-game' : 'legs unaligned'}
                                {ticket.independence != null ? ` · indep ${fmtProb(ticket.independence)}` : ''}
                              </div>
                            </td>
                            <td className="num">
                              {ticket.settlement == null ? 'open' : ticket.settlement === 1 ? 'YES' : 'NO'}
                            </td>
                            <td className="num">
                              <Token
                                label={ticket.corr_room_ok ? 'would take' : 'skip'}
                                color={ticket.corr_room_ok ? 'teal' : 'gray'}
                                size="sm"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Text type="supporting">No fill or RFQ tickets in this window.</Text>
                )}
                {snapshot.notes.map((note) => (
                  <Text key={note} type="supporting">{note}</Text>
                ))}
              </VStack>
            </Section>

            <Section id="method" num={tocById.get('method')?.num ?? '04'} title="Method">
              <VStack gap={3}>
                <Text>
                  Lake rows from <code>options.kalshi_markets</code>: executor
                  fills (<code>source=kalshi_parlay_fill</code>), solicited RFQ
                  two-ways (<code>kalshi_rfq</code>), settlement 0/1
                  (<code>kalshi_settlement</code>). Size is {snapshot.contracts} contracts
                  ($10 notional) minus Kalshi taker fee 0.07·p·(1−p). This
                  experiment does not accept RFQs and cannot set LIVE.
                </Text>
                <Text type="supporting">
                  Corr-room YES is <code>evaluateParlayQuote</code> — same-game,
                  same-side, corr room ≥ 15¢, spread ≤ 8¢, ask ≤ p×q + 2¢,
                  |φ| &lt; 0.15. Underdog buys the side with cost ≤ {fmtPct(snapshot.underdog_max_cost)}.
                  Payoff YES buys YES only when ask ≤ {fmtProb(snapshot.payoff_yes_max_ask)}.
                  Always-YES / always-NO are baselines, not proposals.
                </Text>
              </VStack>
            </Section>
          </>
        ) : null}
      </VStack>

      <nav className="notebook-toc" aria-label="On this page">
        <span className="notebook-toc-title">On this page</span>
        {toc.map((entry) => (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            className={active === entry.id ? 'active' : undefined}
          >
            <span className="notebook-toc-link">
              <span className="notebook-toc-num">{entry.num}</span>
              {entry.label}
            </span>
          </a>
        ))}
      </nav>
    </div>
  );
}
