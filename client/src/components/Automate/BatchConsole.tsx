import { useState, useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { BatchProgress, BatchItem } from '../../lib/batchApi';
import { StageTracker } from '../Outreach/StageTracker';
import { Disclosure } from '../ui/Disclosure';

// Live batch-run surface (slice 0019 → Automate redesign). Renders the in-flight
// run inside the Prepare lane: progress bar, ETA, elapsed, accumulated cost,
// per-disposition counts, current lead + live stage, and an expandable per-lead
// outcome list (the answer to "sometimes it fails and I don't know why").
// The idle/start controls moved to PrepareLane's lead-staging UI.

interface BatchRunViewProps {
  progress: BatchProgress;
  currentLead: { id: string; name: string | null; locCountry: string | null } | null;
  accumulatedCost: number;
  items: BatchItem[];
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}

// Full prepare pipeline ≈ sum of StageTracker EXPECTED_MS. First-lead ETA before
// a measured rate exists.
const PER_LEAD_FALLBACK_MS = 42_000;

const mono: CSSProperties = { fontFamily: 'var(--font-mono)' };
const sectionLabel: CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--text-muted)',
};

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

const DISPOSITION_LABEL: Record<string, string> = {
  sent_specific: 'queued', skipped_no_evidence: 'skipped', skipped_bad_email: 'bad email',
  held_generic: 'held', failed: 'failed',
};

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 16px',
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10, minWidth: 120,
    }}>
      <span style={sectionLabel}>{label}</span>
      <span style={{ ...mono, fontSize: 'var(--text-section)', color: tone ?? 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

function CountChip({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--text-muted)' }}>
      {label} <b style={{ ...mono, color: tone ?? 'var(--text-secondary)' }}>{value}</b>
    </span>
  );
}

export function BatchRunView({ progress, currentLead, accumulatedCost, items, onPause, onResume, onCancel }: BatchRunViewProps) {
  const status = progress.status;
  const paused = status === 'paused';

  // ETA anchor: record (time, processed) when the run-id first appears so the
  // observed rate measures throughput since we began watching. Reset per run.
  const anchor = useRef<{ runId: string; at: number; processed: number } | null>(null);
  if (anchor.current?.runId !== progress.runId) {
    anchor.current = { runId: progress.runId, at: Date.now(), processed: progress.processed };
  }

  // Local 1s tick to advance elapsed + ETA while running (not a data poll).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== 'running') return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [status]);

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const remaining = Math.max(0, progress.total - progress.processed);
  const a = anchor.current!;
  const observed = progress.processed - a.processed;
  const meanMs = observed >= 2 ? (Date.now() - a.at) / observed : PER_LEAD_FALLBACK_MS;
  const etaMs = remaining * meanMs;
  const elapsedMs = Date.now() - a.at;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)', color: 'var(--text-primary)', fontWeight: 500 }}>
          {paused ? 'Batch en pausa' : 'Preparando batch'}
        </span>
        <span style={{ ...mono, fontSize: 'var(--text-body)', color: 'var(--text-secondary)' }}>
          {progress.processed}/{progress.total}
        </span>
      </div>

      {/* progress bar */}
      <div style={{ height: 6, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', boxShadow: '0 0 12px var(--accent-glow)', transition: 'width 240ms ease' }} />
      </div>

      {/* metric cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Metric label="ETA" value={paused ? '—' : remaining === 0 ? 'casi listo' : fmtDuration(etaMs)} tone={paused ? 'var(--text-muted)' : 'var(--accent)'} />
        <Metric label="Transcurrido" value={fmtDuration(elapsedMs)} />
        <Metric label="Costo" value={`$${accumulatedCost.toFixed(4)}`} />
      </div>

      {/* current lead + live stage */}
      {!paused && currentLead && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)', color: 'var(--text-primary)', fontWeight: 500 }}>
            {currentLead.name ?? 'Lead en preparación…'}
          </span>
          <StageTracker lead={currentLead} mode="full" active premiumPresent />
        </div>
      )}

      {/* per-disposition counts */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <CountChip label="queued" value={progress.queuedForSend} tone="var(--success)" />
        <CountChip label="skipped" value={progress.skippedNoEvidence} />
        <CountChip label="held" value={progress.heldGeneric} tone="var(--warn)" />
        <CountChip label="failed" value={progress.failed} tone={progress.failed > 0 ? 'var(--error)' : undefined} />
      </div>

      {/* honest pause reason — leaves a seam for 0020's quota banner */}
      {paused && progress.pauseReason && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--warn)' }}>
          {progress.pauseReason === 'gemini_rpd_exhausted'
            ? 'Presupuesto diario de Gemini agotado — reanuda tras el reset.'
            : progress.pauseReason === 'user_paused' ? 'En pausa.' : progress.pauseReason}
        </span>
      )}

      <OutcomeList items={items} />

      <div style={{ display: 'flex', gap: 10 }}>
        {status === 'running'
          ? <button className="btn-secondary" style={{ padding: '8px 16px' }} onClick={onPause}>Pausar</button>
          : <button className="btn-secondary" style={{ padding: '8px 16px' }} onClick={onResume}>Reanudar</button>}
        <button className="btn-secondary" style={{ padding: '8px 16px' }} onClick={onCancel}>Cancelar</button>
      </div>
    </div>
  );
}

function OutcomeList({ items }: { items: BatchItem[] }) {
  const terminal = items.filter(i =>
    i.state === 'queued_for_send' || i.state === 'skipped_no_evidence' ||
    i.state === 'held_generic' || i.state === 'failed');
  if (terminal.length === 0) return null;

  return (
    <Disclosure label="Resultados por lead" count={terminal.length}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 8, maxHeight: 280, overflowY: 'auto' }}>
        {terminal.map(item => {
          const disp = item.disposition ?? item.state;
          const isFail = item.state === 'failed';
          const isQueued = item.state === 'queued_for_send';
          return (
            <div key={item.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12,
              padding: '6px 0', borderBottom: '1px solid var(--hairline)',
            }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.name ?? item.businessId}
                </div>
                {item.lastError && (
                  <div style={{ ...mono, fontSize: 'var(--text-caption)', color: isFail ? 'var(--error)' : 'var(--text-muted)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.lastError}
                  </div>
                )}
              </div>
              <span style={{
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', fontWeight: 500,
                padding: '2px 8px', borderRadius: 4, flexShrink: 0,
                color: isQueued ? 'var(--success)' : isFail ? 'var(--error)' : 'var(--text-muted)',
                background: isQueued ? 'var(--success-dim)' : isFail ? 'var(--error-dim)' : 'var(--fill-subtle)',
              }}>
                {DISPOSITION_LABEL[disp] ?? disp}
              </span>
            </div>
          );
        })}
      </div>
    </Disclosure>
  );
}
