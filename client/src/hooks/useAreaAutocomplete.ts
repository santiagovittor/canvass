import { useEffect, useRef, useState } from 'react';
import { geoAutocomplete, type GeoPlace } from '../lib/api';

// Debounced area autocomplete (slice 0038). Hits the GeoNames-backed endpoint
// ~200ms after typing stops; a request counter drops stale responses so a slow
// reply can't overwrite a newer query.
export function useAreaAutocomplete(query: string, enabled = true): GeoPlace[] {
  const [results, setResults] = useState<GeoPlace[]>([]);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2) { setResults([]); return; }

    const id = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const { results } = await geoAutocomplete(q);
        if (id === seq.current) setResults(results);
      } catch {
        if (id === seq.current) setResults([]);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query, enabled]);

  return results;
}
