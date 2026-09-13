import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Heading, Text, Token, VStack } from '@astryxdesign/core';
import { api, type KalshiParlayRow, type KalshiParlaySnapshot } from './api';
import { flagLabel, fmtGap, fmtProb, fmtRho, gapTone } from './notebooks/kalshiParlays';
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
            const gap = listed ? row.score.gap_vs_independence : row.score.gap_vs_copula;
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
                  {row.score.copula_fair != null ? (
                    <div className="notebook-answer">copula {fmtProb(row.score.copula_fair)}</div>
                  ) : null}
                </td>
                <td className="num">
                  <Token
                    label={fmtGap(listed ? row.score.gap_vs_independence : (row.score.copula_fair != null
                      ? row.score.copula_fair - row.score.independence
                      : null))}
                    color={gapTone(listed ? row.score.gap_vs_independence : (row.score.copula_fair != null
                      ? row.score.copula_fair - row.score.independence
                      : null))}
                    size="sm"
                  />
                  {listed && gap != null ? (
                    <div className="notebook-answer">listed − independent</div>
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
                  Open multivariate (MVE) combos plus the legs they actually
                  select now land in <code>options.kalshi_markets</code> with
                  {' '}<code>theme=sports</code>. Combo rows store the collection
                  and selected tickers in <code>category</code> as{' '}
                  <code>mve|COLLECTION|yes:LEG,no:LEG,…</code>
                  — not the full sports catalog. Independence is the product of
                  every selected YES (or 1−YES for NO legs). Same-game stacks
                  are correlated by construction; an empty 0-bid / 1-ask combo
                  book is RFQ, not a mispricing signal.
                </Text>
                <Text type="supporting">
                  Source this pass: {snapshot.sports_source === 'lake'
                    ? 'lake (KXMVE hourly ingest)'
                    : snapshot.sports_source === 'live'
                      ? 'live Kalshi MVE fallback — lake had no sports rows yet'
                      : 'none'}
                  {snapshot.verdict.sports_scored
                    ? ` · ${snapshot.verdict.sports_scored} scored · ${snapshot.verdict.sports_flagged} vs independent · ${snapshot.verdict.sports_same_game} same-game`
                    : ''}
                </Text>
                <ParlayTable rows={snapshot.sports ?? []} listed />
              </VStack>
            </Section>

            <Section id="mve" num={tocById.get('mve')?.num ?? '06'} title="Combo CLOB">
              <VStack gap={3}>
                <Text>
                  Kalshi parlays as a product are multivariate event collections.
                  The lake stores the open sports combos that name their legs.
                  A public two-sided book inside (0, 1) is what this notebook
                  can actually screen against independence. Empty 0-bid / 1-ask
                  books are not a mispricing signal; they are no tape.
                </Text>
                <Text>
                  Scanned {snapshot.mve.scanned} open MVE markets · {snapshot.mve.two_sided} two-sided · {snapshot.mve.empty_book} empty.
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

        <Section id="method" num={tocById.get('method')?.num ?? '07'} title="Method">
          <VStack gap={3}>
            <Text>
              Binary events with YES mids pᵢ. Independence says P(all) is the
              product of the selected probabilities. The Fréchet–Hoeffding
              bounds are max(0, Σpᵢ − (n−1)) and min pᵢ. A listed combo mid C
              is compared to that product; a gap larger than half the combo
              spread plus half the leg spreads is flagged. Phi and tetrachoric
              ρ are defined for two legs only.
            </Text>
            <Text>
              Bernoulli phi is the Pearson correlation of the two 0/1 outcomes:
              (C − pq) / √[p(1−p)q(1−q)]. Tetrachoric ρ inverts a Gaussian copula
              so Φ₂(Φ⁻¹(p), Φ⁻¹(q); ρ) = C. Homemade parlays have no C; they use
              overlapping daily log returns of the related lake symbols as ρ and
              report the copula-fair joint versus pq.
            </Text>
            <Text type="supporting">
              Live Kalshi public Trade API for Fed/homemade series. Sports
              parlays prefer <code>options.kalshi_markets</code> rows from the
              hourly KXMVE ingest (open MVE combos + selected legs). Dissent
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
