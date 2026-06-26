import { useEffect, useRef, useState } from 'react';
import { geoAutocomplete, type GeoPlace } from '../lib/api';

// Debounced area autocomplete (slice 0038; loading state added 0041). Hits the
// GeoNames-backed endpoint ~200ms after typing stops; a request counter drops
// stale responses so a slow reply can't overwrite a newer query. `loading` is
// true from debounce-fire until the matching response lands, so the dropdown can
// shimmer instead of flashing an empty box.
export function useAreaAutocomplete(query: string, enabled = true): { results: GeoPlace[]; loading: boolean } {
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) { setResults([]); setLoading(false); return; }

    const id = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { results } = await geoAutocomplete(q);
        if (id === seq.current) { setResults(results); setLoading(false); }
      } catch {
        if (id === seq.current) { setResults([]); setLoading(false); }
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, enabled]);

  return { results, loading };
}
