import { env } from '../env';
import {
  reapStaleClaims, getDueScheduledSends, claimScheduledSend, finishScheduledSend,
  deferScheduledSend, resolveScheduledFromScheduled, getOutreachSendRow, getDraft,
  parseEmails, validateEmail, isSuppressed, sentRowExistsForScheduledSend,
  saveEmailExample, deleteDraft, type ScheduledSendRow,
} from '../db';
import { sendEmail } from './emailSender';
import { evaluateSendGate, parseVerdict } from './sendGate';
import { governSend } from './outreachGovernor';
import { resolveBusinessType } from './outreachSchedulingConfig';

// One in-process poller, mirroring startReplyChecker. 30s granularity is far finer
// than the 5–15min pacing it enforces; the atomic claim — not this guard — is the
// real concurrency primitive, so an overlapping tick can never double-send.
const TICK_INTERVAL_MS = 30_000;
const FIRST_TICK_DELAY_MS = 15_000;
// A claim older than this is treated as a crashed transmit of unknown disposition
// and failed (never retried — never email twice). Covers only the transmit window.
const LEASE_MS = 10 * 60_000;

let running = false;

// ── In-process health snapshot ────────────────────────────────────────────────

export interface TickCounts {
  claimed: number; sent: number; deferred: number;
  held: number; errored: number; elapsedMs: number;
}
export interface SchedulerHealth {
  lastTickAt: string | null;
  ticksTotal: number;
  lastTickCounts: TickCounts;
  intervalMs: number;
  nextTickEtaMs: number;
}

let _lastTickAt: string | null = null;
let _ticksTotal = 0;
let _lastTickCounts: TickCounts = { claimed: 0, sent: 0, deferred: 0, held: 0, errored: 0, elapsedMs: 0 };
let _lastTickEndedAt = 0;
let _tickStartedAt = 0;        // for watchdog

const TICK_STUCK_MS = 5 * 60_000; // watchdog threshold: 5 min

export function getSchedulerHealth(): SchedulerHealth {
  const nextTickEtaMs = _lastTickEndedAt > 0
    ? Math.max(0, _lastTickEndedAt + TICK_INTERVAL_MS - Date.now())
    : FIRST_TICK_DELAY_MS;
  return {
    lastTickAt: _lastTickAt,
    ticksTotal: _ticksTotal,
    lastTickCounts: { ..._lastTickCounts },
    intervalMs: TICK_INTERVAL_MS,
    nextTickEtaMs,
  };
}

// nowMs is injectable for tests so the live gate can exercise a real send inside a
// business window regardless of wall-clock; it feeds the GOVERNOR only. Claim/finish
// timestamps stay real (audit). Production callers pass nothing → Date.now().
export async function processJob(job: ScheduledSendRow, nowMs: number = Date.now(), counts?: TickCounts): Promise<void> {
  const bid = job.business_id;

  // ── READ-ONLY phase: status stays 'scheduled'. Terminal/defer transitions are
  // conditional on status='scheduled' (resolveScheduledFromScheduled / defer), so
  // they never pass through 'claimed' and attempt_count counts real sends only.
  const row = getOutreachSendRow(bid);
  if (!row) {
    console.log(`[scheduler] skipped id=${job.id} business=${bid} reason=business_missing`);
    resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'business_missing');
    return;
  }

  const draft = getDraft(bid);
  if (!draft) {
    console.log(`[scheduler] skipped id=${job.id} business=${bid} reason=draft_missing`);
    resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'draft_missing');
    return;
  }

  const to = parseEmails(row.emailsJson)[0];
  if (!to || !validateEmail(to)) {
    console.log(`[scheduler] skipped id=${job.id} business=${bid} reason=no_valid_email`);
    resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'no_valid_email');
    return;
  }

  if (isSuppressed(to)) {
    console.log(`[scheduler] skipped id=${job.id} business=${bid} reason=suppressed`);
    resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'suppressed');
    return;
  }

  // Secondary idempotency, keyed to THIS scheduled send (not the business).
  if (sentRowExistsForScheduledSend(job.id)) {
    console.log(`[scheduler] skipped id=${job.id} business=${bid} reason=already_sent`);
    resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'already_sent');
    return;
  }

  // Live gate (shared with /send). A held/unverified draft never transmits.
  const gate = evaluateSendGate(draft);
  if (!gate.allowed) {
    console.log(`[scheduler] held id=${job.id} business=${bid} reason=${gate.reason}`);
    if (counts) counts.held++;
    resolveScheduledFromScheduled(job.id, 'held', 'held', gate.reason);
    return;
  }

  // Worker-only hardening: the autonomous path additionally requires a surviving,
  // prospect-specific anchor (disposition). Defense-in-depth — even a future writer
  // that stored a bare 'ok' could never be auto-transmitted as a generic husk.
  const verdict = parseVerdict(draft);
  if (verdict?.disposition !== 'sent_specific') {
    console.log(`[scheduler] held id=${job.id} business=${bid} reason=disposition_not_specific`);
    if (counts) counts.held++;
    resolveScheduledFromScheduled(job.id, 'held', 'held', 'disposition_not_specific');
    return;
  }

  // Governor: cap / window / pacing. Defer keeps the row 'scheduled' at a new time.
  const decision = governSend(resolveBusinessType(row.category), nowMs);
  if (decision.action === 'defer') {
    console.log(`[scheduler] deferred id=${job.id} business=${bid} from=${job.scheduled_at} to=${decision.untilUtc} reason=${decision.reason}`);
    if (counts) counts.deferred++;
    deferScheduledSend(job.id, decision.untilUtc, decision.reason);
    return;
  }

  // ── Atomic claim immediately before transmit. changes!==1 ⇒ another tick/restart
  // already owns this row → bail; only the owner sends. This is the exactly-once point.
  if (!claimScheduledSend(job.id, new Date().toISOString())) {
    console.log(`[scheduler] contention id=${job.id}`);
    return;
  }
  if (counts) counts.claimed++;

  // Per-batch dry-run is ORed with the global flag — OR only, so a row may ADD
  // dry-safety but a real row (dry_run=0) can never override a globally-dry process.
  const dryRun = env.OUTREACH_DRY_RUN || job.dry_run === 1;
  try {
    const result = await sendEmail(
      to, draft.subject, draft.body, bid, row.locCountry, false,
      { dryRun, scheduledSendId: job.id },
    );
    if (!result.success) {
      return void finishScheduledSend(job.id, 'failed', 'failed', result.error ?? 'send_failed');
    }
    // Mirror the /send route's post-send side effects — but NOT in dry-run, which
    // must leave real state (drafts, examples, contacted) untouched.
    if (!dryRun) {
      try {
        saveEmailExample({
          businessId: bid,
          category: row.category,
          topGap: draft.topGap,
          neighbourhood: row.locNeighbourhood,
          subject: draft.subject,
          body: draft.body,
          kind: row.outreachStatus === 'contacted' ? 'followup' : 'initial',
        });
      } catch (err) {
        console.error('[scheduler] saveEmailExample failed:', err);
      }
      deleteDraft(bid);
    }
    if (counts) counts.sent++;
    finishScheduledSend(job.id, 'sent', 'sent');
  } catch (err) {
    finishScheduledSend(job.id, 'failed', 'failed', err instanceof Error ? err.message : String(err));
  }
}

export async function tick(nowMs: number = Date.now()): Promise<void> {
  // Watchdog + observable overlap guard:
  // (b) if previous tick hung >5min, force-reset and log WATCHDOG
  // (c) if normal overlap, log and skip — NOT silent
  if (running) {
    const stuckFor = Date.now() - _tickStartedAt;
    if (stuckFor > TICK_STUCK_MS) {
      console.error(`[scheduler] WATCHDOG previous tick stuck ${Math.round(stuckFor / 1000)}s, forcing reset`);
      running = false;
    } else {
      console.log(`[scheduler] tick skipped reason=overlap previous_started=${new Date(_tickStartedAt).toISOString()}`);
      return;
    }
  }
  running = true;
  _tickStartedAt = Date.now();
  const tickStart = _tickStartedAt;
  const counts: TickCounts = { claimed: 0, sent: 0, deferred: 0, held: 0, errored: 0, elapsedMs: 0 };

  try {
    reapStaleClaims(new Date(Date.now() - LEASE_MS).toISOString());
    const due = getDueScheduledSends(new Date().toISOString());
    for (const job of due) {
      try {
        await processJob(job, nowMs, counts);
      } catch (err) {
        counts.errored++;
        console.error(`[scheduler] uncaught error id=${job.id}:`, err instanceof Error ? err.message : err);
        // Attempt to mark failed; may be no-op if row is not in claimed state.
        try { finishScheduledSend(job.id, 'failed', 'failed', err instanceof Error ? err.message : String(err)); } catch { /* safe */ }
      }
    }
  } catch (err) {
    console.error('[scheduler] tick-level error:', err instanceof Error ? err.message : err);
  } finally {
    counts.elapsedMs = Date.now() - tickStart;
    _lastTickAt = new Date().toISOString();
    _lastTickEndedAt = Date.now();
    _ticksTotal++;
    _lastTickCounts = { ...counts };
    console.log(
      `[scheduler] tick claimed=${counts.claimed} sent=${counts.sent} deferred=${counts.deferred} held=${counts.held} errored=${counts.errored} elapsedMs=${counts.elapsedMs}`,
    );
    running = false;
  }
}

export function startScheduledSendWorker(): void {
  const run = () => {
    tick().catch(err => console.error('[scheduler]', err instanceof Error ? err.message : err));
  };
  if (env.OUTREACH_DRY_RUN) console.log('[scheduler] DRY-RUN mode — transmits suppressed');
  setTimeout(run, FIRST_TICK_DELAY_MS).unref();
  setInterval(run, TICK_INTERVAL_MS).unref();
}
