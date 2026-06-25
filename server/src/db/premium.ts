import { randomUUID } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './index';
import { businesses, premiumAnalyses } from './schema';

// Tri-state signal model. ABSENT_VERIFIED requires render + DOM scan + network
// scan + vision pass ALL agreeing absent — unreachable until the vision pass
// ships, which is intentional: nothing may be claimed verified-absent before then.
export type TriState = 'PRESENT' | 'ABSENT_VERIFIED' | 'UNKNOWN';
export type DetectorKind = 'dom' | 'network' | 'raw_fetch' | 'vision';
export interface SignalEvidence {
  kind: DetectorKind;
  value: string; // DOM snippet | matched network URL | vision justification
}
export interface Signal {
  state: TriState;
  evidence?: SignalEvidence;
  checkedBy: DetectorKind[];
}
export type SignalMap = Record<string, Signal>;

export interface DetectedSig {
  id: string;
  name: string;
  category: string;
  evidence: { kind: 'network' | 'dom'; value: string };
}

export type PremiumAnalysisRow = typeof premiumAnalyses.$inferSelect;

export function enqueuePremiumAnalysis(businessId: string): { id: string; deduped: boolean } {
  const open = db.select({ id: premiumAnalyses.id }).from(premiumAnalyses)
    .where(and(
      eq(premiumAnalyses.businessId, businessId),
      inArray(premiumAnalyses.status, ['pending', 'running']),
    ))
    .get();
  if (open) return { id: open.id, deduped: true };

  const id = randomUUID();
  db.insert(premiumAnalyses).values({
    id,
    businessId,
    status: 'pending',
    createdAt: new Date().toISOString(),
  }).run();
  return { id, deduped: false };
}

// Batch path: get a 'running' row the batch drives itself. If an open (pending/
// running) row already exists — e.g. resetOrphanedRunning flipped a crashed batch's
// row back to 'pending' at boot — REUSE and claim it (pending→running) instead of
// inserting a duplicate. Claiming flips it out of 'pending' so the background
// claimNextPending worker can never also run it (no double Gemini spend on restart).
export function createPremiumAnalysisRunning(businessId: string): PremiumAnalysisRow {
  const existing = db.select().from(premiumAnalyses)
    .where(and(
      eq(premiumAnalyses.businessId, businessId),
      inArray(premiumAnalyses.status, ['pending', 'running']),
    ))
    .orderBy(desc(premiumAnalyses.createdAt))
    .limit(1)
    .get();
  if (existing) {
    if (existing.status === 'pending') {
      db.update(premiumAnalyses).set({ status: 'running' })
        .where(and(eq(premiumAnalyses.id, existing.id), eq(premiumAnalyses.status, 'pending')))
        .run();
    }
    return db.select().from(premiumAnalyses).where(eq(premiumAnalyses.id, existing.id)).get()!;
  }
  const id = randomUUID();
  db.insert(premiumAnalyses).values({
    id,
    businessId,
    status: 'running',
    createdAt: new Date().toISOString(),
  }).run();
  return db.select().from(premiumAnalyses).where(eq(premiumAnalyses.id, id)).get()!;
}

export function countPendingAnalyses(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(premiumAnalyses)
    .where(eq(premiumAnalyses.status, 'pending')).get();
  return row?.n ?? 0;
}

// The latest in-flight ('running') analysis row for a business, or null. Used by the
// batch (slice 0031 F2) to detect that the auto-analyze queue already owns a render of
// this business — so the batch skips a second render of the same row/bundle dir.
export function getRunningAnalysis(businessId: string): PremiumAnalysisRow | null {
  return db.select().from(premiumAnalyses)
    .where(and(eq(premiumAnalyses.businessId, businessId), eq(premiumAnalyses.status, 'running')))
    .orderBy(desc(premiumAnalyses.createdAt))
    .limit(1)
    .get() ?? null;
}

export function countRunningAnalyses(): number {
  const row = db.select({ n: sql<number>`count(*)` }).from(premiumAnalyses)
    .where(eq(premiumAnalyses.status, 'running')).get();
  return row?.n ?? 0;
}

export function claimNextPending(): PremiumAnalysisRow | null {
  const row = db.select().from(premiumAnalyses)
    .where(eq(premiumAnalyses.status, 'pending'))
    .orderBy(premiumAnalyses.createdAt)
    .limit(1)
    .get();
  if (!row) return null;
  db.update(premiumAnalyses).set({ status: 'running' }).where(eq(premiumAnalyses.id, row.id)).run();
  return { ...row, status: 'running' };
}

// Boot: rows orphaned mid-run by a restart go back to pending
export function resetOrphanedRunning(): void {
  db.update(premiumAnalyses).set({ status: 'pending' }).where(eq(premiumAnalyses.status, 'running')).run();
}

// RPD cap during analysis: return this one running row to pending so a later
// kick re-claims it (vs. resetOrphanedRunning which is a boot-wide sweep).
export function resetAnalysisToPending(id: string): void {
  db.update(premiumAnalyses).set({ status: 'pending' }).where(eq(premiumAnalyses.id, id)).run();
}

export function completePremiumAnalysis(id: string, r: {
  status: 'done' | 'failed';
  renderOutcome: string;
  finalUrl: string | null;
  signals: SignalMap;
  cookieWall: boolean;
  consoleErrors: string[];
  paths: { desktop?: string; mobile?: string; html?: string; network?: string };
  detectedSigs: DetectedSig[];
  errorMessage?: string;
  psiJson?: string | null;
  visionJson?: string | null;
}): void {
  db.update(premiumAnalyses).set({
    status: r.status,
    renderOutcome: r.renderOutcome,
    finalUrl: r.finalUrl,
    signalsJson: JSON.stringify(r.signals),
    cookieWall: r.cookieWall ? 1 : 0,
    consoleErrorsJson: JSON.stringify(r.consoleErrors),
    desktopScreenshotPath: r.paths.desktop ?? null,
    mobileScreenshotPath: r.paths.mobile ?? null,
    htmlPath: r.paths.html ?? null,
    networkLogPath: r.paths.network ?? null,
    detectedSigsJson: JSON.stringify(r.detectedSigs),
    psiJson: r.psiJson ?? null,
    visionJson: r.visionJson ?? null,
    errorMessage: r.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  }).where(eq(premiumAnalyses.id, id)).run();
}

export function getBusinessWebsite(businessId: string): { id: string; website: string | null; category: string | null } | null {
  return db.select({ id: businesses.id, website: businesses.website, category: businesses.category })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .get() ?? null;
}

export function getLatestPremiumAnalysis(businessId: string): PremiumAnalysisRow | null {
  return db.select().from(premiumAnalyses)
    .where(eq(premiumAnalyses.businessId, businessId))
    .orderBy(desc(premiumAnalyses.createdAt))
    .limit(1)
    .get() ?? null;
}

// Reuse gate: true when the latest analysis is fresh + complete enough to skip
// re-running. The negation of batchOrchestrator's historic `isStale` predicate,
// minus forceRefresh (a batch-only override that stays in the caller).
export function isAnalysisFresh(businessId: string, ttlDays: number): boolean {
  const premium = getLatestPremiumAnalysis(businessId);
  return !!premium
    && premium.status === 'done'
    && !!premium.completedAt
    && ttlDays !== 0
    && Date.now() - new Date(premium.completedAt).getTime() <= ttlDays * 86400000
    && !!premium.detectedSigsJson && !!premium.psiJson
    && !!premium.visionJson && !!premium.signalsJson;
}
