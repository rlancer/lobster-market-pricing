/**
 * Firm-pipeline experiment — public labels + design id.
 * Canonical cases live on the Worker (same frozen tape as desk-approaches).
 */

import {
  formatDurationMs,
  isChatDeskExperimentModel,
  isDeskCellAborted,
  pct,
  pickLatestChatDeskRun,
  type DeskRunCell,
  type DeskRunForConclusion,
} from './deskApproaches.ts';

export const FIRM_PIPELINE_SLUG = 'firm-pipeline';
export const FIRM_PIPELINE_DESIGN_ID = 'firm-pipeline-v1';
export const FIRM_PIPELINE_CHAT_MODEL = 'deepseek/deepseek-v4-flash-0731';

export const FIRM_APPROACH_LABELS: Record<string, string> = {
  solo: 'Solo trader',
  reports_then_trader: 'Analyst reports → trader',
  bull_bear_debate: 'Bull vs bear research',
  firm_risk_committee: 'Full firm pipeline',
};

export function firmApproachLabel(id: string): string {
  return FIRM_APPROACH_LABELS[id] ?? id;
}

export function firmSessionCountLabel(mode: string): string {
  if (mode === 'one') return '1';
  if (mode === 'reports_then_trader') return '5';
  if (mode === 'bull_bear') return '7';
  if (mode === 'firm_pipeline') return '10';
  return '—';
}

export {
  formatDurationMs,
  isChatDeskExperimentModel,
  isDeskCellAborted,
  pct,
  pickLatestChatDeskRun,
};

export type { DeskRunCell, DeskRunForConclusion } from './deskApproaches.ts';

export interface FirmApproachScore {
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

export interface FirmPipelineConclusion {
  runId: string | null;
  model: string | null;
  created_at: number | null;
  cells_correct: number;
  cells_done: number;
  cells_total: number;
  cells_aborted: number;
  cells_wrong: number;
  byApproach: FirmApproachScore[];
  winningApproaches: string[];
  summary: string;
  wrapUp: string;
}

function scoreApproach(approachId: string, cells: DeskRunCell[]): FirmApproachScore {
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
    label: firmApproachLabel(approachId),
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

export function buildFirmPipelineConclusion(
  run: DeskRunForConclusion | null,
): FirmPipelineConclusion {
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
        'No published Chat-model run yet — the conclusion appears after the first firm-pipeline-v1 matrix is saved.',
      wrapUp:
        'Once a Chat-model matrix lands, this note will say whether analyst reports, bull/bear research, or a later risk committee beat a solo take on the same frozen tape.',
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
    'This notebook holds the same invented-ticker as-of tape as Analyst desk vs sessions, and varies only firm stages from TradingAgents: solo, structured analyst reports, bull/bear research, then a later risk committee.',
  ];
  if (cells_done === 0) {
    wrapParts.push(
      'The latest Chat-model run did not finish any cell, so there is no directional grade yet — only operational outcome.',
    );
  } else if (cells_wrong === 0) {
    if (byApproach.every((row) => row.done === row.total && row.wrong === 0)) {
      wrapParts.push(
        `On this readable tape the four pipelines tied at ${cells_correct}/${cells_total}: extra stages did not beat a solo take.`,
      );
    } else {
      wrapParts.push(
        `Every completed cell was correct (${cells_correct}/${cells_done}). Remaining gaps are seat aborts, not a better lean from debate or risk.`,
      );
    }
    wrapParts.push(
      'If reports, debate, and a risk committee cannot beat one voice on a tape whose 5d/20d continue the as-of path, those stages are extra cost until we find a case where they change the grade.',
    );
  } else {
    const misses = byApproach
      .filter((row) => row.wrong > 0)
      .map((row) => `${row.label} missed ${row.wrongCases.join(', ')}`)
      .join('; ');
    wrapParts.push(`Finished cells scored ${cells_correct}/${cells_done}. ${misses}.`);
    if (winningApproaches.length) {
      wrapParts.push(
        `Highest observed finished accuracy: ${winningApproaches.map(firmApproachLabel).join(', ')}.`,
      );
    }
    const debate = byApproach.find((row) => row.approachId === 'bull_bear_debate');
    const reports = byApproach.find((row) => row.approachId === 'reports_then_trader');
    const firm = byApproach.find((row) => row.approachId === 'firm_risk_committee');
    const solo = byApproach.find((row) => row.approachId === 'solo');
    if (debate && reports && debate.done && reports.done && debate.correct / debate.done > reports.correct / reports.done) {
      wrapParts.push('Bull/bear research beat reports-only on finished cells — the dialectic is doing work beyond extra analysts.');
    }
    if (firm && debate && firm.done && debate.done && firm.correct / firm.done > debate.correct / debate.done) {
      wrapParts.push('The later risk committee improved the grade versus stopping at the trader — risk-after-decision is not the same as a parallel risk specialist.');
    }
    if (solo && winningApproaches.includes('solo') && winningApproaches.length === 1) {
      wrapParts.push('Solo won. Extra stages cost tokens without a better directional call on this design.');
    }
  }
  wrapParts.push(
    'Four invented names and one Chat model is a descriptive bench, not a significance test. TradingAgents reported Sharpe on AAPL/GOOGL/AMZN; this page does not. Treat the scoreboard as evidence for this protocol, not a production mandate to spawn a firm.',
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
