import { broadcast } from '../sse';
import {
  getBusinessForEmail, upsertDraft, saveDraftTopGap, saveDraftVerification,
} from '../db';
import {
  createBatchRun, addBatchItems, getBatchRun, transitionItem, setRunStatus,
  listResumableItems, listRunsByStatus, enqueueForSend, type BatchItemRow,
} from '../db/batch';
import {
  getLatestPremiumAnalysis, createPremiumAnalysisRunning,
  type DetectedSig, type SignalMap,
} from '../db/premium';
import type { PsiData } from '../db/psiCache';
import type { VisionResult } from './visionClient';
import { runPremiumAnalysis } from './premiumAnalyzer';
import { rankAnchors } from './anchorRanker';
import { composeVerifiedEmail } from './outreachComposePipeline';
import { resolveBusinessType, describeWindow } from './outreachSchedulingConfig';
import { nextOptimalWindowUtc } from './outreachGovernor';
import { GeminiRpdExhausted } from './geminiRateLimiter';
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

  // ── analyze: TTL-gated reuse — skip if fresh + complete, else re-run ──
  if (!runIsRunning(runId)) return;
  transitionItem(itemRef, 'analyzing');
  broadcastProgress(runId);

  let premium = getLatestPremiumAnalysis(businessId);
  const ttlDays = getNumber('REUSE_ANALYSIS_TTL_DAYS');
  const forceRefresh = forceRefreshRuns.has(runId);
  const isStale =
    !premium
    || premium.status !== 'done'
    || !premium.completedAt
    || ttlDays === 0
    || forceRefresh
    || Date.now() - new Date(premium.completedAt).getTime() > ttlDays * 86400000
    || !premium.detectedSigsJson || !premium.psiJson || !premium.visionJson || !premium.signalsJson;

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
    scheduled: { businessId, scheduledAtUtc, businessType: type, windowLabel: describeWindow(type), dryRun },
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
}
