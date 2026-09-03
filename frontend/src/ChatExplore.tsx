/**
 * Admin-only explorer for Chat system prompts and tool capabilities.
 * Source of truth is GET /api/admin/chat/capabilities (Worker modules).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button, Heading, HStack, Tab, TabList, Text, Token, ToggleButton, VStack } from '@astryxdesign/core';
import { useIsAdmin } from './useAdmin';
import {
  api,
  type ChatCapabilities,
  type ChatPromptCapability,
  type ChatToolCapability,
} from './api';
import './ChatExplore.css';

type NavItem =
  | { kind: 'prompt'; id: string; prompt: ChatPromptCapability }
  | { kind: 'tool'; id: string; tool: ChatToolCapability };

function itemIdFromSearch(item: string | undefined): string | null {
  if (!item) return null;
  return item.trim() || null;
}

function promptKindLabel(kind: ChatPromptCapability['kind']): string {
  if (kind === 'classifier') return 'Classifier';
  if (kind === 'meta') return 'Meta';
  if (kind === 'invent') return 'Invent';
  if (kind === 'addon') return 'Addon';
  return 'System';
}

export default function ChatExplorePage() {
  const navigate = useNavigate();
  const { item: itemParam } = useSearch({ strict: false }) as { item?: string };
  const { isAdmin, isPending } = useIsAdmin();
  const [data, setData] = useState<ChatCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [includeSamples, setIncludeSamples] = useState(false);
  const [schemaMode, setSchemaMode] = useState<'live' | 'placeholder'>('live');
  const [selectedId, setSelectedId] = useState<string | null>(itemIdFromSearch(itemParam));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.adminChatCapabilities({
        schema: schemaMode,
        samples: includeSamples,
      });
      setData(payload);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setLoading(false);
    }
  }, [includeSamples, schemaMode]);

  useEffect(() => {
    if (!isAdmin) return;
    void load();
  }, [isAdmin, load]);

  useEffect(() => {
    const fromUrl = itemIdFromSearch(itemParam);
    if (fromUrl) setSelectedId(fromUrl);
  }, [itemParam]);

  const items = useMemo<NavItem[]>(() => {
    if (!data) return [];
    return [
      ...data.prompts.map((prompt) => ({
        kind: 'prompt' as const,
        id: `prompt:${prompt.id}`,
        prompt,
      })),
      ...data.tools.map((tool) => ({
        kind: 'tool' as const,
        id: `tool:${tool.name}`,
        tool,
      })),
    ];
  }, [data]);

  useEffect(() => {
    if (!items.length) return;
    if (selectedId && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0].id);
  }, [items, selectedId]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const selectItem = (id: string) => {
    setSelectedId(id);
    setCopied(false);
    void navigate({
      to: '/chat-capabilities',
      search: { item: id },
      replace: true,
    });
  };

  const copyBody = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  if (isPending || !isAdmin) {
    return (
      <VStack className="chat-explore" gap={3} padding={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  return (
    <VStack className="chat-explore" gap={4} padding={5}>
      <VStack className="chat-explore-hero" gap={2}>
        <Heading level={1}>Chat capabilities</Heading>
        <Text color="secondary">
          Live system prompts and tool schemas from the Worker — what the model actually sees.
        </Text>
        {data ? (
          <HStack gap={2} wrap="wrap">
            <Token size="sm" label={`${data.prompts.length} prompts`} />
            <Token size="sm" label={`${data.tools.length} tools`} />
            <Token
              size="sm"
              label={
                data.meta.schema_mode === 'live'
                  ? `schema live · ${data.meta.table_count} tables`
                  : 'schema placeholder'
              }
            />
            <Token size="sm" label={`max steps ${data.meta.agent_iterations_max}`} />
            <Token size="sm" label={`force SQL ≤${data.meta.query_force_failures_max} fails`} />
          </HStack>
        ) : null}
      </VStack>

      <HStack className="chat-explore-controls" gap={2} wrap="wrap" align="center">
        <TabList
          size="sm"
          aria-label="Schema mode"
          value={schemaMode}
          onChange={(value) => setSchemaMode(value as 'live' | 'placeholder')}
        >
          <Tab value="live" label="Live schema" />
          <Tab value="placeholder" label="Placeholder schema" />
        </TabList>
        <ToggleButton
          size="sm"
          label="Samples"
          isPressed={includeSamples}
          isDisabled={schemaMode !== 'live'}
          onPressedChange={setIncludeSamples}
        />
        <Button
          size="sm"
          variant="secondary"
          label={loading ? 'Loading…' : 'Refresh'}
          onClick={() => void load()}
          isDisabled={loading}
        />
      </HStack>

      {error ? <Text className="chat-explore-err">{error}</Text> : null}

      <HStack className="chat-explore-layout" gap={4} align="start">
        <VStack className="chat-explore-sidebar" gap={3}>
          <Text size="sm" color="secondary">Prompts</Text>
          <ul className="chat-explore-list">
            {items.filter((item) => item.kind === 'prompt').map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`chat-explore-item${selectedId === item.id ? ' active' : ''}`}
                  onClick={() => selectItem(item.id)}
                >
                  <span>{item.prompt.title}</span>
                  <span>{promptKindLabel(item.prompt.kind)}</span>
                </button>
              </li>
            ))}
          </ul>
          <Text size="sm" color="secondary">Tools</Text>
          <ul className="chat-explore-list">
            {items.filter((item) => item.kind === 'tool').map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`chat-explore-item${selectedId === item.id ? ' active' : ''}`}
                  onClick={() => selectItem(item.id)}
                >
                  <span>{item.tool.name}</span>
                  <span>{item.tool.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </VStack>

        <VStack className="chat-explore-main" gap={3}>
          {!selected && loading ? <Text color="secondary">Loading capabilities…</Text> : null}
          {selected?.kind === 'prompt' ? (
            <>
              <HStack justify="between" align="start" gap={3} wrap="wrap">
                <VStack gap={1}>
                  <Heading level={2}>{selected.prompt.title}</Heading>
                  <Text color="secondary">{selected.prompt.summary}</Text>
                  <Text size="sm" color="secondary">Used by: {selected.prompt.used_by}</Text>
                </VStack>
                <Button
                  size="sm"
                  variant="secondary"
                  label={copied ? 'Copied' : 'Copy'}
                  onClick={() => void copyBody(selected.prompt.body)}
                />
              </HStack>
              <pre className="chat-explore-body">{selected.prompt.body}</pre>
            </>
          ) : null}
          {selected?.kind === 'tool' ? (
            <>
              <HStack justify="between" align="start" gap={3} wrap="wrap">
                <VStack gap={1}>
                  <Heading level={2}>{selected.tool.name}</Heading>
                  <Text color="secondary">{selected.tool.label}</Text>
                  <Text>{selected.tool.description}</Text>
                </VStack>
                <Button
                  size="sm"
                  variant="secondary"
                  label={copied ? 'Copied' : 'Copy schema'}
                  onClick={() => void copyBody(JSON.stringify(selected.tool.input_schema, null, 2))}
                />
              </HStack>
              <Heading level={3}>Input schema</Heading>
              <pre className="chat-explore-body">
                {JSON.stringify(selected.tool.input_schema, null, 2)}
              </pre>
            </>
          ) : null}
        </VStack>
      </HStack>
    </VStack>
  );
}
