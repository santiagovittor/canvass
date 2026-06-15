/**
 * LIVE verification gate for batch automation. Drives the REAL batch orchestrator
 * against REAL leads with REAL Gemini (per-batch dry_run=true), on a LIVE process
 * (OUTREACH_DRY_RUN unset → env=false). Proves: state machine, Gemini throttle
 * (RPM + persisted Pacific-date RPD pause/resume), handoff into scheduled_sends,
 * per-batch dry-run safety on a live process, crash-between idempotency, and that
 * real contacted-state / real send history are untouched.
 *
 * Run with the main server STOPPED (so its worker can't race / fire real sends):
 *   docker compose run --rm --no-deps server sh -c "cd /app/server && npx tsx src/scripts/batchLiveGate.ts"
 */
import {
  sqlite, getDraft, upsertDraft, saveDraftTopGap, saveDraftVerification, deleteDraft,
  createScheduledSend, getScheduledSendById, rescheduleScheduledSend,
  rollingSentCount24h, setGeminiRpd, getGeminiRpd, reserveGeminiRpd,
} from '../db';
import {
  createBatchRun, addBatchItems, getBatchRun, getBatchItems, transitionItem, enqueueForSend,
} from '../db/batch';
import { startBatch, resumeBatch } from '../services/batchOrchestrator';
import { withGeminiRate, GeminiRpdExhausted, geminiCallCount, pacificDate } from '../services/geminiRateLimiter';
import { processJob } from '../services/scheduledSendWorker';
import { env } from '../env';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const nameOf = (id: string) =>
  (sqlite.prepare('SELECT name FROM businesses WHERE id = ?').get(id) as { name?: string } | undefined)?.name ?? id;
const dryrunRowsFor = (id: string) =>
  (sqlite.prepare(`SELECT COUNT(*) n FROM email_sends WHERE business_id = ? AND status = 'dryrun'`).get(id) as { n: number }).n;
const schedRowsFor = (id: string) =>
  sqlite.prepare(`SELECT id, status, dry_run FROM scheduled_sends WHERE business_id = ? AND dry_run = 1`).all(id) as { id: string; status: string; dry_run: number }[];

async function waitForRun(runId: string, statuses: string[], timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getBatchRun(runId);
    if (run && statuses.includes(run.status)) return run;
    await sleep(2000);
  }
  return getBatchRun(runId);
}

// Tue 16 Jun 2026 11:00 BA — generic + lawyer windows both open (governor injection).
const WINDOW_OPEN = Date.UTC(2026, 5, 16, 14, 0, 0);
const GATE_PREFIX = 'batchgate-';

async function main() {
  if (env.OUTREACH_DRY_RUN) {
    console.error('Run this on a LIVE process (OUTREACH_DRY_RUN unset). It proves per-batch dry-run on env=false.');
    process.exit(1);
  }
  console.log(`\n=== BATCH LIVE GATE === (GEMINI_RPM=${env.GEMINI_RPM}, GEMINI_RPD=${env.GEMINI_RPD}, dailyCap=${env.OUTREACH_DAILY_CAP})\n`);

  // ── select real leads with a done premium analysis carrying evidence ──────────
  const leadIds = (sqlite.prepare(`
    SELECT b.id FROM businesses b
    WHERE b.website IS NOT NULL AND b.website != ''
      AND b.emails_json IS NOT NULL AND b.emails_json NOT IN ('[]', '')
      AND EXISTS (
        SELECT 1 FROM premium_analyses p
        WHERE p.business_id = b.id AND p.status = 'done'
          AND (p.vision_json IS NOT NULL OR p.psi_json IS NOT NULL OR p.detected_sigs_json IS NOT NULL)
      )
    LIMIT 12
  `).all() as { id: string }[]).map(r => r.id);

  if (leadIds.length < 3) {
    console.error(`Not enough real leads with done premium analyses (got ${leadIds.length}). STOP.`);
    process.exit(1);
  }
  console.log(`Selected ${leadIds.length} real leads.\n`);

  // snapshot drafts (restore after) + baselines of REAL state
  const draftSnap = new Map<string, ReturnType<typeof getDraft>>();
  for (const id of leadIds) draftSnap.set(id, getDraft(id));
  const baseSent = (sqlite.prepare(`SELECT COUNT(*) n FROM email_sends WHERE status='sent'`).get() as { n: number }).n;
  const baseContacted = (sqlite.prepare(`SELECT COUNT(*) n FROM businesses WHERE outreach_status='contacted'`).get() as { n: number }).n;
  const baseRolling = rollingSentCount24h();
  const baseRpd = getGeminiRpd(pacificDate()); // persisted counter is cumulative across runs/day

  // ── 1. real dry-run batch: state machine advances ─────────────────────────────
  const callsStart = geminiCallCount();
  const tStart = Date.now();
  console.log('Phase 1 — running real dry-run batch (this calls Gemini; please wait)…');
  const runId = startBatch(leadIds, true);
  const run = await waitForRun(runId, ['done', 'paused', 'canceled'], 20 * 60_000);
  assert('batch reached a terminal run status', !!run && (run.status === 'done' || run.status === 'paused'), `status=${run?.status}`);

  const items = getBatchItems(runId);
  console.log('\n  business | final state | disposition | reason');
  console.log('  ' + '-'.repeat(70));
  const tally: Record<string, number> = {};
  for (const it of items) {
    tally[it.state] = (tally[it.state] ?? 0) + 1;
    console.log(`  ${nameOf(it.businessId).slice(0, 28).padEnd(28)} | ${it.state.padEnd(20)} | ${(it.disposition ?? '-').padEnd(18)} | ${it.lastError ?? ''}`);
  }
  console.log('\n  tally:', JSON.stringify(tally));
  assert('every item reached a terminal state (or run paused)', items.every(i =>
    ['queued_for_send', 'skipped_no_evidence', 'held_generic', 'failed'].includes(i.state)) || run?.status === 'paused');

  // ── 2. throttle: calls/min stayed under RPM ───────────────────────────────────
  const calls = geminiCallCount() - callsStart;
  const elapsedMin = (Date.now() - tStart) / 60_000;
  const rate = elapsedMin > 0 ? calls / elapsedMin : 0;
  console.log(`\nPhase 2 — throttle: ${calls} Gemini calls in ${elapsedMin.toFixed(2)} min = ${rate.toFixed(1)}/min (limit ${env.GEMINI_RPM})`);
  assert('Gemini call rate ≤ RPM (with tolerance)', calls === 0 || rate <= env.GEMINI_RPM * 1.5, `rate=${rate.toFixed(1)} limit=${env.GEMINI_RPM}`);
  // RPD reserves once per LOGICAL call; geminiCallCount counts API attempts (incl.
  // 429/5xx retries). The persisted counter is cumulative across runs, so measure
  // THIS run's delta: 0 < delta ≤ attempts (logical calls ≤ attempts).
  const rpdDelta = getGeminiRpd(pacificDate()) - baseRpd;
  assert('RPD counter incremented this run (0 < delta ≤ attempts)', calls === 0 || (rpdDelta > 0 && rpdDelta <= calls), `delta=${rpdDelta} attempts=${calls}`);

  // ── 3. handoff: queued items → scheduled_sends(dry_run=1); others → none ───────
  console.log('\nPhase 3 — handoff into scheduled_sends');
  const queued = items.filter(i => i.state === 'queued_for_send');
  const notQueued = items.filter(i => ['held_generic', 'skipped_no_evidence', 'failed'].includes(i.state));
  for (const it of queued) assert(`queued ${nameOf(it.businessId).slice(0, 20)} has dry_run=1 sched row`, schedRowsFor(it.businessId).length >= 1);
  for (const it of notQueued) assert(`non-queued ${nameOf(it.businessId).slice(0, 18)} has NO batch sched row`, schedRowsFor(it.businessId).length === 0);
  console.log(`  queued=${queued.length} held/skipped/failed=${notQueued.length}`);

  // ── 4. per-batch dry-run on a LIVE process: worker dry-sends, real state safe ──
  console.log('\nPhase 4 — per-batch dry-run honored on live process (env=false)');
  let droveOne = false;
  for (const it of queued.slice(0, 2)) {
    const sched = schedRowsFor(it.businessId)[0];
    if (!sched) continue;
    rescheduleScheduledSend(sched.id, new Date(WINDOW_OPEN - 60_000).toISOString());
    await processJob(getScheduledSendById(sched.id)!, WINDOW_OPEN);
    assert(`worker dry-sent ${nameOf(it.businessId).slice(0, 18)} (no real SMTP)`, dryrunRowsFor(it.businessId) >= 1);
    droveOne = true;
  }
  if (!droveOne) console.log('  (no queued items to drive — skipping worker dry-send assertion)');
  assert('dryrun rows did NOT raise the REAL rolling cap on a live process', rollingSentCount24h() === baseRolling, `was ${baseRolling}, now ${rollingSentCount24h()}`);

  // ── 5. crash-between enqueue+mark, and resume idempotency ─────────────────────
  console.log('\nPhase 5 — enqueue+mark atomicity + idempotency');
  sqlite.prepare(`INSERT INTO businesses (id, job_id, name, emails_json, loc_country, scraped_at) VALUES (?, 'gate', 'Crash Co', '["c@example.test"]', 'Argentina', ?)`)
    .run(GATE_PREFIX + 'crash', new Date().toISOString());
  const craRun = createBatchRun({ size: 1, dryRun: true, total: 1 });
  addBatchItems(craRun.id, [GATE_PREFIX + 'crash']);
  const craItem = getBatchItems(craRun.id)[0];
  const itemRef = { id: craItem.id, batchId: craRun.id };
  // simulate a crash AFTER the scheduled_sends insert, BEFORE the item transition
  const before = schedRowsFor(GATE_PREFIX + 'crash').length;
  try {
    sqlite.transaction(() => {
      createScheduledSend({ businessId: GATE_PREFIX + 'crash', scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: true });
      throw new Error('simulated crash mid-transaction');
    })();
  } catch { /* expected */ }
  assert('crash mid-txn rolled back the scheduled_sends insert', schedRowsFor(GATE_PREFIX + 'crash').length === before);
  assert('item state unchanged by rolled-back crash', getBatchItems(craRun.id)[0].state === 'pending');
  // now enqueue properly → exactly one row, item queued
  const r1 = enqueueForSend({ item: itemRef, scheduled: { businessId: GATE_PREFIX + 'crash', scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: true } });
  assert('enqueueForSend created one sched row + queued the item', !r1.alreadyQueued && schedRowsFor(GATE_PREFIX + 'crash').length === before + 1 && getBatchItems(craRun.id)[0].state === 'queued_for_send');
  // resume idempotency: a second enqueue (as a restart would attempt) creates no dup
  const r2 = enqueueForSend({ item: itemRef, scheduled: { businessId: GATE_PREFIX + 'crash', scheduledAtUtc: new Date().toISOString(), businessType: 'generic', windowLabel: 'g', dryRun: true } });
  assert('re-enqueue is a no-op (no duplicate scheduled_sends)', r2.alreadyQueued && schedRowsFor(GATE_PREFIX + 'crash').length === before + 1);

  // ── 6. RPD ceiling → pause → reset → resume ───────────────────────────────────
  console.log('\nPhase 6 — Gemini RPD exhaustion pauses the run; reset resumes it');
  const today = pacificDate();
  const rpdBackup = getGeminiRpd(today);
  setGeminiRpd(today, env.GEMINI_RPD); // fill the budget
  assert('reserveGeminiRpd refuses at ceiling', reserveGeminiRpd(today, env.GEMINI_RPD).ok === false);
  let threw = false;
  try { await withGeminiRate(() => Promise.resolve('x'), 'gate-probe'); } catch (e) { threw = e instanceof GeminiRpdExhausted; }
  assert('withGeminiRate throws GeminiRpdExhausted at ceiling', threw);
  // a fresh batch over 1 real lead must pause (compose hits the exhausted budget)
  const pid = leadIds[0];
  const pSnap = getDraft(pid);
  // pid may already carry a Phase-1 scheduled row (different run). Measure the DELTA
  // this run adds — a per-item idempotent enqueue adds at most one across pause/resume.
  const baseSchedForPid = schedRowsFor(pid).length;
  const pRun = startBatch([pid], true);
  const paused = await waitForRun(pRun, ['paused', 'done'], 90_000);
  assert('batch paused on RPD exhaustion', paused?.status === 'paused' && paused?.pauseReason === 'gemini_rpd_exhausted', `status=${paused?.status} reason=${paused?.pauseReason}`);
  // reset budget and resume → run progresses to terminal, no lost/dup items
  setGeminiRpd(today, rpdBackup);
  resumeBatch(pRun);
  const resumed = await waitForRun(pRun, ['done', 'paused'], 5 * 60_000);
  assert('run resumes to done after RPD reset', resumed?.status === 'done', `status=${resumed?.status}`);
  const pItems = getBatchItems(pRun);
  assert('resumed item reached a terminal state exactly once', pItems.length === 1 &&
    ['queued_for_send', 'held_generic', 'skipped_no_evidence', 'failed'].includes(pItems[0].state), `state=${pItems[0]?.state}`);
  // if it queued, ensure no duplicate scheduled row for it
  if (pItems[0].state === 'queued_for_send') assert('pause/resume added at most ONE sched row for its item', schedRowsFor(pid).length <= baseSchedForPid + 1, `base=${baseSchedForPid} now=${schedRowsFor(pid).length}`);

  // ── 7. real state untouched ───────────────────────────────────────────────────
  console.log('\nPhase 7 — real contacted-state + real send history untouched');
  const nowSent = (sqlite.prepare(`SELECT COUNT(*) n FROM email_sends WHERE status='sent'`).get() as { n: number }).n;
  const nowContacted = (sqlite.prepare(`SELECT COUNT(*) n FROM businesses WHERE outreach_status='contacted'`).get() as { n: number }).n;
  assert('no new real sent rows', nowSent === baseSent, `was ${baseSent}, now ${nowSent}`);
  assert('real contacted-state unchanged', nowContacted === baseContacted, `was ${baseContacted}, now ${nowContacted}`);

  // ── cleanup: remove all gate artifacts; restore real drafts ───────────────────
  console.log('\nCleanup — removing gate artifacts, restoring drafts');
  const allRunIds = [runId, craRun.id, pRun];
  const itemBizIds = new Set<string>([...leadIds, GATE_PREFIX + 'crash']);
  for (const bid of itemBizIds) {
    sqlite.prepare(`DELETE FROM scheduled_sends WHERE business_id = ? AND dry_run = 1`).run(bid);
    sqlite.prepare(`DELETE FROM email_sends WHERE business_id = ? AND status = 'dryrun'`).run(bid);
  }
  for (const rid of allRunIds) {
    sqlite.prepare(`DELETE FROM batch_items WHERE batch_id = ?`).run(rid);
    sqlite.prepare(`DELETE FROM batch_runs WHERE id = ?`).run(rid);
  }
  sqlite.prepare(`DELETE FROM businesses WHERE id = ?`).run(GATE_PREFIX + 'crash');
  // restore drafts: re-write snapshot, or delete if none existed before
  for (const id of leadIds) {
    const snap = draftSnap.get(id) ?? null;
    if (snap) {
      upsertDraft(id, snap.subject, snap.body, snap.isAiDraft);
      saveDraftTopGap(id, snap.topGap);
      saveDraftVerification(id, snap.verificationJson);
    } else {
      deleteDraft(id);
    }
  }
  void pSnap; // snapshot already covered by draftSnap loop (pid ∈ leadIds)

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('GATE CRASHED:', err); process.exit(1); });
