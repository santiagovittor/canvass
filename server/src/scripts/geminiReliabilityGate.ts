/**
 * Gemini reliability + latency gate (dry-run only — never sends SMTP).
 *
 * Part A — deterministic safety tests (no real API spend):
 *   1. describeGeminiError parses RetryInfo.retryDelay + QuotaFailure metric/limit.
 *   2. A 429 carrying retryDelay is honored (bounded) before the retry succeeds.
 *   3. A hung call is killed by the per-attempt timeout and fails within the total
 *      cap — seconds, never minutes.
 *   4. A forced verifier error fails CLOSED: status verifier_failed, send gate held.
 *
 * Part B — real end-to-end timing on live leads: full premium analysis (render →
 *   signatures → psi → vision) + compose → verify → gate, timed per email, ES + EN.
 *
 * Run (in the dev container, Node 20):
 *   docker compose -f docker-compose.dev.yml exec server \
 *     sh -c "cd /app/server && npx tsx src/scripts/geminiReliabilityGate.ts --leads=6"
 *   Optional: --leads=id1,id2  to pin specific business ids.
 */
import { db, getBusinessForEmail, sqlite } from '../db';
import { businesses } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createPremiumAnalysisRunning, getLatestPremiumAnalysis } from '../db/premium';
import type { DetectedSig, SignalMap } from '../db/premium';
import type { PsiData } from '../db/psiCache';
import { runPremiumAnalysis } from '../services/premiumAnalyzer';
import { composeVerifiedEmail } from '../services/outreachComposePipeline';
import { verifyDraft } from '../services/geminiVerifier';
import { evaluateSendGate } from '../services/sendGate';
import { withGeminiRate, describeGeminiError, GeminiTimeoutError } from '../services/geminiRateLimiter';
import * as appSettings from '../services/appSettings';
import type { VisionResult } from '../services/visionClient';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// A stand-in for @google/generative-ai's GoogleGenerativeAIFetchError shape.
class FakeFetchError extends Error {
  status = 429;
  statusText = 'Too Many Requests';
  errorDetails: unknown[];
  constructor(retryDelay: string, limit: string) {
    super(`[429 Too Many Requests] quota exceeded`);
    this.name = 'GoogleGenerativeAIFetchError';
    this.errorDetails = [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_requests_per_model_per_minute', description: `Quota exceeded ... limit: ${limit}` }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_limit_value: limit } },
    ];
  }
}

async function partA(): Promise<void> {
  console.log('\n=== Part A — deterministic safety tests ===');

  // 1. errorDetails extraction
  const d = describeGeminiError(new FakeFetchError('13s', '50'));
  check('describeGeminiError: status', d.status === 429, `status=${d.status}`);
  check('describeGeminiError: retryDelay', d.retryDelayMs === 13000, `retryDelayMs=${d.retryDelayMs}`);
  check('describeGeminiError: quota metric', !!d.quotaMetric, `metric=${d.quotaMetric}`);
  check('describeGeminiError: quota limit', d.quotaLimitValue === '50', `limit=${d.quotaLimitValue}`);

  // 2. 429 honors retryDelay (bounded), then succeeds.
  const prevCap = appSettings.getNumber('GEMINI_TOTAL_CAP_MS');
  appSettings.setSetting('GEMINI_TOTAL_CAP_MS', 30_000);
  let calls = 0;
  const t0 = Date.now();
  const result = await withGeminiRate(async () => {
    calls++;
    if (calls === 1) throw new FakeFetchError('1.5s', '50'); // retryable, asks for 1.5s
    return 'ok';
  }, 'gate-429', { timeoutMs: 5000 });
  const waited = Date.now() - t0;
  check('429 retry succeeded', result === 'ok', `calls=${calls}`);
  check('429 honored retryDelay (>=1.4s)', waited >= 1400, `waited=${waited}ms`);
  check('429 stayed bounded (<10s)', waited < 10_000, `waited=${waited}ms`);

  // 3. Hung call → per-attempt timeout, total fails within the cap (seconds).
  // 10_000 is the field minimum; still proves "seconds, not minutes".
  appSettings.setSetting('GEMINI_TOTAL_CAP_MS', 10_000);
  const t1 = Date.now();
  let timedOut = false;
  try {
    await withGeminiRate(() => new Promise<string>(() => { /* never resolves */ }), 'gate-hang', { timeoutMs: 1_500 });
  } catch (err) {
    timedOut = true;
    const msg = err instanceof Error ? err.message : String(err);
    check('hang surfaced as timeout', /timed out/.test(msg) || err instanceof GeminiTimeoutError, msg.slice(0, 80));
  }
  const hangMs = Date.now() - t1;
  check('hung call rejected', timedOut);
  // Bound = cap + at most one in-flight attempt + one backoff (seconds, never minutes).
  check('hung call bounded to seconds (<20s)', hangMs < 20_000, `elapsed=${hangMs}ms`);
  appSettings.setSetting('GEMINI_TOTAL_CAP_MS', prevCap);

  // 4. Forced verifier error fails CLOSED (verifier_failed → send gate held).
  appSettings.setSetting('GEMINI_VERIFIER_MODEL', 'gemini-does-not-exist-xyz');
  try {
    const verdict = await verifyDraft(
      { subject: 'x', body: 'Su sitio carga lento.' },
      [{ text: 'Su sitio carga lento.', evidenceRef: 'psi' } as never],
      {},
    );
    check('forced verifier error → verifier_failed', verdict.status === 'verifier_failed', `status=${verdict.status}`);
    const gate = evaluateSendGate({ isAiDraft: true, verificationJson: JSON.stringify(verdict) } as never);
    check('send gate holds verifier_failed (fail-closed)', gate.allowed === false, gate.allowed ? '' : (gate.reason ?? ''));
  } finally {
    appSettings.resetSetting('GEMINI_VERIFIER_MODEL');
  }
}

function pickLeads(arg: string | undefined): string[] {
  if (arg && /[^0-9]/.test(arg)) return arg.split(',').map(s => s.trim()).filter(Boolean);
  const n = arg ? parseInt(arg, 10) : 6;
  // Prefer a mix of Argentina (ES) + non-Argentina (EN) leads that have a website.
  const q = (country: string, isAr: boolean, lim: number) =>
    sqlite.prepare(
      `SELECT id FROM businesses WHERE website IS NOT NULL AND website != ''
       AND loc_country ${isAr ? '=' : 'IS NOT'} ? ORDER BY scraped_at DESC LIMIT ?`,
    ).all(country, lim) as { id: string }[];
  const ar = q('Argentina', true, Math.ceil(n / 2)).map(r => r.id);
  const en = q('Argentina', false, n - ar.length).map(r => r.id);
  return [...ar, ...en];
}

async function partB(leadArg: string | undefined): Promise<void> {
  console.log('\n=== Part B — real end-to-end timing (dry-run, never sends) ===');
  const ids = pickLeads(leadArg);
  if (ids.length === 0) { console.log('  (no leads with websites found — skipping Part B)'); return; }

  const timings: number[] = [];
  let sawEs = false, sawEn = false;
  for (const id of ids) {
    const business = getBusinessForEmail(id);
    const exists = db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, id)).get();
    if (!business || !exists) { console.log(`  ${id}: not found — skip`); continue; }
    const lang = business.locCountry === 'Argentina' ? 'es' : 'en';

    const t0 = Date.now();
    try {
      const analysisRow = createPremiumAnalysisRunning(id, true); // slice 0053: gate exercises vision → force
      await runPremiumAnalysis(analysisRow);

      const premium = getLatestPremiumAnalysis(id);
      const detectedSigs: DetectedSig[] | undefined = premium?.detectedSigsJson ? JSON.parse(premium.detectedSigsJson) : undefined;
      const psiData: PsiData | null = premium?.psiJson ? JSON.parse(premium.psiJson) : null;
      const visionResult: VisionResult | null = premium?.visionJson ? JSON.parse(premium.visionJson) : null;
      const signalMap: SignalMap | undefined = premium?.signalsJson ? JSON.parse(premium.signalsJson) : undefined;

      const result = await composeVerifiedEmail(business, undefined, detectedSigs, psiData, visionResult, signalMap, id);
      const secs = (Date.now() - t0) / 1000;
      timings.push(secs);
      if (lang === 'es') sawEs = true; else sawEn = true;
      console.log(`  [${lang}] ${business.name}: ${secs.toFixed(1)}s — disposition=${result.verdict.disposition ?? result.verdict.status}`);
    } catch (err) {
      console.log(`  ✗ ${id}: UNHANDLED ERROR — ${err instanceof Error ? err.message : String(err)}`);
      failures++;
    }
  }

  if (timings.length) {
    const max = Math.max(...timings);
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
    console.log(`\n  runs=${timings.length} avg=${avg.toFixed(1)}s max=${max.toFixed(1)}s`);
    check('compose→verify passed in Spanish', sawEs);
    check('compose→verify passed in English', sawEn);
    check('no run hung into minutes (max < 90s)', max < 90, `max=${max.toFixed(1)}s`);
    console.log(`  (target: healthy runs < 60s end-to-end)`);
  }
}

async function main(): Promise<void> {
  // The limiter unref()s its per-attempt timeout (correct for prod — a timeout must
  // not keep the server alive). In this short-lived script the hung-call test would
  // otherwise let the event loop drain and exit early; a ref'd keepalive holds it.
  const keepAlive = setInterval(() => {}, 1000);
  const leadArg = process.argv.find(a => a.startsWith('--leads='))?.slice('--leads='.length);
  await partA();
  if (!process.argv.includes('--micro-only')) await partB(leadArg);
  clearInterval(keepAlive);
  console.log(`\n=== ${failures === 0 ? 'GATE PASSED' : `GATE FAILED (${failures} failing checks)`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('reliability gate crashed:', err);
  process.exit(1);
});
