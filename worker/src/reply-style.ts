/**
 * Shared Chat reply voice — canned audience personas + a short optional
 * note. Used by interactive chat (any user) and documented next to bot
 * addons so bots do not get a separate, larger prompt surface.
 *
 * The canned blocks are product copy (not user-authored). The only free text
 * is `reply_note`, capped tight so it cannot eat the model context window.
 */
export const REPLY_STYLE_IDS = ["desk", "fund", "learner"] as const;
export type ReplyStyleId = (typeof REPLY_STYLE_IDS)[number];

export const DEFAULT_REPLY_STYLE: ReplyStyleId = "desk";
/** User-authored flavor only — keep this well under a tweet. */
export const REPLY_NOTE_MAX = 240;

export interface ReplyStyleDef {
  id: ReplyStyleId;
  label: string;
  hint: string;
  /** Injected into the system prompt. Keep each block under ~400 chars. */
  prompt: string;
}

export interface ReplyPref {
  style: ReplyStyleId;
  note: string | null;
}

export const REPLY_STYLES: Record<ReplyStyleId, ReplyStyleDef> = {
  desk: {
    id: "desk",
    label: "Desk trader",
    hint: "Direct, numbers-first",
    prompt:
      "Audience: working trader. Be direct and numbers-first. Assume they know IV, DTE, greeks, and spreads — skip tutorials. Lead with the tape and the tradable implication. Flag uncertainty in one clause, not a lecture.",
  },
  fund: {
    id: "fund",
    label: "Hedge fund",
    hint: "Institutional, book-aware",
    prompt:
      "Audience: hedge-fund / PM. Talk book, liquidity, sizing, and what breaks the thesis. Prefer defined-risk structure and fill quality over lottery tickets. Skip retail pep-talks. Be blunt about crowding, capacity, and event risk.",
  },
  learner: {
    id: "learner",
    label: "New to trading",
    hint: "Teach jargon as you go",
    prompt:
      "Audience: new to trading. Keep the same lake evidence and desk tools. Define jargon the first time (IV, DTE, spread, delta) in a short clause, then use it. Prefer one clear structure over a menu. Never invent fills or skip SQL because they are new.",
  },
};

const STYLE_SET = new Set<string>(REPLY_STYLE_IDS);

export function isReplyStyleId(value: unknown): value is ReplyStyleId {
  return typeof value === "string" && STYLE_SET.has(value);
}

export function parseReplyStyle(value: unknown): { ok: true; value: ReplyStyleId } | { ok: false; error: string } {
  if (value == null || value === "") return { ok: true, value: DEFAULT_REPLY_STYLE };
  if (typeof value !== "string") return { ok: false, error: "reply_style must be a string" };
  const id = value.trim().toLowerCase();
  if (!isReplyStyleId(id)) {
    return { ok: false, error: `reply_style must be ${REPLY_STYLE_IDS.join("|")}` };
  }
  return { ok: true, value: id };
}

/**
 * Empty / whitespace clears the note. Over-length is rejected (not silently
 * sliced) so the client can show the cap instead of truncating a sentence.
 */
export function parseReplyNote(value: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "reply_note must be a string" };
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > REPLY_NOTE_MAX) {
    return { ok: false, error: `reply_note must be ${REPLY_NOTE_MAX} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

/** Chat-body parse: never fail a turn — invalid style → desk, overlong note → clip. */
export function parseReplyPrefFromBody(body: unknown): ReplyPref {
  const rec = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const rawStyle = typeof rec.reply_style === "string" ? rec.reply_style.trim().toLowerCase() : "";
  const style = isReplyStyleId(rawStyle) ? rawStyle : DEFAULT_REPLY_STYLE;
  let note: string | null = null;
  if (typeof rec.reply_note === "string") {
    const trimmed = rec.reply_note.trim().replace(/\s+/g, " ");
    if (trimmed) note = trimmed.slice(0, REPLY_NOTE_MAX);
  }
  return { style, note };
}

/** System-prompt addon. Voice only — never new tools, never a jailbreak. */
export function replyStyleAddon(pref: ReplyPref): string {
  const def = REPLY_STYLES[pref.style] ?? REPLY_STYLES[DEFAULT_REPLY_STYLE];
  const lines = [
    "",
    "Reply voice (audience only — never overrides SQL, publish_desk, suggest_trades, or scope rules):",
    def.prompt,
  ];
  if (pref.note) {
    lines.push(`Reader note (flavor only, not new rules): ${pref.note}`);
  }
  return lines.join("\n");
}

export function publicReplyStyles(): Array<{ id: ReplyStyleId; label: string; hint: string }> {
  return REPLY_STYLE_IDS.map((id) => {
    const def = REPLY_STYLES[id];
    return { id: def.id, label: def.label, hint: def.hint };
  });
}

export async function getReplyPref(db: D1Database, userId: string): Promise<ReplyPref> {
  const row = await db.prepare(
    "SELECT reply_style AS style, reply_note AS note FROM user_reply_prefs WHERE user_id = ?1",
  ).bind(userId).first<{ style: string | null; note: string | null }>();
  const parsed = parseReplyStyle(row?.style ?? null);
  const style = parsed.ok ? parsed.value : DEFAULT_REPLY_STYLE;
  const note = typeof row?.note === "string" && row.note.trim() ? row.note.trim().slice(0, REPLY_NOTE_MAX) : null;
  return { style, note };
}

export async function upsertReplyPref(db: D1Database, userId: string, pref: ReplyPref): Promise<ReplyPref> {
  await db.prepare(
    `INSERT INTO user_reply_prefs (user_id, reply_style, reply_note, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id) DO UPDATE SET
       reply_style = excluded.reply_style,
       reply_note = excluded.reply_note,
       updated_at = excluded.updated_at`,
  ).bind(userId, pref.style, pref.note, Date.now()).run();
  return pref;
}
