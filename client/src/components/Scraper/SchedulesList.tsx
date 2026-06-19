import { useEffect, useState, useCallback } from 'react';
import type { ScrapeScheduleRow } from '../../lib/scrapeSchedulesApi';
import {
  listScrapeSchedules, createScrapeSchedule, updateScrapeSchedule,
  deleteScrapeSchedule, runScrapeScheduleNow,
} from '../../lib/scrapeSchedulesApi';

interface Props {
  geometry: { type: string; coordinates: number[][][] } | null;
}

export function SchedulesList({ geometry }: Props) {
  const [schedules, setSchedules] = useState<ScrapeScheduleRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('');
  const [formInterval, setFormInterval] = useState(60);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listScrapeSchedules().then(setSchedules).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async () => {
    if (!geometry || !formName.trim() || !formType.trim()) return;
    await createScrapeSchedule({
      name: formName.trim(),
      polygon_json: JSON.stringify(geometry),
      business_type: formType.trim(),
      interval_minutes: formInterval,
      enabled: 1,
    });
    setShowForm(false);
    setFormName(''); setFormType(''); setFormInterval(60);
    refresh();
  };

  const handleToggleEnabled = async (s: ScrapeScheduleRow) => {
    await updateScrapeSchedule(s.id, { enabled: s.enabled ? 0 : 1 });
    refresh();
  };

  const handleRunNow = async (id: string) => {
    await runScrapeScheduleNow(id);
    refresh();
  };

  const handleDelete = async (id: string) => {
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    await deleteScrapeSchedule(id);
    setConfirmDelete(null);
    refresh();
  };

  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
  const label: React.CSSProperties = {
    fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600,
    letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)',
  };
  const ghostBtn: React.CSSProperties = {
    fontFamily: 'var(--font-ui)', fontSize: 10, padding: '2px 7px', borderRadius: 5,
    border: '1px solid var(--border-strong)', background: 'transparent',
    color: 'var(--text-secondary)', cursor: 'pointer',
  };
  const input: React.CSSProperties = {
    width: '100%', background: 'var(--bg-base)', border: '1px solid var(--border-strong)',
    borderRadius: 6, padding: '5px 8px', color: 'var(--text-primary)',
    fontFamily: 'var(--font-ui)', fontSize: 12, outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {schedules.length === 0 && !showForm && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>
          No schedules yet.
        </span>
      )}

      {schedules.map(s => {
        const statusColor = s.last_run_status === 'ok' ? 'var(--success)'
          : s.last_run_status === 'error' ? 'var(--error)' : 'var(--text-muted)';
        return (
          <div key={s.id} style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.name}
              </span>
              {s.kind === 'keyword' && (
                <span className="pill pill--keyword" style={{ marginLeft: 6, fontSize: 10 }}>keyword</span>
              )}
              {s.last_run_status && (
                <span style={{ ...mono, fontSize: 10, color: statusColor }}>
                  {s.last_run_status === 'ok' ? `+${s.last_run_added_count ?? 0}` : s.last_run_status}
                </span>
              )}
              {/* enabled toggle */}
              <button
                style={{ ...ghostBtn, color: s.enabled ? 'var(--success)' : 'var(--text-muted)' }}
                onClick={() => handleToggleEnabled(s)}
                title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
              >
                {s.enabled ? 'on' : 'off'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ ...label }}>
                {s.kind === 'keyword' ? (s.keyword_query ?? '—') : s.business_type}
              </span>
              <span style={{ ...mono, fontSize: 10, color: 'var(--text-muted)' }}>
                {s.interval_minutes === 0 ? 'one-shot' : `every ${s.interval_minutes < 60 ? `${s.interval_minutes}m` : `${s.interval_minutes / 60}h`}`}
              </span>
              {s.last_run_at && (
                <span style={{ ...mono, fontSize: 10, color: 'var(--text-muted)' }}>
                  ran {new Date(s.last_run_at).toLocaleString()}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={ghostBtn} onClick={() => handleRunNow(s.id)}>Run now</button>
              <button
                style={{ ...ghostBtn, color: confirmDelete === s.id ? 'var(--error)' : undefined }}
                onClick={() => handleDelete(s.id)}
              >
                {confirmDelete === s.id ? 'Confirm delete' : 'Delete'}
              </button>
              {confirmDelete === s.id && (
                <button style={ghostBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
              )}
            </div>
          </div>
        );
      })}

      {showForm ? (
        <div style={{
          background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
          borderRadius: 10, padding: '12px',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <span style={{ ...label }}>New Schedule</span>
          {!geometry && (
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--warn)' }}>
              Draw a polygon on the map first.
            </span>
          )}
          <input style={input} placeholder="Name" value={formName} onChange={e => setFormName(e.target.value)} />
          <input style={input} placeholder="Business type (e.g. restaurante)" value={formType} onChange={e => setFormType(e.target.value)} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...label, whiteSpace: 'nowrap' }}>Interval (min)</span>
            <input
              style={{ ...input, fontFamily: 'var(--font-mono)', width: 80 }}
              type="number" min={1} value={formInterval}
              onChange={e => setFormInterval(Number(e.target.value))}
            />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{
                fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
                padding: '5px 14px', borderRadius: 7, border: 'none',
                background: geometry && formName.trim() && formType.trim() ? 'var(--accent)' : 'var(--bg-hover)',
                color: geometry && formName.trim() && formType.trim() ? 'var(--accent-ink)' : 'var(--text-muted)',
                cursor: geometry && formName.trim() && formType.trim() ? 'pointer' : 'not-allowed',
                opacity: geometry && formName.trim() && formType.trim() ? 1 : 0.5,
              }}
              disabled={!geometry || !formName.trim() || !formType.trim()}
              onClick={handleCreate}
            >
              Save
            </button>
            <button style={ghostBtn} onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button
          style={{
            fontFamily: 'var(--font-ui)', fontSize: 11, padding: '5px 0', borderRadius: 7,
            border: '1px dashed var(--border-strong)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer', width: '100%',
          }}
          onClick={() => setShowForm(true)}
        >
          + New schedule
        </button>
      )}
    </div>
  );
}
