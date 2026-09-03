import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Banner, Button, Heading, HStack, Icon, List, ListItem, Text, VStack } from '@astryxdesign/core';
import { Bot, ChevronRight, Mail, MessagesSquare, Palette, Terminal, TrendingUp, Users, type LucideIcon } from 'lucide-react';
import { ADMIN_TOOL_PATHS } from './admin';
import { api } from './api';
import { authClient } from './auth';
import MonitorStatus from './MonitorStatus';
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
    description: 'Bot personas, generate runs, and headless schedules.',
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
    description: 'Lake chat transcripts — profiles or visitor fingerprints.',
    icon: MessagesSquare,
  },
  {
    to: '/trades',
    label: 'Suggested trades',
    description: 'Every suggest_trades idea from chat — ticker, structure, and legs.',
    icon: TrendingUp,
  },
  {
    to: '/chat-capabilities',
    label: 'Chat capabilities',
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

type EmailTestState =
  | { status: 'idle' }
  | { status: 'ok'; to: string; messageId: string }
  | { status: 'error'; message: string };

/**
 * Admin hub — one left-nav entry that opens every admin-only surface.
 * Individual routes stay reachable; this is the index.
 */
export default function AdminPage() {
  const navigate = useNavigate();
  const { isAdmin, isPending } = useIsAdmin();
  const { data: session } = authClient.useSession();
  const [emailTest, setEmailTest] = useState<EmailTestState>({ status: 'idle' });
  const sessionEmail = session?.user?.email?.trim() || null;

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
          Operator tools for bots, users, chats, suggested trades, Chat capabilities, and brand. Open one from here instead of crowding the left nav.
        </Text>
      </VStack>

      <VStack className="admin-dataset" gap={2}>
        <Text type="supporting" weight="semibold">Dataset</Text>
        <MonitorStatus />
      </VStack>

      <VStack className="admin-email-test" gap={2}>
        <Text type="supporting" weight="semibold">Email Service</Text>
        <Text type="supporting">
          Send a Cloudflare Email Service smoke test to your signed-in address
          {sessionEmail ? ` (${sessionEmail})` : ''}.
        </Text>
        <HStack gap={2} vAlign="center">
          <Button
            variant="secondary"
            label="Send test email"
            icon={<Mail size={16} />}
            isDisabled={!sessionEmail}
            clickAction={async () => {
              setEmailTest({ status: 'idle' });
              try {
                const result = await api.adminEmailTest();
                setEmailTest({
                  status: 'ok',
                  to: result.to,
                  messageId: result.message_id,
                });
              } catch (err) {
                setEmailTest({
                  status: 'error',
                  message: err instanceof Error ? err.message : 'Send failed',
                });
              }
            }}
          />
        </HStack>
        {emailTest.status === 'ok' ? (
          <Banner
            status="success"
            title={`Sent to ${emailTest.to}`}
            description={`message_id ${emailTest.messageId}`}
            isDismissable
            onDismiss={() => setEmailTest({ status: 'idle' })}
          />
        ) : null}
        {emailTest.status === 'error' ? (
          <Banner
            status="error"
            title="Email send failed"
            description={emailTest.message}
            isDismissable
            onDismiss={() => setEmailTest({ status: 'idle' })}
          />
        ) : null}
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
