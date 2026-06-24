import { broadcast } from '../sse';
import {
  getBusinessForEmail, getFirstEmailForBusiness, upsertDraft, saveDraftTopGap, saveDraftVerification,
} from '../db';
import { verifyEmailDeliverable } from './emailVerifier';
import {
  createBatchRun, addBatchItems, getBatchRun, transitionItem, setRunStatus,
  listResumableItems, listRunsByStatus, enqueueForSend, type BatchItemRow,
} from '../db/batch';
import {
  getLatestPremiumAnalysis, createPremiumAnalysisRunning, isAnalysisFresh,
  type DetectedSig, type SignalMap,
} from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import { runPremiumAnalysis } from './premiumAnalyzer';
import { rankAnchors } from './anchorRanker';
import { composeVerifiedEmail } from './outreachComposePipeline';
import { resolveBusinessType, describeWindow } from './outreachSchedulingConfig';
import { nextOptimalWindowUtc } from './outreachGovernor';
import { GeminiRpdExhausted, GeminiProviderExhausted } from './geminiRateLimiter';
import { getNumber } from './appSettings';
import { withAnalysis, stageCached } from './stageTracker';

// ── In-house bounded-concurrency semaphore ────────────────────────────────────
// Concurrency is a throttle, not a speed dial: it caps how many leads prepare at
// once. Gemini RPM is independently bounded by the Bottleneck limiter.
function createSemaphore(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (active < max) { active++; resolve(); }
      else queue.push(() => { active++; resolve(); });
    }),
    release: () => {
      active--;
      const next = queue.shift();
      if (next) next();
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
    timer.unref?.();
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

// One driver per run at a time. startBatch/resumeBatch are idempotent against this.
const activeRuns = new Set<string>();
const forceRefreshRuns = new Set<string>();

function broadcastProgress(runId: string): void {
  const run = getBatchRun(runId);
  if (!run) return;
  broadcast('batch:progress', {
    runId,
    status: run.status,
    total: run.total,
    processed: run.processed,
    skippedNoEvidence: run.skippedNoEvidence,
    heldGeneric: run.heldGeneric,
    queuedForSend: run.queuedForSend,
    failed: run.failed,
    pauseReason: run.pauseReason,
  });
}

const runIsRunning = (runId: string): boolean => getBatchRun(runId)?.status === 'running';

// Single item through the prepare state machine. Each stage checks the run is still
// running first, so a pause/cancel stops the item cleanly after its current stage
// (its persisted non-terminal state lets resume pick it up). Failure isolation:
// caller wraps this; a throw → failed (dead-letter), batch continues.
async function processItem(runId: string, item: BatchItemRow, dryRun: boolean): Promise<void> {
  const businessId = item.businessId;
  const itemRef = { id: item.id, batchId: runId };

  const business = getBusinessForEmail(businessId);
  if (!business) {
    transitionItem(itemRef, 'failed', { lastError: 'business_missing', disposition: 'failed' });
    return broadcastProgress(runId);
  }

  // ── email-validity gate (slice 0013): runs FIRST, before analyze/compose/verify,
  // so a dead or placeholder address costs zero Gemini + zero Playwright. 'unknown'
  // (MX ok but SMTP inconclusive/blocked) and 'valid' both proceed — only a
  // definitive 'invalid' is skipped. Reuses the skipped_no_evidence terminal state
  // (already wired to the counter/SSE/UI) with a distinct disposition + log.
  if (!runIsRunning(runId)) return;
  const to = getFirstEmailForBusiness(businessId);
  const validity = to ? await verifyEmailDeliverable(to) : 'invalid';
  if (validity === 'invalid') {
    console.log(`[batch] skipped business=${businessId} reason=bad_email email=${to ?? '<none>'}`);
    transitionItem(itemRef, 'skipped_no_evidence', {
      disposition: 'skipped_bad_email',
      lastError: `email_invalid:${to ?? 'no_email'}`,
    });
    return broadcastProgress(runId);
  }

  // ── analyze: TTL-gated reuse — skip if fresh + complete, else re-run ──
  if (!runIsRunning(runId)) return;
  transitionItem(itemRef, 'analyzing');
  broadcastProgress(runId);

  let premium = getLatestPremiumAnalysis(businessId);
  const ttlDays = getNumber('REUSE_ANALYSIS_TTL_DAYS');
  const forceRefresh = forceRefreshRuns.has(runId);
  const isStale = forceRefresh || !isAnalysisFresh(businessId, ttlDays);

  if (isStale) {
    const fresh = createPremiumAnalysisRunning(businessId);
    await withTimeout(runPremiumAnalysis(fresh), getNumber('BATCH_ANALYZE_TIMEOUT_MS'), 'analyze_timeout');
    premium = getLatestPremiumAnalysis(businessId);
  } else {
    await withAnalysis(businessId, 'premium', async () => {
      stageCached('render');
      stageCached('signatures');
      stageCached('psi');
      stageCached('vision');
    });
  }
  if (!premium || premium.status !== 'done') {
    transitionItem(itemRef, 'failed', { lastError: 'premium_analysis_failed', disposition: 'failed' });
    return broadcastProgress(runId);
  }
  transitionItem(itemRef, 'analyzed');

  const detectedSigs: DetectedSig[] | undefined = premium.detectedSigsJson ? JSON.parse(premium.detectedSigsJson) : undefined;
  const psiData: PsiData | null = premium.psiJson ? JSON.parse(premium.psiJson) as PsiData : null;
  const visionResult: VisionResult | null = premium.visionJson ? JSON.parse(premium.visionJson) as VisionResult : null;
  const signalMap: SignalMap | undefined = premium.signalsJson ? JSON.parse(premium.signalsJson) as SignalMap : undefined;

  // ── pre-compose skip: no assertable anchor ⇒ skip BEFORE spending compose+verify
  // Gemini calls (the specificity guard would only hold it as held_generic anyway).
  const candidates = rankAnchors(
    { category: business.category, locCountry: business.locCountry },
    detectedSigs, psiData, visionResult, signalMap,
  );
  if (candidates.length === 0) {
    transitionItem(itemRef, 'skipped_no_evidence', { disposition: 'skipped_no_evidence' });
    return broadcastProgress(runId);
  }

  // ── compose + verify + specificity guard (the SAME function the /generate route calls) ──
  if (!runIsRunning(runId)) return;
  transitionItem(itemRef, 'composing');
  broadcastProgress(runId);
  const { subject, body, topGap, verdict } = await composeVerifiedEmail(
    business, undefined, detectedSigs, psiData, visionResult, signalMap, businessId,
  );

  if (verdict.disposition !== 'sent_specific') {
    // held_generic / gate-held → terminal, never queued.
    transitionItem(itemRef, 'held_generic', {
      disposition: verdict.disposition ?? 'held_generic',
      lastError: verdict.error ?? null,
    });
    return broadcastProgress(runId);
  }

  // ── handoff: persist the live draft, then enqueue + mark in ONE transaction ──
  if (!runIsRunning(runId)) return;
  upsertDraft(businessId, subject, body, true);
  saveDraftTopGap(businessId, topGap);
  saveDraftVerification(businessId, JSON.stringify(verdict));

  const type = resolveBusinessType(business.category);
  const scheduledAtUtc = new Date(nextOptimalWindowUtc(Date.now(), type)).toISOString();
  enqueueForSend({
    item: itemRef,
    scheduled: { businessId, scheduledAtUtc, businessType: type, windowLabel: describeWindow(type), dryRun, origin: 'auto' },
  });
  broadcastProgress(runId);
}

async function driveRun(runId: string): Promise<void> {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  try {
    const run = getBatchRun(runId);
    if (!run || run.status !== 'running') return;
    const dryRun = run.dryRun === 1;
    const sem = createSemaphore(getNumber('BATCH_PREPARE_CONCURRENCY'));

    const items = listResumableItems(runId);
    await Promise.all(items.map(item => (async () => {
      await sem.acquire();
      try {
        // Re-check at slot acquisition: a pause/cancel mid-run stops launching new items.
        if (!runIsRunning(runId)) return;
        await processItem(runId, item, dryRun);
      } catch (err) {
        if (err instanceof GeminiRpdExhausted) {
          // Budget hit mid-batch: pause the run, leave this item resumable (it never
          // reached a terminal state). Resumes cleanly after the Pacific-midnight reset.
          setRunStatus(runId, 'paused', 'gemini_rpd_exhausted');
          broadcastProgress(runId);
          return;
        }
        if (err instanceof GeminiProviderExhausted) {
          // Google's provider quota is spent (429 RESOURCE_EXHAUSTED past the retry
          // budget): pause resumably, same as RPD, but arm the recovery probe that
          // re-attempts on a backoff until a Gemini call succeeds and auto-resumes.
          setRunStatus(runId, 'paused', PROVIDER_PAUSE_REASON);
          broadcastProgress(runId);
          ensureRecoveryTimer();
          return;
        }
        // Failure isolation: one bad lead → failed (dead-letter), batch continues.
        transitionItem({ id: item.id, batchId: runId }, 'failed', {
          lastError: err instanceof Error ? err.message : String(err),
          disposition: 'failed',
        });
        broadcastProgress(runId);
      } finally {
        sem.release();
      }
    })()));

    // Finalize: if still running and nothing left non-terminal, the run is done.
    if (runIsRunning(runId) && listResumableItems(runId).length === 0) {
      setRunStatus(runId, 'done');
    }
    broadcastProgress(runId);
  } finally {
    activeRuns.delete(runId);
    forceRefreshRuns.delete(runId);
  }
}

// ── Provider-quota recovery probe (slice 0020) ──────────────────────────────────
// Provider exhaustion has no push signal, so a low-frequency server timer re-attempts
// any run paused on 'provider_quota_exhausted'. driveRun re-drives the resumable items;
// if Gemini still 429s, the item re-pauses (no thrash). On a successful call the limiter
// emits gemini:recovered and the run progresses, so the next probe finds nothing and the
// timer stops. Backoff starts at 15m and doubles to a ~1h cap; resets when nothing is
// paused. unref'd so it never holds the process open.
const PROVIDER_PAUSE_REASON = 'provider_quota_exhausted';
const RECOVERY_MIN_MS = 15 * 60_000;
const RECOVERY_MAX_MS = 60 * 60_000;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryBackoffMs = RECOVERY_MIN_MS;

function pausedProviderRuns() {
  return listRunsByStatus(['paused']).filter(r => r.pauseReason === PROVIDER_PAUSE_REASON);
}

function ensureRecoveryTimer(): void {
  if (recoveryTimer !== null) return; // already armed — idempotent across concurrent items
  recoveryBackoffMs = RECOVERY_MIN_MS;
  scheduleRecoveryProbe();
}

function scheduleRecoveryProbe(): void {
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    const paused = pausedProviderRuns();
    if (paused.length === 0) { recoveryBackoffMs = RECOVERY_MIN_MS; return; } // recovered → stop
    console.log(`[batch] gemini recovery probe — re-attempting ${paused.length} run(s) paused on provider quota`);
    for (const run of paused) resumeBatch(run.id);
    recoveryBackoffMs = Math.min(recoveryBackoffMs * 2, RECOVERY_MAX_MS);
    scheduleRecoveryProbe();
  }, recoveryBackoffMs);
  recoveryTimer.unref?.();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startBatch(businessIds: string[], dryRun: boolean, forceRefresh = false): string {
  const run = createBatchRun({ size: businessIds.length, dryRun, total: businessIds.length });
  addBatchItems(run.id, businessIds);
  if (forceRefresh) forceRefreshRuns.add(run.id);
  void driveRun(run.id);
  return run.id;
}

export function pauseBatch(runId: string): boolean {
  const run = getBatchRun(runId);
  if (!run || run.status !== 'running') return false;
  setRunStatus(runId, 'paused', 'user_paused');
  broadcastProgress(runId);
  return true;
}

export function cancelBatch(runId: string): boolean {
  const run = getBatchRun(runId);
  if (!run || run.status === 'done' || run.status === 'canceled') return false;
  setRunStatus(runId, 'canceled', 'user_canceled');
  broadcastProgress(runId);
  return true;
}

export function resumeBatch(runId: string): boolean {
  const run = getBatchRun(runId);
  if (!run || run.status === 'done' || run.status === 'canceled') return false;
  setRunStatus(runId, 'running', null);
  void driveRun(runId);
  return true;
}

// Boot: a run left 'running' by a restart resumes from its persisted item states.
// 'paused' runs stay paused (intentional human/budget hold) until explicitly resumed.
export function resumeInterruptedBatches(): void {
  for (const run of listRunsByStatus(['running'])) {
    void driveRun(run.id);
  }
  // A restart must keep the provider-quota auto-resume alive for runs paused before it.
  if (pausedProviderRuns().length > 0) ensureRecoveryTimer();
}
