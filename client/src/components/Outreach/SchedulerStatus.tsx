import { useState } from 'react';
import type { ScheduledQueueStatus, ScheduledSend } from '../../lib/outreachApi';
import { formatScheduledAt } from '../../lib/outreachApi';

function msAgo(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

export function SchedulerStatus({ status }: { status: ScheduledQueueStatus }) {
  const [expanded, setExpanded] = useState(false);
  const { health, counts, next } = status;

  const lastTickMs = health.lastTickAt ? new Date(health.lastTickAt).getTime() : null;
  const isAlive = lastTickMs !== null && Date.now() - lastTickMs < 2 * health.intervalMs;
  const dotColor = health.lastTickAt === null
    ? 'var(--text-muted)'
    : isAlive ? 'var(--success)' : 'var(--error)';

  const shown: ScheduledSend[] = expanded ? next : next.slice(0, 5);

  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
    }}>
      {/* Header: label + heartbeat */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
          color: 'var(--text-muted)', letterSpacing: '0.11em', textTransform: 'uppercase',
        }}>Scheduler</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{
            display: 'inline-block', width: 7, height: 7,
            borderRadius: '50%', background: dotColor, flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            color: isAlive ? 'var(--text-muted)' : 'var(--error)',
          }}>
            {health.lastTickAt ? `${msAgo(health.lastTickAt)} ago` : 'no tick yet'}
          </span>
        </div>
      </div>

      {/* Counts row: no --warn, no new accents */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {[
          { label: 'sched',      value: counts.scheduled,      color: 'var(--accent)' },
          { label: 'sending',    value: counts.sending,         color: 'var(--text-secondary)' },
          { label: 'sent·today', value: counts.sent_today,      color: 'var(--success)' },
          { label: 'defer',      value: counts.deferred,        color: 'var(--text-secondary)' },
          { label: 'held',       value: counts.held_now,        color: 'var(--text-muted)' },
          { label: 'fail·today', value: counts.failed_today,    color: 'var(--error)' },
        ].map(({ label, value, color }) => (
          <span key={label} style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
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
            fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600,
            color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.09em',
          }}>Next</span>
          {shown.map((row: ScheduledSend) => (
            <div key={row.id} style={{
              display: 'flex', alignItems: 'baseline',
              justifyContent: 'space-between', gap: 8,
            }}>
              <span style={{
                fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minWidth: 0, flex: 1,
              }}>{row.business_name}</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 10,
                color: 'var(--text-muted)', flexShrink: 0,
              }}>{formatScheduledAt(row.scheduled_at)}</span>
            </div>
          ))}
          {next.length > 5 && (
            <button onClick={() => setExpanded(e => !e)} style={{
              fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--accent)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              textAlign: 'left', padding: 0,
            }}>
              {expanded ? 'Show less' : `Show ${next.length - 5} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
