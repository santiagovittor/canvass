import { isAnalysisFresh, enqueuePremiumAnalysis } from '../db/premium';
import { kickPremiumAnalysis } from './premiumAnalysisQueue';
import { getNumber } from './appSettings';

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
