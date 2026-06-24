import { useState, useRef, useCallback } from 'react';
import { useSSE } from './useSSE';
import { startBatch, pauseBatch, resumeBatch, cancelBatch } from '../lib/batchApi';
import type { BatchProgress } from '../lib/batchApi';
import { getActiveRuns } from '../lib/activeRunsApi';

// Batch-run ownership lifted out of Outreach (slice 0019) so the Automate tab is the
// single home for the runner. Owns the live `batch:progress` counters, mount-time
// rehydration of an in-flight run (getActiveRuns / runs:snapshot pattern), and derives
// two signals the progress payload doesn't carry: the current in-flight lead and the
// accumulated Gemini cost — both read off the existing `outreach:stage` stream.

interface StageEvent {
  businessId?: string;
  phase?: 'start' | 'end' | 'retry' | 'done';
  costUsd?: number;
}

export interface BatchRunState {
  progress: BatchProgress | null;
  currentLeadId: string | null;
  accumulatedCost: number;
  start: (businessIds: string[], dryRun: boolean) => Promise<void>;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  error: string | null;
}

export function useBatchRun(): BatchRunState {
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [currentLeadId, setCurrentLeadId] = useState<string | null>(null);
  const [accumulatedCost, setAccumulatedCost] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);

  // Mount: rehydrate an in-flight batch (slice 0012) so opening Automate mid-run shows
  // live counts, not an empty console. Live updates continue via SSE below.
  const mounted = useRef(false);
  if (!mounted.current) {
    mounted.current = true;
    getActiveRuns().then(runs => {
      const batch = runs.find(r => r.type === 'batch');
      if (batch && batch.type === 'batch') {
        runIdRef.current = batch.runId;
        setProgress({
          runId: batch.runId, status: batch.status as BatchProgress['status'],
          total: batch.total, processed: batch.processed,
          skippedNoEvidence: batch.skippedNoEvidence, heldGeneric: batch.heldGeneric,
          queuedForSend: batch.queuedForSend, failed: batch.failed, pauseReason: batch.pauseReason,
        });
      }
    }).catch(() => {});
  }

  useSSE({
    'batch:progress': (data) => {
      const d = data as BatchProgress;
      if (runIdRef.current && d.runId !== runIdRef.current) return;
      setProgress(d);
    },
    // Current lead + cost are not in batch:progress — derive them from the stage stream.
    // Concurrency is 3, so currentLeadId tracks the most-recently-active lead (honest for
    // a legibility view). Cost sums the per-lead total emitted on each lead's `done`.
    'outreach:stage': (data) => {
      const d = data as StageEvent;
      if (!d.businessId) return;
      if (d.phase === 'start') setCurrentLeadId(d.businessId);
      if (d.phase === 'done' && typeof d.costUsd === 'number') {
        setAccumulatedCost(c => c + d.costUsd!);
      }
    },
  });

  const start = useCallback(async (businessIds: string[], dryRun: boolean) => {
    if (businessIds.length === 0) return;
    setError(null);
    setAccumulatedCost(0);
    setCurrentLeadId(null);
    try {
      const { runId } = await startBatch(businessIds, dryRun);
      runIdRef.current = runId;
      // Optimistic initial state; live counts arrive via SSE batch:progress.
      setProgress({
        runId, status: 'running', total: businessIds.length, processed: 0,
        skippedNoEvidence: 0, heldGeneric: 0, queuedForSend: 0, failed: 0, pauseReason: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch failed to start');
    }
  }, []);

  const pause = useCallback(() => {
    if (runIdRef.current) pauseBatch(runIdRef.current).catch(() => {});
  }, []);
  const resume = useCallback(() => {
    if (runIdRef.current) resumeBatch(runIdRef.current).catch(() => {});
  }, []);
  const cancel = useCallback(() => {
    if (runIdRef.current) cancelBatch(runIdRef.current).catch(() => {});
  }, []);

  return { progress, currentLeadId, accumulatedCost, start, pause, resume, cancel, error };
}
