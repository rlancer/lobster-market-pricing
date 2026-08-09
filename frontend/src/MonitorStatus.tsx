import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Tooltip } from '@astryxdesign/core';
import { api, type RefreshRun } from './api';
import { useWorkspace } from './workspace';
import './MonitorStatus.css';

/**
 * Consolidated dataset-status chip for the header. Replaces the old trio of
 * (Dataset-ready dot · "As of …" · "Data · date · status" chip + popover) with
 * one element that folds all of it together and navigates to the full monitor
 * page (/monitor). The detail (loader loop, run history) lives on that page.
 */
const toneOf = (status: string): string => {
  const s = status.toLowerCase();
  if (s === 'complete') return 'ok';
  if (s === 'failed') return 'bad';
  return 'run';
};

export default function MonitorStatus() {
  const navigate = useNavigate();
  const { stats } = useWorkspace();
  const [latest, setLatest] = useState<RefreshRun | null>(null);

  // Latest loader run → the data date + status fragment of the chip.
  useEffect(() => {
    let live = true;
    api
      .runs(1)
      .then((r) => { if (live) setLatest(r[0] ?? null); })
      .catch(() => { /* best-effort; chip just omits the data fragment */ });
    return () => { live = false; };
  }, []);

  const tone = latest ? toneOf(latest.status) : 'ok';

  return (
    <Tooltip
      content={`${stats ? 'Dataset ready' : '…'} — data as of ${latest?.as_of_date ?? 'n/a'} · ${latest?.status ?? ''}. Open the monitor for full status.`}
      hasHoverIndication={false}
    >
      <button
        type="button"
        className="monitor-status"
        onClick={() => navigate({ to: '/monitor' })}
      >
        <span className={`ms-dot ${tone}`} aria-hidden="true" />
        <span className="ms-ready">{stats ? 'Dataset ready' : '…'}</span>
        {latest && (
          <span className="ms-data">
            Data · {latest.as_of_date || 'n/a'}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
