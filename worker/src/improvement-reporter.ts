/**
 * Post-moderation improvement reporter.
 *
 * After the timeline quality gate runs, a cheap OpenRouter pass looks for
 * actionable product/engineering improvements (prompt gaps, tool-loop cutoffs,
 * bad desk seals, data bugs). When IMPROVEMENT_ISSUE_TOKEN is set, each novel
 * fingerprint becomes a GitHub issue. D1 `improvement_reports` dedupes so the
 * same failure mode does not open dozens of tickets.
 *
 * Fire-and-forget via waitUntil — never blocks publish / share latency.
 */
import { generateText, type LanguageModel } from "ai";
import { formatTimelineModerationTranscript, type TimelineModerationDecision } from "./timeline-moderation";

export const DEFAULT_IMPROVEMENT_REPO = "rlancer/lobster-market-pricing";
export const IMPROVEMENT_LABEL = "copilot-improvement";

export const IMPROVEMENT_REVIEW_SYSTEM = [
  "You review one Lobster MP Copilot transcript after the public-timeline quality gate.",
  "Goal: file zero or one GitHub issue that helps engineers improve the product — prompts, tools, truncation, desk/trades sealing, data quality, bot behavior.",
  "Return ONLY a JSON object:",
  '{"improvements":[{"fingerprint":"kebab-slug","title":"short imperative title","category":"prompt|tool-use|truncation|hallucination|ux|data-quality|bot-behavior|other","body":"markdown: what went wrong, why it matters, concrete fix idea"}]}',
  "Rules:",
  "- Prefer an empty improvements array when the chat is fine or the problem is the user's question, not the product.",
  "- At most one improvement. Fingerprint must be a stable kebab-case slug for that failure mode (reuse the same slug for repeats).",
  "- Do NOT paste long transcript text, secrets, emails, or personal data. Summarize; cite share_id if given in context.",
  "- Titles ≤ 80 chars, imperative (e.g. \"Seal desk overview before ending tool narration\").",
  "- Skip one-off content mistakes that need no code/prompt change.",
].join("\n");

export interface ImprovementReporterEnv {
  SCHEMA_DB: D1Database;
  OPEN_ROUTER_KEY?: string;
  COPILOT_MODEL?: string;
  /** Fine-grained PAT with Issues: Read and write on the target repo. */
  IMPROVEMENT_ISSUE_TOKEN?: string;
  /** owner/repo — defaults to rlancer/lobster-market-pricing. */
  IMPROVEMENT_ISSUE_REPO?: string;
}

export type ImprovementAction =
  | "reject_publish"
  | "allow_publish"
  | "reject_bot_share"
  | "allow_bot_share"
  | "reject_bot_create_share"
  | "allow_bot_create_share";

export type ImprovementContext = {
  messages: unknown;
  decision: TimelineModerationDecision;
  action: ImprovementAction;
  shareId?: string | null;
  runId?: string | null;
  botHandle?: string | null;
  /** Origin for /share/{id} links in the issue body. */
  publicOrigin?: string | null;
};

export type ImprovementSuggestion = {
  fingerprint: string;
  title: string;
  category: string;
  body: string;
};

const FINGERPRINT_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,11}$/;
const TITLE_MAX = 80;
const BODY_MAX = 4_000;
const CATEGORIES = new Set([
  "prompt",
  "tool-use",
  "truncation",
  "hallucination",
  "ux",
  "data-quality",
  "bot-behavior",
  "other",
]);

/** Normalize a raw fingerprint into a stable kebab slug, or null if unusable. */
export function normalizeFingerprint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || !FINGERPRINT_RE.test(slug)) return null;
  return slug;
}

/** Parse the reviewer JSON into at most one sanitized suggestion. */
export function parseImprovementSuggestions(text: string): ImprovementSuggestion[] {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = (parsed as { improvements?: unknown }).improvements;
  if (!Array.isArray(list) || list.length === 0) return [];

  const out: ImprovementSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const fingerprint = normalizeFingerprint(rec.fingerprint);
    const title = typeof rec.title === "string" ? rec.title.trim().replace(/\s+/g, " ") : "";
    const body = typeof rec.body === "string" ? rec.body.trim() : "";
    if (!fingerprint || !title || !body) continue;
    const categoryRaw = typeof rec.category === "string" ? rec.category.trim().toLowerCase() : "other";
    const category = CATEGORIES.has(categoryRaw) ? categoryRaw : "other";
    out.push({
      fingerprint,
      title: title.slice(0, TITLE_MAX),
      category,
      body: body.slice(0, BODY_MAX),
    });
    break; // at most one
  }
  return out;
}

export async function extractImprovements(
  messages: unknown,
  model: LanguageModel,
  decision: TimelineModerationDecision,
  opts?: { abortSignal?: AbortSignal; action?: ImprovementAction },
): Promise<ImprovementSuggestion[]> {
  const transcript = formatTimelineModerationTranscript(messages);
  if (!transcript.trim()) return [];

  const contextLines = [
    `moderation_allow: ${decision.allow}`,
    `moderation_source: ${decision.source}`,
    `moderation_reason: ${decision.reason}`,
    opts?.action ? `gate_action: ${opts.action}` : null,
  ].filter(Boolean).join("\n");

  try {
    const result = await generateText({
      model,
      system: IMPROVEMENT_REVIEW_SYSTEM + "\nReply with ONLY the JSON object — no markdown fences.",
      prompt: `${contextLines}\n\n--- transcript ---\n${transcript}`,
      maxOutputTokens: 700,
      temperature: 0.1,
      abortSignal: opts?.abortSignal,
      providerOptions: {
        openrouter: {
          reasoning: { effort: "none" },
        },
      },
    });
    return parseImprovementSuggestions(result.text);
  } catch (error) {
    console.warn(JSON.stringify({
      improvementReporter: true,
      classifierFailed: true,
      error: error instanceof Error ? error.message : String(error),
    }));
    return [];
  }
}

function repoFromEnv(env: ImprovementReporterEnv): { owner: string; repo: string; full: string } {
  const full = (env.IMPROVEMENT_ISSUE_REPO?.trim() || DEFAULT_IMPROVEMENT_REPO).replace(/^\/+|\/+$/g, "");
  const [owner, repo] = full.split("/");
  if (!owner || !repo || full.includes(" ")) {
    return { owner: "rlancer", repo: "lobster-market-pricing", full: DEFAULT_IMPROVEMENT_REPO };
  }
  return { owner, repo, full: `${owner}/${repo}` };
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lobster-mp-improvement-reporter",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = await res.json() as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

/** Ensure the tracking label exists (idempotent). */
export async function ensureImprovementLabel(
  token: string,
  owner: string,
  repo: string,
): Promise<void> {
  const existing = await githubRequest(token, "GET", `/repos/${owner}/${repo}/labels/${encodeURIComponent(IMPROVEMENT_LABEL)}`);
  if (existing.ok) return;
  await githubRequest(token, "POST", `/repos/${owner}/${repo}/labels`, {
    name: IMPROVEMENT_LABEL,
    color: "0E8A16",
    description: "Filed by the timeline moderation improvement reporter",
  });
}

export function buildIssueBody(
  suggestion: ImprovementSuggestion,
  context: ImprovementContext,
): string {
  const origin = (context.publicOrigin || "https://lobster.mp").replace(/\/+$/, "");
  const shareLine = context.shareId
    ? `- Share: ${origin}/share/${context.shareId}`
    : "- Share: (none yet)";
  const lines = [
    "> Auto-filed by the Copilot timeline moderation improvement reporter.",
    "",
    `**Category:** \`${suggestion.category}\``,
    `**Fingerprint:** \`${suggestion.fingerprint}\``,
    `**Gate:** \`${context.action}\` — allow=${context.decision.allow} (${context.decision.source}): ${context.decision.reason}`,
    shareLine,
    context.runId ? `- Run id: \`${context.runId}\`` : null,
    context.botHandle ? `- Bot: \`@${context.botHandle}\`` : null,
    "",
    "## Suggestion",
    "",
    suggestion.body,
    "",
    "---",
    `_Deduped by fingerprint \`${suggestion.fingerprint}\`. Closing this issue does not clear the fingerprint; delete the D1 row to allow a re-file._`,
  ];
  return lines.filter((line) => line !== null).join("\n");
}

export type FiledImprovement = {
  fingerprint: string;
  issueNumber: number | null;
  issueUrl: string | null;
  skipped: "duplicate" | "no_token" | "create_failed" | null;
};

/**
 * Create a GitHub issue for one suggestion if the fingerprint is new.
 * Never throws.
 */
export async function fileImprovementIssue(
  env: ImprovementReporterEnv,
  suggestion: ImprovementSuggestion,
  context: ImprovementContext,
): Promise<FiledImprovement> {
  const token = env.IMPROVEMENT_ISSUE_TOKEN?.trim();
  if (!token) {
    return { fingerprint: suggestion.fingerprint, issueNumber: null, issueUrl: null, skipped: "no_token" };
  }

  const existing = await env.SCHEMA_DB.prepare(
    "SELECT fingerprint, issue_number, issue_url FROM improvement_reports WHERE fingerprint = ?1",
  ).bind(suggestion.fingerprint).first<{ fingerprint: string; issue_number: number | null; issue_url: string | null }>();
  if (existing) {
    console.info(JSON.stringify({
      improvementReporter: true,
      action: "skip_duplicate",
      fingerprint: suggestion.fingerprint,
      issue_number: existing.issue_number,
    }));
    return {
      fingerprint: suggestion.fingerprint,
      issueNumber: existing.issue_number,
      issueUrl: existing.issue_url,
      skipped: "duplicate",
    };
  }

  const { owner, repo, full } = repoFromEnv(env);
  try {
    await ensureImprovementLabel(token, owner, repo);
  } catch (error) {
    console.warn("improvement label ensure failed", error);
  }

  const created = await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues`, {
    title: suggestion.title,
    body: buildIssueBody(suggestion, context),
    labels: [IMPROVEMENT_LABEL, "enhancement"],
  });

  if (!created.ok) {
    // Retry without labels if the enhancement label is missing or restricted.
    if (created.status === 422) {
      const retry = await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues`, {
        title: suggestion.title,
        body: buildIssueBody(suggestion, context),
        labels: [IMPROVEMENT_LABEL],
      });
      if (retry.ok && retry.json) {
        return recordFiled(env, suggestion, context, retry.json, full);
      }
    }
    console.warn(JSON.stringify({
      improvementReporter: true,
      action: "create_failed",
      status: created.status,
      message: created.json?.message ?? null,
      fingerprint: suggestion.fingerprint,
    }));
    return { fingerprint: suggestion.fingerprint, issueNumber: null, issueUrl: null, skipped: "create_failed" };
  }

  return recordFiled(env, suggestion, context, created.json ?? {}, full);
}

async function recordFiled(
  env: ImprovementReporterEnv,
  suggestion: ImprovementSuggestion,
  context: ImprovementContext,
  issueJson: Record<string, unknown>,
  repoFull: string,
): Promise<FiledImprovement> {
  const number = typeof issueJson.number === "number" ? issueJson.number : null;
  const htmlUrl = typeof issueJson.html_url === "string"
    ? issueJson.html_url
    : number
      ? `https://github.com/${repoFull}/issues/${number}`
      : null;
  const now = Date.now();
  try {
    await env.SCHEMA_DB.prepare(
      `INSERT INTO improvement_reports
         (fingerprint, title, category, issue_number, issue_url, share_id, run_id, bot_handle,
          moderation_action, moderation_allow, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(
      suggestion.fingerprint,
      suggestion.title,
      suggestion.category,
      number,
      htmlUrl,
      context.shareId ?? null,
      context.runId ?? null,
      context.botHandle ?? null,
      context.action,
      context.decision.allow ? 1 : 0,
      now,
    ).run();
  } catch (error) {
    // Race: another isolate inserted the same fingerprint. Treat as duplicate.
    if (String(error).includes("UNIQUE")) {
      return { fingerprint: suggestion.fingerprint, issueNumber: number, issueUrl: htmlUrl, skipped: "duplicate" };
    }
    console.warn("improvement_reports insert failed", error);
  }
  console.info(JSON.stringify({
    improvementReporter: true,
    action: "filed",
    fingerprint: suggestion.fingerprint,
    issue_number: number,
    issue_url: htmlUrl,
    gate_action: context.action,
  }));
  return { fingerprint: suggestion.fingerprint, issueNumber: number, issueUrl: htmlUrl, skipped: null };
}

/**
 * Full review + optional GitHub file. Never throws.
 */
export async function reportImprovements(
  env: ImprovementReporterEnv,
  model: LanguageModel | null | undefined,
  context: ImprovementContext,
): Promise<FiledImprovement[]> {
  if (!env.IMPROVEMENT_ISSUE_TOKEN?.trim()) return [];
  if (!model) return [];

  const suggestions = await extractImprovements(context.messages, model, context.decision, {
    action: context.action,
  });
  if (!suggestions.length) {
    console.info(JSON.stringify({
      improvementReporter: true,
      action: "none",
      gate_action: context.action,
      share_id: context.shareId ?? null,
    }));
    return [];
  }

  const filed: FiledImprovement[] = [];
  for (const suggestion of suggestions) {
    filed.push(await fileImprovementIssue(env, suggestion, context));
  }
  return filed;
}

/**
 * Schedule the reporter without blocking the response.
 * No-ops when the PAT is unset.
 */
export function scheduleImprovementReport(
  env: ImprovementReporterEnv,
  model: LanguageModel | null | undefined,
  context: ImprovementContext,
  opts?: { waitUntil?: (p: Promise<unknown>) => void },
): void {
  if (!env.IMPROVEMENT_ISSUE_TOKEN?.trim()) return;
  if (!model) return;
  const task = reportImprovements(env, model, context).catch((error) => {
    console.warn(JSON.stringify({
      improvementReporter: true,
      action: "unhandled",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
  if (opts?.waitUntil) opts.waitUntil(task);
  else void task;
}
