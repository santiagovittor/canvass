# Slice 0027: Second sender + rotation (santiagovittordev@gmail.com)

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F5**. Best after `0014` (reply visibility) so per-sender attribution
> is observable.

## Operator action required (at implementation start, not before)

Before Step 2 can run, the operator must, on **santiagovittordev@gmail.com**:
1. Enable 2-Step Verification.
2. Generate a 16-character **App Password** (Google Account → Security → App
   passwords).
3. Hand the App Password to the implementer to put in env/Settings (secret).
App Password is the reliable, low-friction path (same mechanism as the current
sender). OAuth2 is the heavier alternative and is **not** used here unless the
operator later asks.

## Intent

**Plain English.** Send from two Gmail accounts instead of one, splitting the
daily volume so each account stays under its safe limit and reputation is spread
across both — the operator's goal of ~100 emails/day across the two (a soft
average target, ramped up with warmup, not a hard switch). The app currently knows
only one sender; this slice teaches it a list of senders, picks which account each
email goes from, counts the daily cap *per account*, and scans *both* inboxes for
replies and bounces.

**Project vocabulary.** Replace the single `GMAIL_FROM`/`GMAIL_APP_PASSWORD` send
identity with a senders list; add a rotation policy in the send path
(`emailSender` / `scheduledSendWorker`); persist the sender per send (additive
column on `email_sends` + `scheduled_sends`); make `outreachGovernor`'s cap
per-sender; extend `replyChecker` to scan every sender's inbox.

## Out of scope

- More than two senders' worth of generality (build for a list, but only two are
  configured).
- A warmup *tool* — document the ramp; don't build automated warmup.
- Microsoft/Workspace senders (operator's second account is Gmail; the 60/40
  Google/MS mix from the research is a future note, not this slice).
- Reply visibility UI — that is `0014`.

## Constraints (`docs/SPEC.md` + `rules/architecture.md`)

- **Reuse** `emailSender.sendEmail`, `outreachGovernor.governSend` /
  `capRemaining`, `scheduledSendWorker`, `replyChecker` — extend, do not fork the
  send/reply paths.
- **Additive schema only** — new `email_sends.sender` (or `from_address`) and the
  same on `scheduled_sends`; backfill existing rows to the current `GMAIL_FROM`.
- **Env validated by zod at boot** — a senders list (`GMAIL_SENDERS` JSON, or a
  second `GMAIL_FROM_2`/`GMAIL_APP_PASSWORD_2` pair) with a clear error if a
  configured sender is missing its password.
- **Per-sender cap** — the rolling-24h cap (`OUTREACH_DAILY_CAP`,
  `outreachGovernor.ts:57-59`, currently global) becomes per-sender; the
  GMAIL hard ceiling stays per account.
- **Dry-run rules** unchanged (`OUTREACH_DRY_RUN` records a `dryrun` row per
  sender, never transmits, never flips contacted-state).
- **Secrets** handled like the existing `GMAIL_APP_PASSWORD` (settings registry
  `isSecret`).

## Diagnose-first checklist

Mostly done in `0022` F5. Confirm before editing:

- [x] Files read (all listed). Sender reads found via grep: `emailSender` (transport+from),
      `replyChecker` (IMAP auth + `ownAddress`), `emailVerifier` (probe MAIL FROM — left as
      primary, it's a probe not a send), `index.ts:60` (display — left, reply UI is 0014).
- [x] Symbols catalogued: `getTransport`/`recordEmailSend`/`rollingSentCount24h` →
      sender-aware; `lastSentAtAny` → **kept global** (pacing); `ownAddress` → per sender.
- [x] Rotation policy: **least-loaded-today**. Strict `>` keeps lowest index on ties; since
      a send drops that sender's remaining by one, equal caps self-alternate without
      round-robin state.
- [x] Pacing: **global** across all senders (`lastSentAtAny` unchanged) — total cadence
      stays human.
- [x] Warmup ramp documented (see "Warmup ramp" section below).
- [x] Open questions confirmed — App Password, two Gmail senders, ~100/day soft average.

## Implementation plan

_Operator approves before edits._

- **Step 1 — Senders config.** Add the senders list to `env.ts` + settings
  (validated; each entry `{from, appPassword, dailyCap}`). Keep the existing
  single-sender vars working as sender #1 (back-compat).
  *(Verify: boot with two senders configured; a missing password errors clearly.)*

- **Step 2 — Sender-aware transport + send.** `getTransport(sender)` and
  `sendEmail(..., sender)`; `from:` = the chosen sender. Persist the sender on the
  `email_sends` row (additive column; backfill existing → current `GMAIL_FROM`).
  *(Verify: a manual/dry-run send from sender #2 records `sender=santiagovittordev`
  and uses that transport.)*

- **Step 3 — Rotation + per-sender cap.** In the send path
  (`scheduledSendWorker`/governor), choose the sender by the policy and gate on
  that sender's own rolling-24h count. `capRemaining` becomes per-sender.
  *(Verify: with sender #1 at its cap, new sends route to sender #2; each stays
  under its own cap; SQL shows the split.)*

- **Step 4 — Dual-inbox reply + bounce scan.** `replyChecker` iterates all
  senders' inboxes (IMAP auth per sender), matching replies/DSNs back to the
  `email_sends` row by sender + recipient.
  *(Verify: a reply to sender #2 is detected and attributed; a bounce to sender #2
  flips that send to `bounced`.)*

- **Step 5 — Warmup note + scheduling-config surface.** Document the ramp and
  expose per-sender daily caps in Settings so the operator can raise them as the
  accounts warm.
  *(Verify: per-sender cap editable; defaults conservative.)*

## Warmup ramp (documented, not automated)

Two fresh-ish Gmail identities. Start conservative and scale the per-sender caps
(Settings → Sending & Deliverability → "Daily send cap — sender #1/#2"):

- Week 1: ~5–10/day per inbox.
- Weeks 2–4: ramp toward ~50/day per inbox.
- Steady state: ~50/day × 2 = the operator's ~100/day soft average.

Sender #1 (`svittordev`) is already warmed (default cap shipped here resolved to 50 via
the operator's DB override); sender #2 starts at the conservative default **10** and the
operator raises `OUTREACH_DAILY_CAP_2` as it warms. No automated warmup tool (out of scope).

## Verification gate

_Filled DURING execution with live evidence._

- [x] **Boot validation.** `GMAIL_FROM_2` set, password missing → clear zod error:
      `GMAIL_APP_PASSWORD_2: [ 'GMAIL_FROM_2 and GMAIL_APP_PASSWORD_2 must both be set or
      both be unset' ]`. Refine uses truthiness so an empty-string password also errors
      (not silently dropped). Both-set boots fine; `getSenders()` →
      `['#0 svittordev@gmail.com cap=50', '#1 second@gmail.com cap=10']`.
- [x] **Rotation + per-sender cap + split** (dry-run, synthetic sender #2):
      - fresh → `chooseSender` picks sender #1 (more headroom);
      - sender #1 saturated (`capRemaining(#1)=-20`, `capRemaining(#2)=10`) →
        `chooseSender` → `second@gmail.com`;
      - `governSend('generic', now, skipWindow)` → **send via second@gmail.com** (decision
        carries the chosen sender);
      - both saturated → `governSend` → **defer `deferred:cap_reached`**;
      - `email_sends` split by sender: `{svittordev:50}`, `{second:11}` — each counted
        against its own rolling-24h cap.
- [x] **Backfill.** Pre-0027 rows backfilled to `GMAIL_FROM`; newest live `sent` row now
      reads `sender='svittordev@gmail.com'`.
- [x] **Live send from sender #2.** UNBLOCKED (2026-06-25). Operator set valid
      `GMAIL_FROM_2`/`GMAIL_APP_PASSWORD_2` (first App Password was rejected with
      `535-5.7.8 BadCredentials`; regenerated one authenticates). `getSenders()` resolves both
      (`#0 svittordev`, `#1 santiagovittordev@gmail.com OUTREACH_DAILY_CAP_2`); live
      `transport.verify()` → **OK for both**; live `sendMail` from sender #2 → Gmail accepted
      (`accepted=svittordev@gmail.com`, delivered). Reply/bounce path is structurally extended
      (per-sender IMAP loop, ownAddress per sender) + tsc-verified; will exercise naturally on
      the next real reply/DSN to sender #2's inbox.
- [x] `npx tsc --noEmit` clean — server (in container), after every phase + final.
- [x] **Reviewer subagent pass** (send-path). One actionable fix applied: extend the
      explicit `GMAIL_HARD_CEILING` backstop in `appSettings.clampNumber` to
      `OUTREACH_DAILY_CAP_2`. Cross-inbox reply-dedup noted with a `ponytail:` comment
      (correct for direct Gmail; revisit on aliases/forwarding). Manual-send cap-fallback
      to #1 is the intended spec behavior (operator click never blocked on the cap).

**Note (pre-existing, not a regression):** `scheduledSendGateTest` shows 9 pass / 7 fail on
the live DB because it injects a fixed past `nowMs` (`TUE_OPEN` = Jun 16) while the DB has a
real send today → global pacing defers the seeded sends. Confirmed identical (9/7) on base
(pre-slice) code via `git stash`. Environmental test fragility, untouched by this slice.

## Completion record

- Commit SHAs: _(this commit)_
- What changed: senders list (`senders.ts`) resolved from `GMAIL_FROM[/_2]` env pairs
  (both-or-neither validated); sender-aware `getTransport`/`sendEmail`; additive
  `email_sends.sender` column + backfill + `recordEmailSend(sender)`; per-sender
  `rollingSentCount24h(sender)` / `capRemaining(sender)`; least-loaded `chooseSender()`
  rotation with `governSend` returning the chosen sender; worker + manual route route
  through it; `replyChecker` scans every sender's inbox; Settings gains
  `OUTREACH_DAILY_CAP_2` + `GMAIL_APP_PASSWORD_2` masked status.
- Deliberate simplification: **no `scheduled_sends.sender` column** — the sender is chosen
  at send time (least-loaded), so it would only mirror `email_sends.sender` after the fact,
  already correlated via the existing `scheduled_send_id`. No reader needs it.
- Follow-ups / new parked items:
  - ~~Operator: enable 2FA + generate App Password on `santiagovittordev@gmail.com`~~ DONE
    (2026-06-25): valid App Password set, both senders verify, live send from #2 delivered.
    Reply/bounce attribution for #2 will be observed on the next real reply/DSN to that inbox.
  - Parked: `scheduledSendGateTest` pacing fragility against a live DB (inject a clean
    pacing slate or per-test sent-row isolation) — pre-existing, out of scope here.
