import { useState, useCallback } from 'react';
import { startScrape, cancelJob as apiCancelJob } from '../lib/api';
import type { JobStatus, Bbox } from '../types';

export function useScrape() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (payload: {
    geometry: { type: string; coordinates: number[][][] };
    searchTerm: string;
    language: string;
    gridCellKm: number;
    extractEmails: boolean;
  }) => {
    setError(null);
    try {
      const { jobId: id } = await startScrape(payload);
      setJobId(id);
      setStatus('running');
      return id;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start job');
      return null;
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await apiCancelJob(jobId);
      setStatus('error');
    } catch {}
  }, [jobId]);

  const reset = useCallback(() => {
    setJobId(null);
    setStatus(null);
    setError(null);
  }, []);

  return { jobId, status, setStatus, setJobId, error, start, cancel, reset };
}
