import { useEffect, useState, useCallback } from 'react';
import type { ScrapeSchedulerHealth, ScrapeScheduleRunRow } from '../../lib/scrapeSchedulesApi';
import { getScrapeSchedulerStatus, pauseScrapeScheduler, resumeScrapeScheduler } from '../../lib/scrapeSchedulesApi';
import { useSSE } from '../../hooks/useSSE';

export function ScrapeSchedulerStatus() {
  const [health, setHealth] = useState<ScrapeSchedulerHealth | null>(null);
  const [recentRuns, setRecentRuns] = useState<ScrapeScheduleRunRow[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(() => {
    getScrapeSchedulerStatus()
      .then(d => { setHealth(d.health); setRecentRuns(d.recentRuns); })
      .catch(() => {});
  }, []);

  // One snapshot on mount; live thereafter via SSE (no polling loop).
  useEffect(() => { refresh(); }, [refresh]);

  useSSE({
    'scrape-scheduler:tick': (data) => {
      const d = data as { health: ScrapeSchedulerHealth; recentRuns: ScrapeScheduleRunRow[] };
      setHealth(d.health);
      setRecentRuns(d.recentRuns);
    },
  });

  const handlePause = async () => {
    await pauseScrapeScheduler();
    refresh();
  };
  const handleResume = async () => {
    await resumeScrapeScheduler();
    refresh();
  };

  const lastTickMs = health?.lastTickAt ? new Date(health.lastTickAt).getTime() : null;
  const isAlive = lastTickMs !== null && health !== null && Date.now() - lastTickMs < 2 * health.intervalMs;
  const dotColor = !health ? '#555' : health.paused ? 'var(--warn)' : isAlive ? 'var(--success)' : 'var(--error)';

  const ghostBtn: React.CSSProperties = {
    fontFamily: 'var(--font-ui)', fontSize: 10, padding: '2px 8px', borderRadius: 6,
    border: '1px solid var(--border-strong)', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer',
  };

  const shown = expanded ? recentRuns : recentRuns.slice(0, 5);

  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 12, padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10, flexShrink: 0,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600,
          letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-secondary)',
          flex: 1,
        }}>Scrape Scheduler</span>
        {health?.paused && (
          <span style={{
            fontFamily: 'var(--font-ui)', fontSize: 9, fontWeight: 600,
            color: 'var(--accent-ink)', background: 'var(--accent)',
            borderRadius: 100, padding: '1px 6px', letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>Paused</span>
        )}
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />
        {health?.paused
          ? <button style={ghostBtn} onClick={handleResume}>Resume</button>
          : <button style={ghostBtn} onClick={handlePause}>Pause</button>
        }
      </div>

      {/* Tick counts */}
      {health && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
          {([
            ['due', health.lastTickCounts.due, 'var(--text-secondary)'],
            ['ran', health.lastTickCounts.ran, 'var(--success)'],
            ['added', health.lastTickCounts.added, 'var(--accent)'],
            ['deduped', health.lastTickCounts.deduped, 'var(--text-muted)'],
            ['err', health.lastTickCounts.errored, health.lastTickCounts.errored > 0 ? 'var(--error)' : 'var(--text-muted)'],
          ] as [string, number, string][]).map(([label, val, color]) => (
            <span key={label} style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              {label}{' '}
              <span style={{ color, fontWeight: 600 }}>{val}</span>
            </span>
          ))}
        </div>
      )}

      {/* Recent runs */}
      {recentRuns.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map(run => (
            <div key={run.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                {new Date(run.started_at).toLocaleTimeString()}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: run.status === 'ok' ? 'var(--success)' : run.status === 'error' ? 'var(--error)' : 'var(--warn)' }}>
                {run.status === 'ok' ? `+${run.added_count}` : run.status === 'error' ? 'err' : '…'}
              </span>
            </div>
          ))}
          {recentRuns.length > 5 && (
            <button style={{ ...ghostBtn, alignSelf: 'flex-start', marginTop: 2 }} onClick={() => setExpanded(e => !e)}>
              {expanded ? 'Show less' : `Show ${recentRuns.length - 5} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
