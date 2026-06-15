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

// nowMs is injectable for tests so the live gate can exercise a real send inside a
// business window regardless of wall-clock; it feeds the GOVERNOR only. Claim/finish
// timestamps stay real (audit). Production callers pass nothing → Date.now().
export async function processJob(job: ScheduledSendRow, nowMs: number = Date.now()): Promise<void> {
  const businessId = job.business_id;

  // ── READ-ONLY phase: status stays 'scheduled'. Terminal/defer transitions are
  // conditional on status='scheduled' (resolveScheduledFromScheduled / defer), so
  // they never pass through 'claimed' and attempt_count counts real sends only.
  const row = getOutreachSendRow(businessId);
  if (!row) return void resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'business_missing');

  const draft = getDraft(businessId);
  if (!draft) return void resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'draft_missing');

  const to = parseEmails(row.emailsJson)[0];
  if (!to || !validateEmail(to)) return void resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'no_valid_email');

  if (isSuppressed(to)) return void resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'suppressed');

  // Secondary idempotency, keyed to THIS scheduled send (not the business).
  if (sentRowExistsForScheduledSend(job.id)) return void resolveScheduledFromScheduled(job.id, 'skipped', 'skipped', 'already_sent');

  // Live gate (shared with /send). A held/unverified draft never transmits.
  const gate = evaluateSendGate(draft);
  if (!gate.allowed) return void resolveScheduledFromScheduled(job.id, 'held', 'held', gate.reason);

  // Worker-only hardening: the autonomous path additionally requires a surviving,
  // prospect-specific anchor (disposition). Defense-in-depth — even a future writer
  // that stored a bare 'ok' could never be auto-transmitted as a generic husk.
  const verdict = parseVerdict(draft);
  if (verdict?.disposition !== 'sent_specific') {
    return void resolveScheduledFromScheduled(job.id, 'held', 'held', 'disposition_not_specific');
  }

  // Governor: cap / window / pacing. Defer keeps the row 'scheduled' at a new time.
  const decision = governSend(resolveBusinessType(row.category), nowMs);
  if (decision.action === 'defer') {
    return void deferScheduledSend(job.id, decision.untilUtc, decision.reason);
  }

  // ── Atomic claim immediately before transmit. changes!==1 ⇒ another tick/restart
  // already owns this row → bail; only the owner sends. This is the exactly-once point.
  if (!claimScheduledSend(job.id, new Date().toISOString())) return;

  // Per-batch dry-run is ORed with the global flag — OR only, so a row may ADD
  // dry-safety but a real row (dry_run=0) can never override a globally-dry process.
  const dryRun = env.OUTREACH_DRY_RUN || job.dry_run === 1;
  try {
    const result = await sendEmail(
      to, draft.subject, draft.body, businessId, row.locCountry, false,
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
          businessId,
          category: row.category,
          topGap: draft.topGap,
          neighbourhood: row.locNeighbourhood,
          subject: draft.subject,
          body: draft.body,
          kind: row.outreachStatus === 'contacted' ? 'followup' : 'initial',
        });
      } catch (err) {
        console.error('[scheduledSend] saveEmailExample failed:', err);
      }
      deleteDraft(businessId);
    }
    finishScheduledSend(job.id, 'sent', 'sent');
  } catch (err) {
    finishScheduledSend(job.id, 'failed', 'failed', err instanceof Error ? err.message : String(err));
  }
}

export async function tick(nowMs: number = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    reapStaleClaims(new Date(Date.now() - LEASE_MS).toISOString());
    const due = getDueScheduledSends(new Date().toISOString());
    for (const job of due) {
      await processJob(job, nowMs);
    }
  } finally {
    running = false;
  }
}

export function startScheduledSendWorker(): void {
  const run = () => {
    tick().catch(err => console.error('[scheduledSend]', err instanceof Error ? err.message : err));
  };
  if (env.OUTREACH_DRY_RUN) console.log('[scheduledSend] DRY-RUN mode — transmits suppressed');
  setTimeout(run, FIRST_TICK_DELAY_MS).unref();
  setInterval(run, TICK_INTERVAL_MS).unref();
}
