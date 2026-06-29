/**
 * Gemini cost report. Reads the durable gemini_cost_log ledger and prints spend
 * per stage, per model, per day, and the priciest leads. This is the persistent
 * answer to "where does the money go" — recordCost() now writes every billed call.
 *
 *   docker compose exec server sh -c "cd /app/server && npx tsx src/scripts/costReport.ts [days]"
 *
 * Optional arg: number of trailing days to include (default: all time).
 */
import { getCostRollups } from '../db';

const days = process.argv[2] ? parseInt(process.argv[2], 10) : null;
const sinceIso =
  days && Number.isFinite(days) ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

const r = getCostRollups(sinceIso);
const usd = (n: number | null) => `$${(n ?? 0).toFixed(4)}`;

console.log(`\n=== Gemini cost report ${sinceIso ? `(last ${days}d)` : '(all time)'} ===`);
console.log(`TOTAL: ${usd(r.total.usd)} across ${r.total.calls} billed calls\n`);

console.log('By stage:');
for (const s of r.byStage) {
  console.log(`  ${s.label.padEnd(18)} ${usd(s.usd).padStart(10)}  ${String(s.calls).padStart(4)} calls  in=${s.inTokens} out=${s.outTokens} cached=${s.cachedTokens}`);
}

console.log('\nBy model:');
for (const m of r.byModel) {
  console.log(`  ${m.model.padEnd(24)} ${usd(m.usd).padStart(10)}  ${m.calls} calls`);
}

console.log('\nBy day (last 14):');
for (const d of r.byDay) {
  console.log(`  ${d.day}  ${usd(d.usd).padStart(10)}  ${d.calls} calls`);
}

console.log('\nTop 15 leads by spend:');
for (const l of r.topLeads) {
  console.log(`  ${(l.business_id ?? '(no lead ctx)').slice(0, 28).padEnd(28)} ${usd(l.usd).padStart(10)}  ${l.calls} calls`);
}
console.log('');
