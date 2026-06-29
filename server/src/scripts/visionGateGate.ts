/**
 * Slice 0053 verification gate — vision is gated to outreach-bound leads.
 *
 * Proves the cost gate end-to-end against REAL leads + REAL render/PSI:
 *  1. A below-bar lead (grade < VISION_MIN_GRADE, outreach_status NULL) run via the AUTO
 *     path is GATED — vision_gated=1, vision_json NULL, and NO new `vision` ledger row.
 *  2. Promoting that same lead via the FORCE path (operator/batch intent) lets vision run.
 *  3. An above-bar lead run via the AUTO path runs vision — proving a grade BAR, not a
 *     blanket off-switch.
 *
 * Claim 1 is deterministic (no Gemini dependency). Claims 2/3 assert the gate DECISION
 * (allowed vs gated); whether the live Gemini call then bills is reported as evidence but
 * environmental (a degraded vision API yields vision_gated=0 + vision_json NULL).
 *
 * Run in the server container:
 *   docker compose -f docker-compose.dev.yml exec server \
 *     sh -c "cd /app/server && npx tsx src/scripts/visionGateGate.ts"
 */
import { sqlite, getOutreachLeads, type OutreachLead } from '../db';
import { createPremiumAnalysisRunning, getLatestPremiumAnalysis } from '../db/premium';
import { runPremiumAnalysis } from '../services/premiumAnalyzer';
import { getString } from '../services/appSettings';

const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

function visionLedger(businessId?: string): { calls: number; usd: number } {
  const where = businessId ? `WHERE label='vision' AND business_id=?` : `WHERE label='vision'`;
  const args = businessId ? [businessId] : [];
  const r = sqlite.prepare<unknown[], { calls: number; usd: number }>(
    `SELECT COUNT(*) calls, ROUND(COALESCE(SUM(usd),0),4) usd FROM gemini_cost_log ${where}`,
  ).get(...args)!;
  return r;
}

// Run one analysis and report what the gate decided + whether vision actually landed.
async function analyze(businessId: string, force: boolean): Promise<{
  renderOutcome: string | null; visionGated: boolean; hasVision: boolean;
}> {
  const row = createPremiumAnalysisRunning(businessId, force);
  await runPremiumAnalysis(row);
  const latest = getLatestPremiumAnalysis(businessId);
  return {
    renderOutcome: latest?.renderOutcome ?? null,
    visionGated: latest?.visionGated === 1,
    hasVision: !!latest?.visionJson,
  };
}

// Pick the first lead that renders OK in the AUTO path, among candidates of the wanted
// grade band. Render failures (non-ok) never reach the gate, so they're skipped.
async function findGatedBelowBar(pool: OutreachLead[], minRank: number): Promise<{
  lead: OutreachLead; outcome: Awaited<ReturnType<typeof analyze>>;
} | null> {
  const candidates = pool
    .filter(l => l.website && l.grade && GRADE_RANK[l.grade] < minRank)
    .sort((a, b) => GRADE_RANK[a.grade!] - GRADE_RANK[b.grade!]) // lowest grade first
    .slice(0, 5);
  for (const lead of candidates) {
    const outcome = await analyze(lead.id, false);
    if (outcome.renderOutcome === 'ok') return { lead, outcome };
    console.log(`  …skip ${lead.name} (render ${outcome.renderOutcome})`);
  }
  return null;
}

async function findAboveBar(pool: OutreachLead[], minRank: number): Promise<{
  lead: OutreachLead; outcome: Awaited<ReturnType<typeof analyze>>;
} | null> {
  const candidates = pool
    .filter(l => l.website && l.grade && GRADE_RANK[l.grade] >= minRank)
    .sort((a, b) => GRADE_RANK[b.grade!] - GRADE_RANK[a.grade!]) // highest grade first
    .slice(0, 5);
  for (const lead of candidates) {
    const outcome = await analyze(lead.id, false);
    if (outcome.renderOutcome === 'ok') return { lead, outcome };
    console.log(`  …skip ${lead.name} (render ${outcome.renderOutcome})`);
  }
  return null;
}

async function main(): Promise<void> {
  const minGrade = getString('VISION_MIN_GRADE');
  const minRank = GRADE_RANK[minGrade] ?? 3;
  console.log(`VISION_MIN_GRADE = ${minGrade} (rank ${minRank})\n`);

  const pool = getOutreachLeads(1, 500, { hasWebsite: true }).rows;
  console.log(`Eligible has-website leads loaded: ${pool.length}`);
  const byGrade = pool.reduce<Record<string, number>>((m, l) => {
    if (l.grade) m[l.grade] = (m[l.grade] ?? 0) + 1; return m;
  }, {});
  console.log(`Grade histogram: ${JSON.stringify(byGrade)}\n`);

  const fails: string[] = [];

  // ── Claim 1: below-bar lead, AUTO path → gated, no vision ledger row ──
  console.log('── Claim 1: below-bar AUTO run is GATED ──');
  const gated = await findGatedBelowBar(pool, minRank);
  if (!gated) {
    fails.push('Claim 1: no below-bar lead rendered ok to test');
  } else {
    // A gated lead must have zero vision ledger rows — absolute, no Gemini dependency.
    const led = visionLedger(gated.lead.id);
    console.log(`  lead: ${gated.lead.name} (grade ${gated.lead.grade})`);
    console.log(`  renderOutcome=${gated.outcome.renderOutcome} visionGated=${gated.outcome.visionGated} hasVision=${gated.outcome.hasVision}`);
    console.log(`  ledger vision rows for this lead: ${led.calls} ($${led.usd})`);
    if (!gated.outcome.visionGated) fails.push('Claim 1: expected visionGated=1');
    if (gated.outcome.hasVision) fails.push('Claim 1: expected no vision_json');
    if (led.calls !== 0) fails.push(`Claim 1: expected 0 vision ledger rows, got ${led.calls}`);

    // ── Claim 2: promote the SAME lead via FORCE → vision allowed ──
    console.log('\n── Claim 2: FORCE promote runs vision ──');
    const ledgerBefore = visionLedger();
    const promoted = await analyze(gated.lead.id, true);
    const ledgerAfter = visionLedger();
    console.log(`  renderOutcome=${promoted.renderOutcome} visionGated=${promoted.visionGated} hasVision=${promoted.hasVision}`);
    console.log(`  global vision ledger: ${ledgerBefore.calls} → ${ledgerAfter.calls} (+${ledgerAfter.calls - ledgerBefore.calls}), $${ledgerBefore.usd} → $${ledgerAfter.usd}`);
    if (promoted.visionGated) fails.push('Claim 2: force run must NOT be gated');
    if (!promoted.hasVision) console.log('  ⚠ vision_json empty — gate allowed it but Gemini degraded (environmental, not a gate failure)');
  }

  // ── Claim 3: above-bar lead, AUTO path → vision runs (bar, not off-switch) ──
  console.log('\n── Claim 3: above-bar AUTO run runs vision ──');
  const above = await findAboveBar(pool, minRank);
  if (!above) {
    fails.push('Claim 3: no above-bar lead rendered ok to test');
  } else {
    console.log(`  lead: ${above.lead.name} (grade ${above.lead.grade})`);
    console.log(`  renderOutcome=${above.outcome.renderOutcome} visionGated=${above.outcome.visionGated} hasVision=${above.outcome.hasVision}`);
    if (above.outcome.visionGated) fails.push('Claim 3: above-bar lead must NOT be gated');
    if (!above.outcome.hasVision) console.log('  ⚠ vision_json empty — gate allowed it but Gemini degraded (environmental)');
  }

  // ── Ledger rollup (overall vision spend share) ──
  const total = sqlite.prepare<[], { usd: number }>(`SELECT ROUND(COALESCE(SUM(usd),0),4) usd FROM gemini_cost_log`).get()!;
  const vision = visionLedger();
  console.log(`\n── Ledger ──`);
  console.log(`  vision: ${vision.calls} calls, $${vision.usd}`);
  console.log(`  all gemini: $${total.usd}`);

  console.log('');
  if (fails.length === 0) {
    console.log('GATE PASS ✓ — vision gated below the bar, forced/above-bar leads run vision.');
  } else {
    console.log('GATE FAIL ✗');
    for (const f of fails) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exitCode = 1; });
