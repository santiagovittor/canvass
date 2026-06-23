import { useState, useEffect, useRef, useCallback } from 'react';
import type { OutreachLead, FollowUpLead, RepliedLead, OutreachLeadFilters } from '../../lib/outreachApi';
import { getOutreachLeads, getNoSiteLeads, getFollowUpLeads, getRepliedLeads, getOutreachCategories, countryFlag } from '../../lib/outreachApi';

export type QueueMode = 'new' | 'followup' | 'replied' | 'no-site';

interface LeadQueueProps {
  activeLead: OutreachLead | null;
  onSelect: (lead: OutreachLead) => void;
  onLeadsChange: (leads: OutreachLead[]) => void;
  refreshTrigger?: number;
  mode: QueueMode;
  onModeChange: (mode: QueueMode) => void;
  onMarkReplied: (lead: OutreachLead) => void;
  onReclassify: (lead: RepliedLead, to: 'auto' | 'real') => void;
  style?: React.CSSProperties;
}

const PAGE_SIZE = 25;
const DAYS_STORAGE_KEY = 'outreach.followUpDays';

const relTimeFmt = new Intl.RelativeTimeFormat('es', { numeric: 'always' });

function daysAgo(utcMinus3Iso: string): number {
  // last_sent_at is a UTC-3 shifted ISO string — shift "now" the same way
  return Math.max(0, Math.floor((Date.now() - 3 * 60 * 60 * 1000 - new Date(utcMinus3Iso).getTime()) / 86_400_000));
}

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

export function LeadQueue({ activeLead, onSelect, onLeadsChange, refreshTrigger, mode, onModeChange, onMarkReplied, onReclassify, style }: LeadQueueProps) {
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [country, setCountry] = useState('');
  const [hasWebsite, setHasWebsite] = useState<boolean | undefined>(undefined);
  const [category, setCategory] = useState('');
  const [validEmailOnly, setValidEmailOnly] = useState(true);
  const [followUpDays, setFollowUpDays] = useState(() => {
    const stored = parseInt(localStorage.getItem(DAYS_STORAGE_KEY) ?? '', 10);
    return Number.isFinite(stored) && stored >= 1 ? stored : 4;
  });
  const [page, setPage] = useState(1);
  const [leads, setLeads] = useState<OutreachLead[]>([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [fetchKey, setFetchKey] = useState(0);

  // Reset rows on mode switch — stale 'new'-mode rows lack last_sent_at and
  // crash Intl.RelativeTimeFormat in the follow-up renderer. The setState
  // schedules a re-render, but React still finishes THIS render pass with the
  // stale rows, so the render below must use displayLeads, never leads.
  const [prevMode, setPrevMode] = useState(mode);
  if (mode !== prevMode) {
    setPrevMode(mode);
    setLeads([]);
    setTotal(0);
  }
  const displayLeads = mode !== prevMode ? [] : leads;

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

  // Mode switch: reset page
  useEffect(() => {
    setPage(1);
  }, [mode]);

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
    const fetchPromise = mode === 'followup'
      ? getFollowUpLeads(page, followUpDays)
      : mode === 'replied'
        ? getRepliedLeads(page)
        : mode === 'no-site'
          ? getNoSiteLeads(page, debouncedSearch || undefined)
          : getOutreachLeads(page, filters);
    fetchPromise
      .then(result => {
        if (!cancelled) {
          setLeads(result.rows);
          setTotal(result.total);
          onLeadsChangeRef.current(result.rows);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [page, fetchKey, debouncedSearch, country, hasWebsite, category, validEmailOnly, mode, followUpDays]);

  const handleDaysChange = useCallback((raw: string) => {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) {
      setFollowUpDays(n);
      localStorage.setItem(DAYS_STORAGE_KEY, String(n));
      setPage(1);
    }
  }, []);

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
      ...style,
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
          {mode === 'followup'
            ? 'Follow-ups'
            : mode === 'replied'
              ? 'Respuestas'
              : mode === 'no-site'
                ? 'Sin sitio · WhatsApp'
                : `Lead Queue${activeFilterCount > 0 ? ` · ${activeFilterCount} filtro${activeFilterCount !== 1 ? 's' : ''}` : ''}`}
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
        {/* Row 0: queue mode */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button style={mode === 'new' ? PILL_ACTIVE : PILL_BASE} onClick={() => onModeChange('new')}>
            Nuevos
          </button>
          <button style={mode === 'followup' ? PILL_ACTIVE : PILL_BASE} onClick={() => onModeChange('followup')}>
            Follow-up
          </button>
          <button style={mode === 'replied' ? PILL_ACTIVE : PILL_BASE} onClick={() => onModeChange('replied')}>
            Respondieron
          </button>
          <button style={mode === 'no-site' ? PILL_ACTIVE : PILL_BASE} onClick={() => onModeChange('no-site')}>
            Sin sitio
          </button>
        </div>

        {mode === 'no-site' && (
          <input
            type="text"
            placeholder="Buscar negocio…"
            aria-label="Search no-website leads"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            style={{
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
        )}

        {mode === 'followup' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>Esperar</span>
            <input
              type="number"
              min={1}
              aria-label="Days to wait before follow-up"
              value={followUpDays}
              onChange={e => handleDaysChange(e.target.value)}
              style={{
                width: 48,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '4px 6px',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>días sin respuesta</span>
          </div>
        )}

        {mode === 'new' && (<>
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
        </>)}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' as const }}>
        {displayLeads.length === 0 && (
          <div style={{
            padding: 24,
            textAlign: 'center' as const,
            fontFamily: 'var(--font-ui)',
            fontSize: 13,
            color: 'var(--text-muted)',
          }}>
            {mode === 'followup' ? 'Sin follow-ups pendientes' : mode === 'replied' ? 'Sin respuestas todavía' : mode === 'no-site' ? 'Sin leads sin sitio' : 'No leads in queue'}
          </div>
        )}
        {displayLeads.map(lead => {
          const isActive = activeLead?.id === lead.id;
          // No-site leads have no email by definition — they're contacted by phone,
          // so they are never "invalid" here; the email gate only applies elsewhere.
          // slice 0013: block on the deliverability state (placeholder/dead-MX/bounced),
          // not just regex validity — a confirmed-dead address is not worth composing.
          const validity = mode === 'no-site' ? 'valid' : lead.email_validity;
          const invalid = validity === 'invalid';
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
                  {mode === 'no-site'
                    ? (
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--text-muted)',
                      }}>
                        {lead.phone ?? 'sin teléfono'}
                      </span>
                    )
                  : validity !== 'invalid' && lead.first_email
                    ? (
                      <span
                        title="Email found during enrichment (not the map scrape) — deliverability not guaranteed"
                        style={{
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
                {(mode === 'new' || mode === 'no-site') && lead.category && (
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
                {(mode === 'new' || mode === 'no-site') && lead.locNeighbourhood && (
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
                {mode === 'followup' && (() => {
                  const fu = lead as FollowUpLead;
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' as const }}>
                      {fu.last_sent_at && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                          {relTimeFmt.format(-daysAgo(fu.last_sent_at), 'day')}
                        </span>
                      )}
                      {fu.send_count > 1 && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                          ×{fu.send_count}
                        </span>
                      )}
                      {/* Tri-state open indicator (slice 0015): never claim "sin abrir"
                          when no pixel was embedded. tracked=false → no measurement;
                          tracked+no open → honest "no registrada"; tracked+open → only
                          a *possible* open (MPP/corporate prefetch fire the pixel). */}
                      {(() => {
                        const opened = fu.open_count > 0;
                        const label = !fu.tracked
                          ? 'sin seguimiento'
                          : opened ? 'posible apertura' : 'sin apertura registrada';
                        const title = !fu.tracked
                          ? 'Sin píxel de seguimiento incrustado — las aperturas no se midieron'
                          : opened
                            ? 'Posible apertura: el píxel se cargó, pero Apple Mail y escáneres corporativos lo disparan solos — no puede confirmarse'
                            : 'Píxel incrustado, sin apertura registrada (la ausencia no confirma "sin abrir")';
                        return (
                          <span title={title} style={{
                            fontFamily: 'var(--font-ui)',
                            fontSize: 10,
                            fontWeight: 500,
                            padding: '1px 5px',
                            borderRadius: 3,
                            ...(fu.tracked && opened
                              ? { color: 'var(--accent)', background: 'var(--accent-dim)' }
                              : { color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }),
                          }}>
                            {label}
                          </span>
                        );
                      })()}
                      {fu.reply_type === 'auto' && (
                        <span style={{
                          fontFamily: 'var(--font-ui)',
                          fontSize: 10,
                          fontWeight: 500,
                          padding: '1px 5px',
                          borderRadius: 3,
                          color: 'var(--text-muted)',
                          background: 'rgba(255,255,255,0.05)',
                        }}>
                          auto
                        </span>
                      )}
                      <button
                        onClick={e => { e.stopPropagation(); onMarkReplied(lead); }}
                        title="Marcar como respondido"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          fontFamily: 'var(--font-ui)',
                          fontSize: 10,
                          fontWeight: 500,
                          color: 'var(--success)',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        Respondió
                      </button>
                    </div>
                  );
                })()}
                {mode === 'replied' && (() => {
                  const rl = lead as RepliedLead;
                  const isReal = rl.reply_type === 'real';
                  // auto/unknown/null are non-primary: muted tag + a primary action to
                  // promote to real. A real reply gets a quiet action to dismiss as auto.
                  const tagLabel = isReal ? 'respuesta real'
                    : rl.reply_type === 'auto' ? 'auto-reply' : 'sin clasificar';
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' as const }}>
                      {rl.replied_at && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                          {relTimeFmt.format(-daysAgo(rl.replied_at), 'day')}
                        </span>
                      )}
                      <span style={{
                        fontFamily: 'var(--font-ui)',
                        fontSize: 10,
                        fontWeight: 500,
                        padding: '1px 5px',
                        borderRadius: 3,
                        ...(isReal
                          ? { color: 'var(--success)', background: 'rgba(74,222,128,0.12)' }
                          : { color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }),
                      }}>
                        {tagLabel}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); onReclassify(rl, isReal ? 'auto' : 'real'); }}
                        title={isReal ? 'Reclasificar como auto-respuesta' : 'Marcar como respuesta real'}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          fontFamily: 'var(--font-ui)',
                          fontSize: 10,
                          fontWeight: 500,
                          color: isReal ? 'var(--text-muted)' : 'var(--success)',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        {isReal ? 'Marcar como auto' : 'Es respuesta real'}
                      </button>
                    </div>
                  );
                })()}
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
                {/* slice 0013: 3-state deliverability — valid (filled green) /
                    unknown (hollow muted: MX ok, mailbox unconfirmed) / invalid (warn ⚠).
                    Emails come from the enrichment step, not the scrape. */}
                {validity === 'invalid' ? (
                  <span style={{ fontSize: 12, color: 'var(--warn)' }} title="Undeliverable email (placeholder, dead domain, or bounced)">⚠</span>
                ) : validity === 'unknown' ? (
                  <div
                    title="Deliverability unverified — domain accepts mail but mailbox unconfirmed (email from enrichment, not scrape)"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'transparent',
                      border: '1px solid var(--text-muted)',
                      flexShrink: 0,
                    }} />
                ) : (
                  <div
                    title="Verified deliverable (MX + mailbox accepted)"
                    style={{
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
