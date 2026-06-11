import { useState } from 'react';
import { exportToSheetsWithColumns } from '../../lib/api';
import type { BusinessQueryFilters } from '../../types';

const COLUMNS = [
  { key: 'name',        label: 'Name',         defaultChecked: true  },
  { key: 'email',       label: 'Email',        defaultChecked: true  },
  { key: 'phone',       label: 'Phone',        defaultChecked: true  },
  { key: 'category',    label: 'Category',     defaultChecked: true  },
  { key: 'address',     label: 'Address',      defaultChecked: true  },
  { key: 'rating',      label: 'Rating',       defaultChecked: true  },
  { key: 'website',     label: 'Website',      defaultChecked: true  },
  { key: 'instagram',   label: 'Instagram',    defaultChecked: true  },
  { key: 'facebook',    label: 'Facebook',     defaultChecked: true  },
  { key: 'linkedin',    label: 'LinkedIn',     defaultChecked: false },
  { key: 'twitter',     label: 'Twitter',      defaultChecked: false },
  { key: 'tiktok',      label: 'TikTok',       defaultChecked: false },
  { key: 'youtube',     label: 'YouTube',      defaultChecked: false },
  { key: 'reviewCount', label: 'Review Count', defaultChecked: false },
  { key: 'placeId',     label: 'Place ID',     defaultChecked: false },
  { key: 'scrapedAt',   label: 'Scraped At',   defaultChecked: false },
];

const DEFAULT_SELECTED = new Set(COLUMNS.filter(c => c.defaultChecked).map(c => c.key));

interface ExportModalProps {
  onClose: () => void;
  filters: BusinessQueryFilters;
  total: number;
}

type Phase =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'success'; url: string; tabName: string; rowCount: number }
  | { phase: 'error'; message: string };

export function ExportModal({ onClose, filters, total }: ExportModalProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(DEFAULT_SELECTED));
  const [state, setState] = useState<Phase>({ phase: 'idle' });

  const isLoading = state.phase === 'loading';

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleExport = async () => {
    setState({ phase: 'loading' });
    try {
      const columns = COLUMNS.filter(c => selected.has(c.key)).map(c => c.key);
      const result = await exportToSheetsWithColumns(filters, columns, total);
      setState({ phase: 'success', ...result });
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={isLoading ? undefined : onClose}
    >
      <div
        style={{ background: 'var(--bg-panel)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '12px', padding: '24px', width: '400px', maxHeight: '80vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}
        onClick={e => e.stopPropagation()}
      >
        {state.phase === 'success' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '8px 0' }}>
            <span style={{ fontSize: '48px', color: 'var(--success)', lineHeight: '1' }}>✓</span>
            <div style={{ textAlign: 'center' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600, color: 'var(--text-primary)' }}>
                {state.rowCount.toLocaleString()}
              </span>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: '14px', color: 'var(--text-secondary)', marginLeft: '6px' }}>
                businesses exported
              </span>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', wordBreak: 'break-all' }}>
              {state.tabName}
            </span>
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'block', width: '100%', padding: '10px 16px', background: 'var(--accent)', color: 'var(--accent-ink)', borderRadius: '8px', fontFamily: 'var(--font-ui)', fontSize: '14px', fontWeight: 600, textAlign: 'center', textDecoration: 'none', marginTop: '4px', boxSizing: 'border-box' }}
              onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 0 20px var(--accent-glow)')}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              Open Sheet →
            </a>
            <button
              onClick={() => setState({ phase: 'idle' })}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-muted)', padding: '4px' }}
            >
              Export another
            </button>
          </div>
        ) : state.phase === 'error' ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px', padding: '8px 0' }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '14px', color: 'var(--error)', textAlign: 'center' }}>
              Export failed — check server logs
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
              {state.message}
            </span>
            <button
              onClick={() => setState({ phase: 'idle' })}
              style={{ padding: '8px 20px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '8px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)' }}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
                Export to Google Sheets
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{total.toLocaleString()}</span>
                {' '}businesses · select columns
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {COLUMNS.map(col => (
                <label key={col.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: isLoading ? 'default' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(col.key)}
                    onChange={() => toggle(col.key)}
                    disabled={isLoading}
                    style={{ accentColor: 'var(--accent)', cursor: 'pointer', width: '13px', height: '13px', flexShrink: 0 }}
                  />
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {col.label}
                  </span>
                </label>
              ))}
            </div>

            <button
              onClick={isLoading ? undefined : handleExport}
              disabled={isLoading || selected.size === 0}
              style={{
                padding: '10px 16px',
                background: 'var(--accent)',
                color: 'var(--accent-ink)',
                border: 'none',
                borderRadius: '8px',
                cursor: (isLoading || selected.size === 0) ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-ui)',
                fontSize: '14px',
                fontWeight: 600,
                opacity: (isLoading || selected.size === 0) ? 0.4 : 1,
              }}
              onMouseEnter={e => { if (!isLoading && selected.size > 0) e.currentTarget.style.boxShadow = '0 0 20px var(--accent-glow)'; }}
              onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}
            >
              {isLoading ? 'Creating sheet…' : 'Export to Google Sheets'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
