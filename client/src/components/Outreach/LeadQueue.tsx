import { useState, useEffect, useRef, useCallback } from 'react';
import type { OutreachLead, OutreachLeadFilters } from '../../lib/outreachApi';
import { getOutreachLeads, getOutreachCategories, countryFlag } from '../../lib/outreachApi';

interface LeadQueueProps {
  activeLead: OutreachLead | null;
  onSelect: (lead: OutreachLead) => void;
  onLeadsChange: (leads: OutreachLead[]) => void;
  refreshTrigger?: number;
}

const PAGE_SIZE = 25;

const PILL_BASE: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 20,
  padding: '2px 8px',
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
  color: 'var(--text-muted)',
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
};

const PILL_ACTIVE: React.CSSProperties = {
  ...PILL_BASE,
  background: 'var(--accent)',
  border: '1px solid var(--accent)',
  color: 'var(--accent-ink)',
  fontWeight: 500,
};

export function LeadQueue({ activeLead, onSelect, onLeadsChange, refreshTrigger }: LeadQueueProps) {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [country, setCountry] = useState('');
  const [hasWebsite, setHasWebsite] = useState<boolean | undefined>(undefined);
  const [category, setCategory] = useState('');
  const [validEmailOnly, setValidEmailOnly] = useState(true);
  const [page, setPage] = useState(1);
  const [leads, setLeads] = useState<OutreachLead[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [fetchKey, setFetchKey] = useState(0);

  const onLeadsChangeRef = useRef(onLeadsChange);
  useEffect(() => { onLeadsChangeRef.current = onLeadsChange; });

  // Debounce search → reset page to 1
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // refreshTrigger: reset to page 1, force re-fetch via fetchKey
  useEffect(() => {
    if (!refreshTrigger) return;
    setPage(1);
    setFetchKey(k => k + 1);
  }, [refreshTrigger]);

  // Load categories on mount
  useEffect(() => {
    getOutreachCategories().then(setCategories).catch(() => {});
  }, []);

  // Main fetch
  useEffect(() => {
    let cancelled = false;
    const filters: OutreachLeadFilters = {
      search: debouncedSearch || undefined,
      country: country || undefined,
      hasWebsite,
      category: category || undefined,
      validEmail: validEmailOnly ? true : undefined,
    };
    getOutreachLeads(page, filters)
      .then(result => {
        if (!cancelled) {
          setLeads(result.rows);
          setTotal(result.total);
          onLeadsChangeRef.current(result.rows);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [page, fetchKey, debouncedSearch, country, hasWebsite, category, validEmailOnly]);

  const handleCountry = useCallback((val: string) => {
    const next = country === val ? '' : val;
    if (next !== country) { setCountry(next); setPage(1); }
  }, [country]);

  const handleHasWebsite = useCallback((val: boolean | undefined) => {
    const next = hasWebsite === val ? undefined : val;
    if (next !== hasWebsite) { setHasWebsite(next); setPage(1); }
  }, [hasWebsite]);

  const handleCategory = useCallback((val: string) => {
    if (val !== category) { setCategory(val); setPage(1); }
  }, [category]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const activeFilterCount = [
    !!debouncedSearch,
    !!country,
    hasWebsite !== undefined,
    !!category,
  ].filter(Boolean).length;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <span style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--text-secondary)',
        }}>
          Lead Queue{activeFilterCount > 0 ? ` · ${activeFilterCount} filtro${activeFilterCount !== 1 ? 's' : ''}` : ''}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          {total}
        </span>
      </div>

      {/* Filter bar */}
      <div style={{
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--bg-elevated)',
      }}>
        {/* Row 1: search + category */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            placeholder="Buscar negocio…"
            aria-label="Search leads"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 8px',
              fontFamily: 'var(--font-ui)',
              fontSize: 12,
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          <select
            aria-label="Filter by category"
            value={category}
            onChange={e => handleCategory(e.target.value)}
            style={{
              background: 'var(--bg-panel)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 4px',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              color: category ? 'var(--text-secondary)' : 'var(--text-muted)',
              cursor: 'pointer',
              maxWidth: 100,
            }}
          >
            <option value="">Todas</option>
            {categories.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>

        {/* Row 2: email filter pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            style={validEmailOnly ? PILL_ACTIVE : PILL_BASE}
            onClick={() => { setValidEmailOnly(true); setPage(1); }}
          >
            Has email
          </button>
          <button
            style={!validEmailOnly ? PILL_ACTIVE : PILL_BASE}
            onClick={() => { setValidEmailOnly(false); setPage(1); }}
          >
            All leads
          </button>
        </div>

        {/* Row 3: country pills + website pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' as const }}>
          <button aria-label="All countries" style={country === '' ? PILL_ACTIVE : PILL_BASE} onClick={() => handleCountry('')}>Todos</button>
          <button aria-label="Argentina" style={country === 'Argentina' ? PILL_ACTIVE : PILL_BASE} onClick={() => handleCountry('Argentina')}>🇦🇷 AR</button>
          <button aria-label="United States" style={country === 'United States' ? PILL_ACTIVE : PILL_BASE} onClick={() => handleCountry('United States')}>🇺🇸 US</button>
          <span aria-hidden="true" style={{ width: 1, height: 12, background: 'var(--border-strong)', margin: '0 2px', flexShrink: 0 }} />
          <button aria-label="All websites" style={hasWebsite === undefined ? PILL_ACTIVE : PILL_BASE} onClick={() => handleHasWebsite(undefined)}>Todos</button>
          <button aria-label="No website" style={hasWebsite === false ? PILL_ACTIVE : PILL_BASE} onClick={() => handleHasWebsite(false)}>Sin sitio</button>
          <button aria-label="Has website" style={hasWebsite === true ? PILL_ACTIVE : PILL_BASE} onClick={() => handleHasWebsite(true)}>Con sitio</button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' as const }}>
        {leads.length === 0 && (
          <div style={{
            padding: 24,
            textAlign: 'center' as const,
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            color: 'var(--text-muted)',
          }}>
            No leads in queue
          </div>
        )}
        {leads.map(lead => {
          const isActive = activeLead?.id === lead.id;
          const invalid = !lead.valid_email;
          return (
            <div
              key={lead.id}
              role="button"
              tabIndex={invalid ? -1 : 0}
              aria-pressed={isActive}
              aria-disabled={invalid}
              aria-label={`${lead.name}${lead.first_email ? `, ${lead.first_email}` : ''}`}
              onClick={() => { if (!invalid) onSelect(lead); }}
              onKeyDown={e => { if (!invalid && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(lead); } }}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px 10px 13px',
                borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                background: isActive ? 'var(--bg-elevated)' : 'transparent',
                cursor: invalid ? 'not-allowed' : 'pointer',
                opacity: invalid ? 0.45 : 1,
                transition: 'background 120ms',
                borderBottom: '1px solid var(--border)',
              }}
              onMouseEnter={e => { if (!invalid && !isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
            >
              {/* Left: name + category + neighbourhood */}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                  whiteSpace: 'nowrap' as const,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {lead.name}
                </div>
                <div style={{
                  marginTop: 2,
                  whiteSpace: 'nowrap' as const,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {lead.valid_email && lead.first_email
                    ? (
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                      }}>
                        {lead.first_email}
                      </span>
                    )
                    : (
                      <span style={{
                        fontFamily: 'var(--font-ui)',
                        fontSize: 10,
                        fontWeight: 500,
                        color: 'var(--error)',
                        background: 'rgba(255,77,109,0.12)',
                        padding: '1px 5px',
                        borderRadius: 3,
                      }}>
                        invalid email
                      </span>
                    )
                  }
                </div>
                {lead.category && (
                  <div style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 11,
                    color: invalid ? 'var(--text-muted)' : 'var(--accent)',
                    marginTop: 2,
                    whiteSpace: 'nowrap' as const,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {lead.category}
                  </div>
                )}
                {lead.locNeighbourhood && (
                  <div style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    marginTop: 1,
                    whiteSpace: 'nowrap' as const,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {lead.locNeighbourhood}
                  </div>
                )}
              </div>

              {/* Right: flag + draft indicator + email indicator */}
              <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: 4, marginLeft: 8, flexShrink: 0 }}>
                {lead.locCountry && (
                  <span style={{ fontSize: 14, lineHeight: 1 }}>
                    {countryFlag(lead.locCountry)}
                  </span>
                )}
                {lead.has_draft && (
                  <span style={{ fontSize: 11, color: 'var(--accent)', lineHeight: 1 }}>✏</span>
                )}
                {invalid ? (
                  <span style={{ fontSize: 12, color: 'var(--warn)' }} title="Invalid email">⚠</span>
                ) : (
                  <div style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: 'var(--success)',
                    flexShrink: 0,
                  }} />
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: '10px 16px',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <button
            aria-label="Previous page"
            className="btn-secondary"
            style={{ padding: '5px 10px', fontSize: 12 }}
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            ←
          </button>
          <span aria-live="polite" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)' }}>
            {page} / {totalPages}
          </span>
          <button
            aria-label="Next page"
            className="btn-secondary"
            style={{ padding: '5px 10px', fontSize: 12 }}
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
