import { useState } from 'react';
import type { ScheduledQueueStatus, ScheduledSend } from '../../lib/outreachApi';
import { formatScheduledAt } from '../../lib/outreachApi';

function msAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

interface SchedulerStatusProps {
  status: ScheduledQueueStatus;
  onPause: (reason?: string) => Promise<void>;
  onResume: () => Promise<void>;
  onCancelRow: (id: string) => Promise<void>;
  onCancelAllPending: () => Promise<void>;
}

export function SchedulerStatus({ status, onPause, onResume, onCancelRow, onCancelAllPending }: SchedulerStatusProps) {
  const [expanded, setExpanded] = useState(false);
  const [pauseConfirm, setPauseConfirm] = useState(false);
  const [cancelAllConfirm, setCancelAllConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const { health, counts, next } = status;

  const paused = health.paused;
  const lastTickMs = health.lastTickAt ? new Date(health.lastTickAt).getTime() : null;
  const isAlive = lastTickMs !== null && Date.now() - lastTickMs < 2 * health.intervalMs;

  const dotColor = paused
    ? 'var(--error)'
    : health.lastTickAt === null
      ? 'var(--text-muted)'
      : isAlive ? 'var(--success)' : 'var(--error)';

  const shown: ScheduledSend[] = expanded ? next : next.slice(0, 5);

  async function handlePauseClick() {
    if (!pauseConfirm) { setPauseConfirm(true); return; }
    setPauseConfirm(false);
    setBusy(true);
    try { await onPause(); } finally { setBusy(false); }
  }

  async function handleResumeClick() {
    setBusy(true);
    try { await onResume(); } finally { setBusy(false); }
  }

  async function handleCancelRow(id: string) {
    setBusy(true);
    try { await onCancelRow(id); } finally { setBusy(false); }
  }

  async function handleCancelAll() {
    if (!cancelAllConfirm) { setCancelAllConfirm(true); return; }
    setCancelAllConfirm(false);
    setBusy(true);
    try { await onCancelAllPending(); } finally { setBusy(false); }
  }

  const ghostBtn = {
    fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', padding: '2px 8px', borderRadius: 6,
    border: '1px solid var(--border-strong)', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer',
  } as const;

  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
    }}>
      {/* Header: label + paused pill + heartbeat + pause/resume */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', fontWeight: 600,
            color: 'var(--text-muted)', letterSpacing: '0.11em', textTransform: 'uppercase',
          }}>Scheduler</span>
          {paused && (
            <span
              title={health.pausedReason ?? undefined}
              style={{
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', fontWeight: 600,
                color: 'var(--accent-ink)', background: 'var(--accent)',
                borderRadius: 100, padding: '1px 6px', letterSpacing: '0.06em',
                textTransform: 'uppercase', cursor: health.pausedReason ? 'help' : 'default',
              }}
            >Paused</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            display: 'inline-block', width: 7, height: 7,
            borderRadius: '50%', background: dotColor, flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)',
            color: isAlive && !paused ? 'var(--text-muted)' : 'var(--error)',
          }}>
            {health.lastTickAt ? `${msAgo(health.lastTickAt)} ago` : 'no tick yet'}
          </span>
          {paused ? (
            <button onClick={handleResumeClick} disabled={busy} style={ghostBtn}>
              Resume
            </button>
          ) : pauseConfirm ? (
            <button onClick={handlePauseClick} disabled={busy} style={{ ...ghostBtn, color: 'var(--warn)' }}>
              Confirm pause?
            </button>
          ) : (
            <button onClick={handlePauseClick} disabled={busy} style={ghostBtn}>
              Pause
            </button>
          )}
        </div>
      </div>

      {/* Counts row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'sched',         value: counts.scheduled,       color: 'var(--accent)' },
          { label: 'sending',       value: counts.sending,          color: 'var(--text-secondary)' },
          { label: 'sent·today',    value: counts.sent_today,       color: 'var(--success)' },
          { label: 'defer',         value: counts.deferred,         color: 'var(--text-secondary)' },
          { label: 'held',          value: counts.held_now,         color: 'var(--text-muted)' },
          { label: 'canceled·today',value: counts.canceled_today,   color: 'var(--text-muted)' },
          { label: 'fail·today',    value: counts.failed_today,     color: 'var(--error)' },
        ].map(({ label, value, color }) => (
          <span key={label} style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)',
            color: 'var(--text-secondary)', whiteSpace: 'nowrap',
          }}>
            {label} <span style={{ color, fontWeight: 600 }}>{value}</span>
          </span>
        ))}
      </div>

      {/* Next queue */}
      {next.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{
            fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', fontWeight: 600,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.09em',
          }}>Next</span>
          {shown.map((row: ScheduledSend) => (
            <div key={row.id} style={{
              display: 'flex', alignItems: 'baseline',
              justifyContent: 'space-between', gap: 8,
            }}>
              <span style={{
                fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0, flex: 1,
              }}>{row.business_name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)',
                  color: 'var(--text-muted)',
                }}>{formatScheduledAt(row.scheduled_at)}</span>
                <button
                  onClick={() => handleCancelRow(row.id)}
                  disabled={busy || row.status === 'claimed'}
                  title={row.status === 'claimed' ? 'in-flight' : undefined}
                  style={{
                    fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', padding: '1px 6px', borderRadius: 100,
                    border: '1px solid var(--border)', background: 'transparent',
                    color: row.status === 'claimed' ? 'var(--text-muted)' : 'var(--error)',
                    cursor: row.status === 'claimed' ? 'not-allowed' : 'pointer',
                    opacity: row.status === 'claimed' ? 0.4 : 1,
                  }}
                >×</button>
              </div>
            </div>
          ))}
          {next.length > 5 && (
            <button onClick={() => setExpanded(e => !e)} style={{
              fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', color: 'var(--accent)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              textAlign: 'left', padding: 0,
            }}>
              {expanded ? 'Show less' : `Show ${next.length - 5} more`}
            </button>
          )}
          {expanded && counts.scheduled > 0 && (
            <div style={{ marginTop: 4 }}>
              {cancelAllConfirm ? (
                <button onClick={handleCancelAll} disabled={busy} style={{
                  ...ghostBtn,
                  color: 'var(--error)', border: '1px solid var(--error-border)',
                  background: 'var(--error-dim)',
                }}>
                  Confirm cancel all?
                </button>
              ) : (
                <button onClick={handleCancelAll} disabled={busy} style={{
                  ...ghostBtn,
                  color: 'var(--error)', border: '1px solid var(--error-border)',
                  background: 'var(--error-dim)',
                }}>
                  Cancel all pending
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
