import { useState, useEffect } from 'react';
import { useBusinesses } from '../../hooks/useBusinesses';
import { getBusinessCategories, patchOutreach, getLocationHierarchy } from '../../lib/api';
import { FilterPanel } from './FilterPanel';
import { BusinessTable } from './BusinessTable';
import { ExportModal } from './ExportModal';
import type { BusinessQueryFilters, LocationHierarchy } from '../../types';

const DEFAULT_FILTERS: BusinessQueryFilters = {
  orderBy: 'scraped_at',
  orderDir: 'desc',
  page: 1,
  pageSize: 50,
};

const VALID_ORDER = ['name', 'rating', 'reviewCount', 'scraped_at'] as const;

function filtersToParams(f: BusinessQueryFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.search)                                 p.set('search', f.search);
  if (f.category)                               p.set('category', f.category);
  if (f.locCountry)                             p.set('locCountry', f.locCountry);
  if (f.locState)                               p.set('locState', f.locState);
  if (f.locCity)                                p.set('locCity', f.locCity);
  if (f.hasEmail)                               p.set('hasEmail', 'true');
  if (f.hasPhone)                               p.set('hasPhone', 'true');
  if (f.hasWebsite)                             p.set('hasWebsite', 'true');
  if (f.hasSocial)                              p.set('hasSocial', 'true');
  if (f.minRating)                              p.set('minRating', String(f.minRating));
  if (f.orderBy && f.orderBy !== 'scraped_at')  p.set('orderBy', f.orderBy);
  if (f.orderDir && f.orderDir !== 'desc')      p.set('orderDir', f.orderDir);
  if (f.page && f.page > 1)                     p.set('page', String(f.page));
  if (f.pageSize && f.pageSize !== 50)          p.set('pageSize', String(f.pageSize));
  return p;
}

function paramsToFilters(p: URLSearchParams): BusinessQueryFilters {
  const orderByRaw = p.get('orderBy');
  const orderBy = VALID_ORDER.includes(orderByRaw as typeof VALID_ORDER[number])
    ? (orderByRaw as BusinessQueryFilters['orderBy'])
    : 'scraped_at';
  return {
    search:     p.get('search') || undefined,
    category:   p.get('category') || undefined,
    locCountry: p.get('locCountry') || undefined,
    locState:   p.get('locState') || undefined,
    locCity:    p.get('locCity') || undefined,
    hasEmail:   p.get('hasEmail') === 'true' ? true : undefined,
    hasPhone:   p.get('hasPhone') === 'true' ? true : undefined,
    hasWebsite: p.get('hasWebsite') === 'true' ? true : undefined,
    hasSocial:  p.get('hasSocial') === 'true' ? true : undefined,
    minRating:  p.get('minRating') ? parseFloat(p.get('minRating')!) : undefined,
    orderBy,
    orderDir:   p.get('orderDir') === 'asc' ? 'asc' : 'desc',
    page:       p.get('page') ? Math.max(1, parseInt(p.get('page')!, 10)) : 1,
    pageSize:   p.get('pageSize') ? Math.max(1, parseInt(p.get('pageSize')!, 10)) : 50,
  };
}

export function BusinessExplorer({ refreshTrigger = 0 }: { refreshTrigger?: number }) {
  const [filters, setFilters] = useState<BusinessQueryFilters>(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = paramsToFilters(params);
    if (!params.has('hasEmail')) {
      fromUrl.hasEmail = localStorage.getItem('explorer_hasEmail') !== 'false' ? true : undefined;
    }
    return fromUrl;
  });
  const [categories, setCategories] = useState<string[]>([]);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [locationHierarchy, setLocationHierarchy] = useState<LocationHierarchy>({ countries: [], pendingCount: 0 });

  const { rows, total, withEmail, contacted, loading, updateRow } = useBusinesses(filters, refreshTrigger);

  // Sync filters → URL
  useEffect(() => {
    const params = filtersToParams(filters);
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [filters]);

  // Fetch categories once
  useEffect(() => {
    getBusinessCategories().then(setCategories).catch(() => {});
  }, []);

  // Fetch location hierarchy when relevant filters change (not loc/page/sort)
  const { search, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating } = filters;
  useEffect(() => {
    getLocationHierarchy({ search, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating })
      .then(setLocationHierarchy)
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating]);

  const handleFilterChange = (updated: BusinessQueryFilters) => {
    localStorage.setItem('explorer_hasEmail', String(!!updated.hasEmail));
    setFilters({ ...updated, page: 1 });
  };

  const handleSort = (col: string) => {
    setFilters(f => ({
      ...f,
      orderBy: col as BusinessQueryFilters['orderBy'],
      orderDir: col === f.orderBy ? (f.orderDir === 'asc' ? 'desc' : 'asc') : 'desc',
      page: 1,
    }));
  };

  const handlePageSizeChange = (size: number) => {
    setFilters(f => ({ ...f, pageSize: size, page: 1 }));
  };

  const handleClearFilters = () => {
    localStorage.setItem('explorer_hasEmail', 'false');
    setFilters({ ...DEFAULT_FILTERS });
  };

  const handleOutreachChange = async (id: string, status: string | null) => {
    await patchOutreach(id, status).catch(() => {});
    updateRow(id, { outreachStatus: status ?? undefined });
  };

  const handlePageChange = (newPage: number) => {
    setFilters(f => ({ ...f, page: newPage }));
  };

  const handleLocationChange = (level: 'country' | 'state' | 'city', value: string) => {
    setFilters(f => {
      if (level === 'country') {
        const same = f.locCountry === value;
        return { ...f, locCountry: same ? undefined : value, locState: undefined, locCity: undefined, page: 1 };
      }
      if (level === 'state') {
        const same = f.locState === value;
        return { ...f, locState: same ? undefined : value, locCity: undefined, page: 1 };
      }
      const same = f.locCity === value;
      return { ...f, locCity: same ? undefined : value, page: 1 };
    });
  };

  const handleLocationClear = () => {
    setFilters(f => ({ ...f, locCountry: undefined, locState: undefined, locCity: undefined, page: 1 }));
  };


  // Active filter chips
  const chips: { key: keyof BusinessQueryFilters; label: string }[] = [];
  if (filters.search)     chips.push({ key: 'search',     label: `"${filters.search}"` });
  if (filters.category)   chips.push({ key: 'category',   label: filters.category });
  if (filters.locCountry) chips.push({ key: 'locCountry', label: filters.locCountry });
  if (filters.locState)   chips.push({ key: 'locState',   label: filters.locState });
  if (filters.locCity)    chips.push({ key: 'locCity',    label: filters.locCity });
  if (filters.minRating)  chips.push({ key: 'minRating',  label: `${filters.minRating}+ ★` });
  if (filters.hasEmail)   chips.push({ key: 'hasEmail',   label: 'Has email' });
  if (filters.hasPhone)   chips.push({ key: 'hasPhone',   label: 'Has phone' });
  if (filters.hasWebsite) chips.push({ key: 'hasWebsite', label: 'Has website' });
  if (filters.hasSocial)  chips.push({ key: 'hasSocial',  label: 'Has social' });

  const clearChip = (key: keyof BusinessQueryFilters) => {
    if (key === 'hasEmail') localStorage.setItem('explorer_hasEmail', 'false');
    if (key === 'locCountry') {
      setFilters(f => ({ ...f, locCountry: undefined, locState: undefined, locCity: undefined, page: 1 }));
      return;
    }
    if (key === 'locState') {
      setFilters(f => ({ ...f, locState: undefined, locCity: undefined, page: 1 }));
      return;
    }
    setFilters(f => ({ ...f, [key]: undefined, page: 1 }));
  };

  return (
    <>
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-panel)' }}>
      {/* Left: filters */}
      <div style={{ width: '220px', flexShrink: 0, overflow: 'hidden' }}>
        <FilterPanel
          filters={filters}
          onChange={handleFilterChange}
          categories={categories}
          total={total}
          loading={loading}
          onOpenExportModal={() => setExportModalOpen(true)}
          locationHierarchy={locationHierarchy}
          locCountry={filters.locCountry}
          locState={filters.locState}
          locCity={filters.locCity}
          onLocationChange={handleLocationChange}
          onLocationClear={handleLocationClear}
        />
      </div>

      {/* Main area */}
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Stats bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 12px',
          borderBottom: chips.length > 0 ? 'none' : '1px solid var(--border)',
          flexShrink: 0,
          background: 'var(--bg-panel)',
        }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-primary)' }}>{total.toLocaleString()}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)' }}>businesses</span>
          <span style={{ color: 'var(--border-strong)', margin: '0 4px' }}>·</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-primary)' }}>{withEmail.toLocaleString()}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)' }}>with email</span>
          <span style={{ color: 'var(--border-strong)', margin: '0 4px' }}>·</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)' }}>{contacted.toLocaleString()}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)' }}>contacted</span>
        </div>

        {/* Active filter chips */}
        {chips.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '6px 12px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            {chips.map(chip => (
              <span key={chip.key} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                padding: '2px 6px 2px 10px',
                borderRadius: '20px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border-strong)',
                fontFamily: 'var(--font-ui)',
                fontSize: '11px',
                color: 'var(--text-secondary)',
              }}>
                {chip.label}
                <button
                  onClick={() => clearChip(chip.key)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-muted)', fontSize: '14px', lineHeight: '1', display: 'flex', alignItems: 'center' }}
                >
                  ×
                </button>
              </span>
            ))}
            {chips.length >= 2 && (
              <button
                onClick={handleClearFilters}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'var(--text-muted)', padding: '2px 4px' }}
              >
                Clear all
              </button>
            )}
          </div>
        )}

        {/* Table */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <BusinessTable
            rows={rows}
            total={total}
            loading={loading}
            page={filters.page ?? 1}
            pageSize={filters.pageSize ?? 50}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onOutreachChange={handleOutreachChange}
            orderBy={filters.orderBy}
            orderDir={filters.orderDir ?? 'desc'}
            onSort={handleSort}
            onClearFilters={handleClearFilters}
          />
        </div>
      </div>
    </div>
    {exportModalOpen && (
      <ExportModal
        onClose={() => setExportModalOpen(false)}
        filters={filters}
        total={total}
      />
    )}
    </>
  );
}
