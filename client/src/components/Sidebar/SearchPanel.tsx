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
  const [confirming, setConfirming] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchTerm.trim()) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 2000);
    }
    onStart(searchTerm.trim(), language, extractEmails);
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    fontWeight: 500,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    marginBottom: '7px',
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <label style={labelStyle}>Search Term</label>
        <input
          type="text"
          className="input-field"
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          placeholder="e.g. restaurantes, peluquerías…"
        />
        <span style={{
          display: 'block',
          fontFamily: 'var(--font-ui)',
          fontSize: '11px',
          color: confirming ? 'var(--accent)' : 'var(--text-muted)',
          opacity: confirming ? 0.7 : 1,
          marginTop: '6px',
          transition: 'color 0.2s, opacity 0.2s',
        }}>
          {confirming ? 'Buscando todos los negocios…' : 'Dejá vacío para buscar todo tipo de negocio'}
        </span>
      </div>

      <div>
        <label style={labelStyle}>Language</label>
        <select
          className="input-field"
          value={language}
          onChange={e => setLanguage(e.target.value)}
          style={{ cursor: 'pointer' }}
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
        <label htmlFor="extractEmails" style={{
          fontFamily: 'var(--font-ui)',
          fontSize: '13px',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          lineHeight: '1.4',
        }}>
          Extract emails
          <span style={{
            display: 'block',
            fontFamily: 'var(--font-ui)',
            fontSize: '11px',
            color: 'var(--text-muted)',
            marginTop: '2px',
          }}>
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
