import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  Banner,
  Heading,
  HStack,
  Icon,
  List,
  ListItem,
  Spinner,
  Text,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { ArrowLeft, BookOpen, ChevronRight } from 'lucide-react';
import { api, type AdminMarimoNotebook } from './api';
import { useIsAdmin } from './useAdmin';
import './AdminMarimo.css';

function AccessGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  if (isPending || !isAdmin) {
    return (
      <VStack className="admin-marimo-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  return <>{children}</>;
}

export function AdminMarimoIndexPage() {
  const navigate = useNavigate();
  const { isAdmin } = useIsAdmin();
  const [items, setItems] = useState<AdminMarimoNotebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    api.adminMarimoList()
      .then((response) => {
        if (!cancelled) setItems(response.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isAdmin]);

  return (
    <AccessGate>
      <VStack className="admin-marimo-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={720}>
        <VStack gap={2}>
          <Heading level={1}>Marimo notebooks</Heading>
          <Text type="supporting">
            Executed HTML snapshots of local marimo research notebooks, stored in
            a private R2 bucket. Iceberg attach stays on the export machine — this
            is not html-wasm, and it never ships lake or Kalshi tokens to the
            browser. Refresh with node notebooks/tools/export_marimo_to_r2.mjs or
            the Export marimo notebook workflow.
          </Text>
        </VStack>

        {error ? (
          <Banner status="error" title="Could not list snapshots" description={error} />
        ) : null}
        {loading ? <Spinner /> : null}

        <List density="spacious" hasDividers header="Snapshots">
          {items.map((item) => (
            <ListItem
              key={item.slug}
              label={item.title}
              description={item.present
                ? item.description
                : `${item.description} Snapshot not uploaded yet.`}
              startContent={<Icon icon={BookOpen} size="md" color="secondary" />}
              endContent={
                <HStack gap={2} vAlign="center">
                  <Token
                    label={item.present ? 'uploaded' : 'missing'}
                    color={item.present ? 'green' : 'orange'}
                    size="sm"
                  />
                  <Icon icon={ChevronRight} size="sm" color="tertiary" />
                </HStack>
              }
              onClick={() => {
                void navigate({ to: '/admin/marimo/$slug', params: { slug: item.slug } });
              }}
            />
          ))}
        </List>
      </VStack>
    </AccessGate>
  );
}

export function AdminMarimoNotebookPage() {
  const { slug } = useParams({ from: '/admin/marimo/$slug' });
  const { isAdmin } = useIsAdmin();
  const [item, setItem] = useState<AdminMarimoNotebook | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setFrameUrl(null);

    (async () => {
      const list = await api.adminMarimoList();
      const match = list.items.find((row) => row.slug === slug) ?? null;
      if (cancelled) return;
      setItem(match);
      if (!match) {
        setError('Unknown notebook.');
        return;
      }
      if (!match.present) {
        setError('Snapshot not uploaded yet. Run the export script or workflow.');
        return;
      }
      const html = await api.adminMarimoHtml(slug);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setFrameUrl(url);
    })()
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isAdmin, slug]);

  return (
    <AccessGate>
      <VStack className="admin-marimo-page" gap={4} paddingBlock={6} paddingInline={5}>
        <VStack gap={2}>
          <Link to="/admin/marimo" className="admin-marimo-back">
            <HStack gap={2} vAlign="center">
              <Icon icon={ArrowLeft} size="sm" color="secondary" />
              <Text type="supporting">All marimo snapshots</Text>
            </HStack>
          </Link>
          <Heading level={1}>{item?.title ?? 'Marimo notebook'}</Heading>
          <Text type="supporting">
            {item?.description ?? 'Executed HTML snapshot from a local marimo kernel.'}
            {' '}Source {item?.source ?? slug}. Not wasm — Iceberg queries run at
            export time, not in this page.
          </Text>
          {item?.exported_at ? (
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Token label={item.git_sha ? item.git_sha.slice(0, 7) : 'snapshot'} color="gray" size="sm" />
              <Timestamp value={item.exported_at} format="date_time" />
            </HStack>
          ) : null}
        </VStack>

        {error ? (
          <Banner status="error" title="Snapshot unavailable" description={error} />
        ) : null}
        {loading ? (
          <HStack gap={2} vAlign="center">
            <Spinner />
            <Text type="supporting">Loading snapshot…</Text>
          </HStack>
        ) : null}
        {frameUrl ? (
          <iframe
            className="admin-marimo-frame"
            title={item?.title ?? 'Marimo snapshot'}
            src={frameUrl}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
          />
        ) : null}
      </VStack>
    </AccessGate>
  );
}
