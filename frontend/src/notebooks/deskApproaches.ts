/**
 * Desk-approaches experiment — public labels + design id.
 * Canonical cases/snapshots live on the Worker (`desk-experiment.ts`).
 */

export const DESK_EXPERIMENT_SLUG = 'desk-approaches';
export const DESK_EXPERIMENT_DESIGN_ID = 'desk-approaches-v2';
/** Chat COPILOT_MODEL — scoreboard ignores other probe models (e.g. gpt-4o-mini). */
export const DESK_EXPERIMENT_CHAT_MODEL = 'deepseek/deepseek-v4-flash-0731';
/** OpenRouter slug for a Chat-pin migration cell on the same frozen tape. */
export const DESK_EXPERIMENT_CANDIDATE_MODEL = 'deepseek/deepseek-v4.1-flash';

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

export function isDeskMigrationCohortModel(
  runModel: string,
  chatModel?: string,
  candidateModel: string = DESK_EXPERIMENT_CANDIDATE_MODEL,
): boolean {
  const got = runModel.trim().toLowerCase();
  const chat = (chatModel?.trim() || DESK_EXPERIMENT_CHAT_MODEL).toLowerCase();
  const candidate = candidateModel.trim().toLowerCase();
  return got === chat || got === candidate;
}

export function pickLatestDeskRunByModel<T extends { model: string; created_at: number }>(
  runs: T[],
  model: string,
): T | null {
  const want = model.trim().toLowerCase();
  const filtered = runs
    .filter((run) => run.model.trim().toLowerCase() === want)
    .sort((a, b) => b.created_at - a.created_at);
  return filtered[0] ?? null;
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
  latency_ms?: number;
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

/** Seat abort / cell cap — including published rows saved as status=done with a timeout detail. */
export function isDeskCellAborted(cell: DeskRunCell | null | undefined): boolean {
  if (!cell) return false;
  const blob = `${cell.error ?? ''} ${cell.detail ?? ''}`.toLowerCase();
  if (blob.includes('abort') || blob.includes('timed out') || blob.includes('timeout')) return true;
  return cell.status !== 'done';
}

function scoreApproach(approachId: string, cells: DeskRunCell[]): DeskApproachScore {
  const abortedCases: string[] = [];
  const wrongCases: string[] = [];
  let correct = 0;
  let done = 0;
  let aborted = 0;
  let wrong = 0;
  for (const cell of cells) {
    if (isDeskCellAborted(cell)) {
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

export interface DeskModelRunScore {
  model: string;
  runId: string;
  created_at: number;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  cells_aborted: number;
  cells_wrong: number;
  mean_latency_ms: number | null;
  desk_roleplay: { correct: number; done: number; aborted: number };
}

export type DeskMigrationLean =
  | 'insufficient'
  | 'same_model'
  | 'hold'
  | 'candidate_ok'
  | 'candidate_better'
  | 'candidate_worse';

export interface DeskModelMigrationConclusion {
  chatModel: string;
  candidateModel: string;
  chat: DeskModelRunScore | null;
  candidate: DeskModelRunScore | null;
  lean: DeskMigrationLean;
  summary: string;
  wrapUp: string;
}

function meanPositive(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finishedAccuracy(score: DeskModelRunScore): number | null {
  if (!score.cells_done) return null;
  return score.cells_correct / score.cells_done;
}

function formatMeanLatency(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

export function scoreDeskRunForMigration(run: DeskRunForConclusion): DeskModelRunScore {
  const scored = buildDeskApproachesConclusion(run);
  const roleplay = scored.byApproach.find((row) => row.approachId === 'desk_roleplay');
  const latencies = run.results.cells
    .filter((cell) => !isDeskCellAborted(cell) && typeof cell.latency_ms === 'number' && cell.latency_ms > 0)
    .map((cell) => cell.latency_ms as number);
  return {
    model: run.model,
    runId: run.id,
    created_at: run.created_at,
    cells_correct: scored.cells_correct,
    cells_done: scored.cells_done,
    cells_total: scored.cells_total,
    cells_aborted: scored.cells_aborted,
    cells_wrong: scored.cells_wrong,
    mean_latency_ms: meanPositive(latencies),
    desk_roleplay: {
      correct: roleplay?.correct ?? 0,
      done: roleplay?.done ?? 0,
      aborted: roleplay?.aborted ?? 0,
    },
  };
}

function modelBit(score: DeskModelRunScore): string {
  const acc = score.cells_done ? `${score.cells_correct}/${score.cells_done}` : '0/0';
  const abort = score.cells_aborted ? `, ${score.cells_aborted} abort` : '';
  const latency = score.mean_latency_ms != null
    ? `, mean ${formatMeanLatency(score.mean_latency_ms)}`
    : '';
  return `${shortModel(score.model)} ${acc}${abort}${latency}`;
}

export function buildDeskModelMigrationConclusion(input: {
  chatModel?: string;
  candidateModel?: string;
  chatRun: DeskRunForConclusion | null;
  candidateRun: DeskRunForConclusion | null;
}): DeskModelMigrationConclusion {
  const chatModel = input.chatModel?.trim() || DESK_EXPERIMENT_CHAT_MODEL;
  const candidateModel = input.candidateModel?.trim() || DESK_EXPERIMENT_CANDIDATE_MODEL;
  const chat = input.chatRun ? scoreDeskRunForMigration(input.chatRun) : null;
  const candidate = input.candidateRun ? scoreDeskRunForMigration(input.candidateRun) : null;
  const limit =
    'This comparison does not exercise live Chat tools (`run_query`, `publish_desk`, DSML). '
    + 'Four invented names is a descriptive bench, not a significance test or a production mandate.';

  if (chatModel.toLowerCase() === candidateModel.toLowerCase()) {
    return {
      chatModel,
      candidateModel,
      chat,
      candidate,
      lean: 'same_model',
      summary:
        `Chat pin and candidate are the same slug (${shortModel(chatModel)}). `
        + 'Pick a newer OpenRouter id before this scoreboard can grade a migration.',
      wrapUp:
        'The Chat pin already is the named candidate, so this page has no second model to compare. '
        + limit,
    };
  }

  if (!chat || !candidate) {
    const have = chat ? shortModel(chatModel) : null;
    const waiting = chat ? shortModel(candidateModel) : shortModel(chatModel);
    return {
      chatModel,
      candidateModel,
      chat,
      candidate,
      lean: 'insufficient',
      summary: have
        ? `Chat pin ${have} is published. Waiting for a ${waiting} matrix on the same desk-approaches-v2 tape.`
        : `No published ${shortModel(chatModel)} or ${shortModel(candidateModel)} matrix yet.`,
      wrapUp:
        'Publish the Chat pin and the candidate on this design, then this note will compare finished accuracy, '
        + 'seat aborts, production role-play, and mean cell latency. '
        + limit,
    };
  }

  const chatAcc = finishedAccuracy(chat);
  const candAcc = finishedAccuracy(candidate);
  let lean: DeskMigrationLean = 'candidate_ok';
  if (candidate.cells_done === 0 && chat.cells_done > 0) {
    lean = 'hold';
  } else if (
    candidate.cells_aborted > chat.cells_aborted
    && (candAcc == null || chatAcc == null || candAcc <= chatAcc)
  ) {
    lean = 'hold';
  } else if (chatAcc != null && candAcc != null) {
    if (candAcc > chatAcc) lean = 'candidate_better';
    else if (candAcc < chatAcc) lean = 'candidate_worse';
    else lean = 'candidate_ok';
  }

  const roleplayChat = chat.desk_roleplay.done
    ? `${chat.desk_roleplay.correct}/${chat.desk_roleplay.done}`
    : '—';
  const roleplayCand = candidate.desk_roleplay.done
    ? `${candidate.desk_roleplay.correct}/${candidate.desk_roleplay.done}`
    : '—';

  const summaryParts = [
    `Chat pin ${modelBit(chat)}. Candidate ${modelBit(candidate)}.`,
    `Production role-play: pin ${roleplayChat}, candidate ${roleplayCand}.`,
  ];
  if (lean === 'hold') {
    summaryParts.push('Operational aborts dominate — do not read this as a quality upgrade.');
  } else if (lean === 'candidate_better') {
    summaryParts.push('Candidate finished more held-out leans correctly on this tape.');
  } else if (lean === 'candidate_worse') {
    summaryParts.push('Candidate finished fewer held-out leans correctly on this tape.');
  } else {
    summaryParts.push('Finished directional grade is a tie — cost and live tools still decide a swap.');
  }

  const wrapParts = [
    'The desk-structure scoreboard stays on the live Chat pin. This second question swaps only the OpenRouter slug on the same as-of packets.',
    `Pin ${shortModel(chat.model)} scored ${chat.cells_correct}/${chat.cells_done} finished cells`
      + (chat.cells_aborted ? ` (${chat.cells_aborted} abort)` : '')
      + `; candidate ${shortModel(candidate.model)} scored ${candidate.cells_correct}/${candidate.cells_done}`
      + (candidate.cells_aborted ? ` (${candidate.cells_aborted} abort)` : '')
      + '.',
  ];
  if (lean === 'hold') {
    wrapParts.push(
      'The candidate lost more seats to timeouts or empty closes than the pin, without a better finished grade. '
      + 'That is an operational miss, not a reason to migrate Chat.',
    );
  } else if (lean === 'candidate_better') {
    wrapParts.push(
      'On finished cells the candidate matched more 5d/20d leans. Treat that as evidence this tape is readable to V4.1 Flash, not as a live Chat swap — tools and DSML are out of scope here.',
    );
  } else if (lean === 'candidate_worse') {
    wrapParts.push(
      'On finished cells the candidate missed more held-out leans than the pin. Directional quality on this bench is a reason to hold the Chat pin.',
    );
  } else {
    wrapParts.push(
      'Finished accuracy tied. A Chat migration then turns on cost (V4.1 Flash is priced above 0731 on OpenRouter), latency, and a live tool-loop check this notebook does not run.',
    );
  }
  wrapParts.push(limit);

  return {
    chatModel,
    candidateModel,
    chat,
    candidate,
    lean,
    summary: summaryParts.join(' '),
    wrapUp: wrapParts.join(' '),
  };
}
