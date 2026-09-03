/**
 * Chat context attachments — user-opted handles passed on each Chat turn.
 *
 * Keep body payloads as small handles (kind + source), never full positions.
 * The agent loads live data via get_portfolio. New portfolio brokers add a
 * source id here + a branch in get_portfolio; the UI attach menu grows the same way.
 */

export const PORTFOLIO_SOURCES = ["schwab", "paper"] as const;
export type PortfolioSource = (typeof PORTFOLIO_SOURCES)[number];

const PORTFOLIO_SOURCE_SET = new Set<string>(PORTFOLIO_SOURCES);

export function isPortfolioSource(value: unknown): value is PortfolioSource {
  return typeof value === "string" && PORTFOLIO_SOURCE_SET.has(value);
}

/** User-attached context for this turn. Extend with new `kind`s later. */
export type ChatAttachment = {
  kind: "portfolio";
  source: PortfolioSource;
  /** Optional Schwab account id when the user scoped a single linked account. */
  account_id?: string;
};

export const PORTFOLIO_SOURCE_LABELS: Record<PortfolioSource, string> = {
  schwab: "Schwab portfolio",
  paper: "Paper portfolio",
};

/** Parse chat body.attachments — never fail a turn; drop unknown entries. */
export function parseAttachmentsFromBody(body: unknown): ChatAttachment[] {
  const rec = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const raw = rec.attachments;
  if (!Array.isArray(raw)) return [];

  const out: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.kind !== "portfolio") continue;
    if (!isPortfolioSource(row.source)) continue;
    const accountId = typeof row.account_id === "string" && row.account_id.trim()
      ? row.account_id.trim().slice(0, 64)
      : undefined;
    const key = `${row.source}:${accountId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(accountId
      ? { kind: "portfolio", source: row.source, account_id: accountId }
      : { kind: "portfolio", source: row.source });
    if (out.length >= 8) break;
  }
  return out;
}

/** System-prompt addon when the user attached one or more portfolios. */
export function attachmentsPromptAddon(attachments: readonly ChatAttachment[]): string {
  const portfolios = attachments.filter((a) => a.kind === "portfolio");
  if (portfolios.length === 0) return "";

  const lines = [
    "",
    "Attached context (user opted in for this chat — load via tools, never invent holdings):",
  ];
  for (const a of portfolios) {
    const label = PORTFOLIO_SOURCE_LABELS[a.source];
    const account = a.account_id ? ` (account_id=${a.account_id})` : "";
    lines.push(
      `- ${label}${account}: MUST call get_portfolio with source="${a.source}"`
        + (a.account_id ? ` and account_id="${a.account_id}"` : "")
        + " before recommending adjustments, hedges, or uncorrelated adds. Ground every answer in that tool output.",
    );
  }
  lines.push(
      "Attached Schwab is the live brokerage book (not paper). Attached paper is the tracked suggestion book. Do not conflate them.",
      "Private holdings load ONLY via get_portfolio — never run_query against the lake for brokerage positions, cash, or account numbers.",
      "After get_portfolio returns: ground the risk/adjustment answer in that book. Research at most 2–3 material names if needed — do NOT research every holding. Then publish_desk + a prose takeaway promptly so the turn can finish.",
    );
  return lines.join("\n");
}
