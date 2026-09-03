import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  Avatar,
  Heading,
  HStack,
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
import { api, type AdminUser } from './api';
import './Users.css';

type AdminUserRow = AdminUser & Record<string, unknown>;

function avatarSrc(user: AdminUser): string | undefined {
  const custom = api.avatarSrc(user.avatar_url);
  if (custom) return custom;
  if (user.image && /^(https?:)/i.test(user.image)) return user.image;
  return undefined;
}

function matchesQuery(user: AdminUser, query: string): boolean {
  if (!query) return true;
  const haystack = [
    user.email,
    user.name,
    user.public_name,
    user.display_name ?? '',
    user.handle ?? '',
    user.id,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * Admin-only directory of everyone who signed in with Google.
 * Gated by the same email allowlist as Bots / Brand.
 */
export default function UsersPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .adminUsers()
      .then((response) => {
        if (!cancelled) setUsers(response.items);
      })
      .catch((err) => {
        if (!cancelled) setError(String((err as Error)?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const query = filter.trim().toLowerCase();
  const rows = useMemo(
    () => users.filter((user) => matchesQuery(user, query)) as AdminUserRow[],
    [users, query],
  );

  if (isPending || !isAdmin) return null;

  return (
    <VStack className="users-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={1100}>
      <VStack gap={2}>
        <Heading level={1}>Users</Heading>
        <Text type="supporting">
          Everyone who signed in with Google. Handles are claimed after the first
          login; chats count only non-deleted Chat history.
        </Text>
      </VStack>

      <HStack gap={3} align="center" wrap="wrap">
        <TextInput
          label="Filter users"
          isLabelHidden
          value={filter}
          onChange={setFilter}
          placeholder="Filter by email, name, or handle"
          startIcon={Search}
          hasClear
          width="min(28rem, 100%)"
        />
        <Text type="supporting">
          {loading ? 'Loading…' : `${rows.length.toLocaleString()} of ${users.length.toLocaleString()}`}
        </Text>
      </HStack>

      {error && (
        <Text className="users-error" role="alert">
          {error}
        </Text>
      )}

      {loading && users.length === 0 ? (
        <HStack gap={3} align="center" paddingBlock={8}>
          <Spinner size="md" label="Loading signed-up users" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text type="supporting">
          {users.length === 0 ? 'No users have signed up yet.' : 'No users match that filter.'}
        </Text>
      ) : (
        <Table
          className="users-table"
          data={rows}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          columns={[
            {
              key: 'public_name',
              header: 'User',
              width: proportional(2),
              renderCell: (user) => (
                <HStack gap={3} align="center">
                  <Avatar
                    name={user.public_name}
                    src={avatarSrc(user)}
                    size="sm"
                    tooltip={false}
                  />
                  <VStack gap={0}>
                    <Text weight="semibold">{user.public_name}</Text>
                    {user.handle ? (
                      <Link to="/u/$handle" params={{ handle: user.handle }} className="users-handle">
                        @{user.handle}
                      </Link>
                    ) : (
                      <Text type="supporting" size="sm">
                        No handle yet
                      </Text>
                    )}
                  </VStack>
                </HStack>
              ),
            },
            {
              key: 'email',
              header: 'Email',
              width: proportional(2),
              renderCell: (user) => (
                <HStack gap={2} align="center" wrap="wrap">
                  <Text>{user.email}</Text>
                  {user.is_admin && <Token label="admin" color="teal" size="sm" />}
                  {!user.email_verified && <Token label="unverified" color="yellow" size="sm" />}
                </HStack>
              ),
            },
            {
              key: 'created_at',
              header: 'Signed up',
              width: pixel(160),
              renderCell: (user) =>
                user.created_at ? (
                  <Timestamp value={user.created_at} format="relative" />
                ) : (
                  <Text type="supporting">—</Text>
                ),
            },
            {
              key: 'chat_count',
              header: 'Chats',
              width: pixel(80),
              align: 'end',
              renderCell: (user) => (
                <Text hasTabularNumbers>{user.chat_count.toLocaleString()}</Text>
              ),
            },
          ]}
        />
      )}
    </VStack>
  );
}
