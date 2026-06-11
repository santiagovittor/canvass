import { useState, useEffect, useMemo } from 'react';
import { Button } from '../ui/Button';
import type { BusinessQueryFilters, LocationHierarchy, LocationHierarchyNode } from '../../types';

interface FilterPanelProps {
  filters: BusinessQueryFilters;
  onChange: (filters: BusinessQueryFilters) => void;
  categories: string[];
  total: number;
  loading: boolean;
  onOpenExportModal: () => void;
  locationHierarchy: LocationHierarchy;
  locCountry?: string;
  locState?: string;
  locCity?: string;
  onLocationChange: (level: 'country' | 'state' | 'city', value: string) => void;
  onLocationClear: () => void;
}

function filterHierarchy(countries: LocationHierarchyNode[], query: string): LocationHierarchyNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return countries;
  const result: LocationHierarchyNode[] = [];
  for (const c of countries) {
    if (c.country.toLowerCase().includes(q)) { result.push(c); continue; }
    const states: LocationHierarchyNode['states'] = [];
    for (const s of c.states) {
      if (s.state.toLowerCase().includes(q)) { states.push(s); continue; }
      const cities = s.cities.filter(ci => ci.city.toLowerCase().includes(q));
      if (cities.length > 0) states.push({ ...s, cities });
    }
    if (states.length > 0) result.push({ ...c, states });
  }
  return result;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--font-ui)',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '6px',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  padding: '8px 10px',
  fontFamily: 'var(--font-ui)',
  fontSize: '13px',
  color: 'var(--text-primary)',
  outline: 'none',
};

export function FilterPanel({
  filters, onChange, categories, total, loading, onOpenExportModal,
  locationHierarchy, locCountry, locState, locCity, onLocationChange, onLocationClear,
}: FilterPanelProps) {
  const set = <K extends keyof BusinessQueryFilters>(key: K, value: BusinessQueryFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  const [expandedCountry, setExpandedCountry] = useState<string | null>(locCountry ?? null);
  const [locSearch, setLocSearch] = useState('');

  // Auto-expand when a country filter becomes active
  useEffect(() => {
    if (locCountry) setExpandedCountry(locCountry);
  }, [locCountry]);

  const hasLocFilter = !!(locCountry || locState || locCity);

  const { countries, pendingCount } = locationHierarchy;
  const searching = locSearch.trim() !== '';
  const visibleCountries = useMemo(() => filterHierarchy(countries, locSearch), [countries, locSearch]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      padding: '16px',
      overflowY: 'auto',
      height: '100%',
      borderRight: '1px solid var(--border)',
      minWidth: 0,
    }}>
      {/* Header */}
      <div>
        <div style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>
          Filters
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600, color: loading ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {total.toLocaleString()}
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', fontWeight: 400, color: 'var(--text-muted)', marginLeft: '6px' }}>businesses</span>
        </div>
      </div>

      {/* Search */}
      <div>
        <label style={labelStyle}>Search</label>
        <input
          type="text"
          value={filters.search ?? ''}
          onChange={e => set('search', e.target.value || undefined)}
          placeholder="name or address…"
          style={inputStyle}
          onFocus={e => (e.target.style.borderColor = 'var(--border-strong)')}
          onBlur={e => (e.target.style.borderColor = 'var(--border)')}
        />
      </div>

      {/* Category */}
      <div>
        <label style={labelStyle}>Category</label>
        <select
          value={filters.category ?? ''}
          onChange={e => set('category', e.target.value || undefined)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Min Rating */}
      <div>
        <label style={labelStyle}>Min rating</label>
        <select
          value={filters.minRating ?? ''}
          onChange={e => set('minRating', e.target.value ? parseFloat(e.target.value) : undefined)}
          style={{ ...inputStyle, cursor: 'pointer' }}
        >
          <option value="">Any</option>
          <option value="3">3.0+</option>
          <option value="3.5">3.5+</option>
          <option value="4">4.0+</option>
          <option value="4.5">4.5+</option>
        </select>
      </div>

      {/* Boolean toggles */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={labelStyle}>Has</div>
        {([
          ['hasEmail',   'Email'],
          ['hasPhone',   'Phone'],
          ['hasWebsite', 'Website'],
          ['hasSocial',  'Social'],
        ] as const).map(([key, label]) => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!filters[key]}
              onChange={e => set(key, e.target.checked ? true : undefined)}
              style={{ accentColor: 'var(--accent)', cursor: 'pointer', width: '14px', height: '14px', flexShrink: 0 }}
            />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', color: 'var(--text-secondary)' }}>
              {label}
            </span>
          </label>
        ))}
      </div>

      {/* Location hierarchy */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <span style={labelStyle}>Location</span>
          {hasLocFilter && (
            <button
              onClick={onLocationClear}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '10px', color: 'var(--text-muted)', padding: 0, marginBottom: '6px' }}
            >
              Clear
            </button>
          )}
        </div>

        {countries.length === 0 && pendingCount === 0 ? (
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Location data loading…
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
            {countries.length > 5 && (
              <input
                type="text"
                value={locSearch}
                onChange={e => setLocSearch(e.target.value)}
                placeholder="filter locations…"
                style={{ ...inputStyle, fontSize: '12px', padding: '6px 8px', marginBottom: '4px' }}
                onFocus={e => (e.target.style.borderColor = 'var(--border-strong)')}
                onBlur={e => (e.target.style.borderColor = 'var(--border)')}
              />
            )}
            {searching && visibleCountries.length === 0 && (
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 6px' }}>
                No matches
              </span>
            )}
            {visibleCountries.map(({ country, count, states }) => {
              const isExpanded = searching || expandedCountry === country;
              const isActive = locCountry === country;
              return (
                <div key={country}>
                  {/* Country row — chevron expands, name filters */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      width: '100%',
                      background: isActive ? 'var(--bg-elevated)' : 'none',
                      border: isActive ? '1px solid var(--border-strong)' : '1px solid transparent',
                      borderRadius: '6px',
                      gap: '4px',
                    }}
                  >
                    <button
                      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${country}`}
                      onClick={() => setExpandedCountry(isExpanded ? null : country)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0 4px 6px', fontFamily: 'var(--font-ui)', fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0, width: '16px' }}
                    >
                      {isExpanded ? '▾' : '▸'}
                    </button>
                    <button
                      onClick={() => onLocationChange('country', country)}
                      style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px 4px 0', gap: '4px' }}
                    >
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: isActive ? 'var(--accent)' : 'var(--text-secondary)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {country}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {count.toLocaleString()}
                      </span>
                    </button>
                  </div>

                  {/* State rows */}
                  {isExpanded && states.map(({ state, count: stateCount, cities }) => {
                    const isStateActive = locState === state;
                    return (
                      <div key={state}>
                        <button
                          onClick={() => onLocationChange('state', state)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            width: '100%',
                            background: isStateActive ? 'var(--bg-elevated)' : 'none',
                            border: isStateActive ? '1px solid var(--border-strong)' : '1px solid transparent',
                            borderRadius: '6px',
                            padding: '3px 6px 3px 20px',
                            cursor: 'pointer',
                            gap: '4px',
                          }}
                        >
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '12px', color: isStateActive ? 'var(--accent)' : 'var(--text-secondary)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {state || '(unknown)'}
                          </span>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', flexShrink: 0 }}>
                            {stateCount.toLocaleString()}
                          </span>
                        </button>

                        {/* City rows — only under active state */}
                        {isStateActive && cities.map(({ city, count: cityCount }) => {
                          const isCityActive = locCity === city;
                          return (
                            <button
                              key={city}
                              onClick={() => onLocationChange('city', city)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                width: '100%',
                                background: isCityActive ? 'var(--bg-elevated)' : 'none',
                                border: isCityActive ? '1px solid var(--border-strong)' : '1px solid transparent',
                                borderRadius: '6px',
                                padding: '2px 6px 2px 32px',
                                cursor: 'pointer',
                                gap: '4px',
                              }}
                            >
                              <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: isCityActive ? 'var(--accent)' : 'var(--text-muted)', flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {city || '(unknown)'}
                              </span>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
                                {cityCount.toLocaleString()}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {pendingCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 6px 4px 22px' }}>
                <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', flex: 1, textAlign: 'left' }}>
                  Pending location
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
                  {pendingCount.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Export — pinned to bottom */}
      <div style={{ marginTop: 'auto', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
        <Button
          variant="primary"
          fullWidth
          onClick={onOpenExportModal}
          disabled={total === 0}
          style={{ fontSize: '13px', padding: '8px 14px' }}
        >
          Export to Sheets
        </Button>
      </div>
    </div>
  );
}
