import { randomUUID } from 'crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
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

export function completePremiumAnalysis(id: string, r: {
  status: 'done' | 'failed';
  renderOutcome: string;
  finalUrl: string | null;
  signals: SignalMap;
  cookieWall: boolean;
  consoleErrors: string[];
  paths: { desktop?: string; mobile?: string; html?: string; network?: string };
  errorMessage?: string;
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
    errorMessage: r.errorMessage ?? null,
    completedAt: new Date().toISOString(),
  }).where(eq(premiumAnalyses.id, id)).run();
}

export function getBusinessWebsite(businessId: string): { id: string; website: string | null } | null {
  return db.select({ id: businesses.id, website: businesses.website })
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
