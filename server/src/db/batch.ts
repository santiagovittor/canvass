import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sqlite, createScheduledSend, hasActiveScheduledSend } from './index';
import { nowUtcMinus3 } from '../util/time';
import { batchRuns, batchItems } from './schema';

export type BatchRunRow = typeof batchRuns.$inferSelect;
export type BatchItemRow = typeof batchItems.$inferSelect;
export type BatchItemState = BatchItemRow['state'];
export type BatchRunStatus = BatchRunRow['status'];

const NON_TERMINAL_STATES: BatchItemState[] = [
  'pending', 'analyzing', 'analyzed', 'composing', 'composed', 'verifying', 'verified',
];

// Terminal item states → the batch_runs counter column that tracks them. Bumped
// once when an item first reaches the state (resume never re-enters a terminal item).
const TERMINAL_BUMP = {
  queued_for_send: sqlite.prepare<[string, string], void>(
    `UPDATE batch_runs SET queued_for_send = queued_for_send + 1, processed = processed + 1, updated_at = ? WHERE id = ?`),
  skipped_no_evidence: sqlite.prepare<[string, string], void>(
    `UPDATE batch_runs SET skipped_no_evidence = skipped_no_evidence + 1, processed = processed + 1, updated_at = ? WHERE id = ?`),
  held_generic: sqlite.prepare<[string, string], void>(
    `UPDATE batch_runs SET held_generic = held_generic + 1, processed = processed + 1, updated_at = ? WHERE id = ?`),
  failed: sqlite.prepare<[string, string], void>(
    `UPDATE batch_runs SET failed = failed + 1, processed = processed + 1, updated_at = ? WHERE id = ?`),
} as const;

function isTerminalBump(state: BatchItemState): state is keyof typeof TERMINAL_BUMP {
  return state in TERMINAL_BUMP;
}

export function createBatchRun(input: { size: number; dryRun: boolean; total: number }): BatchRunRow {
  const id = randomUUID();
  const now = nowUtcMinus3();
  db.insert(batchRuns).values({
    id, size: input.size, dryRun: input.dryRun ? 1 : 0, total: input.total,
    createdAt: now, updatedAt: now,
  }).run();
  return db.select().from(batchRuns).where(eq(batchRuns.id, id)).get()!;
}

export function addBatchItems(batchId: string, businessIds: string[]): void {
  const now = nowUtcMinus3();
  const unique = [...new Set(businessIds)];
  const txn = sqlite.transaction(() => {
    for (const businessId of unique) {
      db.insert(batchItems).values({
        id: randomUUID(), batchId, businessId, state: 'pending', createdAt: now, updatedAt: now,
      }).run();
    }
  });
  txn();
}

export function getBatchRun(id: string): BatchRunRow | null {
  return db.select().from(batchRuns).where(eq(batchRuns.id, id)).get() ?? null;
}

export function getBatchItems(batchId: string): BatchItemRow[] {
  return db.select().from(batchItems).where(eq(batchItems.batchId, batchId)).all();
}

export function setRunStatus(id: string, status: BatchRunStatus, reason?: string | null): void {
  db.update(batchRuns)
    .set({ status, pauseReason: reason ?? null, updatedAt: nowUtcMinus3() })
    .where(eq(batchRuns.id, id))
    .run();
}

// Non-terminal items of a run — what a restart/resume must re-drive. Terminal and
// queued_for_send items are skipped by their state (idempotency by construction).
export function listResumableItems(batchId: string): BatchItemRow[] {
  return db.select().from(batchItems)
    .where(and(eq(batchItems.batchId, batchId), inArray(batchItems.state, NON_TERMINAL_STATES)))
    .all();
}

export function listRunsByStatus(statuses: BatchRunStatus[]): BatchRunRow[] {
  return db.select().from(batchRuns).where(inArray(batchRuns.status, statuses)).all();
}

// Single source of truth for an item transition. Persists state (+ optional
// disposition/last_error) and, when the target is terminal, bumps the matching run
// counter once. Plain statements — safe to call inside an enclosing transaction.
export function transitionItem(
  item: { id: string; batchId: string },
  state: BatchItemState,
  opts: { disposition?: string | null; lastError?: string | null } = {},
): void {
  const now = nowUtcMinus3();
  const patch: Partial<typeof batchItems.$inferInsert> = { state, updatedAt: now };
  if ('disposition' in opts) patch.disposition = opts.disposition ?? null;
  if ('lastError' in opts) patch.lastError = opts.lastError ?? null;
  db.update(batchItems).set(patch).where(eq(batchItems.id, item.id)).run();
  if (isTerminalBump(state)) TERMINAL_BUMP[state].run(now, item.batchId);
}

// Enqueue + mark in ONE transaction: a crash rolls back both, so batch_item.state is
// the reliable idempotency guard. If the item is already queued_for_send, do nothing
// (resume safety — never create a duplicate scheduled_sends row).
const enqueueTxn = sqlite.transaction((args: {
  item: { id: string; batchId: string };
  scheduled: { businessId: string; scheduledAtUtc: string; businessType: string | null; windowLabel: string | null; dryRun: boolean };
}): { scheduledId: string | null; alreadyQueued: boolean } => {
  const cur = db.select({ state: batchItems.state }).from(batchItems).where(eq(batchItems.id, args.item.id)).get();
  if (cur?.state === 'queued_for_send') return { scheduledId: null, alreadyQueued: true };
  if (hasActiveScheduledSend(args.scheduled.businessId)) return { scheduledId: null, alreadyQueued: true };
  const sched = createScheduledSend(args.scheduled);
  transitionItem(args.item, 'queued_for_send', { disposition: 'sent_specific' });
  return { scheduledId: sched.id, alreadyQueued: false };
});

export function enqueueForSend(args: {
  item: { id: string; batchId: string };
  scheduled: { businessId: string; scheduledAtUtc: string; businessType: string | null; windowLabel: string | null; dryRun: boolean };
}): { scheduledId: string | null; alreadyQueued: boolean } {
  return enqueueTxn(args);
}
