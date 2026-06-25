/**
 * F2 contrived-overlap gate (slice 0031 F2, proven here per slice 0032 P3).
 *
 * Proves: when the auto-analyze queue (or a manual analysis) already owns an in-flight
 * 'running' premium_analyses row for a business, a batch that picks the SAME business
 * does NOT start a second render. createPremiumAnalysisRunning would otherwise reuse
 * that same row id and both renders would write the same bundle dir + double-complete.
 * Instead the batch reverts the item to 'pending' (resumable) and renders nothing.
 *
 * Deterministic (no timing race): we SEED a 'running' analysis row to simulate the
 * queue mid-render, force the batch stale (forceRefresh), and assert the guard fired.
 *
 * Run with the main server STOPPED so its queue can't race:
 *   docker compose run --rm --no-deps server sh -c "cd /app/server && npx tsx src/scripts/batchF2OverlapGate.ts"
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { sqlite, dataDir, upsertEmailValidity } from '../db';
import { getBatchItems } from '../db/batch';
import { getRunningAnalysis } from '../db/premium';
import { startBatch, cancelBatch } from '../services/batchOrchestrator';

let pass = 0, fail = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const BID = 'f2gate-' + randomUUID().slice(0, 8);
const EMAIL = `${BID}@example.test`;
const countAnalyses = () =>
  (sqlite.prepare('SELECT count(*) n FROM premium_analyses WHERE business_id = ?').get(BID) as { n: number }).n;
const countCostRows = () =>
  (sqlite.prepare('SELECT count(*) n FROM gemini_cost_log WHERE business_id = ?').get(BID) as { n: number }).n;
const itemState = (runId: string) => getBatchItems(runId)[0]?.state;

async function main() {
  console.log(`\n=== F2 OVERLAP GATE === business=${BID}\n`);

  // Synthetic lead + cached-valid email so the pre-analyze email gate passes without network.
  sqlite.prepare(
    `INSERT INTO businesses (id, job_id, name, website, emails_json, category, loc_country, scraped_at)
     VALUES (?, 'f2gate', 'F2 Overlap Co', 'https://example.com', ?, 'Cafetería', 'Argentina', ?)`
  ).run(BID, JSON.stringify([EMAIL]), new Date().toISOString());
  upsertEmailValidity(EMAIL, 'valid', true, 'probe');

  // Simulate the queue owning an in-flight render: a 'running' analysis row that never completes.
  const runningId = randomUUID();
  sqlite.prepare(
    `INSERT INTO premium_analyses (id, business_id, status, created_at) VALUES (?, ?, 'running', ?)`
  ).run(runningId, BID, new Date().toISOString());

  assert('precondition: exactly one (running) analysis row', countAnalyses() === 1);
  assert('precondition: getRunningAnalysis sees the seeded row', getRunningAnalysis(BID)?.id === runningId);

  // Force the batch stale so it reaches the analyze branch (and the F2 guard) regardless
  // of any TTL, then start it. dryRun=true so nothing is ever sent.
  const runId = startBatch([BID], true, /* forceRefresh */ true);

  // Wait for the F2 revert. The in-run re-drive (0032) keeps reverting every pass since
  // the fake running row never completes — poll for the stable 'pending' state.
  let reverted = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (itemState(runId) === 'pending') { reverted = true; break; }
  }

  assert('batch reverted the item to pending (F2 guard fired, not dead-lettered)', reverted, `state=${itemState(runId)}`);
  assert('batch started NO second render — still exactly one analysis row', countAnalyses() === 1, `count=${countAnalyses()}`);
  assert('seeded running row untouched (not completed/duplicated)', getRunningAnalysis(BID)?.id === runningId);
  assert('no bundle dir written for this business', !fs.existsSync(path.join(dataDir, 'premium', BID)), path.join(dataDir, 'premium', BID));
  assert('no Gemini cost ledger row for this business', countCostRows() === 0, `rows=${countCostRows()}`);

  // Stop the re-drive spin, then clean up every artifact.
  cancelBatch(runId);
  await sleep(200);
  sqlite.prepare('DELETE FROM batch_items WHERE batch_id = ?').run(runId);
  sqlite.prepare('DELETE FROM batch_runs WHERE id = ?').run(runId);
  sqlite.prepare('DELETE FROM premium_analyses WHERE business_id = ?').run(BID);
  sqlite.prepare('DELETE FROM email_validity WHERE email = ?').run(EMAIL);
  sqlite.prepare('DELETE FROM businesses WHERE id = ?').run(BID);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  console.log(fail === 0 ? 'OK F2\n' : 'F2 GATE FAILED\n');
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('GATE CRASHED:', err); process.exit(1); });
