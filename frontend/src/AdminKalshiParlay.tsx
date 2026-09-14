import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Banner,
  Button,
  Heading,
  HStack,
  Spinner,
  StatusDot,
  Text,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { useIsAdmin } from './useAdmin';
import {
  api,
  type KalshiParlayDecision,
  type KalshiParlayExecutor,
  type KalshiParlayMonitor,
  type KalshiParlaySample,
} from './api';
import './AdminKalshiParlay.css';

const POLL_MS = 20_000;

type DecisionRow = KalshiParlayDecision & Record<string, unknown>;
type SampleRow = KalshiParlaySample & Record<string, unknown>;

type Mode = {
  label: string;
  variant: 'success' | 'warning' | 'error' | 'accent' | 'neutral';
  color: 'green' | 'orange' | 'red' | 'blue' | 'gray';
  pulse: boolean;
};

function executorMode(executor: KalshiParlayExecutor, passing: boolean): Mode {
  if (passing) {
    return { label: 'Pass in flight', variant: 'warning', color: 'orange', pulse: true };
  }
  if (executor.execute && executor.live) {
    return { label: 'LIVE', variant: 'error', color: 'red', pulse: true };
  }
  if (executor.execute) {
    return { label: 'Dry-run', variant: 'accent', color: 'blue', pulse: false };
  }
  return { label: 'Idle', variant: 'neutral', color: 'gray', pulse: false };
}

function fmtPx(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(3);
}

function yesNo(value: boolean): { label: string; color: 'green' | 'gray' | 'red' } {
  if (value) return { label: 'yes', color: 'green' };
  return { label: 'no', color: 'gray' };
}

function probeToken(probe: string | null): { label: string; color: 'blue' | 'gray' | 'orange' } {
  if (probe === 'skipped_executor') {
    return { label: 'Hourly RFQ probe skipped', color: 'blue' };
  }
  if (probe === 'research_tape_never_accepts') {
    return { label: 'Hourly research probe', color: 'gray' };
  }
  if (probe) return { label: `Probe ${probe}`, color: 'orange' };
  return { label: 'Hourly probe unknown', color: 'gray' };
}

/**
 * Admin console for the Kalshi same-game parlay RFQ executor.
 * Status is proxied through the screener Worker — the browser never calls the loader.
 */
export default function AdminKalshiParlayPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [data, setData] = useState<KalshiParlayMonitor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [triggerNote, setTriggerNote] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await api.adminKalshiParlay();
      setData(response);
      setFetchedAt(response.fetched_at);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
    const id = window.setInterval(() => { void load(true); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [isAdmin, load]);

  const runTrigger = async () => {
    setTriggering(true);
    setTriggerNote(null);
    try {
      const result = await api.adminKalshiParlayTrigger();
      setTriggerNote(result.note || (result.ok ? 'Forced dry-run pass started.' : result.error || 'Trigger failed'));
      await load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setTriggering(false);
    }
  };

  if (isPending || !isAdmin) {
    return (
      <VStack className="admin-kalshi-parlay-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  const executor = data?.executor;
  const passing = Boolean(data?.loop?.passing);
  const mode = executor ? executorMode(executor, passing) : null;
  const live = Boolean(executor?.live);
  const accepted = executor?.accepted ?? 0;

  return (
    <VStack className="admin-kalshi-parlay-page" gap={5} paddingBlock={6} paddingInline={5}>
      <VStack gap={2}>
        <Heading level={1}>Kalshi parlay bot</Heading>
        <Text type="supporting">
          Same-game two-leg sports RFQ executor (kalshi-parlay-executor on cboe-to-r2).
          Last pass, universe mix, and would_accept / accepted rows. Size is 10
          contracts ($10 notional) with at most one live fill per pass. This page
          never turns LIVE on or off. Public notebook:{' '}
          <Link to="/experiments/kalshi-parlays" className="admin-kalshi-parlay-link">
            Kalshi parlays
          </Link>
          .
        </Text>
      </VStack>

      {live ? (
        <Banner
          status="error"
          title="LIVE is on"
          description="Accepts can fill in the Kalshi account at 10 contracts ($10 notional) per RFQ, at most one fill per 5-minute pass. This console cannot change LIVE."
        />
      ) : null}
      {accepted > 0 ? (
        <Banner
          status="warning"
          title={`Last pass accepted ${accepted} YES quote${accepted === 1 ? '' : 's'}`}
          description="Fills land in the Kalshi account, not on this page."
        />
      ) : null}

      <HStack gap={3} vAlign="center" wrap="wrap">
        {mode ? (
          <HStack gap={2} vAlign="center">
            <StatusDot variant={mode.variant} label={mode.label} isPulsing={mode.pulse} />
            <Token label={mode.label} color={mode.color} size="sm" />
          </HStack>
        ) : null}
        {executor?.idle_reason === 'execute_off' ? (
          <Token label="EXECUTE off" color="gray" size="sm" />
        ) : null}
        {data?.hourly ? (
          <Token
            label={probeToken(data.hourly.rfq_probe).label}
            color={probeToken(data.hourly.rfq_probe).color}
            size="sm"
          />
        ) : null}
        {executor?.enabled ? (
          <Token label={`Cadence ${executor.cadence_seconds}s`} color="gray" size="sm" />
        ) : (
          <Token label="Job disabled" color="orange" size="sm" />
        )}
        <Token
          label={`${executor?.contracts ?? 10} contracts · $${executor?.contracts ?? 10} notional`}
          color="gray"
          size="sm"
        />
        <Token
          label={`Max ${executor?.max_accepts_per_pass ?? 1} fill / pass`}
          color="gray"
          size="sm"
        />
      </HStack>

      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label={triggering ? 'Triggering…' : 'Force dry-run pass'}
          variant="secondary"
          size="sm"
          isDisabled={triggering || live || !executor}
          clickAction={() => { void runTrigger(); }}
        />
        <Button
          label="Refresh"
          variant="ghost"
          size="sm"
          isDisabled={loading}
          clickAction={() => { void load(); }}
        />
        {fetchedAt ? (
          <Text type="supporting" size="sm">
            Fetched <Timestamp value={fetchedAt} format="relative" />
          </Text>
        ) : null}
        {executor?.last_pass_at ? (
          <Text type="supporting" size="sm">
            Last pass <Timestamp value={executor.last_pass_at} format="relative" />
            {executor.last_pass_duration_ms != null ? ` · ${executor.last_pass_duration_ms}ms` : ''}
          </Text>
        ) : (
          <Text type="supporting" size="sm">No last_pass recorded yet.</Text>
        )}
      </HStack>
      <Text type="supporting" size="sm">
        Force dry-run cannot turn LIVE on. The button is disabled while LIVE. With
        EXECUTE off the pass records idle_reason execute_off. EXECUTE on skips the
        hourly research RFQ probe so two Creates do not 409.
      </Text>
      {triggerNote ? <Text type="supporting">{triggerNote}</Text> : null}

      {error ? (
        <Text className="admin-kalshi-parlay-error" role="alert">
          {error}
        </Text>
      ) : null}
      {data?.errors.hourly ? (
        <Text type="supporting" size="sm">Hourly job: {data.errors.hourly}</Text>
      ) : null}
      {data?.errors.loop ? (
        <Text type="supporting" size="sm">Loader loop: {data.errors.loop}</Text>
      ) : null}

      {loading && !data ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading Kalshi parlay status" />
        </HStack>
      ) : executor ? (
        <VStack gap={5}>
          <VStack gap={2}>
            <Heading level={2}>RFQ pass</Heading>
            <HStack gap={2} wrap="wrap">
              <Token label={`Attempted ${executor.attempted}`} color="blue" size="sm" />
              <Token label={`Would accept ${executor.would_accept}`} color="green" size="sm" />
              <Token
                label={`Accepted ${executor.accepted}`}
                color={executor.accepted > 0 ? 'red' : 'gray'}
                size="sm"
              />
              <Token label={`Skipped ${executor.skipped}`} color="gray" size="sm" />
              {executor.attempted === 0 && executor.idle_reason && executor.idle_reason !== 'execute_off' ? (
                <Token label={executor.idle_reason.replace(/_/g, ' ')} color="orange" size="sm" />
              ) : null}
            </HStack>
          </VStack>

          <VStack gap={2}>
            <Heading level={2}>Universe</Heading>
            <Text type="supporting">
              Open sports MVEs from the live Kalshi API, not the hourly lake
              volume-80 cap. Legs load only for same-game two-leg stacks; RFQs
              rank by corr room. n{'>'}2 and cross-game stay in the counts but
              are not solicited.
            </Text>
            <HStack gap={2} wrap="wrap">
              <Token label={`Open combos ${executor.open_combos}`} color="gray" size="sm" />
              <Token label={`Open legs ${executor.open_legs}`} color="gray" size="sm" />
              <Token label={`Combo legs ${executor.combo_legs}`} color="gray" size="sm" />
              <Token label={`Two-leg ${executor.two_leg}`} color="blue" size="sm" />
              <Token
                label={`Same-game two-leg ${executor.same_game_two_leg}`}
                color={executor.same_game_two_leg > 0 ? 'green' : 'orange'}
                size="sm"
              />
              <Token label={`Cross-game two-leg ${executor.cross_game_two_leg}`} color="gray" size="sm" />
              <Token label={`Missing leg mids ${executor.missing_leg_mids}`} color="gray" size="sm" />
            </HStack>
          </VStack>

          <VStack gap={2}>
            <Heading level={2}>Filter</Heading>
            <Text type="supporting">
              Takes only 2-leg same-game same-side sports stacks: corr room at least 15 cents,
              spread at most 8 cents, ask at most independence + 2 cents, |phi| {'<'} 0.15,
              single-maker quote_id. Skips mixed yes/no, n{'>'}2, leftover yes_last, and
              Fréchet-priced tapes. Dry-run logs would_accept and DELETE the RFQ. Live YES
              accept needs EXECUTE=1 and LIVE=1 at 10 contracts ($10 notional), at most one
              fill per pass; the maker confirms (HVM 3s). The job never calls /confirm.
            </Text>
          </VStack>

          <VStack gap={2}>
            <Heading level={2}>Decisions</Heading>
            {!executor.decisions.length ? (
              <Text type="supporting">
                No RFQ decisions on the last pass. If same-game two-leg is 0,
                the open MVE mix is n{'>'}2 or cross-game — not a silent skip
                and not the lake volume cap.
              </Text>
            ) : (
              <Table
                className="admin-kalshi-parlay-table"
                data={executor.decisions as DecisionRow[]}
                idKey={(row) => `${row.market_ticker}:${row.rfq_id ?? ''}:${row.quote_id ?? ''}`}
                density="compact"
                dividers="rows"
                hasHover
                textOverflow="truncate"
                columns={[
                  {
                    key: 'market_ticker',
                    header: 'Market',
                    width: proportional(3),
                    renderCell: (row) => <Text size="sm">{row.market_ticker}</Text>,
                  },
                  {
                    key: 'would_accept',
                    header: 'Would accept',
                    width: pixel(120),
                    renderCell: (row) => {
                      const token = yesNo(row.would_accept);
                      return <Token label={token.label} color={token.color} size="sm" />;
                    },
                  },
                  {
                    key: 'accepted',
                    header: 'Accepted',
                    width: pixel(110),
                    renderCell: (row) => {
                      const token = row.accepted
                        ? { label: 'yes', color: 'red' as const }
                        : { label: 'no', color: 'gray' as const };
                      return <Token label={token.label} color={token.color} size="sm" />;
                    },
                  },
                  {
                    key: 'reasons',
                    header: 'Reasons',
                    width: proportional(3),
                    renderCell: (row) => (
                      <Text size="sm">{row.reasons.length ? row.reasons.join(', ') : '—'}</Text>
                    ),
                  },
                  {
                    key: 'error',
                    header: 'Error',
                    width: proportional(2),
                    renderCell: (row) => <Text size="sm">{row.error || '—'}</Text>,
                  },
                  {
                    key: 'yes_bid',
                    header: 'YES bid',
                    width: pixel(90),
                    renderCell: (row) => <Text size="sm">{fmtPx(row.yes_bid)}</Text>,
                  },
                  {
                    key: 'yes_ask',
                    header: 'YES ask',
                    width: pixel(90),
                    renderCell: (row) => <Text size="sm">{fmtPx(row.yes_ask)}</Text>,
                  },
                  {
                    key: 'rfq_id',
                    header: 'RFQ',
                    width: pixel(120),
                    renderCell: (row) => <Text size="sm">{row.rfq_id || '—'}</Text>,
                  },
                  {
                    key: 'quote_id',
                    header: 'Quote',
                    width: pixel(120),
                    renderCell: (row) => <Text size="sm">{row.quote_id || '—'}</Text>,
                  },
                ]}
              />
            )}
          </VStack>

          {executor.idle_reason === 'no_targets' ? (
            <VStack gap={2}>
              <Heading level={2}>Samples</Heading>
              {!executor.samples.length ? (
                <Text type="supporting">No combo samples on this pass.</Text>
              ) : (
                <Table
                  className="admin-kalshi-parlay-table"
                  data={executor.samples as SampleRow[]}
                  idKey="market_ticker"
                  density="compact"
                  dividers="rows"
                  hasHover
                  columns={[
                    {
                      key: 'market_ticker',
                      header: 'Market',
                      width: proportional(3),
                      renderCell: (row) => <Text size="sm">{row.market_ticker}</Text>,
                    },
                    {
                      key: 'n_legs',
                      header: 'Legs',
                      width: pixel(80),
                      renderCell: (row) => <Text size="sm">{row.n_legs}</Text>,
                    },
                    {
                      key: 'game_group',
                      header: 'Game group',
                      width: proportional(2),
                      renderCell: (row) => <Text size="sm">{row.game_group}</Text>,
                    },
                    {
                      key: 'tape',
                      header: 'Tape',
                      width: proportional(2),
                      renderCell: (row) => <Text size="sm">{row.tape}</Text>,
                    },
                  ]}
                />
              )}
            </VStack>
          ) : null}
        </VStack>
      ) : null}
    </VStack>
  );
}
