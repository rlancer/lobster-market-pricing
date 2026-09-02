/**
 * User-opted chat context attachments (portfolio handles for Copilot).
 *
 * Body sends handles only — the Worker loads live positions via get_portfolio.
 * Add a new PortfolioSource here + UI row + Worker branch when another broker lands.
 */

export const PORTFOLIO_SOURCES = ['schwab', 'paper'] as const;
export type PortfolioSource = (typeof PORTFOLIO_SOURCES)[number];

const PORTFOLIO_SOURCE_SET = new Set<string>(PORTFOLIO_SOURCES);

export function isPortfolioSource(value: unknown): value is PortfolioSource {
  return typeof value === 'string' && PORTFOLIO_SOURCE_SET.has(value);
}

export type ChatAttachment = {
  kind: 'portfolio';
  source: PortfolioSource;
  account_id?: string;
};

export const PORTFOLIO_SOURCE_LABELS: Record<PortfolioSource, string> = {
  schwab: 'Schwab',
  paper: 'Paper book',
};

export function portfolioAttachmentKey(attachment: ChatAttachment): string {
  return `${attachment.source}:${attachment.account_id ?? ''}`;
}

export function hasPortfolioSource(
  attachments: readonly ChatAttachment[],
  source: PortfolioSource,
): boolean {
  return attachments.some((a) => a.kind === 'portfolio' && a.source === source);
}

export function togglePortfolioAttachment(
  attachments: readonly ChatAttachment[],
  source: PortfolioSource,
  accountId?: string,
): ChatAttachment[] {
  const key = `${source}:${accountId ?? ''}`;
  const without = attachments.filter(
    (a) => !(a.kind === 'portfolio' && portfolioAttachmentKey(a) === key),
  );
  if (without.length !== attachments.length) return without;
  return [
    ...attachments,
    accountId
      ? { kind: 'portfolio' as const, source, account_id: accountId }
      : { kind: 'portfolio' as const, source },
  ];
}

export function removePortfolioAttachment(
  attachments: readonly ChatAttachment[],
  source: PortfolioSource,
  accountId?: string,
): ChatAttachment[] {
  const key = `${source}:${accountId ?? ''}`;
  return attachments.filter(
    (a) => !(a.kind === 'portfolio' && portfolioAttachmentKey(a) === key),
  );
}

/** Serialize for the Copilot turn body (handles only). */
export function attachmentsForBody(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.slice(0, 8).map((a) => (
    a.account_id
      ? { kind: 'portfolio' as const, source: a.source, account_id: a.account_id }
      : { kind: 'portfolio' as const, source: a.source }
  ));
}
