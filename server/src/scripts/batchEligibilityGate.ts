/**
 * Regression gate for slice 0029: a lead with an ACTIVE scheduled send must never be
 * returned as eligible-to-prepare. Pins the invariant at the data layer, where the bug
 * lived (a UI test would miss the dry-run case). Self-contained — no Gemini, no network;
 * fabricates one gate business, exercises the eligibility predicate across send states
 * and both dry-run modes, then cleans up.
 *
 *   docker compose -f docker-compose.dev.yml exec -T server sh -c "cd /app/server && npx tsx src/scripts/batchEligibilityGate.ts"
 */
import { sqlite, getOutreachLeads, createScheduledSend } from '../db';
import { createBatchRun, addBatchItems, getBatchItems, enqueueForSend } from '../db/batch';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

const BIZ = 'eliggate-biz';
const NAME = 'Eligibility Gate Co ZZZ';

// True iff the gate business appears in the eligible-to-prepare set (the Automate
// staging fetch + the Outreach tab both go through buildOutreachWhere with validEmail).
function isEligible(): boolean {
  const { rows } = getOutreachLeads(1, 100, { validEmail: true, search: NAME });
  return rows.some(r => r.id === BIZ);
}
const setStatus = (status: string) =>
  sqlite.prepare(`UPDATE scheduled_sends SET status = ? WHERE business_id = ?`).run(status, BIZ);
const clearSched = () => sqlite.prepare(`DELETE FROM scheduled_sends WHERE business_id = ?`).run(BIZ);

function cleanup() {
  clearSched();
  sqlite.prepare(`DELETE FROM batch_items WHERE business_id = ?`).run(BIZ);
  sqlite.prepare(`DELETE FROM batch_runs WHERE id IN (SELECT batch_id FROM batch_items WHERE business_id = ?)`).run(BIZ);
  sqlite.prepare(`DELETE FROM businesses WHERE id = ?`).run(BIZ);
}

function main() {
  console.log('\n=== BATCH ELIGIBILITY GATE (slice 0029) ===\n');
  cleanup(); // idempotent — clear any prior run's artifacts

  sqlite.prepare(
    `INSERT INTO businesses (id, job_id, name, emails_json, loc_country, scraped_at) VALUES (?, 'eliggate', ?, '["gate@example.test"]', 'Argentina', ?)`
  ).run(BIZ, NAME, new Date().toISOString());

  // ── control: a fresh deliverable lead with no scheduled send is eligible ─────────
  assert('fresh deliverable lead is eligible', isEligible());

  // ── active scheduled send (dry-run) drops it from eligible ───────────────────────
  createScheduledSend({ businessId: BIZ, scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: true, origin: 'auto' });
  assert('dry-run scheduled send → NOT eligible', !isEligible());

  // ── status transitions: only scheduled/claimed/deferred are "active" ─────────────
  setStatus('claimed');  assert('claimed → NOT eligible', !isEligible());
  setStatus('deferred'); assert('deferred → NOT eligible', !isEligible());
  setStatus('sent');     assert('sent → eligible again (terminal, not active)', isEligible());
  setStatus('canceled'); assert('canceled → eligible again', isEligible());

  // ── real (dry_run=0) send excludes identically ───────────────────────────────────
  clearSched();
  createScheduledSend({ businessId: BIZ, scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: false, origin: 'auto' });
  assert('real scheduled send → NOT eligible', !isEligible());
  clearSched();

  // ── enqueueForSend (the production path) → not eligible, exactly one sched row ────
  const run = createBatchRun({ size: 1, dryRun: true, total: 1 });
  addBatchItems(run.id, [BIZ]);
  const item = getBatchItems(run.id)[0];
  const r = enqueueForSend({ item: { id: item.id, batchId: run.id }, scheduled: { businessId: BIZ, scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: true, origin: 'auto' } });
  const schedCount = (sqlite.prepare(`SELECT COUNT(*) n FROM scheduled_sends WHERE business_id = ?`).get(BIZ) as { n: number }).n;
  assert('enqueueForSend created one sched row + queued the item', !r.alreadyQueued && schedCount === 1);
  assert('after enqueueForSend the lead is NOT eligible', !isEligible());

  cleanup();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(fail === 0 ? 0 : 1);
}

try { main(); } catch (err) { console.error('GATE CRASHED:', err); cleanup(); process.exit(1); }
