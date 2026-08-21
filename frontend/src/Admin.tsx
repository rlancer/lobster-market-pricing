import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Heading, Icon, List, ListItem, Text, VStack } from '@astryxdesign/core';
import { Bot, ChevronRight, MessagesSquare, Palette, Terminal, TrendingUp, Users, type LucideIcon } from 'lucide-react';
import { ADMIN_TOOL_PATHS } from './admin';
import { useIsAdmin } from './useAdmin';
import './Admin.css';

type AdminTool = {
  to: (typeof ADMIN_TOOL_PATHS)[number];
  label: string;
  description: string;
  icon: LucideIcon;
};

/** Admin-only destinations formerly listed individually in the left nav. */
const ADMIN_TOOLS: AdminTool[] = [
  {
    to: '/bots',
    label: 'Bots',
    description: 'Copilot personas, generate runs, and headless schedules.',
    icon: Bot,
  },
  {
    to: '/users',
    label: 'Users',
    description: 'Signed-up Google identities, handles, and chat counts.',
    icon: Users,
  },
  {
    to: '/chats',
    label: 'Chats',
    description: 'Lake Copilot transcripts — profiles or visitor fingerprints.',
    icon: MessagesSquare,
  },
  {
    to: '/trades',
    label: 'Suggested trades',
    description: 'Every Copilot suggest_trades idea — ticker, structure, and legs.',
    icon: TrendingUp,
  },
  {
    to: '/copilot',
    label: 'Copilot',
    description: 'Live system prompts and tool input schemas from the Worker.',
    icon: Terminal,
  },
  {
    to: '/brand',
    label: 'Brand',
    description: 'Style guide and shareable assets — marks, palette, voice.',
    icon: Palette,
  },
];

/**
 * Admin hub — one left-nav entry that opens every admin-only surface.
 * Individual routes stay reachable; this is the index.
 */
export default function AdminPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();

  useEffect(() => {
    if (!isPending && !isAdmin) {
      void navigate({ to: '/' });
    }
  }, [isAdmin, isPending, navigate]);

  if (isPending || !isAdmin) {
    return (
      <VStack className="admin-page" gap={3} paddingBlock={6} paddingInline={5}>
        <Text color="secondary">Checking admin access…</Text>
      </VStack>
    );
  }

  return (
    <VStack className="admin-page" gap={5} paddingBlock={6} paddingInline={5} maxWidth={720}>
      <VStack gap={2}>
        <Heading level={1}>Admin</Heading>
        <Text type="supporting">
          Operator tools for bots, users, chats, suggested trades, Copilot
          internals, and brand. Open one from here instead of crowding the left nav.
        </Text>
      </VStack>

      <List density="spacious" hasDividers header="Tools">
        {ADMIN_TOOLS.map((tool) => (
          <ListItem
            key={tool.to}
            label={tool.label}
            description={tool.description}
            startContent={<Icon icon={tool.icon} size="md" color="secondary" />}
            endContent={<Icon icon={ChevronRight} size="sm" color="tertiary" />}
            onClick={() => { void navigate({ to: tool.to }); }}
          />
        ))}
      </List>
    </VStack>
  );
}
