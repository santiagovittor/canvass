import type { CSSProperties } from 'react';
import type { SettingFieldView, SettingValue } from '../../lib/api';

interface Props {
  field: SettingFieldView;
  value: SettingValue | undefined;
  onChange: (value: SettingValue) => void;
  error?: string;
  overridden?: boolean;       // source === 'db' → show Reset
  onReset?: () => void;
}

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const labelStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  fontFamily: 'var(--font-ui)',
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
  marginBottom: '7px',
};

const helpStyle: CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-ui)',
  fontSize: '11px',
  color: 'var(--text-muted)',
  marginTop: '6px',
};

// Pure presentation: renders one registry field by its type and emits onChange.
// No fetching, no validation — the server is authoritative; errors arrive as props.
export function SettingField({ field, value, onChange, error, overridden, onReset }: Props) {
  const unit = field.unit ? ` (${field.unit})` : '';

  function control() {
    switch (field.type) {
      case 'number':
        return (
          <input
            type="number"
            className="input-field input-mono"
            value={value === undefined ? '' : String(value)}
            min={field.min}
            max={field.max}
            step={field.max !== undefined && field.max <= 1 ? 0.05 : 1}
            onChange={e => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
          />
        );
      case 'string':
        return (
          <input
            type="text"
            className="input-field"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value)}
          />
        );
      case 'time':
        return (
          <input
            type="time"
            className="input-field input-mono"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value)}
          />
        );
      case 'enum':
        return (
          <select
            className="input-field"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value)}
          >
            {(field.enum ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      case 'boolean':
        return (
          <input
            type="checkbox"
            checked={value === true}
            onChange={e => onChange(e.target.checked)}
            style={{ accentColor: 'var(--accent)', width: '16px', height: '16px' }}
          />
        );
      case 'weekdays': {
        const days = Array.isArray(value) ? value as number[] : [];
        return (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {DAY_ABBR.map((abbr, d) => {
              const on = days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onChange(on ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b))}
                  className={on ? 'btn-primary' : 'btn-secondary'}
                  style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                >
                  {abbr}
                </button>
              );
            })}
          </div>
        );
      }
      case 'signature':
        return (
          <textarea
            className="input-field"
            value={typeof value === 'string' ? value : ''}
            onChange={e => onChange(e.target.value)}
            rows={6}
            style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.5 }}
          />
        );
      case 'secret':
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="input-field input-mono" style={{ color: 'var(--text-muted)', userSelect: 'none' }}>
              {field.secret?.isSet ? `•••• ${field.secret.last4 ?? ''}` : 'not set'}
            </span>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              set via .env, restart to apply
            </span>
          </div>
        );
    }
  }

  return (
    <div style={{ marginBottom: '18px' }}>
      <label style={labelStyle}>
        <span>{field.label}{unit}</span>
        {overridden && onReset && (
          <button
            type="button"
            onClick={onReset}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              fontFamily: 'var(--font-ui)', fontSize: '10px', letterSpacing: '0.05em',
              textTransform: 'uppercase', color: 'var(--accent)',
            }}
          >
            Reset
          </button>
        )}
      </label>
      {control()}
      {error && (
        <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--error)', marginTop: '6px' }}>
          {error}
        </span>
      )}
      {field.help && !error && <span style={helpStyle}>{field.help}</span>}
    </div>
  );
}
