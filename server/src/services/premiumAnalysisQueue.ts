import { env } from '../env';
import { broadcast } from '../sse';
import { claimNextPending, enqueuePremiumAnalysis, completePremiumAnalysis, resetAnalysisToPending, countPendingAnalyses } from '../db/premium';
import { runPremiumAnalysis } from './premiumAnalyzer';
import { GeminiRpdExhausted } from './geminiRateLimiter';
import { getBool, setSetting } from './appSettings';
import { listRunsByStatus } from '../db/batch';

let running = false;
let rekick = false;
let _pausedAt: string | null = null;

// Stateless batch-yield gate (slice 0031): while any batch run is `running`, the
// auto-analyze queue stops claiming NEW work so the batch owns the single shared
// Gemini limiter + Playwright browser. A live query (no flag) — self-healing across
// restarts, and deliberately separate from AUTO_ANALYZE_PAUSED so the batch never
// clobbers the operator's manual pause. The batch re-runs stale analysis inline, so
// the deferred backlog loses nothing; batchOrchestrator kicks the queue on run end.
function isBatchRunning(): boolean {
  return listRunsByStatus(['running']).length > 0;
}

export interface AutoAnalyzeHealth { backlog: number; paused: boolean; pausedAt: string | null; deferred: boolean; }

export function getAutoAnalyzeHealth(): AutoAnalyzeHealth {
  const backlog = countPendingAnalyses();
  return { backlog, paused: getBool('AUTO_ANALYZE_PAUSED'), pausedAt: _pausedAt, deferred: backlog > 0 && isBatchRunning() };
}

export function setAutoAnalyzePaused(paused: boolean): void {
  setSetting('AUTO_ANALYZE_PAUSED', paused);
  _pausedAt = paused ? new Date().toISOString() : null;
  if (!paused) kickPremiumAnalysis(); // kick-driven worker: restart drain on resume
}

// Sequential background worker for premium website analysis, cloned from the
// enrichmentQueue pattern. Pending work lives in the DB (premium_analyses rows
// with status='pending'), so it survives restarts. Idempotent: call whenever
// new work may exist (boot, enqueue).
export function kickPremiumAnalysis(): void {
  if (!env.PLAYWRIGHT_WS_URL) return;
  if (running) { rekick = true; return; }
  running = true;
  loop()
    .catch(err => console.error('[premiumAnalysisQueue] worker crashed:', err))
    .finally(() => {
      running = false;
      if (rekick) { rekick = false; kickPremiumAnalysis(); }
    });
}

// Service-layer entry point for routes: enqueue (deduped) and wake the worker.
export function requestPremiumAnalysis(businessId: string): { id: string; deduped: boolean } {
  const result = enqueuePremiumAnalysis(businessId);
  broadcast('premium:progress', { businessId, analysisId: result.id, status: 'pending' });
  kickPremiumAnalysis();
  return result;
}

async function loop(): Promise<void> {
  while (true) {
    if (getBool('AUTO_ANALYZE_PAUSED')) return; // pause stops claiming; in-flight finished, pending rows wait
    if (isBatchRunning()) return; // batch-yield (slice 0031): stop claiming while a batch owns the shared lanes; batch kicks us back on run end
    const row = claimNextPending();
    if (!row) return;
    broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'running' });
    try {
      await runPremiumAnalysis(row);
    } catch (err) {
      if (err instanceof GeminiRpdExhausted) {
        // Budget cap, not a fault: return the row to pending and stop draining.
        // `return` (not continue) — continuing would hot-spin re-claiming the same
        // row and re-hitting the fast-failing reserveGeminiRpd. A later kick (or the
        // boot kick after the Pacific-midnight reset) drains it.
        resetAnalysisToPending(row.id);
        broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'pending' });
        console.warn(`[premiumAnalysisQueue] RPD exhausted; ${row.id} → pending, pausing drain`);
        return;
      }
      // One bad site must never wedge the loop
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[premiumAnalysisQueue] analysis ${row.id} failed:`, message);
      completePremiumAnalysis(row.id, {
        status: 'failed', renderOutcome: 'browser_error', finalUrl: null,
        signals: {}, cookieWall: false, consoleErrors: [], paths: {}, detectedSigs: [],
        errorMessage: message,
      });
      broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'failed', renderOutcome: 'browser_error' });
    }
  }
}
