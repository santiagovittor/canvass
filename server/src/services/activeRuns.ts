import { listActiveScrapeJobs, listActiveKeywordRuns } from '../db/activeRuns';
import { listRunsByStatus } from '../db/batch';
import { countPendingAnalyses, countRunningAnalyses } from '../db/premium';

// Server-authoritative read-model for every active run (slice 0012). Aggregated
// from the existing durable stores — no parallel tracker. Consumed by both the
// GET /api/runs/active route and the connect-time runs:snapshot SSE event, so the
// client rehydrates identically whether it polls once on mount or reconnects.

export type ActiveRun =
  | { type: 'scrape'; jobId: string; status: string; businessesFound: number; cellCount: number; cellsDone: number }
  | { type: 'keyword'; jobId: string; runId: string | null; stage: string | null; query: string; startedAt: string }
  | { type: 'batch'; runId: string; status: string; total: number; processed: number; queuedForSend: number; skippedNoEvidence: number; heldGeneric: number; failed: number; pauseReason: string | null }
  | { type: 'premium'; running: number; pending: number };

export function getActiveRuns(): ActiveRun[] {
  const runs: ActiveRun[] = [];

  for (const j of listActiveScrapeJobs()) {
    runs.push({ type: 'scrape', ...j });
  }

  for (const k of listActiveKeywordRuns()) {
    runs.push({ type: 'keyword', ...k });
  }

  for (const b of listRunsByStatus(['running', 'paused'])) {
    runs.push({
      type: 'batch',
      runId: b.id,
      status: b.status,
      total: b.total,
      processed: b.processed,
      queuedForSend: b.queuedForSend,
      skippedNoEvidence: b.skippedNoEvidence,
      heldGeneric: b.heldGeneric,
      failed: b.failed,
      pauseReason: b.pauseReason,
    });
  }

  // Premium analysis is a sequential background queue — surface it as one aggregate
  // row (running + pending backlog) rather than one row per business.
  const running = countRunningAnalyses();
  const pending = countPendingAnalyses();
  if (running + pending > 0) {
    runs.push({ type: 'premium', running, pending });
  }

  return runs;
}
