import { isAnalysisFresh, enqueuePremiumAnalysis } from '../db/premium';
import { getLeadsNeedingPsiBackfill } from '../db';
import { kickPremiumAnalysis } from './premiumAnalysisQueue';
import { getNumber } from './appSettings';
import { env } from '../env';

// Auto-analyze entry point shared by every scrape path (polygon/keyword/instant).
// Per id: skip if a fresh+complete analysis already exists (TTL reuse gate), else
// enqueue a pending row (deduped against any open row). Kick once at the end.
// Ignores AUTO_ANALYZE_PAUSED by design — rows are recorded even while paused and
// drain on resume. Callers pass only website-bearing ids; runPremiumAnalysis still
// short-circuits any stray websiteless lead to renderOutcome='no_website'.
export function autoEnqueueForAnalysis(businessIds: string[]): { enqueued: number; skipped: number } {
  if (businessIds.length === 0) return { enqueued: 0, skipped: 0 };
  const ttlDays = getNumber('REUSE_ANALYSIS_TTL_DAYS');
  let enqueued = 0;
  let skipped = 0;
  for (const id of businessIds) {
    if (isAnalysisFresh(id, ttlDays)) { skipped++; continue; }
    enqueuePremiumAnalysis(id);
    enqueued++;
  }
  if (enqueued > 0) kickPremiumAnalysis();
  return { enqueued, skipped };
}

// Slice 0049: paced PSI backfill for the email pool. Selects the top-`limit` untouched,
// has-site, has-email leads (by LeadScore) that lack a PSI score, then routes them through
// autoEnqueueForAnalysis — so the TTL reuse gate, dedup, FIFO low-priority drain, and the
// slice-0031 batch-yield are all reused verbatim (a live batch always wins the shared
// Gemini/Playwright lane). No-op with a clear log when premium analysis is unconfigured.
export function backfillPremiumAnalysis(limit: number): { enqueued: number; skipped: number } {
  if (!env.PLAYWRIGHT_WS_URL) {
    console.log('[psi-backfill] PLAYWRIGHT_WS_URL unset; premium analysis unavailable, no-op');
    return { enqueued: 0, skipped: 0 };
  }
  const ids = getLeadsNeedingPsiBackfill(limit);
  const r = autoEnqueueForAnalysis(ids);
  console.log(`[psi-backfill] queued ${r.enqueued} (skipped ${r.skipped} fresh)`);
  return r;
}
