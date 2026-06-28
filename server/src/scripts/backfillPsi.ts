/**
 * Slice 0049: one-off PSI backfill for the email pool. Enqueues premium analysis for the
 * top-`limit` untouched, has-site, has-email leads that lack a PSI score (ranked by
 * LeadScore), drains the queue in-process, then reports pool PSI coverage before/after.
 *
 * Reuses the TTL reuse gate, dedup, and the slice-0031 batch-yield via
 * autoEnqueueForAnalysis — a live batch always wins the shared Gemini/Playwright lane.
 *
 *   docker compose -f docker-compose.dev.yml exec -T server sh -c "cd /app/server && npx tsx src/scripts/backfillPsi.ts 3"
 *
 * ponytail: the in-process drain can double-claim a pending row with the server's own
 * worker if a scrape/batch runs concurrently — worst case one wasted render, never
 * corruption (completePremiumAnalysis just overwrites the row). Run it when idle.
 */
import { sqlite, getOutreachLeads, getLeadsNeedingPsiBackfill } from '../db';
import { countPendingAnalyses, countRunningAnalyses } from '../db/premium';
import { backfillPremiumAnalysis } from '../services/autoAnalyzeEnqueue';

const limit = Number(process.argv[2] ?? 50);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Pool PSI coverage, single-sourced off the exported helpers (no duplicated WHERE):
// pool = the has-site has-email untouched universe getOutreachLeads ranks; needing = those
// of it lacking a PSI score (the selector); withPsi = the rest.
function coverage(): { pool: number; withPsi: number; needing: number } {
  const pool = getOutreachLeads(1, 1, { hasWebsite: true }).total;
  const needing = getLeadsNeedingPsiBackfill(1_000_000).length;
  return { pool, withPsi: pool - needing, needing };
}

async function main(): Promise<void> {
  console.log(`\n=== PSI BACKFILL (slice 0049) — limit ${limit} ===\n`);

  const before = coverage();
  console.log(`[before] PSI coverage ${before.withPsi}/${before.pool} (needing: ${before.needing})`);

  const r = backfillPremiumAnalysis(limit);
  if (r.enqueued === 0) {
    console.log('[psi-backfill] nothing enqueued; exiting');
    sqlite.pragma('wal_checkpoint(FULL)');
    process.exit(0);
  }

  // Drain the in-process worker. One-off CLI poll (not app realtime → no SSE rule),
  // bounded so a wedged render can't hang the script forever (~2 min/lead budget).
  const deadline = Date.now() + Math.max(10, limit * 2) * 60_000;
  let inFlight = countPendingAnalyses() + countRunningAnalyses();
  let last = -1;
  while (inFlight > 0 && Date.now() < deadline) {
    if (inFlight !== last) { console.log(`[draining] ${inFlight} pending/running...`); last = inFlight; }
    await sleep(3000);
    inFlight = countPendingAnalyses() + countRunningAnalyses();
  }
  if (inFlight > 0) console.warn(`[psi-backfill] deadline hit with ${inFlight} still in flight`);

  const after = coverage();
  console.log(`[after]  PSI coverage ${after.withPsi}/${after.pool} (needing: ${after.needing})`);
  console.log(`[delta]  +${after.withPsi - before.withPsi} PSI scores\n`);

  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(0);
}

main().catch(err => { console.error('BACKFILL CRASHED:', err); process.exit(1); });
