import { useCallback, useEffect, useState } from 'react';
import { getCoverage, type CoverageArea } from '../lib/api';
import { useSSE } from './useSSE';

// Scraped-area coverage registry (slice 0038). Fetches once and refreshes over
// SSE when a job finishes — no polling. job:done is the registry-write signal.
export function useCoverage(): CoverageArea[] {
  const [areas, setAreas] = useState<CoverageArea[]>([]);

  const refresh = useCallback(() => {
    getCoverage().then(r => setAreas(r.areas)).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useSSE({ 'job:done': refresh });

  return areas;
}
