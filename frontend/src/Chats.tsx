import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Avatar,
  Button,
  Code,
  Dialog,
  DialogHeader,
  Heading,
  HStack,
  Markdown,
  Spinner,
  Text,
  TextInput,
  Timestamp,
  Token,
  VStack,
} from '@astryxdesign/core';
import { Table, pixel, proportional } from '@astryxdesign/core/Table';
import { Search } from 'lucide-react';
import { useIsAdmin } from './useAdmin';
import { api, type AdminChat, type AdminChatUser, type ChatHistoryMessage } from './api';
import './Chats.css';

type AdminChatRow = AdminChat & Record<string, unknown>;

function avatarSrc(user: AdminChatUser): string | undefined {
  const custom = api.avatarSrc(user.avatar_url);
  if (custom) return custom;
  if (user.image && /^(https?:)/i.test(user.image)) return user.image;
  return undefined;
}

function shortChatId(chatId: string): string {
  return chatId.length > 8 ? chatId.slice(0, 8) : chatId;
}

function shortModel(model: string | null): string {
  if (!model) return '—';
  const slash = model.lastIndexOf('/');
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function asMessages(messages: AdminChat['messages']): ChatHistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m): m is ChatHistoryMessage =>
      Boolean(m) && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant'),
  );
}

function matchesQuery(chat: AdminChat, query: string): boolean {
  if (!query) return true;
  const haystack = [
    chat.title ?? '',
    chat.chat_id,
    chat.model ?? '',
    chat.mode,
    chat.ip ?? '',
    chat.visitor_fingerprint ?? '',
    chat.user_agent_summary ?? '',
    chat.user_agent ?? '',
    chat.user?.email ?? '',
    chat.user?.name ?? '',
    chat.user?.public_name ?? '',
    chat.user?.handle ?? '',
    chat.user_id ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Admin-only lake chat directory — signed-in profiles when present, otherwise
 * a visitor fingerprint from server-stamped IP + User-Agent.
 */
export default function ChatsPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [chats, setChats] = useState<AdminChat[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AdminChat | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  const loadPage = useCallback(async (before?: string | null) => {
    const appending = Boolean(before);
    if (appending) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await api.adminChatHistory({ limit: 100, before: before ?? undefined });
      setChats((prev) => (appending ? [...prev, ...response.items] : response.items));
      setNextBefore(response.next_before);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      if (appending) setLoadingMore(false);
      else setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadPage();
  }, [isAdmin, loadPage]);

  const query = filter.trim().toLowerCase();
  const rows = useMemo(
    () => chats.filter((chat) => matchesQuery(chat, query)) as AdminChatRow[],
    [chats, query],
  );

  if (isPending || !isAdmin) return null;

  const selectedMessages = selected ? asMessages(selected.messages) : [];

  return (
    <VStack className="chats-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1200}>
      <VStack gap={2}>
        <Heading level={1}>Chats</Heading>
        <Text type="supporting">
          Every chat conversation in the lake. Signed-in chats show the profile;
          anonymous ones show a visitor fingerprint from IP and browser.
        </Text>
      </VStack>

      <HStack gap={3} align="center" wrap="wrap">
        <TextInput
          label="Filter chats"
          isLabelHidden
          value={filter}
          onChange={setFilter}
          placeholder="Filter by title, handle, email, fingerprint, or IP"
          startIcon={Search}
          hasClear
          width="min(32rem, 100%)"
        />
        <Text type="supporting">
          {loading ? 'Loading…' : `${rows.length.toLocaleString()} shown`}
        </Text>
        <Button
          label="Refresh"
          variant="secondary"
          size="sm"
          onClick={() => void loadPage()}
          isDisabled={loading}
        />
      </HStack>

      {error && (
        <Text className="chats-error" role="alert">
          {error}
        </Text>
      )}

      {loading && chats.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading chats" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          {chats.length === 0 ? 'No chats captured yet.' : 'No chats match that filter.'}
        </Text>
      ) : (
        <Table
          className="chats-table"
          data={rows}
          idKey="chat_id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'ended_at',
              header: 'When',
              width: pixel(140),
              renderCell: (chat) =>
                chat.ended_at ? (
                  <Timestamp value={chat.ended_at} format="relative" />
                ) : (
                  <Text type="supporting">—</Text>
                ),
            },
            {
              key: 'title',
              header: 'Chat',
              width: proportional(3),
              renderCell: (chat) => (
                <VStack gap={0}>
                  <Button
                    className="chats-title-btn"
                    label={chat.title?.trim() || 'Untitled chat'}
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected(chat)}
                  />
                  <Text type="supporting" size="sm">
                    <Code>{shortChatId(chat.chat_id)}</Code>
                    {' · '}
                    {chat.message_count} msg
                  </Text>
                </VStack>
              ),
            },
            {
              key: 'user',
              header: 'Who',
              width: proportional(2),
              renderCell: (chat) => {
                if (chat.user) {
                  return (
                    <HStack gap={3} align="center">
                      <Avatar
                        name={chat.user.public_name}
                        src={avatarSrc(chat.user)}
                        size="sm"
                        tooltip={false}
                      />
                      <VStack gap={0}>
                        <Text weight="semibold">{chat.user.public_name}</Text>
                        {chat.user.handle ? (
                          <Link
                            to="/u/$handle"
                            params={{ handle: chat.user.handle }}
                            className="chats-handle"
                          >
                            @{chat.user.handle}
                          </Link>
                        ) : (
                          <Text type="supporting" size="sm">
                            {chat.user.email}
                          </Text>
                        )}
                      </VStack>
                    </HStack>
                  );
                }
                return (
                  <VStack gap={1}>
                    <HStack gap={2} align="center" wrap="wrap">
                      <Token label="anon" color="gray" size="sm" />
                      {chat.visitor_fingerprint ? (
                        <Code>{chat.visitor_fingerprint}</Code>
                      ) : (
                        <Text type="supporting" size="sm">
                          unknown visitor
                        </Text>
                      )}
                    </HStack>
                    <Text type="supporting" size="sm">
                      {[chat.ip, chat.user_agent_summary].filter(Boolean).join(' · ') || '—'}
                    </Text>
                  </VStack>
                );
              },
            },
            {
              key: 'model',
              header: 'Model',
              width: pixel(160),
              renderCell: (chat) => (
                <Text type="supporting" size="sm">
                  {shortModel(chat.model)}
                </Text>
              ),
            },
          ]}
        />
      )}

      {nextBefore && !query && chats.length > 0 && (
        <HStack gap={3} align="center">
          <Button
            label={loadingMore ? 'Loading…' : 'Load older chats'}
            variant="secondary"
            size="sm"
            onClick={() => void loadPage(nextBefore)}
            isDisabled={loadingMore}
            isLoading={loadingMore}
          />
        </HStack>
      )}

      <Dialog
        isOpen={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        width={720}
        maxHeight="85vh"
        purpose="info"
      >
        {selected && (
          <>
            <DialogHeader
              title={selected.title?.trim() || 'Untitled chat'}
              subtitle={`${shortChatId(selected.chat_id)} · ${selected.message_count} messages`}
              onOpenChange={(open) => {
                if (!open) setSelected(null);
              }}
            />
            <VStack className="chats-detail" gap={4} paddingBlock={3} paddingInline={4}>
              {selected.user ? (
                <HStack gap={3} align="center">
                  <Avatar
                    name={selected.user.public_name}
                    src={avatarSrc(selected.user)}
                    size="sm"
                    tooltip={false}
                  />
                  <VStack gap={0}>
                    <Text weight="semibold">{selected.user.public_name}</Text>
                    <Text type="supporting" size="sm">
                      {selected.user.handle ? `@${selected.user.handle}` : selected.user.email}
                      {selected.user.is_admin ? ' · admin' : ''}
                    </Text>
                  </VStack>
                </HStack>
              ) : (
                <VStack gap={1}>
                  <HStack gap={2} align="center" wrap="wrap">
                    <Token label="anon" color="gray" size="sm" />
                    {selected.visitor_fingerprint && <Code>{selected.visitor_fingerprint}</Code>}
                  </HStack>
                  <Text type="supporting" size="sm">
                    {[selected.ip, selected.user_agent_summary, selected.user_agent]
                      .filter(Boolean)
                      .slice(0, 2)
                      .join(' · ') || 'No visitor metadata'}
                  </Text>
                </VStack>
              )}

              <Text type="supporting" size="sm">
                {selected.ended_at ? (
                  <>
                    Ended <Timestamp value={selected.ended_at} format="date_time" />
                  </>
                ) : null}
                {selected.model ? ` · ${selected.model}` : ''}
              </Text>

              {selectedMessages.length === 0 ? (
                <Text type="supporting">No messages on this lake row.</Text>
              ) : (
                <VStack className="chats-transcript" gap={4}>
                  {selectedMessages.map((message, index) => (
                    <VStack
                      key={`${message.role}-${index}-${message.ts ?? index}`}
                      className={
                        message.role === 'user' ? 'chats-turn chats-turn-user' : 'chats-turn'
                      }
                      gap={2}
                    >
                      <Text weight="semibold" size="sm">
                        {message.role === 'user' ? 'User' : 'Assistant'}
                      </Text>
                      {message.role === 'assistant' ? (
                        <Markdown>{message.content || '—'}</Markdown>
                      ) : (
                        <Text className="chats-user-text">{message.content || '—'}</Text>
                      )}
                      {message.sql ? (
                        <Text type="supporting" size="sm" className="chats-sql">
                          SQL: {message.sql}
                        </Text>
                      ) : null}
                    </VStack>
                  ))}
                </VStack>
              )}
            </VStack>
          </>
        )}
      </Dialog>
    </VStack>
  );
}
