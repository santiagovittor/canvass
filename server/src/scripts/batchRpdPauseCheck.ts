/**
 * Focused re-check for the RPD-exhaustion pause path through the COMPOSE/VERIFY
 * stages (the full gate proved everything else). Seeds the Gemini daily budget to
 * its ceiling, runs a real batch, and asserts the run PAUSES resumably — items are
 * left non-terminal (NOT dead-lettered as failed) — then reset+resume drives to done.
 *
 *   docker compose exec server sh -c "cd /app/server && npx tsx src/scripts/batchRpdPauseCheck.ts"
 */
import {
  sqlite, getDraft, upsertDraft, saveDraftTopGap, saveDraftVerification, deleteDraft,
  setGeminiRpd, getGeminiRpd,
} from '../db';
import { getBatchRun, getBatchItems } from '../db/batch';
import { startBatch, resumeBatch } from '../services/batchOrchestrator';
import { pacificDate } from '../services/geminiRateLimiter';
import { env } from '../env';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitForRun(runId: string, statuses: string[], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getBatchRun(runId);
    if (run && statuses.includes(run.status)) return run;
    await sleep(1500);
  }
  return getBatchRun(runId);
}

async function main() {
  const ids = (sqlite.prepare(`
    SELECT b.id FROM businesses b
    WHERE b.website IS NOT NULL AND b.website != '' AND b.emails_json IS NOT NULL AND b.emails_json NOT IN ('[]','')
      AND EXISTS (SELECT 1 FROM premium_analyses p WHERE p.business_id=b.id AND p.status='done'
                  AND (p.vision_json IS NOT NULL OR p.psi_json IS NOT NULL OR p.detected_sigs_json IS NOT NULL))
    LIMIT 3
  `).all() as { id: string }[]).map(r => r.id);
  if (ids.length < 1) { console.error('no leads; STOP'); process.exit(1); }

  const snap = new Map(ids.map(id => [id, getDraft(id)]));
  const today = pacificDate();
  const rpdBackup = getGeminiRpd(today);

  console.log('\n=== RPD PAUSE RE-CHECK ===');
  // 1. fill the budget, run a batch → must pause resumably (no item dead-lettered)
  setGeminiRpd(today, env.GEMINI_RPD);
  const runId = startBatch(ids, true);
  const paused = await waitForRun(runId, ['paused', 'done'], 120_000);
  const items1 = getBatchItems(runId);
  assert('run paused on RPD exhaustion (not done)', paused?.status === 'paused' && paused?.pauseReason === 'gemini_rpd_exhausted',
    `status=${paused?.status} reason=${paused?.pauseReason}`);
  assert('no item dead-lettered as failed by RPD exhaustion',
    items1.every(i => i.state !== 'failed'),
    items1.map(i => i.state).join(','));

  // 2. reset budget + resume → run completes, items terminal, no duplicate rows
  setGeminiRpd(today, rpdBackup);
  resumeBatch(runId);
  const done = await waitForRun(runId, ['done', 'paused'], 5 * 60_000);
  const items2 = getBatchItems(runId);
  assert('run resumes to done after reset', done?.status === 'done', `status=${done?.status}`);
  assert('all items terminal after resume',
    items2.every(i => ['queued_for_send', 'held_generic', 'skipped_no_evidence', 'failed'].includes(i.state)),
    items2.map(i => `${i.state}`).join(','));
  for (const id of ids) {
    const n = (sqlite.prepare(`SELECT COUNT(*) n FROM scheduled_sends WHERE business_id=? AND dry_run=1`).get(id) as { n: number }).n;
    assert(`≤1 scheduled row for ${id.slice(0, 14)} (no dup from pause/resume)`, n <= 1, `n=${n}`);
  }
  console.log('  final states:', items2.map(i => i.state).join(', '));

  // cleanup
  for (const id of ids) {
    sqlite.prepare(`DELETE FROM scheduled_sends WHERE business_id=? AND dry_run=1`).run(id);
    sqlite.prepare(`DELETE FROM email_sends WHERE business_id=? AND status='dryrun'`).run(id);
    const s = snap.get(id);
    if (s) { upsertDraft(id, s.subject, s.body, s.isAiDraft); saveDraftTopGap(id, s.topGap); saveDraftVerification(id, s.verificationJson); }
    else deleteDraft(id);
  }
  sqlite.prepare(`DELETE FROM batch_items WHERE batch_id=?`).run(runId);
  sqlite.prepare(`DELETE FROM batch_runs WHERE id=?`).run(runId);
  setGeminiRpd(today, rpdBackup);
  sqlite.pragma('wal_checkpoint(FULL)');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(err => { console.error('CHECK CRASHED:', err); process.exit(1); });
