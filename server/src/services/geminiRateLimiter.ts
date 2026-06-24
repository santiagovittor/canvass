import Bottleneck from 'bottleneck';
import pRetry, { AbortError } from 'p-retry';
import { env } from '../env';
import { reserveGeminiRpd, insertGeminiCost } from '../db';
// Namespace import: appSettings depends on this module too (RPM apply side-effect),
// so the cyclic edge must be a lazy property read, never a load-time binding.
import * as appSettings from './appSettings';
import { reportRetry, addCost, currentCostMeta } from './stageTracker';
import { markGeminiExhausted, markGeminiSuccess, refreshGeminiHealth } from './geminiHealth';

// Thrown when the persisted Pacific-date daily budget is hit. The batch orchestrator
// catches this, pauses the run, and resumes after the midnight-Pacific RPD reset.
export class GeminiRpdExhausted extends Error {
  constructor(
    public readonly count: number,
    public readonly ceiling: number,
    public readonly pacificDate: string,
  ) {
    super(`Gemini daily request budget exhausted (${count}/${ceiling}) for ${pacificDate}`);
    this.name = 'GeminiRpdExhausted';
  }
}

// Thrown when Google's *provider-side* quota/billing is exhausted: a genuine 429 whose
// reason is RESOURCE_EXHAUSTED that survived the entire bounded retry budget (a soft
// per-minute 429 clears within the budget and never reaches here). Distinct from the
// app's own GeminiRpdExhausted. The batch orchestrator catches it, pauses with
// 'provider_quota_exhausted', and a recovery timer re-probes until a call succeeds.
export class GeminiProviderExhausted extends Error {
  constructor(public readonly desc: GeminiErrorDesc) {
    super(`Gemini provider quota exhausted (status=${desc.status ?? '?'} reason=${desc.reason ?? '?'})`);
    this.name = 'GeminiProviderExhausted';
  }
}

// RPM enforced in-memory: a reservoir of GEMINI_RPM refilled every 60s, plus minTime
// spacing and a single in-flight call so even a burst can't exceed RPM in the window.
const RPM = env.GEMINI_RPM;
const limiter = new Bottleneck({
  reservoir: RPM,
  reservoirRefreshAmount: RPM,
  reservoirRefreshInterval: 60_000,
  minTime: Math.ceil(60_000 / RPM),
  maxConcurrent: 1,
});

// Live RPM retune from the Settings tab. Updates the reservoir + spacing in place so
// a new rate takes effect on the next refresh window — no restart, no re-import.
export function applyRpm(rpm: number): void {
  if (!Number.isFinite(rpm) || rpm < 1) return;
  void limiter.updateSettings({
    reservoir: rpm,
    reservoirRefreshAmount: rpm,
    minTime: Math.ceil(60_000 / rpm),
  });
}

// Live concurrency retune. maxConcurrent=1 keeps vision image calls serialized so a
// single analysis can't burst; raise only to trade serialization for batch throughput.
export function applyConcurrency(n: number): void {
  if (!Number.isFinite(n) || n < 1) return;
  void limiter.updateSettings({ maxConcurrent: Math.floor(n) });
}

// Apply persisted db overrides at boot (the module-load reservoir reads env.GEMINI_RPM,
// so a Settings override would otherwise not take effect until its next write).
export function initLimiterFromSettings(): void {
  applyRpm(appSettings.getNumber('GEMINI_RPM'));
  applyConcurrency(appSettings.getNumber('GEMINI_MAX_CONCURRENT'));
}

// Google resets RPD at midnight Pacific. en-CA yields YYYY-MM-DD.
export function pacificDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
}

// Thrown when a single generateContent call exceeds its per-attempt hard timeout.
// Treated as retryable (transient) but bounded by the total wall-clock cap below.
export class GeminiTimeoutError extends Error {
  constructor(public readonly ms: number, public readonly label: string) {
    super(`Gemini call '${label}' timed out after ${ms}ms`);
    this.name = 'GeminiTimeoutError';
  }
}

// @google/generative-ai surfaces HTTP status on .status, or embedded in the message
// (e.g. "[429 Too Many Requests]"). Retry only on 429 / 5xx / timeout; all else aborts.
function extractStatus(err: unknown): number | null {
  const e = err as { status?: number; statusCode?: number; response?: { status?: number }; message?: string };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.status === 'number') return e.response.status;
  const m = typeof e?.message === 'string' ? e.message.match(/\[(\d{3})\b/) : null;
  return m ? Number(m[1]) : null;
}
function isRetryable(err: unknown): boolean {
  if (err instanceof GeminiTimeoutError) return true;
  const s = extractStatus(err);
  return s === 429 || (s !== null && s >= 500 && s <= 599);
}

// Parse the structured `errorDetails` array on a GoogleGenerativeAIFetchError. Google
// embeds RetryInfo.retryDelay, QuotaFailure (the violated metric + its limit) and
// ErrorInfo.reason here — all of which the old code threw away.
export interface GeminiErrorDesc {
  status: number | null;
  retryDelayMs: number | null;
  quotaMetric: string | null;
  quotaLimitValue: string | null;
  reason: string | null;
}
function parseDuration(s: unknown): number | null {
  const m = /^([\d.]+)s$/.exec(String(s).trim());
  return m ? Math.round(parseFloat(m[1]) * 1000) : null;
}
export function describeGeminiError(err: unknown): GeminiErrorDesc {
  const e = err as { statusText?: string; errorDetails?: unknown[] };
  const details = Array.isArray(e?.errorDetails) ? e.errorDetails : [];
  let retryDelayMs: number | null = null;
  let quotaMetric: string | null = null;
  let quotaLimitValue: string | null = null;
  let reason: string | null = null;

  for (const raw of details) {
    const d = raw as Record<string, unknown>;
    const t = typeof d['@type'] === 'string' ? (d['@type'] as string) : '';
    if (t.endsWith('RetryInfo') && d.retryDelay) {
      retryDelayMs = parseDuration(d.retryDelay);
    }
    if (t.endsWith('QuotaFailure') && Array.isArray(d.violations) && d.violations[0]) {
      const v = d.violations[0] as Record<string, unknown>;
      quotaMetric = (v.quotaMetric as string) ?? (v.subject as string) ?? null;
      quotaLimitValue = (v.quotaValue as string) ?? null;
      if (!quotaLimitValue && typeof v.description === 'string') {
        const m = /limit:?\s*([\d.]+)/i.exec(v.description);
        if (m) quotaLimitValue = m[1];
      }
    }
    if (t.endsWith('ErrorInfo')) {
      const meta = (d.metadata as Record<string, unknown>) ?? {};
      reason = (d.reason as string) ?? reason;
      if (!quotaMetric && meta.quota_metric) quotaMetric = String(meta.quota_metric);
      if (!quotaLimitValue && meta.quota_limit_value) quotaLimitValue = String(meta.quota_limit_value);
    }
  }
  return { status: extractStatus(err), retryDelayMs, quotaMetric, quotaLimitValue, reason };
}
function logGeminiFailure(label: string, d: GeminiErrorDesc, err: unknown, attempt: number): void {
  const parts = [`status=${d.status ?? '?'}`];
  if (d.reason) parts.push(`reason=${d.reason}`);
  if (d.quotaMetric) parts.push(`metric=${d.quotaMetric}`);
  if (d.quotaLimitValue) parts.push(`limit=${d.quotaLimitValue}`);
  if (d.retryDelayMs != null) parts.push(`retryDelay=${(d.retryDelayMs / 1000).toFixed(1)}s`);
  if (err instanceof GeminiTimeoutError) parts.push('cause=timeout');
  console.error(`[gemini] ${label} attempt#${attempt} FAILED ${parts.join(' ')}`);
}

// Per-1M-token USD estimate, keyed by model. ESTIMATE — edit to match current pricing.
const GEMINI_PRICING: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.30, out: 2.50 },
  'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40 },
  'gemini-3.5-flash': { in: 0.30, out: 2.50 },
};
const DEFAULT_PRICING = { in: 0.30, out: 2.50 };
function recordCost(label: string, model: string | undefined, out: unknown): void {
  if (!model) return;
  const um = (out as { response?: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } })?.response?.usageMetadata;
  if (!um) return;
  const inT = um.promptTokenCount ?? 0;
  const outT = um.candidatesTokenCount ?? 0;
  // NIM (slice 0026) is free — ledger NIM rows at $0 instead of the Gemini default estimate.
  const p = model.startsWith('nim:') ? { in: 0, out: 0 } : (GEMINI_PRICING[model] ?? DEFAULT_PRICING);
  const usd = (inT / 1e6) * p.in + (outT / 1e6) * p.out;
  addCost(usd);
  const meta = currentCostMeta();
  // Durable ledger row — the persistent answer to "where did the money go", per
  // stage (label), per model, per lead. Best-effort: never let a logging write
  // break a Gemini call.
  try {
    insertGeminiCost({
      label, model, businessId: meta?.businessId ?? null, analysisId: meta?.analysisId ?? null,
      inTokens: inT, outTokens: outT, usd,
    });
  } catch (e) {
    console.error('[gemini][cost] ledger write failed:', e instanceof Error ? e.message : String(e));
  }
  console.log(`[gemini][cost] ${label} ${model} in=${inT} out=${outT} ~$${usd.toFixed(4)}`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Per-attempt hard timeout. AbortController cancels the underlying fetch (SDK honors
// the signal); the Promise.race rejection is the guarantee — it frees the Bottleneck
// slot even if a fetch never settles, so nothing can wedge the pipeline for minutes.
async function callWithTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, label: string): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new GeminiTimeoutError(ms, label)); }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let calls = 0;
export function geminiCallCount(): number {
  return calls;
}

// Wrap the single generateContent call at each Gemini site. `fn` receives an AbortSignal
// to thread into generateContent. RPD is reserved once per logical call (resume-safe;
// retries ride the margin). Each attempt is hard-timed-out; 429/5xx/timeout retries run
// inside Bottleneck (rate-limited, no 429 storm) with bounded backoff that honors the
// server's RetryInfo.retryDelay, all capped by a total wall-clock budget so a stuck call
// fails safe in seconds — never minutes.
export async function withGeminiRate<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label = 'gemini',
  opts: { timeoutMs?: number; model?: string } = {},
): Promise<T> {
  // Genuinely-unconfigured non-NIM callers degrade as before (no rate/RPD/timeout). A NIM
  // model (slice 0026) is a first-class provider — keep it on the full machinery even when
  // GEMINI_API_KEY is unset, so its calls are still rate/RPD/timeout/cost-governed.
  if (!env.GEMINI_API_KEY && !opts.model?.startsWith('nim:')) return fn(new AbortController().signal);

  const date = pacificDate();
  const rpd = appSettings.getNumber('GEMINI_RPD');
  const reserved = reserveGeminiRpd(date, rpd);
  if (!reserved.ok) {
    refreshGeminiHealth(); // counter is at the ceiling → chip flips to exhausted
    throw new GeminiRpdExhausted(reserved.count, rpd, date);
  }

  const timeoutMs = opts.timeoutMs ?? appSettings.getNumber('GEMINI_TIMEOUT_MS');
  const totalCapMs = appSettings.getNumber('GEMINI_TOTAL_CAP_MS');
  const start = Date.now();

  return runWithRetry(fn, label, opts, { timeoutMs, totalCapMs, start, rpdCount: reserved.count, rpdCeiling: rpd });
}

// Inner retry runner, split out so withGeminiRate can classify the *final* failure:
// a 429/RESOURCE_EXHAUSTED that survives the whole retry budget is provider exhaustion
// (vs. a soft per-minute 429 that clears within the budget and resolves to success).
async function runWithRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  opts: { timeoutMs?: number; model?: string },
  budget: { timeoutMs: number; totalCapMs: number; start: number; rpdCount: number; rpdCeiling: number },
): Promise<T> {
  const { timeoutMs, totalCapMs, start, rpdCount, rpdCeiling } = budget;
  try {
    return await pRetry(
      () => limiter.schedule(async () => {
        calls++;
        console.log(`[gemini] ${label} call #${calls} @ ${new Date().toISOString()} (rpd ${rpdCount}/${rpdCeiling})`);
        try {
          const out = await callWithTimeout(fn, timeoutMs, label);
          recordCost(label, opts.model, out);
          markGeminiSuccess(); // clears any latched provider exhaustion + refreshes the band
          return out;
        } catch (err) {
          // Non-retryable (other 4xx, parse/logic) → abort: p-retry rejects with the
          // original error, preserving each caller's existing degradation behavior.
          if (!isRetryable(err)) throw new AbortError(err instanceof Error ? err : new Error(String(err)));
          throw err; // retryable → onFailedAttempt below, then backoff + re-schedule
        }
      }),
      {
        retries: 4, minTimeout: 1000, maxTimeout: 8000, factor: 2, randomize: true,
        onFailedAttempt: async (error) => {
          // Only fires for retryable errors (p-retry skips this for AbortError).
          const elapsed = Date.now() - start;
          const d = describeGeminiError(error);
          logGeminiFailure(label, d, error, error.attemptNumber);
          // No room for another full attempt within the budget → stop and fail safe now
          // (caller's catch decides hold/degrade) rather than overshoot by a whole attempt.
          if (elapsed + timeoutMs >= totalCapMs) throw new AbortError(error);
          // Honor the server's requested retryDelay, but never wait past the budget.
          if (d.retryDelayMs && d.retryDelayMs > 0) {
            const wait = Math.min(d.retryDelayMs, totalCapMs - elapsed);
            reportRetry(d.retryDelayMs, error.attemptNumber);
            if (wait > 0) await sleep(wait);
          } else {
            reportRetry(null, error.attemptNumber);
          }
        },
      },
    );
  } catch (err) {
    // Final failure after the whole retry budget. A genuine 429 whose reason is
    // RESOURCE_EXHAUSTED here means Google's provider quota is spent — classify it
    // distinctly so the batch pauses (and auto-resumes) instead of dead-lettering
    // each lead. Everything else (timeouts, 5xx, parse/logic) propagates unchanged.
    const d = describeGeminiError(err);
    if (d.status === 429 && d.reason === 'RESOURCE_EXHAUSTED') {
      markGeminiExhausted(d);
      throw new GeminiProviderExhausted(d);
    }
    throw err;
  }
}
