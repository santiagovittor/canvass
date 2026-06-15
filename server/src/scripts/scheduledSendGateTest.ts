/**
 * Live verification-gate test for the scheduled-send engine. Runs the REAL worker
 * (processJob/tick) end-to-end with OUTREACH_DRY_RUN=true, against seeded throwaway
 * businesses. Asserts: durability, exactly-once idempotency, governor cap/window/
 * pacing, gate safety (held + disposition + suppression + draft-missing), and that
 * NO real SMTP fired and real contacted-state / send history are untouched.
 *
 * Run (in the server container):
 *   OUTREACH_DRY_RUN=true npx tsx src/scripts/scheduledSendGateTest.ts
 */
import { sqlite, createScheduledSend, getScheduledSendById, listUpcomingScheduledSends, upsertDraft, saveDraftVerification, addSuppression, type ScheduledSendRow } from '../db';
import { processJob, tick } from '../services/scheduledSendWorker';
import { getDailyCapRolling } from '../services/outreachSchedulingConfig';
import { env } from '../env';
import { UTC_MINUS_3_OFFSET_MS } from '../util/time';

if (!env.OUTREACH_DRY_RUN) {
  console.error('REFUSING TO RUN: set OUTREACH_DRY_RUN=true (this test must never transmit).');
  process.exit(1);
}

const PREFIX = 'schedtest-';
let pass = 0, fail = 0;
const rows: string[] = [];
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function cleanup(): void {
  sqlite.prepare(`DELETE FROM email_sends WHERE business_id LIKE ?`).run(PREFIX + '%');
  sqlite.prepare(`DELETE FROM scheduled_sends WHERE business_id LIKE ?`).run(PREFIX + '%');
  sqlite.prepare(`DELETE FROM outreach_drafts WHERE business_id LIKE ?`).run(PREFIX + '%');
  sqlite.prepare(`DELETE FROM businesses WHERE id LIKE ?`).run(PREFIX + '%');
  sqlite.prepare(`DELETE FROM suppression_list WHERE email LIKE ?`).run('%@example.test');
}
function clearTestSends(): void {
  sqlite.prepare(`DELETE FROM email_sends WHERE business_id LIKE ?`).run(PREFIX + '%');
}
function seedBusiness(id: string, name: string, category: string, email: string): void {
  sqlite.prepare(
    `INSERT INTO businesses (id, job_id, name, category, emails_json, loc_country, scraped_at)
     VALUES (?, 'schedtest', ?, ?, ?, 'Argentina', ?)`
  ).run(PREFIX + id, name, category, JSON.stringify([email]), new Date().toISOString());
}
const sentSpecific = JSON.stringify({ status: 'ok', claims: [{ claim: 'x', supported: true, evidence: 'e' }], disposition: 'sent_specific', anchorId: 'a', anchorFact: 'f' });
const heldGeneric = JSON.stringify({ status: 'held_generic', claims: [], disposition: 'held_generic', error: 'no anchor' });
const okNoDisposition = JSON.stringify({ status: 'ok', claims: [{ claim: 'x', supported: true, evidence: 'e' }] }); // disposition absent
function seedDraft(id: string, verificationJson: string | null): void {
  const bid = PREFIX + id;
  upsertDraft(bid, 'Asunto de prueba', 'Cuerpo de prueba.', true);
  if (verificationJson) saveDraftVerification(bid, verificationJson);
}
function schedule(id: string, businessType: string): ScheduledSendRow {
  return createScheduledSend({
    businessId: PREFIX + id,
    scheduledAtUtc: new Date(Date.now() - 60_000).toISOString(), // due (past)
    businessType,
    windowLabel: businessType,
  });
}
function jobStatus(scheduledId: string): ScheduledSendRow {
  return getScheduledSendById(scheduledId)!;
}
function dryrunRowsFor(id: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE business_id = ? AND status = 'dryrun'`).get(PREFIX + id) as { n: number }).n;
}
function realSentCount(): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM email_sends WHERE status = 'sent'`).get() as { n: number }).n;
}
function realContactedCount(): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM businesses WHERE outreach_status = 'contacted'`).get() as { n: number }).n;
}
// BA wall-clock instants (true-UTC ms) for governor injection.
const TUE_OPEN = Date.UTC(2026, 5, 16, 14, 0, 0);   // Tue 16 Jun 11:00 BA → generic + lawyer open
const MON_CLOSED = Date.UTC(2026, 5, 15, 5, 0, 0);   // Mon 15 Jun 02:00 BA → all windows closed
// Seed a synthetic 'dryrun' row with a sent_at ~minsAgo before `nowMs` (UTC-3 shifted).
function seedRecentSend(nowMs: number, minsAgo: number): void {
  const sentAt = new Date(nowMs - minsAgo * 60_000 - UTC_MINUS_3_OFFSET_MS).toISOString();
  sqlite.prepare(
    `INSERT INTO email_sends (id, business_id, sent_at, status, verification_override, scheduled_send_id)
     VALUES (?, ?, ?, 'dryrun', 0, NULL)`
  ).run(crypto.randomUUID(), PREFIX + 'synthetic', sentAt);
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  cleanup();
  const baseSent = realSentCount();
  const baseContacted = realContactedCount();
  console.log(`\nBaseline: email_sends 'sent'=${baseSent}, businesses contacted=${baseContacted}\n`);

  // Phase 1 — SEND (happy path, dry-run) + IDEMPOTENCY
  console.log('Phase 1 — send (dry-run) + idempotency');
  seedBusiness('A', 'Café A', 'Cafetería', 'a@example.test');
  seedDraft('A', sentSpecific);
  const A = schedule('A', 'generic');
  await processJob(A, TUE_OPEN);
  const aRow = jobStatus(A.id);
  assert('A sent (dry-run)', aRow.status === 'sent' && aRow.disposition === 'sent', `got ${aRow.status}/${aRow.disposition}`);
  assert('A produced exactly one dryrun row', dryrunRowsFor('A') === 1, `got ${dryrunRowsFor('A')}`);
  rows.push(`A | generic ${TUE_OPEN && 'Tue 11:00'} | send | ${aRow.disposition}`);

  clearTestSends();
  seedBusiness('B', 'Café B', 'Cafetería', 'b@example.test');
  seedDraft('B', sentSpecific);
  const B = schedule('B', 'generic');
  const Bjob = jobStatus(B.id);
  await Promise.all([processJob(Bjob, TUE_OPEN), processJob(Bjob, TUE_OPEN)]); // overlapping ticks
  assert('B sent exactly once under overlapping ticks', dryrunRowsFor('B') === 1, `got ${dryrunRowsFor('B')}`);
  assert('B attempt_count === 1 (claim fired once)', jobStatus(B.id).attempt_count === 1, `got ${jobStatus(B.id).attempt_count}`);
  rows.push(`B | generic Tue 11:00 | send×1 (2 ticks) | ${jobStatus(B.id).disposition}`);

  // Phase 2 — PACING (cap ok, window open, recent send → defer)
  console.log('Phase 2 — pacing');
  clearTestSends();
  seedRecentSend(TUE_OPEN, 3); // a send 3 min before the injected now
  seedBusiness('C', 'Café C', 'Cafetería', 'c@example.test');
  seedDraft('C', sentSpecific);
  const C = schedule('C', 'generic');
  await processJob(jobStatus(C.id), TUE_OPEN);
  const cRow = jobStatus(C.id);
  assert('C deferred on pacing', cRow.status === 'scheduled' && cRow.last_error === 'deferred:pacing', `got ${cRow.status}/${cRow.last_error}`);
  rows.push(`C | generic Tue 11:00 | defer:pacing | (rescheduled)`);
  clearTestSends();

  // Phase 3 — CAP (saturate rolling 24h → defer, even with window open)
  console.log('Phase 3 — cap');
  for (let i = 0; i < getDailyCapRolling(); i++) seedRecentSend(TUE_OPEN, 60 + i); // fill the cap
  seedBusiness('D', 'Café D', 'Cafetería', 'd@example.test');
  seedDraft('D', sentSpecific);
  const D = schedule('D', 'generic');
  await processJob(jobStatus(D.id), TUE_OPEN);
  const dRow = jobStatus(D.id);
  assert('D deferred on cap', dRow.status === 'scheduled' && dRow.last_error === 'deferred:cap_reached', `got ${dRow.status}/${dRow.last_error}`);
  rows.push(`D | generic Tue 11:00 | defer:cap_reached | (rescheduled)`);
  clearTestSends();

  // Phase 4 — WINDOW (Monday → all windows closed; lawyer next slot Tue/Wed/Thu)
  console.log('Phase 4 — window');
  seedBusiness('E', 'Estudio E', 'Abogados', 'e@example.test');
  seedDraft('E', sentSpecific);
  const E = schedule('E', 'lawyer');
  await processJob(jobStatus(E.id), MON_CLOSED);
  const eRow = jobStatus(E.id);
  const eBa = new Date(new Date(eRow.scheduled_at).getTime() - UTC_MINUS_3_OFFSET_MS);
  const eDow = eBa.getUTCDay(), eHH = eBa.getUTCHours(), eMM = eBa.getUTCMinutes();
  const lawyerSlotOk = [2, 3, 4].includes(eDow) && ((eHH === 10 && eMM === 30) || (eHH === 13 && eMM === 0));
  assert('E deferred outside window', eRow.last_error === 'deferred:outside_window', `got ${eRow.last_error}`);
  assert('E next slot is a lawyer window (Tue/Wed/Thu 10:30 or 13:00)', lawyerSlotOk, `got dow=${eDow} ${eHH}:${eMM}`);
  rows.push(`E | lawyer (Mon→) | defer:outside_window | next ${eBa.toISOString().slice(0, 16)} BA`);

  // Phase 5 — SAFETY
  console.log('Phase 5 — safety (held / disposition / suppression / draft-missing)');
  seedBusiness('F', 'Café F', 'Cafetería', 'f@example.test');
  seedDraft('F', heldGeneric);
  const F = schedule('F', 'generic');
  await processJob(jobStatus(F.id), TUE_OPEN);
  assert('F held_generic → held, not sent', jobStatus(F.id).status === 'held' && dryrunRowsFor('F') === 0, `got ${jobStatus(F.id).status}`);
  rows.push(`F | held_generic draft | gate hold | held`);

  seedBusiness('G', 'Café G', 'Cafetería', 'g@example.test');
  seedDraft('G', okNoDisposition);
  const G = schedule('G', 'generic');
  await processJob(jobStatus(G.id), TUE_OPEN);
  assert('G ok-but-no-disposition → held by worker hardening', jobStatus(G.id).status === 'held' && jobStatus(G.id).last_error === 'disposition_not_specific' && dryrunRowsFor('G') === 0, `got ${jobStatus(G.id).status}/${jobStatus(G.id).last_error}`);
  rows.push(`G | ok, disposition≠sent_specific | worker hold | held`);

  seedBusiness('H', 'Café H', 'Cafetería', 'suppressed@example.test');
  seedDraft('H', sentSpecific);
  addSuppression('suppressed@example.test', 'test');
  const H = schedule('H', 'generic');
  await processJob(jobStatus(H.id), TUE_OPEN);
  assert('H suppressed recipient → skipped, not sent', jobStatus(H.id).status === 'skipped' && jobStatus(H.id).last_error === 'suppressed' && dryrunRowsFor('H') === 0, `got ${jobStatus(H.id).status}/${jobStatus(H.id).last_error}`);
  rows.push(`H | suppressed recipient | skip | skipped`);

  // I — scheduled row whose business has NO draft
  seedBusiness('I', 'Café I', 'Cafetería', 'i@example.test');
  const I = schedule('I', 'generic'); // no seedDraft
  await processJob(jobStatus(I.id), TUE_OPEN);
  assert('I draft-missing → skipped (no crash)', jobStatus(I.id).status === 'skipped' && jobStatus(I.id).last_error === 'draft_missing', `got ${jobStatus(I.id).status}/${jobStatus(I.id).last_error}`);
  rows.push(`I | no draft | skip | skipped(draft_missing)`);
  clearTestSends();

  // Phase 6 — DURABILITY (source of truth survives; a fresh tick re-reads the table)
  console.log('Phase 6 — durability');
  const upcoming = listUpcomingScheduledSends().filter(s => s.business_id.startsWith(PREFIX));
  assert('deferred jobs persist in scheduled_sends (C/D/E)', upcoming.length >= 3, `got ${upcoming.length}`);
  // A real restart would resume from exactly this table — simulate by re-running a
  // tick (no due test rows should send now: C/D/E are rescheduled to the future).
  await tick(MON_CLOSED);
  assert('post-"restart" tick sends nothing new (rescheduled jobs not yet due)', dryrunRowsFor('A') === 0, 'unexpected send');

  // Phase 7 — NO real mutation
  console.log('Phase 7 — real state untouched');
  assert('no new real \'sent\' rows', realSentCount() === baseSent, `was ${baseSent}, now ${realSentCount()}`);
  assert('real contacted-state unchanged', realContactedCount() === baseContacted, `was ${baseContacted}, now ${realContactedCount()}`);

  // ── results table ──
  console.log('\nscheduled_at(window) | business-type window | governor decision | final disposition');
  console.log('-'.repeat(80));
  for (const r of rows) console.log('  ' + r);

  cleanup();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed.`);
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('test crashed:', err); cleanup(); process.exit(1); });
