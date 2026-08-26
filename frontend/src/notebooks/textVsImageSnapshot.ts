import type {
  ExperimentRunPayload,
  ExperimentRunSummary,
} from '../api.ts';
import snapshotJson from '../generated/textVsImageSnapshot.json';

export interface TextVsImageSnapshot {
  generated_at: string;
  design_id: string;
  run_schema_version: number | null;
  items: ExperimentRunSummary[];
  model_runs: ExperimentRunPayload[];
}

export const textVsImageSnapshot =
  snapshotJson as unknown as TextVsImageSnapshot;
