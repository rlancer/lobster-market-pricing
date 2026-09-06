import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Spinner,
  Text,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { useIsAdmin } from './useAdmin';
import {
  api,
  type QualityGateEvent,
  type QualityGateImprovement,
  type QualityGateMonitor,
} from './api';
import './AdminQualityGate.css';

type EventRow = QualityGateEvent & Record<string, unknown>;
type IssueRow = QualityGateImprovement & Record<string, unknown>;

function actionColor(action: string, source: string | null): 'green' | 'red' | 'orange' | 'gray' {
  if (source === 'fail_open') return 'orange';
  if (action.includes('allow')) return 'green';
  if (action.includes('reject') || action.includes('unlist')) return 'red';
  return 'gray';
}

function actionLabel(action: string): string {
  return action.replace(/_/g, ' ');
}

/**
 * Admin ledger for the Floor quality gate — mint decisions, fail-open,
 * remediator unlists, and improvement tickets.
 */
export default function AdminQualityGatePage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const search = useSearch({ strict: false }) as { action?: string; source?: string };
  const actionFilter = search.action?.trim() || undefined;
  const sourceFilter = search.source?.trim() || undefined;

  const [data, setData] = useState<QualityGateMonitor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adminQualityGate({
        action: actionFilter,
        source: sourceFilter,
      });
      setData(response);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [actionFilter, sourceFilter]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  const setFilter = (next: { action?: string; source?: string }) => {
    void navigate({
      to: '/admin/quality-gate',
      search: {
        ...(next.action ? { action: next.action } : {}),
        ...(next.source ? { source: next.source } : {}),
      },
    });
  };

  const runSweep = async () => {
    setSweeping(true);
    setSweepNote(null);
    try {
      const result = await api.adminQualityGateRemoderate();
      setSweepNote(`Scanned ${result.scanned}, unlisted ${result.unlisted}.`);
      await load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setSweeping(false);
    }
  };

  if (isPending || !isAdmin) {
    return (
      <VStack className="admin-quality-gate-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  const summary = data?.summary;

  return (
    <VStack className="admin-quality-gate-page" gap={5} paddingBlock={6} paddingInline={5}>
      <VStack gap={2}>
        <Heading level={1}>Quality gate</Heading>
        <Text type="supporting">
          Watch the Floor monitor: mint-time allow/reject, fail-open (the gate could not decide),
          remediator unlists, and improvement tickets. Last seven days.
        </Text>
      </VStack>

      <HStack gap={2} wrap="wrap">
        <Token
          label={`Decisions ${summary?.decisions ?? 0}`}
          color={actionFilter || sourceFilter ? 'gray' : 'blue'}
          size="sm"
          onClick={() => setFilter({})}
        />
        <Token
          label={`Allowed ${summary?.allowed ?? 0}`}
          color="green"
          size="sm"
          onClick={() => setFilter({ action: 'allow_bot_share' })}
        />
        <Token
          label={`Rejected ${summary?.rejected ?? 0}`}
          color="red"
          size="sm"
          onClick={() => setFilter({ action: 'reject_bot_share' })}
        />
        <Token
          label={`Fail-open ${summary?.fail_open ?? 0}`}
          color="orange"
          size="sm"
          onClick={() => setFilter({ source: 'fail_open' })}
        />
        <Token
          label={`Unlisted later ${summary?.remediator_unlisted ?? 0}`}
          color="red"
          size="sm"
          onClick={() => setFilter({ action: 'remoderate_unlist' })}
        />
      </HStack>

      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label={sweeping ? 'Sweeping…' : 'Run remediator now'}
          variant="secondary"
          size="sm"
          isDisabled={sweeping}
          clickAction={() => { void runSweep(); }}
        />
        <Button
          label="Refresh"
          variant="ghost"
          size="sm"
          isDisabled={loading}
          clickAction={() => { void load(); }}
        />
        {summary?.last_sweep ? (
          <Text type="supporting" size="sm">
            Last sweep scanned {summary.last_sweep.scanned}, unlisted {summary.last_sweep.unlisted}
            {' · '}
            <Timestamp value={summary.last_sweep.created_at} format="relative" />
          </Text>
        ) : (
          <Text type="supporting" size="sm">No remediator sweep recorded yet.</Text>
        )}
      </HStack>
      {sweepNote ? <Text type="supporting">{sweepNote}</Text> : null}

      {error ? (
        <Text className="admin-quality-gate-error" role="alert">
          {error}
        </Text>
      ) : null}

      {loading && !data ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading quality gate" />
        </HStack>
      ) : (
        <VStack gap={4}>
          <VStack gap={2}>
            <Heading level={2}>Recent decisions</Heading>
            {!data?.events.length ? (
              <Text type="supporting">No gate events yet. New bot shares and publishes will land here.</Text>
            ) : (
              <Table
                className="admin-quality-gate-table"
                data={data.events as EventRow[]}
                idKey="event_id"
                density="compact"
                dividers="rows"
                hasHover
                textOverflow="truncate"
                columns={[
                  {
                    key: 'created_at',
                    header: 'When',
                    width: pixel(140),
                    renderCell: (row) => <Timestamp value={row.created_at} format="relative" />,
                  },
                  {
                    key: 'action',
                    header: 'Action',
                    width: pixel(160),
                    renderCell: (row) => (
                      <Token
                        label={actionLabel(row.action)}
                        color={actionColor(row.action, row.source)}
                        size="sm"
                      />
                    ),
                  },
                  {
                    key: 'source',
                    header: 'Source',
                    width: pixel(110),
                    renderCell: (row) => (
                      <Text size="sm">{row.source || '—'}</Text>
                    ),
                  },
                  {
                    key: 'reason',
                    header: 'Reason',
                    width: proportional(3),
                    renderCell: (row) => (
                      <Text size="sm">{row.reason || (row.extra ? JSON.stringify(row.extra) : '—')}</Text>
                    ),
                  },
                  {
                    key: 'share_id',
                    header: 'Share',
                    width: proportional(2),
                    renderCell: (row) =>
                      row.share_id ? (
                        <Link
                          className="admin-quality-gate-link"
                          to="/share/$shareId"
                          params={{ shareId: row.share_id }}
                        >
                          {row.share_id}
                        </Link>
                      ) : (
                        <Text size="sm">—</Text>
                      ),
                  },
                  {
                    key: 'bot_handle',
                    header: 'Bot',
                    width: pixel(120),
                    renderCell: (row) => (
                      <Text size="sm">{row.bot_handle ? `@${row.bot_handle}` : '—'}</Text>
                    ),
                  },
                ]}
              />
            )}
          </VStack>

          <VStack gap={2}>
            <Heading level={2}>Improvement tickets</Heading>
            {!data?.improvements.length ? (
              <Text type="supporting">No improvement issues filed from the gate yet.</Text>
            ) : (
              <Table
                className="admin-quality-gate-table"
                data={data.improvements as IssueRow[]}
                idKey="fingerprint"
                density="compact"
                dividers="rows"
                hasHover
                textOverflow="truncate"
                columns={[
                  {
                    key: 'created_at',
                    header: 'When',
                    width: pixel(140),
                    renderCell: (row) => <Timestamp value={row.created_at} format="relative" />,
                  },
                  {
                    key: 'title',
                    header: 'Issue',
                    width: proportional(3),
                    renderCell: (row) =>
                      row.issue_url ? (
                        <a
                          className="admin-quality-gate-link"
                          href={row.issue_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.title}
                        </a>
                      ) : (
                        <Text>{row.title}</Text>
                      ),
                  },
                  {
                    key: 'category',
                    header: 'Category',
                    width: pixel(120),
                    renderCell: (row) => <Text size="sm">{row.category || '—'}</Text>,
                  },
                  {
                    key: 'share_id',
                    header: 'Share',
                    width: proportional(2),
                    renderCell: (row) =>
                      row.share_id ? (
                        <Link
                          className="admin-quality-gate-link"
                          to="/share/$shareId"
                          params={{ shareId: row.share_id }}
                        >
                          {row.share_id}
                        </Link>
                      ) : (
                        <Text size="sm">—</Text>
                      ),
                  },
                ]}
              />
            )}
          </VStack>
        </VStack>
      )}
    </VStack>
  );
}
