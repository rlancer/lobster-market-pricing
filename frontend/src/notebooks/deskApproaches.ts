/**
 * Desk-approaches experiment — public labels + design id.
 * Canonical cases/snapshots live on the Worker (`desk-experiment.ts`).
 */

export const DESK_EXPERIMENT_SLUG = 'desk-approaches';
export const DESK_EXPERIMENT_DESIGN_ID = 'desk-approaches-v2';
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

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

export interface DeskRunCell {
  rep_id: string;
  question_id: string;
  status: string;
  correct?: boolean;
  error?: string;
  lean_5d?: string;
  lean_20d?: string;
  actual_5d?: string;
  actual_20d?: string;
  detail?: string;
}

export interface DeskRunForConclusion {
  id: string;
  model: string;
  created_at: number;
  results: {
    design_id: string;
    questions: Array<{ id: string }>;
    cells: DeskRunCell[];
    rep_order?: string[];
  };
}

export interface DeskApproachScore {
  approachId: string;
  label: string;
  correct: number;
  done: number;
  total: number;
  aborted: number;
  wrong: number;
  abortedCases: string[];
  wrongCases: string[];
}

export interface DeskApproachesConclusion {
  runId: string | null;
  model: string | null;
  created_at: number | null;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  cells_aborted: number;
  cells_wrong: number;
  byApproach: DeskApproachScore[];
  winningApproaches: string[];
  /** Short scoreboard takeaway. */
  summary: string;
  /** Closing narrative for the Conclusion section. */
  wrapUp: string;
}

export function pickLatestChatDeskRun<T extends { model: string; created_at: number }>(
  runs: T[],
  designModel?: string,
): T | null {
  const filtered = runs
    .filter((run) => isChatDeskExperimentModel(run.model, designModel))
    .sort((a, b) => b.created_at - a.created_at);
  return filtered[0] ?? null;
}

function isAbortedCell(cell: DeskRunCell): boolean {
  if (cell.status !== 'done') return true;
  const err = (cell.error ?? '').toLowerCase();
  return err.includes('abort') || err.includes('timed out') || err.includes('timeout');
}

function scoreApproach(approachId: string, cells: DeskRunCell[]): DeskApproachScore {
  const abortedCases: string[] = [];
  const wrongCases: string[] = [];
  let correct = 0;
  let done = 0;
  let aborted = 0;
  let wrong = 0;
  for (const cell of cells) {
    if (isAbortedCell(cell)) {
      aborted += 1;
      abortedCases.push(cell.question_id);
      continue;
    }
    done += 1;
    if (cell.correct) {
      correct += 1;
    } else {
      wrong += 1;
      wrongCases.push(cell.question_id);
    }
  }
  return {
    approachId,
    label: approachLabel(approachId),
    correct,
    done,
    total: cells.length,
    aborted,
    wrong,
    abortedCases,
    wrongCases,
  };
}

function shortModel(model: string): string {
  return model.includes('/') ? model.split('/')[1]! : model;
}

export function buildDeskApproachesConclusion(
  run: DeskRunForConclusion | null,
): DeskApproachesConclusion {
  if (!run) {
    return {
      runId: null,
      model: null,
      created_at: null,
      cells_correct: 0,
      cells_done: 0,
      cells_total: 0,
      cells_aborted: 0,
      cells_wrong: 0,
      byApproach: [],
      winningApproaches: [],
      summary:
        'No published Chat-model run yet — the conclusion appears after the first desk-approaches-v2 matrix is saved.',
      wrapUp:
        'Once a Chat-model matrix lands, this note will say whether extra sessions beat one voice on the frozen as-of tape, and whether any miss is a wrong lean or an operational abort.',
    };
  }

  const approachIds = run.results.rep_order?.length
    ? run.results.rep_order
    : [...new Set(run.results.cells.map((cell) => cell.rep_id))];
  const byApproach = approachIds.map((id) =>
    scoreApproach(id, run.results.cells.filter((cell) => cell.rep_id === id)),
  );
  const cells_total = run.results.cells.length;
  const cells_aborted = byApproach.reduce((n, row) => n + row.aborted, 0);
  const cells_done = byApproach.reduce((n, row) => n + row.done, 0);
  const cells_correct = byApproach.reduce((n, row) => n + row.correct, 0);
  const cells_wrong = byApproach.reduce((n, row) => n + row.wrong, 0);

  const scored = byApproach.filter((row) => row.done > 0);
  const best = scored.reduce((n, row) => Math.max(n, row.correct / row.done), 0);
  const winningApproaches = scored
    .filter((row) => row.done && row.correct / row.done === best)
    .map((row) => row.approachId);

  const approachBits = byApproach
    .map((row) => {
      const score = row.done ? `${row.correct}/${row.done}` : '0/0';
      const extra = row.aborted
        ? ` (${row.aborted} abort${row.aborted === 1 ? '' : 's'}: ${row.abortedCases.join(', ')})`
        : '';
      return `${row.label} ${score}${extra}`;
    })
    .join('; ');

  const summaryParts: string[] = [
    `Latest Chat run ${shortModel(run.model)} scored ${cells_correct}/${cells_done} finished cells`
      + (cells_aborted ? ` (${cells_aborted} aborted of ${cells_total})` : ` (${cells_total} cells)`)
      + '.',
  ];
  if (approachBits) summaryParts.push(approachBits + '.');
  if (cells_wrong === 0 && cells_done > 0) {
    summaryParts.push('Every finished cell matched both held-out horizons.');
  }
  if (cells_aborted > 0 && cells_wrong === 0) {
    summaryParts.push('Remaining misses are seat timeouts, not wrong leans.');
  }

  const wrapParts: string[] = [
    'This notebook holds the evidence pack frozen at an as-of date and varies only session structure: one voice, production publish_desk role-play, shared-session seats, or a new session per specialist.',
  ];
  if (cells_done === 0) {
    wrapParts.push(
      'The latest Chat-model run did not finish any cell, so there is no directional grade yet — only operational outcome.',
    );
  } else if (cells_wrong === 0) {
    const finishedApproaches = byApproach.filter((row) => row.done === row.total && row.wrong === 0);
    const abortedApproaches = byApproach.filter((row) => row.aborted > 0);
    if (finishedApproaches.length === byApproach.length) {
      wrapParts.push(
        `On this readable tape the four structures tied at ${cells_correct}/${cells_total}: extra sessions did not beat one voice.`,
      );
    } else {
      wrapParts.push(
        `Every completed cell was correct (${cells_correct}/${cells_done}). `
          + (finishedApproaches.length
            ? `${finishedApproaches.map((row) => row.label).join(', ')} finished clean. `
            : '')
          + (abortedApproaches.length
            ? `${abortedApproaches
              .map((row) => `${row.label} lost ${row.abortedCases.join(', ')} to a seat abort`)
              .join('; ')}. `
            : '')
          + 'That gap is operational, not a better lean from isolated specialists.',
      );
    }
    wrapParts.push(
      'The as-of OHLC already contains the tell; 5d/20d continue that path. On a tape this readable, spawning specialists is extra cost without a better grade.',
    );
  } else {
    const misses = byApproach
      .filter((row) => row.wrong > 0)
      .map((row) => `${row.label} missed ${row.wrongCases.join(', ')}`)
      .join('; ');
    wrapParts.push(
      `Finished cells scored ${cells_correct}/${cells_done}. ${misses}.`,
    );
    if (winningApproaches.length) {
      wrapParts.push(
        `Highest observed finished accuracy: ${winningApproaches.map(approachLabel).join(', ')}.`,
      );
    }
  }
  wrapParts.push(
    'Four invented names and one Chat model is a descriptive bench, not a significance test. Treat the scoreboard as evidence for this design, not a production mandate to spawn or retire the desk.',
  );

  return {
    runId: run.id,
    model: run.model,
    created_at: run.created_at,
    cells_correct,
    cells_done,
    cells_total,
    cells_aborted,
    cells_wrong,
    byApproach,
    winningApproaches,
    summary: summaryParts.join(' '),
    wrapUp: wrapParts.join(' '),
  };
}
