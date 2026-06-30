import { broadcast } from '../sse';
import {
  getBusinessForEmail, upsertDraft, saveDraftTopGap, saveDraftVerification,
} from '../db';
import { verifyEmailDeliverable, selectBestEmail } from './emailVerifier';
import {
  createBatchRun, addBatchItems, getBatchRun, transitionItem, setRunStatus,
  listResumableItems, listRunsByStatus, enqueueForSend, bumpBatchItemAttempt,
  type BatchItemRow, type BatchRunRow,
} from '../db/batch';
import { UTC_MINUS_3_OFFSET_MS } from '../util/time';
import {
  getLatestPremiumAnalysis, createPremiumAnalysisRunning, isAnalysisFresh, getRunningAnalysis,
  resetAnalysisToPending,
  type DetectedSig, type SignalMap,
} from '../db/premium';
import { kickPremiumAnalysis } from './premiumAnalysisQueue';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import { runPremiumAnalysis } from './premiumAnalyzer';
import { rankAnchors } from './anchorRanker';
import { composeVerifiedEmail } from './outreachComposePipeline';
import { resolveBusinessType, describeWindow } from './outreachSchedulingConfig';
import { nextOptimalWindowUtc } from './outreachGovernor';
import { GeminiRpdExhausted, GeminiProviderExhausted, withGeminiPriority } from './geminiRateLimiter';
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

// Batch Gemini scheduling priority (slice 0031). Lower runs first in the shared limiter;
// 1 jumps all opportunistic backlog vision calls (default 5). The batch is the time-boxed,
// user-facing operation; the backlog is opportunistic and re-runnable.
const BATCH_PRIORITY = 1;

// Self-timeout recovery for COMPOSE (slice 0032). A slow compose that blows the budget
// must not dead-letter the lead: up to TIMEOUT_RETRIES attempts before it goes terminal.
// Between retries driveRun re-drives in-run; a stagnant pass (every remaining item still
// waiting on its in-flight work to finish) sleeps REDRIVE_DELAY_MS before retrying,
// bounded by MAX_STAGNANT_PASSES so a genuine wedge falls through to the stall watchdog
// rather than spinning forever.
// ANALYZE no longer uses this path: it is AWAITED to completion (no abandon-timeout) — see
// processItem. Abandoning an uncancellable analyze left the premium_analyses row stuck
// 'running', which the F2 guard then bounced forever until the stall watchdog mass-failed
// the run. The analyzer is internally bounded (render/PSI/vision each self-timeout), so the
// await always settles; a genuine hang falls through to the run-level stall watchdog.
// ponytail: K and delays are fixed consts, not env/Settings — promote to env only if the
// operator ever needs to tune them live.
const TIMEOUT_RETRIES = 2;
const REDRIVE_DELAY_MS = 3000;
const MAX_STAGNANT_PASSES = 100; // ~300s ceiling; in-flight work always settles well within this
const TIMEOUT_SENTINELS = new Set(['compose_timeout']);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
  const to = await selectBestEmail(businessId);
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
  // Slice 0053: the batch prepares leads for outreach, so they MUST have vision. A prior
  // auto-run may have gated it (vision_gated=1, fresh-but-no-vision) — treat that as stale
  // so the forced re-run below actually fires vision instead of reusing the gated row.
  const isStale = forceRefresh || !isAnalysisFresh(businessId, ttlDays) || premium?.visionGated === 1;

  if (isStale) {
    // F2 (slice 0031): if the auto-analyze queue (or a manual analysis) already owns an
    // in-flight render of this business, do NOT start a second one — createPremiumAnalysisRunning
    // would reuse that same running row id and both renders would write the same bundle dir
    // and call completePremiumAnalysis twice. (A) yield shrinks this to a narrow window (a
    // render in flight when the batch started); here we close it. Skip → leave the item
    // resumable: revert to 'pending' so a later resume re-picks it (by then the row is
    // 'done' + TTL-fresh → instant reuse, no re-render).
    if (getRunningAnalysis(businessId)) {
      transitionItem(itemRef, 'pending');
      return broadcastProgress(runId);
    }
    const fresh = createPremiumAnalysisRunning(businessId, true); // slice 0053: batch = prepare-for-outreach → force vision
    // AWAIT to completion — never abandon. An abandon-timeout here can't cancel the work, so
    // it left an orphaned 'running' row the F2 guard bounced forever (→ stall-watchdog mass
    // kill). The analyzer is internally bounded (render/PSI/vision each self-timeout); a true
    // hang is caught by the run-level stall watchdog. On ANY throw (incl. RPD/provider
    // exhaustion), settle the row back to 'pending' so it is never left orphaned 'running'.
    try {
      await runPremiumAnalysis(fresh);
    } catch (err) {
      resetAnalysisToPending(fresh.id);
      throw err;
    }
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
  const { subject, body, topGap, verdict } = await withTimeout(
    composeVerifiedEmail(business, undefined, detectedSigs, psiData, visionResult, signalMap, businessId),
    getNumber('BATCH_COMPOSE_TIMEOUT_MS'), 'compose_timeout',
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

    // Bounded in-run re-drive (slice 0032). Each pass processes every currently-resumable
    // item; a self-timeout reverts an item to 'pending' (retry) rather than dead-lettering.
    // A pass that terminalizes nothing means every remaining item is still waiting on its
    // in-flight analysis to settle (incl. F2 queue-owned renders) — sleep briefly, retry.
    // That in-flight work is bounded (render/PSI/vision each self-timeout), so it always
    // settles and a later pass progresses. MAX_STAGNANT_PASSES is the safety floor: a true
    // wedge falls through to the 600s stall watchdog instead of spinning forever.
    let stagnantPasses = 0;
    while (runIsRunning(runId)) {
      const items = listResumableItems(runId);
      if (items.length === 0) break;
      const sem = createSemaphore(getNumber('BATCH_PREPARE_CONCURRENCY'));
      await Promise.all(items.map(item => (async () => {
        await sem.acquire();
        try {
          // Re-check at slot acquisition: a pause/cancel mid-run stops launching new items.
          if (!runIsRunning(runId)) return;
          // Priority context propagates across the nested runPremiumAnalysis / composeVerifiedEmail
          // awaits (slice 0031 B), so every batch Gemini call inherits BATCH_PRIORITY.
          await withGeminiPriority(BATCH_PRIORITY, () => processItem(runId, item, dryRun));
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
          const msg = err instanceof Error ? err.message : String(err);
          if (TIMEOUT_SENTINELS.has(msg)) {
            // Self-inflicted COMPOSE slowness (slice 0032): the wall-clock budget fired but
            // the in-flight compose is NOT cancelled and finishes moments later. Don't
            // dead-letter — retry up to TIMEOUT_RETRIES. On the retry the analysis is already
            // 'done' + TTL-fresh → reused with no re-render. Only a lead that can't finish
            // within budget across all attempts goes terminal, tagged so the operator can
            // tell "genuinely slow" from "broken". (Analyze is awaited, never timed out here.)
            const next = (item.attemptCount ?? 0) + 1;
            if (next >= TIMEOUT_RETRIES) {
              transitionItem({ id: item.id, batchId: runId }, 'failed', {
                lastError: `${msg}_exhausted_after_${next}`, disposition: 'failed',
              });
            } else {
              bumpBatchItemAttempt(item.id, next);
              transitionItem({ id: item.id, batchId: runId }, 'pending');
            }
            broadcastProgress(runId);
          } else {
            // Failure isolation: one bad lead → failed (dead-letter), batch continues.
            transitionItem({ id: item.id, batchId: runId }, 'failed', {
              lastError: msg, disposition: 'failed',
            });
            broadcastProgress(runId);
          }
        } finally {
          sem.release();
        }
      })()));

      if (!runIsRunning(runId)) break; // paused/canceled mid-pass
      const remaining = listResumableItems(runId).length;
      if (remaining === 0) break;
      if (remaining >= items.length) {
        // Nothing terminalized this pass — every remaining item is still waiting on its
        // in-flight analysis to settle (incl. F2 queue-owned renders). Pause, then re-drive.
        if (++stagnantPasses > MAX_STAGNANT_PASSES) break;
        await sleep(REDRIVE_DELAY_MS);
      } else {
        stagnantPasses = 0;
      }
    }

    // Finalize: still running with nothing non-terminal left → done.
    if (runIsRunning(runId) && listResumableItems(runId).length === 0) {
      setRunStatus(runId, 'done');
    }
    broadcastProgress(runId);
  } finally {
    activeRuns.delete(runId);
    forceRefreshRuns.delete(runId);
    // Wake the auto-analyze queue (slice 0031): it yields the shared Gemini+Playwright
    // lanes while a batch is `running`, so kick it on every driver exit (done/paused/
    // canceled). Idempotent and self-gating — if another run is still `running`, the
    // queue's isBatchRunning() check makes the kick a no-op.
    kickPremiumAnalysis();
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

// ── Run-level stall watchdog (slice 0023) ───────────────────────────────────────
// A run can wedge with no item progress (a stage hanging past its own timeout, a
// crashed driver) and sit 'running' forever — the operator's 47-min stuck batch. A
// low-frequency sweep finalizes any running run whose updated_at has not advanced
// within BATCH_STALL_TIMEOUT_MS: its non-terminal items fail (last_error='stalled')
// and the run is marked done, so the factory never needs a manual nudge. updated_at
// advances on ANY item transition or status change (not just terminal bumps — see
// transitionItem), so a healthy-but-slow run that is steadily moving items through
// stages keeps resetting the clock and never trips; only a run with NO activity at
// all for the full bound is treated as wedged. Armed by startBatch/resumeBatch,
// re-armed on boot; self-stops when no run is running.
// unref'd so it never holds the process open.
const STALL_SWEEP_MS = 60_000;
let stallTimer: ReturnType<typeof setTimeout> | null = null;

// updated_at is nowUtcMinus3() (a -3h-shifted ISO string); subtract the same offset
// from Date.now() so the delta is offset-invariant.
function runAgeMs(run: BatchRunRow): number {
  return Date.now() - UTC_MINUS_3_OFFSET_MS - Date.parse(run.updatedAt);
}

function sweepStalledRuns(): void {
  const bound = getNumber('BATCH_STALL_TIMEOUT_MS');
  for (const run of listRunsByStatus(['running'])) {
    const age = runAgeMs(run);
    if (age < bound) continue;
    const stuck = listResumableItems(run.id);
    console.warn(`[batch] stall watchdog — run=${run.id} no progress for ${Math.round(age / 1000)}s; failing ${stuck.length} item(s) + finalizing`);
    for (const item of stuck) {
      transitionItem({ id: item.id, batchId: run.id }, 'failed', { lastError: 'stalled', disposition: 'failed' });
    }
    setRunStatus(run.id, 'done');
    broadcastProgress(run.id);
  }
}

function ensureStallWatchdog(): void {
  if (stallTimer !== null) return; // already armed — idempotent across concurrent starts
  scheduleStallSweep();
}

function scheduleStallSweep(): void {
  stallTimer = setTimeout(() => {
    stallTimer = null;
    sweepStalledRuns();
    if (listRunsByStatus(['running']).length > 0) scheduleStallSweep(); // keep watching while work remains
  }, STALL_SWEEP_MS);
  stallTimer.unref?.();
}

// ── Public API ────────────────────────────────────────────────────────────────

export function startBatch(businessIds: string[], dryRun: boolean, forceRefresh = false): string {
  const run = createBatchRun({ size: businessIds.length, dryRun, total: businessIds.length });
  addBatchItems(run.id, businessIds);
  if (forceRefresh) forceRefreshRuns.add(run.id);
  void driveRun(run.id);
  ensureStallWatchdog();
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
  ensureStallWatchdog();
  return true;
}

// Boot: a run left 'running' by a restart resumes from its persisted item states.
// 'paused' runs stay paused (intentional human/budget hold) until explicitly resumed.
export function resumeInterruptedBatches(): void {
  const running = listRunsByStatus(['running']);
  for (const run of running) {
    void driveRun(run.id);
  }
  if (running.length > 0) ensureStallWatchdog();
  // A restart must keep the provider-quota auto-resume alive for runs paused before it.
  if (pausedProviderRuns().length > 0) ensureRecoveryTimer();
}
