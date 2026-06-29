/**
 * Cost-per-outcome report (slice 0054). Joins the durable gemini_cost_log ledger to the
 * outreach outcome (email_sends.status='sent' / a real reply) and prints cost-per-sent
 * and cost-per-reply by stage×model — so every token cut (NIM swap 0052, vision gate
 * 0053) lands with a *quality* number, not just a dollar number.
 *
 *   docker compose exec server sh -c "cd /app/server && npx tsx src/scripts/costPerOutcome.ts [split]"
 *
 * No arg        → all-time table (reconciles Σ usd against costReport.ts).
 * YYYY-MM-DD    → before/after split at that date (e.g. a slice's deploy date), so you
 *                 can read the cut's effect on cost-per-reply directly.
 * Nd  (e.g. 30d)→ trailing N-day window.
 */
import { getCostPerOutcome, getCostOutcomeTotals, type CostOutcomeRow } from '../db/analytics';
import { getCostRollups } from '../db';

// Below this many replies in a window, cost-per-reply is dominated by noise (~3.5%
// reply rate on a few hundred sends) — flagged, not gated on.
const LOW_REPLY_N = 30;

const usd = (n: number | null) => `$${(n ?? 0).toFixed(4)}`;
const per = (total: number, n: number) => (n > 0 ? `$${(total / n).toFixed(4)}` : '—');
const pct = (num: number, den: number) => (den > 0 ? `${((num / den) * 100).toFixed(0)}%` : '—');

const COLS =
  '  ' + 'stage'.padEnd(16) + 'model'.padEnd(22) +
  'usd'.padStart(10) + 'calls'.padStart(7) + 'leads'.padStart(7) +
  'sent'.padStart(6) + 'repl'.padStart(6) + '$/sent'.padStart(11) + '$/reply'.padStart(12) + 'cache'.padStart(7);

function printTable(title: string, rows: CostOutcomeRow[]): void {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (no billed calls in this window)');
    return;
  }
  console.log(COLS);
  for (const r of rows) {
    console.log(
      '  ' +
      r.label.slice(0, 15).padEnd(16) +
      r.model.slice(0, 21).padEnd(22) +
      usd(r.usd).padStart(10) +
      String(r.calls).padStart(7) +
      String(r.leads).padStart(7) +
      String(r.sentLeads).padStart(6) +
      String(r.repliedLeads).padStart(6) +
      per(r.usd, r.sentLeads).padStart(11) +
      per(r.usd, r.repliedLeads).padStart(12) +
      pct(r.cachedTokens, r.inTokens).padStart(7),
    );
  }
}

// Window-level summary: usd is additive across stages, but distinct sent/replied leads
// are NOT (a lead spans stages) — so the headline cost-per-reply comes from the ungrouped
// totals query, never from summing the rows above.
function printSummary(label: string, since?: string, until?: string): { rowSum: number; total: number } {
  const rows = getCostPerOutcome(since, until);
  const t = getCostOutcomeTotals(since, until);
  printTable(label, rows);
  const totalUsd = t.usd ?? 0;
  console.log(
    `  ${'—'.repeat(96)}\n` +
    `  pipeline: ${usd(totalUsd)} over ${t.calls} calls · ${t.leads} leads · ` +
    `${t.sentLeads} sent · ${t.repliedLeads} replied   ` +
    `cost/sent ${per(totalUsd, t.sentLeads)}   cost/reply ${per(totalUsd, t.repliedLeads)}`,
  );
  if (t.repliedLeads < LOW_REPLY_N) {
    console.log(
      `  ⚠ low N: only ${t.repliedLeads} replies — cost/reply is noisy. ` +
      `Read it as directional, not a decision gate, until N ≥ ${LOW_REPLY_N}.`,
    );
  }
  const rowSum = Number(rows.reduce((a, r) => a + r.usd, 0).toFixed(4));
  return { rowSum, total: Number(totalUsd.toFixed(4)) };
}

const arg = process.argv[2];
const isDate = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg);
const daysM = arg ? /^(\d+)d$/.exec(arg) : null;

console.log('\n=== Cost-per-outcome (gemini_cost_log ⋈ outreach outcome) ===');
console.log('cache = cachedContentTokenCount / prompt tokens (implicit-cache coverage).');

let reconcile: { rowSum: number; total: number; against: number | null } | null = null;

if (isDate) {
  // Before/after split: did the cut move cost-per-reply? `before` is closed at `arg`.
  printSummary(`BEFORE ${arg} (closed window)`, undefined, arg);
  const after = printSummary(`ON/AFTER ${arg} (open window)`, arg);
  // The open AFTER window aligns with getCostRollups(arg) → reconcile that one.
  reconcile = { ...after, against: getCostRollups(new Date(`${arg}T00:00:00Z`).toISOString()).total.usd };
} else {
  const days = daysM ? parseInt(daysM[1], 10) : null;
  const sinceIso = days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;
  const win = printSummary(days ? `Last ${days}d` : 'All time', sinceIso);
  reconcile = { ...win, against: getCostRollups(sinceIso ?? null).total.usd };
}

// Reconciliation: every billed call appears once. The authoritative equality is the
// ungrouped pipeline total vs the independent costReport.ts rollup over the same window
// (both ROUND(SUM(usd),4) over identical rows ⇒ must match exactly). Σ(per-stage usd) is
// an informational cross-check: summing per-stage rounded values drifts sub-cent, so a
// dropped/duplicated stage shows as ≫1¢ drift while ordinary rounding does not.
const against = Number((reconcile.against ?? 0).toFixed(4));
const rowDrift = Math.abs(reconcile.rowSum - reconcile.total);
const ok = reconcile.total === against && rowDrift < 0.005;
console.log('\n— reconciliation —');
console.log(`  pipeline total usd = ${usd(reconcile.total)}   costReport rollup = ${usd(against)}   ${reconcile.total === against ? '✓ exact' : '✗ MISMATCH'}`);
console.log(`  Σ stage usd        = ${usd(reconcile.rowSum)}   (cross-check, drift ${rowDrift.toFixed(4)} from per-stage rounding)`);
console.log(ok ? '  ✓ reconciled' : '  ✗ MISMATCH — investigate before trusting the numbers');
console.log('');
