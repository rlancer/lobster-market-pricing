import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { api, type KalshiParlayRow, type KalshiParlaySnapshot } from './api';
import { flagLabel, fmtGap, fmtPct, fmtProb, fmtRho, fmtUsd, gapTone } from './notebooks/kalshiParlays';
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

function flagColor(flag: string): 'red' | 'teal' | 'gray' {
  if (flag.includes('frechet')) return 'red';
  if (flag === 'independence_gap' || flag === 'copula_gap') return 'teal';
  return 'gray';
}

function Flags({ flags }: { flags: string[] }) {
  if (!flags.length) {
    return <Token label="in line" color="gray" size="sm" />;
  }
  return (
    <VStack gap={1}>
      {flags.map((flag) => (
        <Token
          key={flag}
          label={flagLabel(flag)}
          color={flagColor(flag)}
          size="sm"
        />
      ))}
    </VStack>
  );
}

function LegsCell({ row }: { row: KalshiParlayRow }) {
  return (
    <VStack gap={1}>
      {row.legs.map((leg) => (
        <Text key={leg.quote.ticker} type="supporting">
          {leg.role}: {fmtProb(leg.selected_prob)}
          {' · '}
          <code>{leg.quote.ticker}</code>
        </Text>
      ))}
    </VStack>
  );
}

function ParlayTable({ rows, listed }: { rows: KalshiParlayRow[]; listed: boolean }) {
  if (!rows.length) {
    return <Text type="supporting">No live rows this snapshot.</Text>;
  }
  return (
    <div className="notebook-results">
      <table>
        <thead>
          <tr>
            <th>{listed ? 'Combo' : 'Pair'}</th>
            <th>Legs</th>
            <th>Book / indep.</th>
            <th>Gap</th>
            <th>φ / ρ</th>
            <th>Flag</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const joint = listed ? row.score.joint : row.score.copula_fair;
            return (
              <tr key={row.id} className={row.score.flags.length ? 'notebook-row-winner' : undefined}>
                <td>
                  <strong>{row.label}</strong>
                  {row.meeting ? (
                    <div className="notebook-answer">{row.meeting}</div>
                  ) : null}
                  {row.combo ? (
                    <div className="notebook-answer"><code>{row.combo.ticker}</code></div>
                  ) : null}
                </td>
                <td><LegsCell row={row} /></td>
                <td className="num">
                  {fmtProb(joint)}
                  <div className="notebook-answer">indep {fmtProb(row.score.independence)}</div>
                  {row.score.joint == null && listed ? (
                    <div className="notebook-answer">
                      Fréchet {fmtProb(row.score.frechet_low)}–{fmtProb(row.score.frechet_high)}
                    </div>
                  ) : null}
                  {row.score.flags.includes('same_game') && (row.score.corr_room ?? 0) > 0 ? (
                    <div className="notebook-answer">
                      corr room {fmtGap(row.score.corr_room)}
                    </div>
                  ) : null}
                  {row.score.copula_fair != null ? (
                    <div className="notebook-answer">copula {fmtProb(row.score.copula_fair)}</div>
                  ) : null}
                </td>
                <td className="num">
                  <Token
                    label={fmtGap(listed
                      ? (row.score.gap_vs_independence ?? (row.score.flags.includes('same_game') ? row.score.corr_room : null))
                      : (row.score.copula_fair != null
                        ? row.score.copula_fair - row.score.independence
                        : null))}
                    color={gapTone(listed
                      ? (row.score.gap_vs_independence ?? (row.score.flags.includes('same_game') ? row.score.corr_room : null))
                      : (row.score.copula_fair != null
                        ? row.score.copula_fair - row.score.independence
                        : null))}
                    size="sm"
                  />
                  {listed && row.score.gap_vs_independence != null ? (
                    <div className="notebook-answer">listed − independent</div>
                  ) : listed && row.score.flags.includes('same_game') ? (
                    <div className="notebook-answer">Fréchet high − independent</div>
                  ) : (
                    <div className="notebook-answer">copula − independent</div>
                  )}
                </td>
                <td className="num">
                  φ {fmtRho(row.score.phi)}
                  <div className="notebook-answer">
                    ρ {fmtRho(row.score.implied_rho ?? row.rho_proxy)}
                  </div>
                </td>
                <td>
                  <Flags flags={row.score.flags} />
                  <div className="notebook-answer">{row.notes}</div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function KalshiParlaysNotebookPage() {
  const [snapshot, setSnapshot] = useState<KalshiParlaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState('verdict');

  useEffect(() => {
    let cancelled = false;
    void api.kalshiParlayExperiment()
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
      { id: 'listed', label: 'Listed Fed combos' },
      { id: 'marginals', label: 'Cross-book marginals' },
      { id: 'homemade', label: 'Homemade parlays' },
      { id: 'sports', label: 'Sports parlays' },
      { id: 'backtest', label: 'Strategy backtest' },
      { id: 'crypto', label: 'Crypto target-price MVEs' },
      { id: 'mve', label: 'Combo CLOB' },
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
            Kalshi parlays
          </Text>
          <Heading level={1}>Are Kalshi parlays ever mispriced?</Heading>
          <Text type="supporting">
            A live check of whether combo prices equal the product of the legs
            (independence). If the legs move together, that product is the wrong
            probability — and a listed combo that ignores the correlation is
            mispriced relative to the singles.
          </Text>
        </VStack>

        {error ? (
          <div className="notebook-banner">
            <Text>Could not load the live snapshot: {error}</Text>
          </div>
        ) : null}

        {!snapshot && !error ? (
          <Text type="supporting">Loading live Kalshi books and lake return correlations…</Text>
        ) : null}

        {snapshot ? (
          <>
            <Section id="verdict" num={tocById.get('verdict')?.num ?? '01'} title="Verdict">
              <VStack gap={3}>
                <Heading level={3}>{snapshot.verdict.headline}</Heading>
                <Text type="supporting">
                  Snapshot {formatWhen(snapshot.fetched_at)} · design {snapshot.design_id}
                  {snapshot.verdict.max_abs_independence_gap != null
                    ? ` · largest |listed − independent| ${fmtGap(snapshot.verdict.max_abs_independence_gap).replace('+', '')}`
                    : ''}
                </Text>
                <VStack gap={2}>
                  {snapshot.verdict.bullets.map((bullet) => (
                    <Text key={bullet}>{bullet}</Text>
                  ))}
                </VStack>
                {snapshot.errors.length ? (
                  <Text type="supporting">Partial: {snapshot.errors.join(' · ')}</Text>
                ) : null}
              </VStack>
            </Section>

            <Section id="listed" num={tocById.get('listed')?.num ?? '02'} title="Listed Fed combos">
              <VStack gap={3}>
                <Text>
                  Kalshi lists <code>KXFEDCOMBO</code> as a 2×2 of the meeting&apos;s rate
                  decision and whether anyone dissents. The legs live on{' '}
                  <code>KXFEDDECISION</code> and <code>KXFOMCDISSENTCOUNT</code>. If those
                  books were independent, each combo mid would equal the product of the
                  two YES mids. A gap larger than the combined half-spreads is the
                  correlation the combo book is charging (or paying).
                </Text>
                <ParlayTable rows={snapshot.listed} listed />
              </VStack>
            </Section>

            <Section id="marginals" num={tocById.get('marginals')?.num ?? '03'} title="Cross-book marginals">
              <VStack gap={3}>
                <Text>
                  Summing combo cells that share a rate (or a dissent outcome) should
                  recover the standalone marginal. A persistent gap is a second kind of
                  mispricing: the joint book and the single-leg books disagree about
                  P(hike) or P(unanimous).
                </Text>
                {snapshot.marginals.length ? (
                  <div className="notebook-results">
                    <table>
                      <thead>
                        <tr>
                          <th>Meeting</th>
                          <th>Quantity</th>
                          <th>Combo-implied</th>
                          <th>Standalone</th>
                          <th>Gap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.marginals.map((row) => (
                          <tr key={`${row.meeting}-${row.name}`} className={row.flag ? 'notebook-row-winner' : undefined}>
                            <td>{row.meeting}</td>
                            <td>{row.name}</td>
                            <td className="num">{fmtProb(row.combo_implied)}</td>
                            <td className="num">{fmtProb(row.standalone)}</td>
                            <td className="num">
                              <Token
                                label={fmtGap(row.gap)}
                                color={row.flag ? gapTone(row.gap) : 'gray'}
                                size="sm"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Text type="supporting">No overlapping meeting to compare.</Text>
                )}
              </VStack>
            </Section>

            <Section id="homemade" num={tocById.get('homemade')?.num ?? '04'} title="Homemade parlays">
              <VStack gap={3}>
                <Text>
                  Investing series are not in Kalshi&apos;s multivariate (sports) combo
                  collections. Pair the most liquid two-sided YES contracts on related
                  underlyings and ask: if someone quoted that parlay as independent,
                  how wrong would they be once you plug in the lake&apos;s overlapping
                  daily log-return correlation as a Gaussian copula ρ?
                </Text>
                {snapshot.correlations.length ? (
                  <div className="notebook-results">
                    <table>
                      <thead>
                        <tr>
                          <th>Pair</th>
                          <th>n</th>
                          <th>Pearson ρ</th>
                          <th>Lookback</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.correlations.map((row) => (
                          <tr key={`${row.symbol_a}-${row.symbol_b}`}>
                            <td>{row.symbol_a} × {row.symbol_b}</td>
                            <td className="num">{row.n}</td>
                            <td className="num">{fmtRho(row.pearson)}</td>
                            <td className="num">{row.lookback_days}d</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Text type="supporting">No overlapping OHLC this pass — copula-fair prices omitted.</Text>
                )}
                <ParlayTable rows={snapshot.homemade} listed={false} />
              </VStack>
            </Section>

            <Section id="sports" num={tocById.get('sports')?.num ?? '05'} title="Sports parlays">
              <VStack gap={3}>
                <Text>
                  Multivariate (MVE) combos plus the legs they actually
                  select land in <code>options.kalshi_markets</code> with
                  {' '}<code>theme=sports</code>. Combo rows store the collection
                  and selected tickers in <code>category</code> as{' '}
                  <code>mve|COLLECTION|yes:LEG,no:LEG,…</code>
                  — not the full sports catalog. Combos are RFQ auctions
                  (Kalshi HVMs): makers quote privately, then a fill may
                  print on the public book. Empty 0/0/0 is the resting
                  venue, not a missing market. Same-game stacks (1H spread AND
                  1H total, Henry 110+ AND Jackson 40+) have correlated legs.
                  Corr room is Fréchet high minus p×q — the positive
                  correlation a maker leaves on the table if the RFQ quotes
                  independence. The hourly ingest solicits a capped set of
                  same-game RFQs, maps the private two-way onto
                  <code>yes_bid</code>/<code>yes_ask</code>, then cancels
                  without accepting — that is how implied ρ becomes
                  observable. Legs are aligned
                  to the combo snapshot time, not mixed latest-wins.
                </Text>
                <Text type="supporting">
                  Source this pass: {snapshot.sports_source === 'lake'
                    ? 'lake (KXMVE hourly ingest)'
                    : snapshot.sports_source === 'live'
                      ? 'live Kalshi MVE fallback — lake had no sports rows yet'
                      : 'none'}
                  {snapshot.verdict.sports_scored
                    ? ` · ${snapshot.verdict.sports_scored} shown · ${snapshot.verdict.sports_flagged} vs independent on a real tape · ${snapshot.verdict.sports_same_game} same-game`
                    : ''}
                </Text>
                <ParlayTable rows={snapshot.sports ?? []} listed />
              </VStack>
            </Section>

            <Section id="backtest" num={tocById.get('backtest')?.num ?? '06'} title="Strategy backtest">
              <VStack gap={3}>
                <Text>
                  The live executor buys a same-game two-leg combo YES only
                  when a maker RFQ sits near independence: corr room ≥ 15¢,
                  spread ≤ 8¢, ask ≤ p×q + 2¢, |φ| &lt; 0.15, same side.
                  Last night&apos;s production tickets are graded from{' '}
                  <code>source=kalshi_parlay_fill</code> (Kalshi portfolio
                  fills published by the executor). The filter replay still
                  uses lake <code>source=kalshi_rfq</code> two-ways against
                  settlement 0/1. Strategy P&amp;L is BUY YES at the ask.
                  Actual P&amp;L is the fill side that landed — on
                  2026-09-14 that was BUY NO at 1 − bid.
                </Text>
                {snapshot.backtest ? (
                  <>
                    {snapshot.backtest.live && snapshot.backtest.live.n > 0 ? (
                      <>
                        <Text type="supporting">
                          Live fills {snapshot.backtest.live.n} · settled {snapshot.backtest.live.settled} · filled-side hits {fmtPct(snapshot.backtest.live.hit_rate)} · actual {fmtUsd(snapshot.backtest.live.actual_pnl)} · YES-at-same-price {fmtUsd(snapshot.backtest.live.yes_counterfactual_pnl)}
                        </Text>
                        <div className="notebook-results">
                          <table>
                            <thead>
                              <tr>
                                <th>Live fill</th>
                                <th>Side / prices</th>
                                <th>Result</th>
                                <th>Actual P&amp;L</th>
                                <th>YES if filled</th>
                              </tr>
                            </thead>
                            <tbody>
                              {snapshot.backtest.live.fills.map((fill) => (
                                <tr key={`${fill.market_ticker}-${fill.quoted_at ?? ''}`} className={fill.actual_pnl != null && fill.actual_pnl < 0 ? 'notebook-row-winner' : undefined}>
                                  <td>
                                    <strong>{fill.title}</strong>
                                    <div className="notebook-answer"><code>{fill.market_ticker}</code></div>
                                  </td>
                                  <td className="num">
                                    BUY {fill.fill_side.toUpperCase()} × {fill.contracts}
                                    <div className="notebook-answer">
                                      YES {fmtProb(fill.yes_price)} · NO {fmtProb(fill.no_price)}
                                    </div>
                                  </td>
                                  <td className="num">
                                    {fill.settlement == null ? 'open' : fill.settlement === 1 ? 'YES' : 'NO'}
                                  </td>
                                  <td className="num">{fmtUsd(fill.actual_pnl)}</td>
                                  <td className="num">{fmtUsd(fill.yes_counterfactual_pnl)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    ) : (
                      <Text type="supporting">
                        No executor fills in the lake yet. Each kalshi-parlay-executor pass publishes GET /portfolio/fills onto source=kalshi_parlay_fill.
                      </Text>
                    )}
                    <Text type="supporting">
                      {snapshot.backtest.rfq_quotes} sports RFQ books · {snapshot.backtest.same_game} same-game aligned · {snapshot.backtest.would_accept} would accept · {snapshot.backtest.strategy.settled} settled · hit rate {fmtPct(snapshot.backtest.strategy.hit_rate)}
                    </Text>
                    <div className="notebook-results">
                      <table>
                        <thead>
                          <tr>
                            <th>Cohort</th>
                            <th>n / settled</th>
                            <th>YES hits</th>
                            <th>YES P&amp;L</th>
                            <th>NO P&amp;L</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className="notebook-row-winner">
                            <td><strong>Live filter</strong></td>
                            <td className="num">{snapshot.backtest.strategy.n} / {snapshot.backtest.strategy.settled}</td>
                            <td className="num">{snapshot.backtest.strategy.yes_wins} ({fmtPct(snapshot.backtest.strategy.hit_rate)})</td>
                            <td className="num">{fmtUsd(snapshot.backtest.strategy.yes_pnl)}</td>
                            <td className="num">{fmtUsd(snapshot.backtest.strategy.no_pnl)}</td>
                          </tr>
                          <tr>
                            <td>All same-game RFQs</td>
                            <td className="num">{snapshot.backtest.all_rfq.n} / {snapshot.backtest.all_rfq.settled}</td>
                            <td className="num">{snapshot.backtest.all_rfq.yes_wins} ({fmtPct(snapshot.backtest.all_rfq.hit_rate)})</td>
                            <td className="num">{fmtUsd(snapshot.backtest.all_rfq.yes_pnl)}</td>
                            <td className="num">{fmtUsd(snapshot.backtest.all_rfq.no_pnl)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    {snapshot.backtest.fills.length ? (
                      <div className="notebook-results">
                        <table>
                          <thead>
                            <tr>
                              <th>Combo</th>
                              <th>Ask / indep.</th>
                              <th>Result</th>
                              <th>YES P&amp;L</th>
                              <th>NO P&amp;L</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.backtest.fills.map((fill) => (
                              <tr key={`${fill.market_ticker}-${fill.quoted_at ?? ''}`}>
                                <td>
                                  <strong>{fill.title}</strong>
                                  <div className="notebook-answer"><code>{fill.market_ticker}</code></div>
                                </td>
                                <td className="num">
                                  {fmtProb(fill.yes_ask)}
                                  <div className="notebook-answer">indep {fmtProb(fill.independence)}</div>
                                </td>
                                <td className="num">
                                  {fill.settlement == null ? 'open' : fill.settlement === 1 ? 'YES' : 'NO'}
                                </td>
                                <td className="num">{fmtUsd(fill.yes_pnl)}</td>
                                <td className="num">{fmtUsd(fill.no_pnl)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Text type="supporting">No filter-pass RFQs to list this window.</Text>
                    )}
                    {snapshot.backtest.notes.map((note) => (
                      <Text key={note} type="supporting">{note}</Text>
                    ))}
                  </>
                ) : (
                  <Text type="supporting">No backtest payload this snapshot.</Text>
                )}
              </VStack>
            </Section>

            <Section id="crypto" num={tocById.get('crypto')?.num ?? '07'} title="Crypto target-price MVEs">
              <VStack gap={3}>
                <Text>
                  <code>KXMVECROSSCATEGORY</code> also packs 15-minute and daily
                  crypto target-price legs (BTC, ETH, SOL, …). Those are not a
                  sportsbook tape. Independence on same-close crypto targets
                  is a different question from NFL props — lake BTC×ETH
                  daily returns already correlate around 0.9. They are
                  scored here so they are not silently treated as sports
                  parlays.
                </Text>
                <ParlayTable rows={snapshot.crypto_mves ?? []} listed />
              </VStack>
            </Section>

            <Section id="mve" num={tocById.get('mve')?.num ?? '07'} title="Combo CLOB">
              <VStack gap={3}>
                <Text>
                  Kalshi combos are RFQ auctions. You request a quote; makers
                  answer privately with <code>yes_bid</code>/<code>no_bid</code>;
                  after accept+confirm the fill prints on a public book that
                  usually goes empty again. The lake stores combos that name
                  their legs, including last quotes from the 30-day candle
                  backfill. A two-sided book or an auction print in (0, 1)
                  is what this notebook can screen against independence.
                  Empty 0/0/0 with last 0 is the resting venue until the
                  hourly RFQ probe fills a two-way (source
                  <code>kalshi_rfq</code>) or an auction print lands.
                </Text>
                <Text>
                  Scanned {snapshot.mve.scanned} lake MVE combos · {snapshot.mve.two_sided} two-sided on the latest snapshot · {snapshot.mve.empty_book} empty.
                  {snapshot.mve.combo_tickers != null
                    ? ` Ever two-sided in the window: ${snapshot.mve.ever_two_sided ?? 0} of ${snapshot.mve.combo_tickers}. Sports ${snapshot.mve.sports_combos ?? 0} · crypto target-price ${snapshot.mve.crypto_mve_combos ?? 0} · mixed ${snapshot.mve.mixed_combos ?? 0}. Same-game corr room max ${snapshot.mve.corr_room_max != null ? `${(snapshot.mve.corr_room_max * 100).toFixed(1)}¢` : '—'}. Tape-scored ${snapshot.mve.tape_scored ?? 0} · flagged ${snapshot.mve.tape_flagged ?? 0} · clears fees ${snapshot.mve.survives_spread_fees ?? 0}.`
                    : ''}
                </Text>
                {snapshot.mve.sample_titles.length ? (
                  <Text type="supporting">
                    Sample titles: {snapshot.mve.sample_titles.join(' · ')}
                  </Text>
                ) : null}
              </VStack>
            </Section>
          </>
        ) : null}

        <Section id="method" num={tocById.get('method')?.num ?? '08'} title="Method">
          <VStack gap={3}>
            <Text>
              Binary events with YES mids pᵢ. Independence says P(all) is the
              product of the selected probabilities. The Fréchet–Hoeffding
              bounds are max(0, Σpᵢ − (n−1)) and min pᵢ. A listed combo mid C
              is compared to that product when the combo book is two-sided
              inside (0, 1), when the snapshot is a solicited RFQ two-way
              (<code>source=kalshi_rfq</code>), or when <code>yes_last</code> is an RFQ auction
              print in (0, 1). Empty 0/0/0 with last 0 is not C. A gap larger than half the
              combo spread plus half the leg spreads is flagged; clearing
              Kalshi taker fees (~7% of expected earnings) is a stricter bar.
              Phi and tetrachoric ρ are defined for two legs only. The live
              executor filter is backtested on those RFQ two-ways against
              settlement 0/1 rows (<code>source=kalshi_settlement</code>) —
              BUY YES at the ask versus the BUY NO fills from 2026-09-14.
            </Text>
            <Text>
              Bernoulli phi is the Pearson correlation of the two 0/1 outcomes:
              (C − pq) / √[p(1−p)q(1−q)]. Tetrachoric ρ inverts a Gaussian copula
              so Φ₂(Φ⁻¹(p), Φ⁻¹(q); ρ) = C. Homemade parlays have no C; they use
              overlapping daily log returns of the related lake symbols as ρ and
              report the copula-fair joint versus pq. Same-game sports stacks
              without a public print report the Fréchet interval from the lake
              legs — that is the auction-fair range a maker should quote.
            </Text>
            <Text type="supporting">
              Live Kalshi public Trade API for Fed/homemade series. Sports
                  parlays prefer <code>options.kalshi_markets</code> history from the
                  hourly KXMVE ingest (MVE combos + selected legs + daily candles).
                  Combo mids use the last two-sided snapshot, solicited RFQ
                  two-way, or RFQ auction print; legs are the nearest
                  tradable snapshot to that time. Combo <code>category</code> keeps
                  <code>event_ticker</code> as <code>yes:LEG@EVENT</code>. Settlement
                  0/1 is a tagged lake row, not a quote. Crypto target-price CROSSCATEGORY
                  stacks are scored separately from NFL/sports props. Dissent
                  &gt;0 is the complement of the 0-dissent contract. Return series
              from <code>options.ohlc</code>, latest-wins per symbol/date. Chat
              still treats Kalshi as investing event odds — sports rows are
              for this experiment, not trade suggestions. Not a tradable
              signal after fees.
            </Text>
          </VStack>
        </Section>
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
