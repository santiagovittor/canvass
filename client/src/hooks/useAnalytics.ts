import { useState, useEffect, useCallback } from 'react';
import { getAnalytics } from '../lib/analyticsApi';
import type { AnalyticsPayload } from '../lib/analyticsApi';

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

  return { data, error, loading, reload };
}
