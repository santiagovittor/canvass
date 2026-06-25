/**
 * Timeout-recovery gate (slice 0032 P2). Proves a self-inflicted analyze timeout does
 * NOT dead-letter a lead: the item reverts to 'pending' (recoverable) and only goes
 * terminal after TIMEOUT_RETRIES, tagged 'analyze_timeout_exhausted_after_N' so the
 * operator can tell a genuinely slow site from a broken one.
 *
 * Deterministic: BATCH_ANALYZE_TIMEOUT_MS is forced to 1ms (every analyze attempt times
 * out instantly), on a synthetic forceRefresh lead so the analyze branch always runs.
 * The setting is restored in finally — a leaked 1ms would break real batches.
 *
 * Run with the main server STOPPED:
 *   docker compose run --rm --no-deps server sh -c "cd /app/server && npx tsx src/scripts/batchTimeoutRecoveryGate.ts"
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { sqlite, dataDir, upsertEmailValidity } from '../db';
import { getBatchItems } from '../db/batch';
import { startBatch, cancelBatch } from '../services/batchOrchestrator';
import { getNumber, setSetting } from '../services/appSettings';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const BID = 'totgate-' + randomUUID().slice(0, 8);
const EMAIL = `${BID}@example.test`;
const item = (runId: string) => getBatchItems(runId)[0];

async function main() {
  console.log(`\n=== TIMEOUT-RECOVERY GATE === business=${BID}\n`);
  const backup = getNumber('BATCH_ANALYZE_TIMEOUT_MS');
  // 1000ms is the registry minimum; a full analyze (render + PSI + vision of example.com)
  // always exceeds it, so every attempt times out deterministically.
  const TINY_BUDGET = 1000;
  let runId = '';
  try {
    sqlite.prepare(
      `INSERT INTO businesses (id, job_id, name, website, emails_json, category, loc_country, scraped_at)
       VALUES (?, 'totgate', 'Timeout Co', 'https://example.com', ?, 'Cafetería', 'Argentina', ?)`
    ).run(BID, JSON.stringify([EMAIL]), new Date().toISOString());
    upsertEmailValidity(EMAIL, 'valid', true, 'probe');

    setSetting('BATCH_ANALYZE_TIMEOUT_MS', TINY_BUDGET);
    runId = startBatch([BID], true, /* forceRefresh */ true);

    // Phase 1 — first timeout must RECOVER (pending, attempt_count=1), not dead-letter.
    let recovered = false;
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const it = item(runId);
      if (it?.state === 'pending' && it.attemptCount === 1) { recovered = true; break; }
      if (it?.state === 'failed' && it.attemptCount < 2) break; // dead-lettered too early → fail below
    }
    assert('first analyze_timeout reverted to pending with attempt_count=1 (no dead-letter)', recovered,
      `state=${item(runId)?.state} attempt=${item(runId)?.attemptCount}`);

    // Phase 2 — after TIMEOUT_RETRIES it goes terminal, tagged as a slow exhaustion.
    // Slow to reach: the F2 guard (correctly) blocks the retry's re-render until the
    // first attempt's in-flight analysis settles (~render+PSI+vision), then attempt 2
    // times out and exhausts. Poll generously.
    let exhausted = false;
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      const it = item(runId);
      if (it?.state === 'failed') {
        exhausted = it.lastError === 'analyze_timeout_exhausted_after_2';
        break;
      }
    }
    const it = item(runId);
    assert('exhausted retries → terminal failed, tagged analyze_timeout_exhausted_after_2', exhausted,
      `state=${it?.state} attempt=${it?.attemptCount} lastError=${it?.lastError}`);
  } finally {
    setSetting('BATCH_ANALYZE_TIMEOUT_MS', backup); // CRITICAL: never leave the tiny budget persisted
    if (runId) cancelBatch(runId); // stop any in-run re-drive still spinning
    await sleep(200);
    // cleanup — only this gate's artifacts; runs even if an assertion path threw
    if (runId) {
      sqlite.prepare('DELETE FROM batch_items WHERE batch_id = ?').run(runId);
      sqlite.prepare('DELETE FROM batch_runs WHERE id = ?').run(runId);
    }
    sqlite.prepare('DELETE FROM premium_analyses WHERE business_id = ?').run(BID);
    sqlite.prepare('DELETE FROM email_validity WHERE email = ?').run(EMAIL);
    sqlite.prepare('DELETE FROM businesses WHERE id = ?').run(BID);
    fs.rmSync(path.join(dataDir, 'premium', BID), { recursive: true, force: true }); // render bundles from the timed-out attempts
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  console.log(fail === 0 ? 'OK TIMEOUT-RECOVERY\n' : 'TIMEOUT-RECOVERY GATE FAILED\n');
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('GATE CRASHED:', err); process.exit(1); });
