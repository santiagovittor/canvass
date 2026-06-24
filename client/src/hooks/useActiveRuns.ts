import { useEffect, useState } from 'react';
import { useSSE } from './useSSE';
import { getActiveRuns, type ActiveRun } from '../lib/activeRunsApi';
import type { BatchProgress } from '../lib/batchApi';

// Client mirror of the server-authoritative active-runs read-model (slice 0012).
// Hydrates from a one-shot GET on mount (covers a late-mounting consumer, since a
// fresh runs:snapshot only fires on a new EventSource connection) and from the
// connect-time runs:snapshot event, then stays current off the existing per-run
// progress events. No polling — the GET runs once; everything else is SSE-driven.
//
// Strategy: membership changes (a run starts/ends) are infrequent → refetch the
// authoritative set on those boundary events. Count updates are frequent → patch
// in place by id for smoothness; a missed id self-heals on the next boundary.
export function useActiveRuns(): ActiveRun[] {
  const [runs, setRuns] = useState<ActiveRun[]>([]);

  useEffect(() => {
    let alive = true;
    getActiveRuns().then(r => { if (alive) setRuns(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const refetch = () => { getActiveRuns().then(setRuns).catch(() => {}); };

  useSSE({
    'runs:snapshot': (data) => setRuns(data as ActiveRun[]),

    // ── membership boundaries → refetch the authoritative set ──
    'job:started': () => refetch(),
    'job:done': () => refetch(),
    'job:error': () => refetch(),
    'keyword:started': () => refetch(),
    'keyword:done': () => refetch(),
    'keyword:error': () => refetch(),
    'premium:progress': () => refetch(),

    // ── live count patches (no refetch) ──
    'job:progress': (data) => {
      const e = data as { jobId: string; cellsDone: number; totalBusinesses: number };
      setRuns(prev => prev.map(r =>
        r.type === 'scrape' && r.jobId === e.jobId
          ? { ...r, cellsDone: e.cellsDone, businessesFound: e.totalBusinesses }
          : r,
      ));
    },
    'keyword:stage': (data) => {
      const e = data as { runId: string; stage: string };
      setRuns(prev => prev.map(r =>
        r.type === 'keyword' && r.runId === e.runId ? { ...r, stage: e.stage } : r,
      ));
    },
    'batch:progress': (data) => {
      const e = data as BatchProgress;
      setRuns(prev => {
        // Terminal batch → drop it from the strip.
        if (e.status !== 'running' && e.status !== 'paused') {
          return prev.filter(r => !(r.type === 'batch' && r.runId === e.runId));
        }
        const exists = prev.some(r => r.type === 'batch' && r.runId === e.runId);
        if (!exists) { refetch(); return prev; }
        return prev.map(r =>
          r.type === 'batch' && r.runId === e.runId
            ? {
                type: 'batch', runId: e.runId, status: e.status, total: e.total,
                processed: e.processed, queuedForSend: e.queuedForSend,
                skippedNoEvidence: e.skippedNoEvidence, heldGeneric: e.heldGeneric,
                failed: e.failed, pauseReason: e.pauseReason,
              }
            : r,
        );
      });
    },
  });

  return runs;
}
