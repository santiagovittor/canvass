import { useState, useEffect, useCallback, useRef } from 'react';
import { getOutreachLeads } from '../lib/outreachApi';

export interface StagingLead {
  id: string;
  name: string;
  category: string | null;
  locCountry: string | null;
}

// Sources the deliverable 'new'-mode leads the operator can stage for a batch,
// and owns the selection set. Page-1 fetch + debounced search (local timer, not
// a poll). selectFirst(n) pages until n ids are gathered (mirrors the batch's
// own lead sourcing) so quick-select works beyond the first page.
export function useLeadStaging() {
  const [leads, setLeads] = useState<StagingLead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      setLoading(true);
      getOutreachLeads(1, { validEmail: true, search: search || undefined })
        .then(r => {
          setLeads(r.rows.map(l => ({ id: l.id, name: l.name, category: l.category, locCountry: l.locCountry })));
          setTotal(r.total);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => { if (debounce.current) clearTimeout(debounce.current); };
  }, [search]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelected(prev => {
      const allOn = ids.length > 0 && ids.every(id => prev.has(id));
      const next = new Set(prev);
      if (allOn) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const selectFirst = useCallback(async (n: number) => {
    const ids: string[] = [];
    let page = 1;
    while (ids.length < n) {
      const { rows, total: t } = await getOutreachLeads(page, { validEmail: true, search: search || undefined });
      for (const r of rows) ids.push(r.id);
      if (ids.length >= t || rows.length === 0) break;
      page++;
    }
    setSelected(new Set(ids.slice(0, n)));
  }, [search]);

  return { leads, total, loading, search, setSearch, selected, toggle, toggleAll, selectFirst, clear };
}
