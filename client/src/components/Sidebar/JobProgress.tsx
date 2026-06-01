import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import type { JobStatus } from '../../types';

interface JobProgressProps {
  jobId: string;
  status: JobStatus;
  cellsDone: number;
  cellCount: number;
  totalResults: number;
  enrichedDone: number;
  enrichedTotal: number;
  eventLog: string[];
  onCancel: () => void;
}

export function JobProgress({
  status,
  cellsDone,
  cellCount,
  totalResults,
  enrichedDone,
  enrichedTotal,
  eventLog,
  onCancel,
}: JobProgressProps) {
  const [logOpen, setLogOpen] = useState(false);
  const scrapeProgress = cellCount > 0 ? (cellsDone / cellCount) * 100 : 0;
  const enrichProgress = enrichedTotal > 0 ? (enrichedDone / enrichedTotal) * 100 : 0;
  const isRunning = status === 'running';
  const isEnriching = status === 'enriching';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Badge status={status} />
        {isRunning && (
          <Button variant="danger" onClick={onCancel} style={{ padding: '6px 12px', fontSize: '12px' }}>
            Cancel
          </Button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
            Cells
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {cellsDone} / {cellCount}
          </span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ transform: `scaleX(${scrapeProgress / 100})` }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '28px', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>
          {totalResults}
        </span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)' }}>
          businesses
        </span>
      </div>

      {(isEnriching || enrichedDone > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
              Social Profiles
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
              {enrichedDone} / {enrichedTotal}
            </span>
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill${isEnriching ? ' progress-fill--enriching' : ''}`}
              style={{ transform: `scaleX(${enrichProgress / 100})` }}
            />
          </div>
        </div>
      )}

      <div>
        <button
          onClick={() => setLogOpen(o => !o)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500,
            color: 'var(--text-muted)', padding: 0,
          }}
        >
          {logOpen ? '▲' : '▼'} Event Log
        </button>
        {logOpen && (
          <div className="event-log" style={{ marginTop: '8px' }}>
            {eventLog.slice(-50).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
