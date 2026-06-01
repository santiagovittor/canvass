import { useState, useEffect, useRef } from 'react';
import { SocialIcon } from '../ui/SocialIcon';
import { Button } from '../ui/Button';
import { formatRating } from '../../lib/format';
import type { ExplorerBusiness } from '../../types';

interface BusinessTableProps {
  rows: ExplorerBusiness[];
  total: number;
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onOutreachChange: (id: string, status: string | null) => void;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  onSort: (col: string) => void;
  onClearFilters?: () => void;
}

type OutreachStatus = 'contacted' | 'replied' | 'converted' | 'skip' | null;

const STATUS_OPTIONS: { value: OutreachStatus; label: string }[] = [
  { value: null,        label: 'Clear' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'replied',   label: 'Replied' },
  { value: 'converted', label: 'Converted' },
  { value: 'skip',      label: 'Skip' },
];

function pillStyle(status: string | null | undefined): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    fontFamily: 'var(--font-ui)',
    fontSize: '11px',
    fontWeight: 500,
    padding: '2px 7px',
    borderRadius: '20px',
    border: '1px solid',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
  switch (status) {
    case 'contacted': return { ...base, color: 'var(--accent)',   borderColor: 'var(--accent)' };
    case 'replied':   return { ...base, color: 'var(--success)', borderColor: 'var(--success)' };
    case 'converted': return { ...base, color: 'var(--success)', borderColor: 'var(--success)' };
    case 'skip':      return { ...base, color: 'var(--text-muted)', borderColor: 'var(--border-strong)' };
    default:          return { ...base, color: 'var(--text-muted)', borderColor: 'transparent' };
  }
}

function pillLabel(status: string | null | undefined): string {
  switch (status) {
    case 'contacted': return 'Contacted';
    case 'replied':   return 'Replied';
    case 'converted': return 'Converted ★';
    case 'skip':      return 'Skip';
    default:          return '—';
  }
}

const TH: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  padding: '9px 12px',
  textAlign: 'left',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
  background: 'var(--bg-panel)',
  zIndex: 1,
};

const TD: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: '13px',
  color: 'var(--text-primary)',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const PAGE_SIZE_OPTIONS = [
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 9999, label: 'All (max 500)' },
];

const SORTABLE: Record<string, string> = {
  name: 'Name',
  category: 'Category',
  rating: 'Rating',
  reviewCount: 'Reviews',
  scraped_at: 'Scraped',
};

export function BusinessTable({ rows, total, loading, page, pageSize, onPageChange, onPageSizeChange, onOutreachChange, orderBy, orderDir, onSort, onClearFilters }: BusinessTableProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pickerOpenId, setPickerOpenId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!pickerOpenId) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpenId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpenId]);

  const handleCopy = (email: string, id: string) => {
    navigator.clipboard.writeText(email).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1200);
    }).catch(() => {});
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
        {loading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          <div style={{ padding: '80px 20px', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: '14px', color: 'var(--text-muted)', marginBottom: '12px' }}>
              No businesses match your filters
            </div>
            {onClearFilters && (
              <button
                onClick={onClearFilters}
                style={{ background: 'none', border: '1px solid var(--border-strong)', borderRadius: '8px', padding: '6px 16px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-secondary)' }}
              >
                Clear all filters
              </button>
            )}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ minWidth: '180px' }} />
              <col style={{ width: '130px' }} />
              <col style={{ width: '130px' }} />
              <col style={{ width: '170px' }} />
              <col style={{ width: '52px' }} />
              <col style={{ width: '68px' }} />
              <col style={{ width: '58px' }} />
              <col style={{ width: '68px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '96px' }} />
            </colgroup>
            <thead>
              <tr>
                {(['name', 'category'] as const).map(col => (
                  <th key={col} style={{ ...TH, cursor: 'pointer', userSelect: 'none' }} onClick={() => onSort(col)}>
                    {SORTABLE[col]}{orderBy === col ? (orderDir === 'asc' ? ' ↑' : ' ↓') : <span style={{ opacity: 0.3 }}> ↕</span>}
                  </th>
                ))}
                <th style={{ ...TH, fontFamily: 'var(--font-mono)' }}>Phone</th>
                <th style={{ ...TH, fontFamily: 'var(--font-mono)' }}>Email</th>
                <th style={TH}>Web</th>
                <th style={TH}>Social</th>
                <th style={{ ...TH, fontFamily: 'var(--font-mono)', textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => onSort('rating')}>
                  {SORTABLE['rating']}{orderBy === 'rating' ? (orderDir === 'asc' ? ' ↑' : ' ↓') : <span style={{ opacity: 0.3 }}> ↕</span>}
                </th>
                <th style={{ ...TH, fontFamily: 'var(--font-mono)', textAlign: 'right', cursor: 'pointer', userSelect: 'none' }} onClick={() => onSort('reviewCount')}>
                  {SORTABLE['reviewCount']}{orderBy === 'reviewCount' ? (orderDir === 'asc' ? ' ↑' : ' ↓') : <span style={{ opacity: 0.3 }}> ↕</span>}
                </th>
                <th style={{ ...TH, fontFamily: 'var(--font-mono)', cursor: 'pointer', userSelect: 'none' }} onClick={() => onSort('scraped_at')}>
                  {SORTABLE['scraped_at']}{orderBy === 'scraped_at' ? (orderDir === 'asc' ? ' ↑' : ' ↓') : <span style={{ opacity: 0.3 }}> ↕</span>}
                </th>
                <th style={TH}>Outreach</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  style={{ background: 'transparent' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; setHoveredId(r.id); }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; setHoveredId(prev => prev === r.id ? null : prev); }}
                >
                  <td style={{ ...TD, fontWeight: 500 }} title={r.address ? `${r.name}\n${r.address}` : r.name}>
                    {r.name}
                    {r.address && (
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 400, color: 'var(--text-muted)', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '220px', marginTop: '2px' }}>
                        {r.address.length > 60 ? r.address.slice(0, 60) + '…' : r.address}
                      </div>
                    )}
                  </td>
                  <td style={{ ...TD, color: 'var(--text-secondary)' }} title={r.category ?? ''}>{r.category ?? '—'}</td>
                  <td style={{ ...TD, fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                    {r.phone ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td
                    style={{
                      ...TD,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '11px',
                      background: copiedId === r.id ? 'var(--accent-dim)' : undefined,
                      transition: 'background 0.3s',
                    }}
                    title={r.email ?? ''}
                  >
                    {r.email ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{r.email}</span>
                        {hoveredId === r.id && (
                          <button
                            onClick={() => handleCopy(r.email!, r.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '0 2px',
                              color: copiedId === r.id ? 'var(--accent)' : 'var(--text-muted)',
                              fontSize: '11px',
                              flexShrink: 0,
                            }}
                            title="Copy email"
                          >
                            {copiedId === r.id ? '✓' : '⎘'}
                          </button>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={TD}>
                    {r.website
                      ? <a href={r.website} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', fontSize: '12px' }}>link</a>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={TD}>
                    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
                      <SocialIcon platform="instagram" href={r.instagram ?? undefined} />
                      <SocialIcon platform="facebook" href={r.facebook ?? undefined} />
                    </div>
                  </td>
                  <td style={{ ...TD, fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                    {formatRating(r.rating)}
                  </td>
                  <td style={{ ...TD, fontFamily: 'var(--font-mono)', textAlign: 'right' }}>
                    {r.reviewCount != null
                      ? r.reviewCount.toLocaleString()
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                  </td>
                  <td style={{ ...TD, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)' }}>
                    {r.scrapedAt.slice(0, 10)}
                  </td>
                  <td style={{ ...TD, position: 'relative', overflow: 'visible' }}>
                    <div ref={pickerOpenId === r.id ? pickerRef : null}>
                      <span
                        style={pillStyle(r.outreachStatus)}
                        onClick={() => setPickerOpenId(prev => prev === r.id ? null : r.id)}
                      >
                        {pillLabel(r.outreachStatus)}
                      </span>
                      {pickerOpenId === r.id && (
                        <div style={{
                          position: 'absolute',
                          top: '100%',
                          right: 0,
                          zIndex: 10,
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                          padding: '4px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                          minWidth: '110px',
                        }}>
                          {STATUS_OPTIONS.map(opt => (
                            <button
                              key={String(opt.value)}
                              onClick={() => {
                                onOutreachChange(r.id, opt.value);
                                setPickerOpenId(null);
                              }}
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '5px 8px',
                                textAlign: 'left',
                                borderRadius: '5px',
                                fontFamily: 'var(--font-ui)',
                                fontSize: '12px',
                                color: opt.value === null ? 'var(--text-muted)' : opt.value === 'skip' ? 'var(--text-muted)' : opt.value === 'contacted' ? 'var(--accent)' : 'var(--success)',
                              }}
                              onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)')}
                              onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'none')}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination footer */}
      <div style={{
        borderTop: '1px solid var(--border)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flexShrink: 0,
        background: 'var(--bg-panel)',
      }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-muted)', flex: 1 }}>
          {total === 0 ? '—' : `${start}–${end} of ${total.toLocaleString()}`}
        </span>
        <select
          value={pageSize}
          onChange={e => onPageSizeChange(Number(e.target.value))}
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            padding: '3px 6px',
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          {PAGE_SIZE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <Button
          variant="secondary"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1 || loading}
          style={{ fontSize: '13px', padding: '4px 12px' }}
        >
          ←
        </Button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)', minWidth: '60px', textAlign: 'center' }}>
          {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || loading}
          style={{ fontSize: '13px', padding: '4px 12px' }}
        >
          →
        </Button>
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <div>
      {Array.from({ length: 14 }).map((_, i) => (
        <div
          key={i}
          style={{ display: 'flex', gap: '10px', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}
        >
          <div style={{ flex: 3, height: '13px', borderRadius: '3px', background: 'var(--bg-elevated)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 50}ms` }} />
          <div style={{ flex: 2, height: '13px', borderRadius: '3px', background: 'var(--bg-elevated)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 50 + 70}ms` }} />
          <div style={{ flex: 2, height: '13px', borderRadius: '3px', background: 'var(--bg-elevated)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 50 + 140}ms` }} />
          <div style={{ flex: 1, height: '13px', borderRadius: '3px', background: 'var(--bg-elevated)', animation: 'pulse 1.4s ease-in-out infinite', animationDelay: `${i * 50 + 210}ms` }} />
        </div>
      ))}
    </div>
  );
}
