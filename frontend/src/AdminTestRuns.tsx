import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  Button,
  Heading,
  HStack,
  Spinner,
  Text,
  TextArea,
  TextInput,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { useIsAdmin } from './useAdmin';
import { api, type QaBatch, type QaItem } from './api';
import './AdminTestRuns.css';

type BatchRow = QaBatch & Record<string, unknown>;
type ItemRow = QaItem & Record<string, unknown>;

function prLabel(url: string): string {
  const match = url.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i);
  return match ? `PR #${match[1]}` : url.replace(/^https:\/\//i, '');
}

function verdictToken(item: QaItem) {
  if (item.verdict_ok === true) return <Token label="pass" color="green" size="sm" />;
  if (item.verdict_ok === false) return <Token label="fail" color="red" size="sm" />;
  return <Token label="pending" color="gray" size="sm" />;
}

/**
 * Admin-only ledger of QA / e2e bot runs. Shares stay unlisted so they
 * never land on the Floor; the /share/{id} capability URL still works.
 */
export default function AdminTestRunsPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const search = useSearch({ strict: false }) as { batch?: string };
  const selectedId = search.batch?.trim() || null;

  const [batches, setBatches] = useState<QaBatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [prUrl, setPrUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [verdictBusy, setVerdictBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.adminQaBatches();
      setBatches(response.items);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  const selected = useMemo(
    () => batches.find((batch) => batch.batch_id === selectedId) ?? null,
    [batches, selectedId],
  );
  const items = selected?.items ?? [];

  const openBatch = (batchId: string | null) => {
    void navigate({
      to: '/admin/test-runs',
      search: batchId ? { batch: batchId } : { batch: undefined },
    });
  };

  const createBatch = async () => {
    if (!title.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createQaBatch({
        title: title.trim(),
        description: description.trim() || undefined,
        pr_url: prUrl.trim() || undefined,
      });
      setTitle('');
      setDescription('');
      setPrUrl('');
      await load();
      openBatch(created.batch.batch_id);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setCreating(false);
    }
  };

  const importShares = async () => {
    if (!selected || !importText.trim()) return;
    setImporting(true);
    setError(null);
    try {
      await api.importQaShares(selected.batch_id, importText);
      setImportText('');
      await load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setImporting(false);
    }
  };

  const markVerdict = async (itemId: string, verdictOk: boolean) => {
    setVerdictBusy(itemId);
    setError(null);
    try {
      await api.patchQaItem(itemId, { verdict_ok: verdictOk });
      await load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setVerdictBusy(null);
    }
  };

  if (isPending || !isAdmin) {
    return (
      <VStack className="admin-test-runs-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  return (
    <VStack className="admin-test-runs-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
      <VStack gap={2}>
        <Heading level={1}>Test runs</Heading>
        <Text type="supporting">
          QA and e2e bot shares stay off the Floor. Record the bug and PR, then
          open the unlisted /share links from here.
        </Text>
      </VStack>

      <VStack className="admin-test-runs-form" gap={3}>
        <Text type="supporting" weight="semibold">New batch</Text>
        <TextInput
          label="Title"
          value={title}
          onChange={setTitle}
          placeholder="Portfolio schema leak — overview tape"
        />
        <TextArea
          label="What we are testing"
          value={description}
          onChange={setDescription}
          rows={3}
          placeholder="Bug, expected behavior, or the assertion the e2e is proving."
        />
        <TextInput
          label="PR URL"
          value={prUrl}
          onChange={setPrUrl}
          placeholder="https://github.com/rlancer/lobster-market-pricing/pull/328"
          isOptional
        />
        <HStack gap={2}>
          <Button
            label="Create batch"
            variant="primary"
            size="sm"
            isDisabled={creating || !title.trim()}
            clickAction={() => { void createBatch(); }}
          />
          <Button
            label="Refresh"
            variant="secondary"
            size="sm"
            isDisabled={loading}
            clickAction={() => { void load(); }}
          />
        </HStack>
      </VStack>

      {error ? (
        <Text className="admin-test-runs-error" role="alert">
          {error}
        </Text>
      ) : null}

      {loading && batches.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading test runs" />
        </HStack>
      ) : batches.length === 0 ? (
        <Text type="supporting">No test-run batches yet.</Text>
      ) : (
        <Table
          className="admin-test-runs-table"
          data={batches as BatchRow[]}
          idKey="batch_id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'created_at',
              header: 'When',
              width: pixel(140),
              renderCell: (batch) => <Timestamp value={batch.created_at} format="relative" />,
            },
            {
              key: 'title',
              header: 'Batch',
              width: proportional(3),
              renderCell: (batch) => (
                <VStack gap={0}>
                  <Button
                    className="admin-test-runs-title-btn"
                    label={batch.title}
                    variant="ghost"
                    size="sm"
                    onClick={() => openBatch(batch.batch_id)}
                  />
                  <Text type="supporting" size="sm">
                    {batch.description?.trim() || 'No description'}
                  </Text>
                </VStack>
              ),
            },
            {
              key: 'pr_url',
              header: 'PR',
              width: proportional(1),
              renderCell: (batch) =>
                batch.pr_url ? (
                  <a
                    className="admin-test-runs-link"
                    href={batch.pr_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {prLabel(batch.pr_url)}
                  </a>
                ) : (
                  <Text type="supporting">—</Text>
                ),
            },
            {
              key: 'item_count',
              header: 'Runs',
              width: pixel(72),
              renderCell: (batch) => (
                <Token label={String(batch.item_count)} color="gray" size="sm" />
              ),
            },
          ]}
        />
      )}

      {selected ? (
        <VStack gap={3}>
          <HStack gap={3} align="center" wrap="wrap">
            <Heading level={2}>{selected.title}</Heading>
            <Button
              label="All batches"
              variant="ghost"
              size="sm"
              onClick={() => openBatch(null)}
            />
          </HStack>
          {selected.description ? (
            <Text type="supporting">{selected.description}</Text>
          ) : null}
          {selected.pr_url ? (
            <a
              className="admin-test-runs-link"
              href={selected.pr_url}
              target="_blank"
              rel="noreferrer"
            >
              {prLabel(selected.pr_url)}
            </a>
          ) : null}

          <TextArea
            label="Import share IDs"
            value={importText}
            onChange={setImportText}
            rows={2}
            placeholder="Paste share ids or /share/… URLs — they leave the Floor and attach here."
          />
          <Button
            label="Import and unlist"
            variant="secondary"
            size="sm"
            isDisabled={importing || !importText.trim()}
            clickAction={() => { void importShares(); }}
          />

          {items.length === 0 ? (
            <Text type="supporting">No runs in this batch yet.</Text>
          ) : (
            <Table
              className="admin-test-runs-table"
              data={items as ItemRow[]}
              idKey="item_id"
              density="compact"
              dividers="rows"
              hasHover
              textOverflow="truncate"
              columns={[
                {
                  key: 'created_at',
                  header: 'When',
                  width: pixel(140),
                  renderCell: (item) => <Timestamp value={item.created_at} format="relative" />,
                },
                {
                  key: 'handle',
                  header: 'Bot',
                  width: pixel(120),
                  renderCell: (item) => (
                    <Text>{item.handle ? `@${item.handle}` : '—'}</Text>
                  ),
                },
                {
                  key: 'share_id',
                  header: 'Share',
                  width: proportional(2),
                  renderCell: (item) => (
                    <Link
                      to="/share/$shareId"
                      params={{ shareId: item.share_id }}
                      className="admin-test-runs-link"
                    >
                      /share/{item.share_id}
                    </Link>
                  ),
                },
                {
                  key: 'listed_on_floor',
                  header: 'Floor',
                  width: pixel(88),
                  renderCell: (item) =>
                    item.listed_on_floor ? (
                      <Token label="listed" color="orange" size="sm" />
                    ) : (
                      <Token label="unlisted" color="gray" size="sm" />
                    ),
                },
                {
                  key: 'verdict_ok',
                  header: 'Verdict',
                  width: pixel(88),
                  renderCell: (item) => verdictToken(item),
                },
                {
                  key: 'item_id',
                  header: '',
                  width: pixel(160),
                  renderCell: (item) => (
                    <HStack gap={1}>
                      <Button
                        label="Pass"
                        variant="ghost"
                        size="sm"
                        isDisabled={verdictBusy === item.item_id}
                        onClick={() => { void markVerdict(item.item_id, true); }}
                      />
                      <Button
                        label="Fail"
                        variant="ghost"
                        size="sm"
                        isDisabled={verdictBusy === item.item_id}
                        onClick={() => { void markVerdict(item.item_id, false); }}
                      />
                    </HStack>
                  ),
                },
              ]}
            />
          )}
        </VStack>
      ) : null}
    </VStack>
  );
}
