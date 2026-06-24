import { useState, useMemo } from 'react';
import { SocialIcon } from '../ui/SocialIcon';
import { formatRating, formatCount } from '../../lib/format';
import type { Business } from '../../types';

interface ResultsTableProps {
  results: Business[];
  filter: string;
}

type SortKey = 'name' | 'rating' | 'reviewCount' | 'category';
type SortDir = 'asc' | 'desc';

const thStyle: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  padding: '10px 12px',
  textAlign: 'left',
  borderBottom: '1px solid var(--border)',
  cursor: 'pointer',
  userSelect: 'none',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '13px',
  color: 'var(--text-primary)',
  padding: '10px 12px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
};

export function ResultsTable({ results, filter }: ResultsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedHours, setExpandedHours] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!filter) return results;
    const q = filter.toLowerCase();
    return results.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.address ?? '').toLowerCase().includes(q) ||
      (r.category ?? '').toLowerCase().includes(q),
    );
  }, [results, filter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: string | number | null | undefined;
      let bv: string | number | null | undefined;
      if (sortKey === 'name') { av = a.name; bv = b.name; }
      else if (sortKey === 'rating') { av = a.rating ?? -1; bv = b.rating ?? -1; }
      else if (sortKey === 'reviewCount') { av = a.reviewCount ?? -1; bv = b.reviewCount ?? -1; }
      else { av = a.category ?? ''; bv = b.category ?? ''; }

      const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortIndicator = (key: SortKey) =>
    sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  if (results.length === 0) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: '14px' }}>
        No results yet
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, minHeight: 0 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle} onClick={() => toggleSort('name')}>Name{sortIndicator('name')}</th>
            <th style={thStyle}>Phone</th>
            <th style={thStyle}>Website</th>
            <th style={thStyle}>Social</th>
            <th style={thStyle}>Hours</th>
            <th style={{ ...thStyle, fontFamily: 'var(--font-mono)' }} onClick={() => toggleSort('rating')}>Rating{sortIndicator('rating')}</th>
            <th style={thStyle} onClick={() => toggleSort('category')}>Category{sortIndicator('category')}</th>
            <th style={thStyle}>Address</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const isNew = i === 0;
            const hoursExpanded = expandedHours.has(r.id);
            let parsedHours: string[] = [];
            if (r.hoursJson) {
              try { parsedHours = JSON.parse(r.hoursJson); } catch {}
            }

            return (
              <tr
                key={r.id}
                className={isNew ? 'row-new' : undefined}
                style={{ background: 'transparent' }}
                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)')}
                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
              >
                <td style={tdStyle}>
                  <div style={{ fontWeight: 500 }}>{r.name}</div>
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                  {r.phone ?? '—'}
                </td>
                <td style={tdStyle}>
                  {r.website
                    ? <a href={r.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: '12px', wordBreak: 'break-all' }}>link</a>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <SocialIcon platform="instagram" href={r.instagram ?? undefined} />
                    <SocialIcon platform="facebook" href={r.facebook ?? undefined} />
                    <SocialIcon platform="twitter" href={r.twitter ?? undefined} />
                    <SocialIcon platform="tiktok" href={r.tiktok ?? undefined} />
                  </div>
                </td>
                <td style={tdStyle}>
                  {parsedHours.length > 0 ? (
                    <button
                      onClick={() => setExpandedHours(prev => {
                        const next = new Set(prev);
                        next.has(r.id) ? next.delete(r.id) : next.add(r.id);
                        return next;
                      })}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '11px', padding: 0 }}
                    >
                      {hoursExpanded ? '▲ hide' : '▼ show'}
                    </button>
                  ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  {hoursExpanded && parsedHours.length > 0 && (
                    <div style={{ marginTop: '4px', fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      {parsedHours.map((h, j) => <div key={j}>{h}</div>)}
                    </div>
                  )}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', textAlign: 'center', whiteSpace: 'nowrap' }}>
                  {formatRating(r.rating)}
                </td>
                <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{r.category ?? '—'}</td>
                <td style={{ ...tdStyle, fontSize: '12px', color: 'var(--text-secondary)', maxWidth: '140px' }}>{r.address ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
