import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useScheduledSends } from '../../hooks/useScheduledSends';
import { loadDraft, sendOutreachEmail, formatScheduledAt, defaultScheduleLocal, type ScheduledSend } from '../../lib/outreachApi';
import { LaneHeader } from './LaneHeader';
import { InlineDraftEditor } from './InlineDraftEditor';

// Send lane: the scheduled-send queue where prepared leads land. Review/edit the
// draft inline, send now, reschedule, or cancel — all via existing endpoints.
const actionBtn: CSSProperties = {
  background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 6,
  padding: '4px 10px', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)',
  color: 'var(--text-secondary)', cursor: 'pointer',
};
const dtInput: CSSProperties = {
  background: 'var(--bg-panel)', border: '1px solid var(--border-strong)', borderRadius: 6,
  padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)', color: 'var(--text-primary)',
};

export function SendLane() {
  const queue = useScheduledSends();
  const [editing, setEditing] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const paused = queue.status?.health.paused ?? false;

  const sendNow = async (row: ScheduledSend) => {
    setSending(row.id);
    try {
      const draft = await loadDraft(row.business_id);
      if (!draft) return;
      await sendOutreachEmail(row.business_id, draft.subject, draft.body);
      queue.refresh();
    } finally {
      setSending(null);
    }
  };

  const startReschedule = (id: string) => { setRescheduling(id); setWhen(defaultScheduleLocal()); };
  const confirmReschedule = async (id: string) => { await queue.reschedule(id, when); setRescheduling(null); };

  return (
    <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-pane)', padding: 'var(--space-lane)' }}>
      <LaneHeader
        step={3}
        title="Enviar"
        status={
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {queue.status && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-label)', color: 'var(--text-muted)' }}>
                {queue.status.counts.scheduled} en cola · {queue.status.counts.sent_today} enviados hoy
              </span>
            )}
            <button
              style={{ ...actionBtn, color: paused ? 'var(--warn)' : 'var(--text-secondary)' }}
              onClick={() => (paused ? queue.resume() : queue.pause())}
            >
              {paused ? 'Reanudar envío' : 'Pausar envío'}
            </button>
          </span>
        }
      />

      {queue.rows.length === 0 ? (
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)', color: 'var(--text-muted)', padding: '8px 0' }}>
          {queue.loading ? 'Cargando cola…' : 'Nada en cola. Prepará leads arriba para encolarlos.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {queue.rows.map(row => (
            <div key={row.id} style={{ borderBottom: '1px solid var(--hairline)', padding: '10px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {row.business_name}
                  </div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)', marginTop: 2 }}>
                    {formatScheduledAt(row.scheduled_at)}{row.window_label ? ` · ${row.window_label}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button style={actionBtn} onClick={() => setEditing(editing === row.id ? null : row.id)}>
                    {editing === row.id ? 'Cerrar' : 'Editar'}
                  </button>
                  <button style={{ ...actionBtn, borderColor: 'var(--accent)', color: 'var(--accent)' }} disabled={sending === row.id} onClick={() => sendNow(row)}>
                    {sending === row.id ? 'Enviando…' : 'Enviar ahora'}
                  </button>
                  <button style={actionBtn} onClick={() => startReschedule(row.id)}>Reprogramar</button>
                  <button style={{ ...actionBtn, color: 'var(--error)' }} onClick={() => queue.cancel(row.id)}>Cancelar</button>
                </div>
              </div>

              {rescheduling === row.id && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} aria-label="Nueva fecha de envío" style={dtInput} />
                  <button className="btn-primary" style={{ padding: '4px 12px' }} onClick={() => confirmReschedule(row.id)}>Confirmar</button>
                  <button style={actionBtn} onClick={() => setRescheduling(null)}>Cancelar</button>
                </div>
              )}

              {editing === row.id && (
                <InlineDraftEditor businessId={row.business_id} onClose={() => setEditing(null)} onSaved={queue.refresh} />
              )}
            </div>
          ))}

          {/* bulk */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 12 }}>
            {confirmAll ? (
              <>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-label)', color: 'var(--warn)' }}>¿Cancelar toda la cola?</span>
                <button style={{ ...actionBtn, color: 'var(--error)' }} onClick={() => { queue.cancelAll(); setConfirmAll(false); }}>Sí, cancelar todo</button>
                <button style={actionBtn} onClick={() => setConfirmAll(false)}>No</button>
              </>
            ) : (
              <button style={actionBtn} onClick={() => setConfirmAll(true)}>Cancelar todo</button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
