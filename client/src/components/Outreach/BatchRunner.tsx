import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { BatchProgress } from '../../lib/batchApi';

interface BatchRunnerProps {
  progress: BatchProgress | null;
  queueCount: number;
  onStart: (size: number, dryRun: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

const PRESETS = [15, 30, 60];

const wrap: CSSProperties = {
  borderBottom: '1px solid var(--border)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'var(--bg-panel)',
};
const label: CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 11, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--text-muted)',
};
const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const pillBase: CSSProperties = {
  background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 20,
  padding: '2px 10px', fontFamily: 'var(--font-mono)', fontSize: 11,
  color: 'var(--text-secondary)', cursor: 'pointer',
};
const pillActive: CSSProperties = {
  ...pillBase, background: 'var(--bg-hover)', border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
};
const primaryBtn: CSSProperties = {
  background: 'var(--accent)', color: 'var(--accent-ink)', border: 'none', borderRadius: 8,
  padding: '6px 12px', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};
const ghostBtn: CSSProperties = {
  background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)',
  borderRadius: 8, padding: '5px 10px', fontFamily: 'var(--font-ui)', fontSize: 12, cursor: 'pointer',
};

export function BatchRunner({ progress, queueCount, onStart, onPause, onResume, onCancel }: BatchRunnerProps) {
  const [size, setSize] = useState(15);
  const [custom, setCustom] = useState('');
  const [dryRun, setDryRun] = useState(true);

  const active = progress !== null && (progress.status === 'running' || progress.status === 'paused');

  if (active && progress) {
    const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
    return (
      <div style={wrap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={label}>Batch {progress.status === 'paused' ? '· paused' : 'running'}</span>
          <span style={{ ...mono, fontSize: 12, color: 'var(--text-secondary)' }}>
            {progress.processed}/{progress.total}
          </span>
        </div>
        {/* progress bar — the single accent while a run is active */}
        <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', boxShadow: '0 0 12px var(--accent-glow)', transition: 'width 240ms ease' }} />
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
          <span>queued <b style={{ ...mono, color: 'var(--success)' }}>{progress.queuedForSend}</b></span>
          <span>skipped <b style={mono}>{progress.skippedNoEvidence}</b></span>
          <span>held <b style={{ ...mono, color: 'var(--warn)' }}>{progress.heldGeneric}</b></span>
          <span>failed <b style={{ ...mono, color: progress.failed > 0 ? 'var(--error)' : 'var(--text-muted)' }}>{progress.failed}</b></span>
        </div>
        {progress.pauseReason === 'gemini_rpd_exhausted' && (
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--warn)' }}>
            Gemini daily budget hit — resumes after reset.
          </span>
        )}
        <div style={{ display: 'flex', gap: 6 }}>
          {progress.status === 'running'
            ? <button style={ghostBtn} onClick={onPause}>Pause</button>
            : <button style={ghostBtn} onClick={onResume}>Resume</button>}
          <button style={ghostBtn} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }

  const effectiveSize = custom.trim() ? Math.max(1, parseInt(custom, 10) || 0) : size;
  const runnable = Math.min(effectiveSize, queueCount);

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={label}>Run batch</span>
        <span style={{ ...mono, fontSize: 11, color: 'var(--text-muted)' }}>{queueCount} in queue</span>
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {PRESETS.map(p => (
          <button
            key={p}
            style={!custom.trim() && size === p ? pillActive : pillBase}
            onClick={() => { setSize(p); setCustom(''); }}
          >{p}</button>
        ))}
        <input
          value={custom}
          onChange={e => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="N"
          style={{
            width: 40, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
            borderRadius: 8, padding: '2px 6px', fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--text-primary)',
          }}
        />
      </div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
        Dry-run (prepare + queue, no real send)
      </label>
      <button
        style={runnable > 0 ? primaryBtn : { ...primaryBtn, opacity: 0.4, cursor: 'default' }}
        disabled={runnable === 0}
        onClick={() => onStart(runnable, dryRun)}
      >
        Prepare {runnable} lead{runnable === 1 ? '' : 's'}
      </button>
    </div>
  );
}
