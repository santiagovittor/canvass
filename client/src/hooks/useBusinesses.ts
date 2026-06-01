import { useState, useEffect } from 'react';
import { getBusinesses } from '../lib/api';
import type { ExplorerBusiness, BusinessQueryFilters } from '../types';

export function useBusinesses(filters: BusinessQueryFilters, refreshTrigger = 0) {
  const [rows, setRows] = useState<ExplorerBusiness[]>([]);
  const [total, setTotal] = useState(0);
  const [withEmail, setWithEmail] = useState(0);
  const [contacted, setContacted] = useState(0);
  const [loading, setLoading] = useState(false);

  // Debounce the search string so we don't fire on every keystroke
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(t);
  }, [filters.search]);

  const { locCountry, locState, locCity, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating, orderBy, orderDir, page, pageSize } = filters;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBusinesses({
      search: debouncedSearch, locCountry, locState, locCity, category, hasEmail, hasPhone,
      hasWebsite, hasSocial, minRating, orderBy, orderDir, page, pageSize,
    })
      .then(res => {
        if (!cancelled) {
          setRows(res.rows);
          setTotal(res.total);
          setWithEmail(res.withEmail);
          setContacted(res.contacted);
          setLoading(false);
        }
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedSearch, locCountry, locState, locCity, category, hasEmail, hasPhone, hasWebsite, hasSocial, minRating, orderBy, orderDir, page, pageSize, refreshTrigger]);

  const updateRow = (id: string, patch: Partial<ExplorerBusiness>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  };

  return { rows, total, withEmail, contacted, loading, updateRow };
}
