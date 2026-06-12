import { useEffect, useState } from 'react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import type { JobStatus } from '../../types';

export interface SweepActivity {
  jobsDone: number;
  jobsTotal: number;
  category: string;
  at: number;
}

interface JobProgressProps {
  jobId: string;
  status: JobStatus;
  cellsDone: number;
  cellCount: number;
  sweep: SweepActivity | null;
  totalResults: number;
  enrichedDone: number;
  enrichedTotal: number;
  eventLog: string[];
  onCancel: () => void;
  onResume: () => void;
}

export function JobProgress({
  status,
  cellsDone,
  cellCount,
  sweep,
  totalResults,
  enrichedDone,
  enrichedTotal,
  eventLog,
  onCancel,
  onResume,
}: JobProgressProps) {
  const [logOpen, setLogOpen] = useState(false);
  const scrapeProgress = cellCount > 0 ? (cellsDone / cellCount) * 100 : 0;
  const enrichProgress = enrichedTotal > 0 ? (enrichedDone / enrichedTotal) * 100 : 0;
  const isRunning = status === 'running';
  const isEnriching = status === 'enriching';
  const isIncomplete = status === 'error' && cellCount > 0 && cellsDone < cellCount;

  // Local 1s clock so "Xs ago" ticks between SSE events — render only, no fetching
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isRunning || !sweep) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning, sweep]);

  const agoSec = sweep ? Math.max(0, Math.floor((now - sweep.at) / 1000)) : 0;
  const ago = agoSec < 60 ? `${agoSec}s` : `${Math.floor(agoSec / 60)}m ${agoSec % 60}s`;

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
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
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

      {isRunning && !sweep && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)' }}>
          Sweep in progress — first update lands when the current search finishes (~90s)
        </span>
      )}

      {isRunning && sweep && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Searches
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
              {sweep.jobsDone} / {sweep.jobsTotal}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Last sweep
            </span>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-primary)' }}>
              {sweep.category}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Updated
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)' }}>
              {ago} ago
            </span>
          </div>
        </div>
      )}

      {isIncomplete && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '10px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
          borderRadius: '8px', padding: '12px',
        }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--warn)' }}>
            Grid incomplete —{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{cellsDone}</span> of{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{cellCount}</span> cells finished.{' '}
            <span style={{ fontFamily: 'var(--font-mono)' }}>{totalResults}</span> businesses saved.
          </span>
          <Button onClick={onResume} style={{ padding: '6px 12px', fontSize: '12px' }}>
            Resume
          </Button>
        </div>
      )}

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
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
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
