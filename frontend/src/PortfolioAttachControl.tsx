import { useEffect, useState } from 'react';
import {
  Button,
  CheckboxList,
  CheckboxListItem,
  Divider,
  HStack,
  Popover,
  Text,
  VStack,
} from '@astryxdesign/core';
import { Briefcase } from 'lucide-react';
import { api, type SchwabStatus } from './api';
import { authClient, signInWithGoogle } from './auth';
import {
  isPortfolioSource,
  PORTFOLIO_SOURCE_LABELS,
  type ChatAttachment,
} from './chatAttachments';

type SchwabGate =
  | { state: 'loading' }
  | { state: 'hidden' }
  | { state: 'ready'; status: SchwabStatus }
  | { state: 'error'; message: string };

/**
 * Composer control to attach a portfolio book to this chat turn.
 * Schwab is the first brokerage source; paper proves the multi-source path.
 * New brokers add a CheckboxListItem + PortfolioSource — no composer rewrite.
 */
export function PortfolioAttachControl({
  attachments,
  onChange,
  returnTo,
}: {
  attachments: ChatAttachment[];
  onChange: (next: ChatAttachment[]) => void;
  /** OAuth return URL after Connect Schwab (usually the live chat path). */
  returnTo: string;
}) {
  const { data: session } = authClient.useSession();
  const signedIn = Boolean(session?.user);
  const [schwab, setSchwab] = useState<SchwabGate>({ state: 'loading' });

  useEffect(() => {
    let alive = true;
    api.health()
      .then(async (health) => {
        if (!alive) return;
        if (!health.auth?.schwab) {
          setSchwab({ state: 'hidden' });
          return;
        }
        if (!signedIn) {
          setSchwab({
            state: 'ready',
            status: {
              ok: true,
              configured: true,
              connected: false,
              connected_at: null,
              expires_at: null,
            },
          });
          return;
        }
        try {
          const status = await api.schwabStatus();
          if (alive) setSchwab({ state: 'ready', status });
        } catch (error) {
          if (alive) {
            setSchwab({
              state: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })
      .catch(() => {
        if (alive) setSchwab({ state: 'hidden' });
      });
    return () => { alive = false; };
  }, [signedIn]);

  const attachedCount = attachments.filter((a) => a.kind === 'portfolio').length;
  const label = attachedCount > 0
    ? `Portfolio (${attachedCount})`
    : 'Portfolio';

  const selected = attachments
    .filter((a) => a.kind === 'portfolio')
    .map((a) => a.source);

  const setSources = (values: string[]) => {
    const kept = attachments.filter((a) => a.kind !== 'portfolio');
    const portfolios: ChatAttachment[] = [];
    for (const value of values) {
      if (!isPortfolioSource(value)) continue;
      portfolios.push({ kind: 'portfolio', source: value });
    }
    onChange([...kept, ...portfolios]);
  };

  const schwabReady = schwab.state === 'ready' ? schwab.status : null;
  const schwabConnected = Boolean(schwabReady?.connected);
  const showSchwab = schwab.state !== 'hidden';

  return (
    <Popover
      placement="above"
      alignment="start"
      label="Attach portfolio"
      width="min(22rem, calc(100vw - var(--spacing-6)))"
      content={
        <VStack gap={3}>
          <VStack gap={1}>
            <Text type="body" weight="semibold">
              Attach a portfolio
            </Text>
            <Text type="supporting">
              Lobster loads live holdings when you ask about adjustments or uncorrelated adds.
            </Text>
          </VStack>

          {!signedIn ? (
            <VStack gap={2}>
              <Text type="supporting">
                Sign in to attach Schwab or your paper book.
              </Text>
              <Button
                variant="primary"
                size="sm"
                label="Sign in with Google"
                onClick={() => { void signInWithGoogle(); }}
              />
            </VStack>
          ) : (
            <>
              <CheckboxList
                label="Portfolios"
                isLabelHidden
                value={selected}
                onChange={setSources}
                density="compact"
                hasDividers
              >
                {showSchwab ? (
                  <CheckboxListItem
                    value="schwab"
                    label={PORTFOLIO_SOURCE_LABELS.schwab}
                    description={
                      schwab.state === 'loading'
                        ? 'Checking connection…'
                        : schwabConnected
                          ? 'Live brokerage balances and positions'
                          : 'Connect Schwab first, then attach'
                    }
                    isDisabled={!schwabConnected || schwab.state === 'loading'}
                    aria-label={PORTFOLIO_SOURCE_LABELS.schwab}
                  />
                ) : null}
                <CheckboxListItem
                  value="paper"
                  label={PORTFOLIO_SOURCE_LABELS.paper}
                  description="Tracked Chat suggestions and paper PnL"
                  aria-label={PORTFOLIO_SOURCE_LABELS.paper}
                />
              </CheckboxList>

              {showSchwab && schwabReady && !schwabConnected ? (
                <>
                  <Divider />
                  <HStack gap={2} wrap="wrap">
                    <Button
                      variant="secondary"
                      size="sm"
                      label="Connect Schwab"
                      onClick={() => {
                        window.location.href = api.schwabConnectUrl(returnTo);
                      }}
                    />
                  </HStack>
                </>
              ) : null}

              {schwab.state === 'error' ? (
                <Text type="supporting" role="alert">
                  {schwab.message}
                </Text>
              ) : null}
            </>
          )}
        </VStack>
      }
    >
      <Button
        variant="ghost"
        size="md"
        label={label}
        tooltip={
          attachedCount > 0
            ? `Attached: ${attachments
              .filter((a) => a.kind === 'portfolio')
              .map((a) => PORTFOLIO_SOURCE_LABELS[a.source])
              .join(', ')}`
            : 'Attach a portfolio for book-aware questions'
        }
        icon={<Briefcase size={14} />}
      />
    </Popover>
  );
}
