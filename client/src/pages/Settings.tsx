import { useState, useEffect, useMemo, type CSSProperties } from 'react';
import { useSettings } from '../hooks/useSettings';
import { SettingField } from '../components/Settings/SettingField';
import type { SettingValue, SettingsView } from '../lib/api';

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const sectionLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '13px',
  fontWeight: 600,
  letterSpacing: '0.04em',
  color: 'var(--text-primary)',
  paddingBottom: '10px',
  marginBottom: '20px',
  borderBottom: '1px solid var(--hairline)',
};

// Maps every non-secret field key → its server value, for dirty comparison.
function originalValues(view: SettingsView): Record<string, SettingValue> {
  const o: Record<string, SettingValue> = {};
  for (const g of view.groups) for (const f of g.fields) {
    if (!f.isSecret && f.value !== undefined) o[f.key] = f.value;
  }
  return o;
}

export function Settings() {
  const { view, loading, error, save, reset } = useSettings();
  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savingGroup, setSavingGroup] = useState<string | null>(null);

  const original = useMemo(() => (view ? originalValues(view) : {}), [view]);

  // Reseed the draft whenever the canonical view changes (initial load + post-save reload).
  useEffect(() => {
    if (view) { setDraft(originalValues(view)); setErrors({}); }
  }, [view]);

  async function saveGroup(groupName: string, fields: SettingsView['groups'][number]['fields']) {
    const patch: Record<string, SettingValue> = {};
    for (const f of fields) {
      if (f.isSecret) continue;
      if (!eq(draft[f.key], original[f.key])) patch[f.key] = draft[f.key];
    }
    if (Object.keys(patch).length === 0) return;
    setSavingGroup(groupName);
    const res = await save(patch);
    setSavingGroup(null);
    if (!res.ok && res.field) setErrors(e => ({ ...e, [res.field!]: res.error ?? 'invalid value' }));
    else if (!res.ok) setErrors(e => ({ ...e, [groupName]: res.error ?? 'save failed' }));
  }

  if (loading) {
    return <div style={{ padding: '40px', display: 'flex', alignItems: 'center', gap: '12px', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-muted)' }}>
      <span style={{ width: '40px', height: '3px', borderRadius: '2px', background: 'var(--accent)', animation: 'pulse 1.4s ease-in-out infinite' }} />
      loading config…
    </div>;
  }
  if (error || !view) {
    return <div style={{ padding: '40px', fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--error)' }}>
      {error ?? 'no settings'}
    </div>;
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ maxWidth: '720px', margin: '0 auto', padding: '32px 28px 80px' }}>
        <h1 style={{ fontFamily: 'var(--font-ui)', fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Settings
        </h1>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '32px' }}>
          Live config for the outreach pipeline. Changes take effect on the next governor tick / compose — no restart.
        </p>

        {view.groups.map(group => {
          const editable = group.fields.filter(f => !f.isSecret);
          const dirty = editable.some(f => !eq(draft[f.key], original[f.key]));
          return (
            <section key={group.name} style={{ marginBottom: '40px' }}>
              <div style={sectionLabelStyle}>{group.name}</div>
              {group.fields.map(f => (
                <SettingField
                  key={f.key}
                  field={f}
                  value={f.isSecret ? undefined : draft[f.key]}
                  onChange={v => { setDraft(d => ({ ...d, [f.key]: v })); setErrors(e => { const { [f.key]: _drop, ...rest } = e; return rest; }); }}
                  error={errors[f.key]}
                  overridden={f.source === 'db'}
                  onReset={() => void reset(f.key)}
                />
              ))}
              {errors[group.name] && (
                <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--error)', marginBottom: '12px' }}>
                  {errors[group.name]}
                </span>
              )}
              {editable.length > 0 && (
                <button
                  className="btn-primary"
                  disabled={!dirty || savingGroup === group.name}
                  onClick={() => saveGroup(group.name, group.fields)}
                >
                  {savingGroup === group.name ? 'Saving…' : 'Save'}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
