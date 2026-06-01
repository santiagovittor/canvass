import { useState } from 'react';
import { Button } from '../ui/Button';

interface SearchPanelProps {
  disabled: boolean;
  isDanger: boolean;
  onStart: (searchTerm: string, language: string, extractEmails: boolean) => void;
}

export function SearchPanel({ disabled, isDanger, onStart }: SearchPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [language, setLanguage] = useState('es');
  const [extractEmails, setExtractEmails] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onStart(searchTerm.trim(), language, extractEmails);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontFamily: 'var(--font-ui)',
    fontSize: '14px',
    color: 'var(--text-primary)',
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '8px',
  };

  const hintStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <label style={labelStyle}>Search Term</label>
        <input
          type="text"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          placeholder="e.g. restaurantes, peluquerías…"
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = 'var(--border-strong)')}
          onBlur={e => (e.target.style.borderColor = 'var(--border)')}
        />
        <span style={{ ...hintStyle, marginTop: '6px' }}>
          Dejá vacío para buscar todo tipo de negocio
        </span>
      </div>

      <div>
        <label style={labelStyle}>Language</label>
        <select
          value={language}
          onChange={e => setLanguage(e.target.value)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="es">Español</option>
          <option value="en">English</option>
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <input
          type="checkbox"
          id="extractEmails"
          checked={extractEmails}
          onChange={e => setExtractEmails(e.target.checked)}
          style={{ marginTop: '2px', accentColor: 'var(--accent)', cursor: 'pointer' }}
        />
        <label htmlFor="extractEmails" style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer', lineHeight: '1.4' }}>
          Extract emails
          <span style={{ ...hintStyle, marginTop: '2px' }}>
            Slower (~2×). Recommended off.
          </span>
        </label>
      </div>

      <Button
        type="submit"
        fullWidth
        disabled={disabled || isDanger}
      >
        Start Scrape
      </Button>
    </form>
  );
}
