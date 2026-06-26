import { useState, useEffect, useCallback, useRef } from 'react';
import { getAnalytics } from '../lib/analyticsApi';
import type { AnalyticsPayload } from '../lib/analyticsApi';
import { useSSE } from './useSSE';

export function useAnalytics() {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    getAnalytics()
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load analytics'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Live refresh on outreach/scrape activity (slice 0039) — no polling. Re-pulls
  // silently (no loading flicker, keeps prior data on a transient error) and
  // debounces bursts (the scheduler sending several emails) into one fetch.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      getAnalytics().then(setData).catch(() => {});
    }, 800);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useSSE({
    'send-scheduler:tick': refresh,
    'email:replied': refresh,
    'businesses_updated': refresh,
    'email:opened': refresh, // harmless until slice 0040 enables open tracking
  });

  return { data, error, loading, reload };
}
