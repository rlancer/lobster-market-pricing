/**
 * Desk-approaches experiment — public labels + design id.
 * Canonical cases/snapshots live on the Worker (`desk-experiment.ts`).
 */

export const DESK_EXPERIMENT_SLUG = 'desk-approaches';
export const DESK_EXPERIMENT_DESIGN_ID = 'desk-approaches-v1';
/** Chat COPILOT_MODEL — scoreboard ignores other probe models (e.g. gpt-4o-mini). */
export const DESK_EXPERIMENT_CHAT_MODEL = 'deepseek/deepseek-v4-flash-0731';

export const DESK_APPROACH_LABELS: Record<string, string> = {
  solo: 'Solo analyst',
  desk_roleplay: 'Analyst desk role-play',
  desk_shared_session: 'Shared session specialists',
  desk_fresh_sessions: 'New session per specialist',
};

export function approachLabel(id: string): string {
  return DESK_APPROACH_LABELS[id] ?? id;
}

export function pct(correct: number, done: number): string {
  if (!done) return '—';
  return `${Math.round((correct / done) * 100)}%`;
}

export function isChatDeskExperimentModel(runModel: string, designModel?: string): boolean {
  const want = (designModel?.trim() || DESK_EXPERIMENT_CHAT_MODEL).toLowerCase();
  return runModel.trim().toLowerCase() === want;
}
