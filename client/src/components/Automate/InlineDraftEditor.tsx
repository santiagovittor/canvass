import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { loadDraft, saveDraft } from '../../lib/outreachApi';

interface InlineDraftEditorProps {
  businessId: string;
  onClose: () => void;
  onSaved?: () => void;
}

// In-row draft editor for the Send lane. Loads the live draft, lets the operator
// tweak subject/body, and persists via saveDraft (single source of truth — the
// send worker re-reads this at fire time).
const field: CSSProperties = {
  width: '100%', background: 'var(--bg-panel)', border: '1px solid var(--border-strong)',
  borderRadius: 8, padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-body)',
  color: 'var(--text-primary)', outline: 'none',
};

export function InlineDraftEditor({ businessId, onClose, onSaved }: InlineDraftEditorProps) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isAiDraft, setIsAiDraft] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    loadDraft(businessId)
      .then(d => { if (!alive || !d) return; setSubject(d.subject); setBody(d.body); setIsAiDraft(d.isAiDraft); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [businessId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Operator edits make it a human draft, not AI.
      await saveDraft(businessId, subject, body, false);
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 12 }}>
        <div className="an-skeleton" style={{ minHeight: 0, height: 16, width: '40%', borderRadius: 4, marginBottom: 10, background: 'var(--bg-elevated)' }} />
        <div className="an-skeleton" style={{ minHeight: 0, height: 80, borderRadius: 6, background: 'var(--bg-elevated)' }} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 0' }}>
      <input
        value={subject}
        onChange={e => setSubject(e.target.value)}
        placeholder="Asunto"
        aria-label="Asunto del email"
        style={field}
      />
      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Cuerpo del email"
        aria-label="Cuerpo del email"
        rows={8}
        style={{ ...field, resize: 'vertical', lineHeight: 'var(--leading-body)' }}
      />
      {!isAiDraft && (
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' }}>
          Borrador editado manualmente.
        </span>
      )}
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        <button className="btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </div>
  );
}
