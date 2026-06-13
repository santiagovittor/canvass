import { env } from '../env';
import { broadcast } from '../sse';
import { claimNextPending, enqueuePremiumAnalysis, completePremiumAnalysis } from '../db/premium';
import { runPremiumAnalysis } from './premiumAnalyzer';

let running = false;
let rekick = false;

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
    const row = claimNextPending();
    if (!row) return;
    broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'running' });
    try {
      await runPremiumAnalysis(row);
    } catch (err) {
      // One bad site must never wedge the loop
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[premiumAnalysisQueue] analysis ${row.id} failed:`, message);
      completePremiumAnalysis(row.id, {
        status: 'failed', renderOutcome: 'browser_error', finalUrl: null,
        signals: {}, cookieWall: false, consoleErrors: [], paths: {},
        errorMessage: message,
      });
      broadcast('premium:progress', { businessId: row.businessId, analysisId: row.id, status: 'failed', renderOutcome: 'browser_error' });
    }
  }
}
