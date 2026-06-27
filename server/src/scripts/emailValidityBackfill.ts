/**
 * One-off (slice 0046): probe-before-rank email-validity backfill. Probes the
 * untouched email pool in paced, bounded batches so the Outreach queue (slice 0045)
 * ranks on real deliverability verdicts instead of treating everything as 'unknown'.
 * Reuses backfillEmailValidity → selectBestEmail → verifyEmailDeliverable — no new
 * probe logic. Idempotent: re-run until it reports "probed 0" (TTL/already-probed
 * no-op). Optional arg = batch cap (default 50).
 *
 *   docker compose -f docker-compose.dev.yml exec -T server sh -c "cd /app/server && npx tsx src/scripts/emailValidityBackfill.ts [limit]"
 */
import { sqlite } from '../db';
import { backfillEmailValidity } from '../services/emailVerifier';

async function main() {
  const limit = Number(process.argv[2]) || 50;
  console.log(`\n=== EMAIL VALIDITY BACKFILL (slice 0046) — limit ${limit} ===\n`);
  const counts = await backfillEmailValidity(limit);
  console.log(`\n=== DONE: ${JSON.stringify(counts)} ===\n`);
  sqlite.pragma('wal_checkpoint(FULL)');
  process.exit(0);
}

main().catch(err => { console.error('BACKFILL CRASHED:', err); process.exit(1); });
