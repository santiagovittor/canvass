# Slice 0046: Probe-Before-Rank — Email Validity Backfill

## Intent

Make reachability a real ranking input by probing the email pool *before* it is
ranked, so verified addresses float to the top of the queue and unverified/dead
ones sink. Diagnosis `0043` found only **92 of the 425** untouched email-pool
leads have any cached validity verdict — **333 are completely unprobed** — while
2026 research says verified lists reply at **2×** unverified and bounce rate is
the single biggest deliverability differentiator (**F4**). The probing machinery
already exists (`verifyEmailDeliverable` / `selectBestEmail`,
`server/src/services/emailVerifier.ts`); this slice just runs it across the pool
on a paced background pass and ensures the result feeds the score. Recommended
slice #2.

**Project vocabulary (one line).** Add a paced background backfill that calls
`selectBestEmail(businessId)` (which caches each candidate via
`verifyEmailDeliverable` → `upsertEmailValidity`) for every untouched, has-email,
unprobed lead, bounded by `EMAIL_VERIFY_TIMEOUT_MS` and an inter-probe delay, so
`getOutreachLeads`'s cache-only validity read (slice 0045) ranks on real verdicts.

## Out of scope

- Changing the probe logic, the symmetry test, or the valid-only confirmer
  semantics (slices 0013/0024/0030 settled those) — reuse `verifyEmailDeliverable`
  verbatim.
- The ranking/sort itself (**0045**) — this slice only populates the cache it
  reads.
- Bounce/DSN ingestion (slice 0013) — already the authoritative dead signal;
  untouched here.
- SMTP-probe enablement in prod — if `EMAIL_VERIFY_SMTP_PROBE` is off / port 25
  blocked, MX-only verdicts (`invalid` on dead domain, else `unknown`) are the
  expected outcome and still improve ranking (dead domains sink). Document, don't
  fight it.

## Constraints

- **Reuse `emailVerifier.ts`** — `selectBestEmail` / `verifyEmailDeliverable`
  only. No new SMTP code. Fail-open to `unknown` is the contract; never throw into
  the pass.
- **Pacing** — respect `EMAIL_VERIFY_TIMEOUT_MS` per probe and add a small
  inter-probe delay; this opens raw sockets to port 25, so it must not hammer.
  Sequential, no parallel fan-out (mirrors the "jobs run sequentially" ethos).
- **TTL-aware** — skip addresses with a fresh `email_validity` row
  (`EMAIL_VERIFY_CACHE_TTL_DAYS`); `verifyEmailDeliverable` already does this, so
  re-runs are cheap and idempotent.
- **Additive only** — no schema change (`email_validity` already exists).
- **No send-path change** — this never sends mail; it only probes RCPT.
- **tsc clean gate.**

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/services/emailVerifier.ts` (full) — `verifyEmailDeliverable`,
    `selectBestEmail`, cache TTL, `EMAIL_VERIFY_SMTP_PROBE` gate.
  - `server/src/db/index.ts` — `getBusinessEmails`, `getEmailValidity`,
    `upsertEmailValidity`, and the email-pool predicate
    (`HAS_SITE AND HAS_EMAIL AND outreach_status IS NULL`).
  - `server/src/scripts/batchEligibilityGate.ts` + the other `scripts/*Gate.ts` —
    the existing one-off `tsx` script pattern to copy (container-run, dotenv
    `../.env`).
  - `server/src/env.ts` — `EMAIL_VERIFY_*` vars.
- [ ] Symbols to catalog: `EMAIL_VERIFY_TIMEOUT_MS`, `EMAIL_VERIFY_SMTP_PROBE`,
  `EMAIL_VERIFY_CACHE_TTL_DAYS`, `email_validity(email,result,mx_ok,source,
  checked_at)`.
- [ ] Online topics: none (research already in 0043 — verified = 2× reply).
- [ ] Open questions: run as a **manual one-off script** the operator triggers, a
  **boot-time paced drain**, or an **on-demand "verify this page" button** in the
  queue? Default recommendation: a paced background drainer that runs a bounded
  batch per tick when the app is idle, plus a manual script for the initial 333.

## Implementation plan

_Approved before edits._

- **Step 1 — Selector query.** Add a db helper returning untouched, has-email
  leads whose best email has **no fresh `email_validity` row** (LEFT JOIN
  `email_validity` on the parsed emails, or filter in TS after
  `getBusinessEmails`). Cap the returned batch (e.g. 50/run). *(verify: SQL count
  matches the 333 unprobed figure ±recent changes.)*
- **Step 2 — Paced backfill runner.** A function `backfillEmailValidity(limit)`
  that iterates the selector, calls `selectBestEmail(businessId)` (caches every
  candidate it probes), sleeps `SOCIAL_ENRICHMENT_DELAY_MS`-style between leads,
  and logs `[validity-backfill] probed N, valid/unknown/invalid = a/b/c`.
  *(verify: log line shows verdict counts; `email_validity` row count rises.)*
- **Step 3 — Trigger.** Wire the runner as (a) a one-off `scripts/` `tsx` task for
  the initial 333 (run in the server container per the memory note on dotenv), and
  (b) optionally a bounded call from an existing idle tick (reuse a worker that
  already paces, e.g. piggyback the scheduled-send worker's idle cycle) — only if
  trivial; otherwise leave (a) and a manual route. *(verify: running the script
  populates the cache; re-running is a near-instant no-op via TTL.)*
- **Step 4 — Confirm the score consumes it.** After backfill, the 0045 queue sort
  (cache-only validity read) ranks `valid` above `unknown` above unprobed above
  `invalid`. *(verify: queue top shifts toward valid-email leads.)*

## Verification gate

_Filled DURING execution._

- [x] SQL before: unprobed pool (first-email has no `email_validity` row) = **337**
      of a 361-lead pool (≈ the 333 from 0043; pool shrank as leads were
      contacted). `email_validity` total **198 → 536** after the full drain (+338
      rows). After run: selector reports **0 leads still needing probe**.
- [x] Log: `[validity-backfill] probed 284, valid/unknown/invalid = 105/105/74`
      (full drain, fixed runner). Earlier partial batch: `probed 50, ... = 8/42/0`.
- [x] Queue skew (verified via `getOutreachLeads(1,25)` directly — auth is a no-op
      in dev, same code path the route calls): page-1 validity dist = `{valid:25}`,
      every top-5 row `valid / grade A`. Verified addresses now float to the top.
- [x] Idempotency: immediate re-run → `[validity-backfill] probed 0, valid/unknown/
      invalid = 0/0/0` (selector excludes leads that already have a first-email row).
- [x] `npx tsc --noEmit` clean (server container) after every step.

**Diagnosis correction during execution.** The slice vocabulary said
`selectBestEmail` "caches each candidate", but `selectBestEmail` short-circuits
single-email leads (`emails.length <= 1`) and returns WITHOUT probing — and
single-email leads are the majority of the pool. The first runner (built to spec)
therefore phantom-counted them as probed without writing any row, so the pool never
drained (selector still 284 after a "309-probed" run). Fixed by probing each
candidate via `verifyEmailDeliverable` directly in `backfillEmailValidity`,
mirroring `selectBestEmail`'s rank + valid short-circuit. Real verdicts followed
immediately (105 valid / 105 unknown / 74 invalid).

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - `server/src/db/index.ts` — `getLeadsNeedingValidityProbe(limit)`: pool leads
    (same `buildOutreachWhere` predicate the queue ranks) whose first email has no
    `email_validity` row, capped per run.
  - `server/src/services/emailVerifier.ts` — `backfillEmailValidity(limit)`: paced,
    sequential probe of each lead's candidates via `verifyEmailDeliverable`
    (`SOCIAL_ENRICHMENT_DELAY_MS` between leads), logs verdict counts. Reuses the
    existing probe/cache machinery verbatim; no new SMTP code.
  - `server/src/scripts/emailValidityBackfill.ts` — one-off `tsx` trigger
    (`... npx tsx src/scripts/emailValidityBackfill.ts [limit]`), idempotent re-run.
- Skipped (slice Step 3b): the optional idle-tick auto-drain. Not trivial to bolt
  onto an existing paced worker; operator runs the script (re-run until `probed 0`).
  Add when a steady inflow of new leads makes manual runs annoying.
- Follow-ups: dev port 25 is partially open (real `valid` confirmations seen). If
  prod port 25 is blocked, most verdicts are `unknown`; revisit a paid MX/validation
  API only if bounce rate proves it necessary (0043 F8 still says owned-signals-first).
