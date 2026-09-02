/**
 * User-opted chat context attachments (portfolio handles for Copilot).
 *
 * Body sends handles only — the Worker loads live positions via get_portfolio.
 * Add a new PortfolioSource here + UI row + Worker branch when another broker lands.
 */

export const PORTFOLIO_SOURCES = ['schwab', 'paper'] as const;
export type PortfolioSource = (typeof PORTFOLIO_SOURCES)[number];

/**
 * Follow-up when a turn sealed after tools/reasoning with no prose (disconnect).
 * Keeps prior get_portfolio results in history — prefer this over regenerate.
 */
export const FINISH_INCOMPLETE_PROMPT =
  'Finish the portfolio risk review you started — publish_desk now and close with the main risks and adjustments. Do not research every holding again.';

const ATTACHMENTS_STORAGE_PREFIX = 'lobster.chatAttachments:';

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

/** Tools/reasoning landed but no prose — disconnect mid-turn left an unfinished answer. */
export function isIncompleteAssistantTurn(message: {
  role: string;
  content?: string;
  desk?: unknown;
  error?: unknown;
  tools?: { name?: string }[] | null;
  reasoning?: string | null;
} | null | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if ((message.content ?? '').trim() || message.desk || message.error) return false;
  if ((message.tools?.length ?? 0) > 0) return true;
  return Boolean((message.reasoning ?? '').trim());
}

/** Recover portfolio handles from a sealed get_portfolio tool row (refresh loses React state). */
export function portfolioAttachmentsFromTools(
  tools: readonly { name?: string; args?: string; ok?: boolean; summary?: string }[] | null | undefined,
): ChatAttachment[] {
  if (!tools?.length) return [];
  const out: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (tool.ok === false) continue;
    const name = tool.name ?? '';
    let source: PortfolioSource | null = null;
    let accountId: string | undefined;
    if (name === 'get_portfolio') {
      const fromArgs = parsePortfolioArgs(tool.args);
      if (fromArgs) {
        source = fromArgs.source;
        accountId = fromArgs.account_id;
      } else if (/schwab/i.test(tool.summary ?? '') || /schwab/i.test(tool.args ?? '')) {
        source = 'schwab';
      } else if (/paper/i.test(tool.summary ?? '') || /paper/i.test(tool.args ?? '')) {
        source = 'paper';
      }
    } else if (name === 'get_paper_portfolio') {
      source = 'paper';
    }
    if (!source) continue;
    const key = `${source}:${accountId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(accountId
      ? { kind: 'portfolio', source, account_id: accountId }
      : { kind: 'portfolio', source });
  }
  return out;
}

function parsePortfolioArgs(args: string | undefined): { source: PortfolioSource; account_id?: string } | null {
  if (!args?.trim()) return null;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    if (!isPortfolioSource(parsed.source)) return null;
    const accountId = typeof parsed.account_id === 'string' && parsed.account_id.trim()
      ? parsed.account_id.trim().slice(0, 64)
      : undefined;
    return accountId
      ? { source: parsed.source, account_id: accountId }
      : { source: parsed.source };
  } catch {
    // Compact display args from formatToolArgs — look for source=schwab style.
    const match = /\bsource["'\s:=]+(schwab|paper)\b/i.exec(args);
    if (!match) return null;
    const source = match[1]!.toLowerCase();
    if (!isPortfolioSource(source)) return null;
    return { source };
  }
}

export function loadChatAttachments(chatId: string): ChatAttachment[] {
  if (!chatId || typeof sessionStorage === 'undefined') return [];
  try {
    const raw = sessionStorage.getItem(ATTACHMENTS_STORAGE_PREFIX + chatId);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return attachmentsForBody(
      parsed.filter((item): item is ChatAttachment => (
        Boolean(item)
        && typeof item === 'object'
        && (item as ChatAttachment).kind === 'portfolio'
        && isPortfolioSource((item as ChatAttachment).source)
      )),
    );
  } catch {
    return [];
  }
}

export function saveChatAttachments(chatId: string, attachments: readonly ChatAttachment[]): void {
  if (!chatId || typeof sessionStorage === 'undefined') return;
  try {
    const body = attachmentsForBody(attachments);
    if (body.length === 0) {
      sessionStorage.removeItem(ATTACHMENTS_STORAGE_PREFIX + chatId);
      return;
    }
    sessionStorage.setItem(ATTACHMENTS_STORAGE_PREFIX + chatId, JSON.stringify(body));
  } catch {
    // sessionStorage full / private mode — continue without persistence.
  }
}
