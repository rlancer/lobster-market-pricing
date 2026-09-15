import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { api, type KalshiParlayBooksSnapshot } from './api';
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

export default function KalshiParlayPayoffsNotebookPage() {
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
      { id: 'buckets', label: 'Price buckets' },
      { id: 'shape', label: 'Payoff shape' },
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
  const underdog = snapshot?.books.find((b) => b.id === 'underdog');
  const alwaysNo = snapshot?.books.find((b) => b.id === 'always_no');
  const populated = snapshot?.buckets.filter((b) => b.n > 0) ?? [];

  return (
    <div className="notebook-layout">
      <VStack gap={6}>
        <VStack gap={2} className="notebook-hero">
          <Text type="supporting">
            <Link to="/experiments">Experiments</Link>
            {' · '}
            Kalshi parlay payoffs
          </Text>
          <Heading level={1}>Do combo prices pay like their odds?</Heading>
          <Text type="supporting">
            Binary $1 contracts have a payoff table, not just a hit rate.
            Buying 80¢ NO needs ~80% wins to break even; buying 20¢ YES needs
            ~22%. This notebook buckets settled combo YES prices and compares
            empirical hit rate to breakeven (price + Kalshi taker fee).
          </Text>
          <Text type="supporting">
            Companion:{' '}
            <Link to="/experiments/kalshi-parlay-books">Book bakeoff</Link>
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
          <Text type="supporting">Loading settlement-graded combo prices…</Text>
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
                  Design {snapshot.design_id} · combined {snapshot.universes.combined.settled} settled tickets ·
                  fetched {formatWhen(snapshot.fetched_at)}
                </Text>
              </VStack>
            </Section>

            <Section id="buckets" num={tocById.get('buckets')?.num ?? '02'} title="Price buckets">
              <VStack gap={3}>
                <Text>
                  Each row is settled combo YES prices in that band. Hit rate
                  is P(YES=1). Breakeven is mean(price + fee). If hit rate
                  exceeds breakeven, buying YES in that band is +EV on this
                  tape. Buying NO is the complement.
                </Text>
                {populated.length ? (
                  <div className="notebook-results">
                    <table>
                      <thead>
                        <tr>
                          <th>YES price</th>
                          <th>n / hits</th>
                          <th>Hit vs BE</th>
                          <th>YES P&amp;L</th>
                          <th>NO P&amp;L</th>
                          <th>YES R:R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.buckets.map((bucket) => (
                          <tr
                            key={bucket.label}
                            className={bucket.n > 0 && bucket.yes_pnl > 0 ? 'notebook-row-winner' : undefined}
                          >
                            <td>
                              <strong>{bucket.label}</strong>
                              <div className="notebook-answer">avg {fmtProb(bucket.avg_yes)}</div>
                            </td>
                            <td className="num">
                              {bucket.n}
                              <div className="notebook-answer">{bucket.hits} YES hits</div>
                            </td>
                            <td className="num">
                              <Token
                                label={`${fmtPct(bucket.hit_rate)} vs ${fmtPct(bucket.breakeven)}`}
                                color={
                                  bucket.n === 0
                                    ? 'gray'
                                    : (bucket.hit_rate ?? 0) > (bucket.breakeven ?? 1)
                                      ? 'green'
                                      : 'red'
                                }
                                size="sm"
                              />
                            </td>
                            <td className="num">
                              <Token label={fmtUsd(bucket.yes_pnl)} color={pnlTone(bucket.yes_pnl)} size="sm" />
                            </td>
                            <td className="num">
                              <Token label={fmtUsd(bucket.no_pnl)} color={pnlTone(bucket.no_pnl)} size="sm" />
                            </td>
                            <td className="num">{fmtRr(bucket.yes_rr)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Text type="supporting">No settled combo prices to bucket yet.</Text>
                )}
                <Text type="supporting">
                  A 0–10¢ miss does not kill the book — that is a ~17:1 ticket.
                  Last night the 30–40¢ band (not the cheapest YES) was the
                  fattest YES P&amp;L, which is why a 30¢ ask cap left money
                  on the table versus buying every underdog YES.
                </Text>
              </VStack>
            </Section>

            <Section id="shape" num={tocById.get('shape')?.num ?? '03'} title="Payoff shape">
              <VStack gap={3}>
                <Text>
                  Corr-room is a pricing model: same-game legs should trade
                  above p×q. The payoff book is market structure: a two-leg
                  combo YES is usually the cheap side of a $1 binary, so you
                  are long convexity even if the quote is not mispriced versus
                  independence. Last night those two ideas disagreed — the
                  filter took nothing; the cheap side still paid.
                </Text>
                {underdog && alwaysNo ? (
                  <Text type="supporting">
                    Underdog on live fills {fmtUsd(underdog.fills.pnl)} at average
                    price {fmtProb(underdog.fills.avg_price)} (R:R {fmtRr(underdog.fills.avg_rr)},
                    breakeven {fmtPct(underdog.fills.breakeven)}). Always-NO{' '}
                    {fmtUsd(alwaysNo.fills.pnl)} at {fmtProb(alwaysNo.fills.avg_price)}{' '}
                    (R:R {fmtRr(alwaysNo.fills.avg_rr)}, breakeven {fmtPct(alwaysNo.fills.breakeven)}).
                  </Text>
                ) : null}
              </VStack>
            </Section>

            <Section id="method" num={tocById.get('method')?.num ?? '04'} title="Method">
              <VStack gap={3}>
                <Text>
                  Same snapshot as{' '}
                  <Link to="/experiments/kalshi-parlay-books">the book bakeoff</Link>
                  {' '}(<code>GET /api/experiments/kalshi-parlay-books</code>,
                  design {snapshot.design_id}). Combined universe, 10-contract
                  tickets, Kalshi taker fee 0.07·p·(1−p). Buckets are YES
                  price bands; P&amp;L is what you would have made buying YES
                  or NO on every settled ticket in the band.
                </Text>
                <Text type="supporting">
                  This is one night plus whatever RFQs have settled in the lake.
                  It is not a walk-forward, and it does not turn LIVE on.
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
