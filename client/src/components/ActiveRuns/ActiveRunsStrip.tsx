import type { ReactNode } from 'react';
import { useActiveRuns } from '../../hooks/useActiveRuns';
import type { ActiveRun } from '../../lib/activeRunsApi';

type View = 'scraper' | 'explorer' | 'outreach' | 'automate' | 'analytics' | 'settings';

interface ActiveRunsStripProps {
  onNavigate: (view: View) => void;
}

const KEYWORD_STAGE_LABEL: Record<string, string> = {
  submitting: 'Submitting', scraping: 'Scraping', saving: 'Saving',
  enriching: 'Enriching', done: 'Done', error: 'Error',
};

interface RunChip {
  key: string;
  view: View;
  label: string;
  meta: ReactNode;
  state?: 'error' | 'paused';
}

function toChip(run: ActiveRun): RunChip {
  switch (run.type) {
    case 'scrape':
      return {
        key: `scrape:${run.jobId}`, view: 'scraper', label: 'Map scrape',
        state: run.status === 'error' ? 'error' : undefined,
        meta: (
          <>
            <span className="active-run-num">{run.cellsDone}</span>/<span className="active-run-num">{run.cellCount}</span> cells
            {' · '}<span className="active-run-num">{run.businessesFound}</span> found
          </>
        ),
      };
    case 'keyword':
      return {
        key: `keyword:${run.runId ?? run.jobId}`, view: 'scraper',
        label: `Keyword: ${run.query}`,
        meta: KEYWORD_STAGE_LABEL[run.stage ?? ''] ?? 'Running',
      };
    case 'batch':
      return {
        key: `batch:${run.runId}`, view: 'automate', label: 'Outreach batch',
        state: run.status === 'paused' ? 'paused' : undefined,
        meta: (
          <>
            <span className="active-run-num">{run.processed}</span>/<span className="active-run-num">{run.total}</span>
            {' · '}<span className="active-run-num">{run.queuedForSend}</span> queued
            {run.status === 'paused' && run.pauseReason ? ` · ${run.pauseReason}` : ''}
          </>
        ),
      };
    case 'premium':
      return {
        key: 'premium', view: 'outreach', label: 'Premium analysis',
        meta: (
          <>
            <span className="active-run-num">{run.running}</span> running
            {' · '}<span className="active-run-num">{run.pending}</span> queued
          </>
        ),
      };
  }
}

// Always-mounted global strip (slice 0012). Server-authoritative active runs, so a
// run survives tab unmount and several render at once. Hidden when nothing runs.
export function ActiveRunsStrip({ onNavigate }: ActiveRunsStripProps) {
  const runs = useActiveRuns();
  if (runs.length === 0) return null;

  return (
    <div className="active-runs-strip">
      <span className="active-runs-label">RUNNING</span>
      {runs.map(toChip).map(chip => (
        <button
          key={chip.key}
          className={`active-run-chip${chip.state ? ` active-run-chip--${chip.state}` : ''}`}
          onClick={() => onNavigate(chip.view)}
          title={`Go to ${chip.view}`}
        >
          <span className="active-run-dot" />
          <span className="active-run-name">{chip.label}</span>
          <span className="active-run-meta">{chip.meta}</span>
        </button>
      ))}
    </div>
  );
}
