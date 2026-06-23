# Slice 0013: Email-validity gate + bounce ingestion

> Derived from diagnosis [`0011`](0011-ux-clarity-and-outreach-audit.md) finding
> **(e)**. Addresses BRIEF symptom 6 ("Address not found… wasting resources").
> Operator directive (2026-06-23): *"whatever you can do to make sure we get real
> emails, this is key."* → strongest practical validity.

## Intent

**Plain English:** Stop spending compose/send effort on email addresses that
don't exist. Before we write and send an email, check that the address is real —
the domain can receive mail (MX) and, where possible, the specific mailbox
exists (SMTP probe) — and throw out obvious template placeholders like
`tuemail@email.com`. And when a message *does* bounce back as "Address not
found," record it so the lead is marked bad instead of looking "sent."

**Project vocabulary:** Insert a pre-compose validity gate (MX + best-effort
SMTP-RCPT + expanded placeholder/junk blocklist) ahead of the Gemini step in the
outreach pipeline, and add DSN/bounce ingestion to the existing IMAP pass,
recording an additive `email_sends.status='bounced'` (and a lead-level bad-email
flag) so "sent" finally means "delivered."

## Out of scope

- Buying a third-party verification API (Hunter/NeverBounce). Do it in-house
  with DNS MX + SMTP — no new paid dependency, no new banned package.
- Re-scraping or changing how emails are *found* (`socialEnricher.extractEmails`
  stays; we gate what it produced).
- Changing send pacing/governor logic — the gate sits *before* compose.
- Auto-deleting leads. A bad email flags the lead; it does not erase it.

## Constraints (`docs/SPEC.md`)

- **Reuse the send path.** Gate slots into `outreachComposePipeline` /
  `batchOrchestrator` *before* `composeVerifiedEmail` — do not duplicate compose
  or send.
- **Additive schema only.** New `email_sends.status` value `'bounced'`; an
  additive column for last-validity result / bad-email flag on `businesses` (or a
  small `email_validity` table). No destructive migration.
- **Run migrations before prepares** (boot ordering invariant).
- **SSRF-style caution.** SMTP-RCPT probes connect outbound to arbitrary MX
  hosts — bound timeouts, handle connection refusal/greylisting/catch-all
  gracefully; never block the pipeline on a hanging probe (mirror the
  `SOCIAL_ENRICHMENT_TIMEOUT_MS` discipline).
- **undici / Node stdlib only** for networking; no axios (`rules/architecture.md`).
- **Env validated by zod** — any new toggle/timeout (e.g.
  `EMAIL_VERIFY_SMTP_PROBE`, `EMAIL_VERIFY_TIMEOUT_MS`) added to
  `server/src/env.ts` with a safe default.

## Diagnose-first checklist

- [x] Files to read: `server/src/db/index.ts:463` (`validateEmail`),
      `server/src/services/socialEnricher.ts:77-110` (`EMAIL_RE`, `isJunkEmail`,
      `extractEmails`), `server/src/services/outreachComposePipeline.ts`
      (`composeVerifiedEmail` entry), `server/src/services/batchOrchestrator.ts`
      (prepare loop / where to gate), `server/src/services/emailSender.ts:86-95`
      (status recording), `server/src/services/replyChecker.ts` (IMAP scan to
      extend with DSN parsing), `server/src/db/index.ts:681` (`recordEmailSend`).
- [x] Symbols to catalog: every call site of `validateEmail`; the parse of
      `emails_json` → first email (`getOutreachLeads:572-580`); `email_sends`
      schema + status set; `getReplyCheckTargets`; the IMAP fetch loop
      (`replyChecker.ts:89-108`) — where DSNs would be matched.
- [x] Measure (scratch SQL, discard): how many queued leads' first email is a
      placeholder pattern (`tuemail@`, `youremail@`, `email@email`, `info@example`
      …)? How many distinct domains across queued `emails_json`? Establishes the
      win size before building.
      → **409 queued w/ email · 34 placeholder first-emails (~8.3%) · 281 distinct
      domains** (2026-06-23). Note: `tuemail@email.com` passes current `validateEmail`
      because `email.com` is a real provider — must block by placeholder local-part,
      not domain.
- [ ] Online topics: MX lookup + SMTP RCPT TO handshake semantics, catch-all
      detection, greylisting false-negatives; DSN (RFC 3464) message structure
      for "Address not found"; Gmail 2026 >3% bounce → spam-filter trigger.
      (Sources cited in `0011`.)
- [ ] Open questions: probe strictness vs. speed (operator already said
      strongest — default SMTP probe ON, but with a per-batch time budget so a
      slow MX can't stall a run).

## Implementation plan

_Draft — operator approves before edits._

- Step 1 — Expand the junk/placeholder blocklist in one shared validator: reject
  `tuemail@*`, `youremail@*`, `email@email.*`, `name@domain.*`, `info@example.*`,
  and the like. *Verify:* `tuemail@email.com` (real row on "Aurora Estudio") now
  fails validation.
- Step 2 — `verifyEmailDeliverable(addr)`: DNS MX lookup (dead domain → invalid)
  → optional SMTP `RCPT TO` probe behind a timeout, with catch-all detection
  (probe a random local-part; if it also "accepts," downgrade to "unknown" not
  "valid"). Cache results (additive table/column) to avoid re-probing.
  *Verify:* a known-dead domain returns invalid; a known-good Gmail returns
  valid; a catch-all returns unknown.
- Step 3 — Gate in the pipeline *before* `composeVerifiedEmail`: invalid →
  skip the lead, record reason, never spend Gemini. *Verify:* a batch over a
  list containing a dead address skips it with a logged reason and zero Gemini
  cost for that lead (check `stageTracker` cost).
- Step 4 — Surface validity on the lead row (`getOutreachLeads` →
  `OutreachLead`): replace the always-green dot (`LeadQueue.tsx:570-576`) with
  valid / unknown / invalid states + a hint that emails come from the *enrichment
  step, not the scrape* (provenance, BRIEF symptom 6). *Verify:* queue visibly
  distinguishes a verified vs. unverified vs. bad email.
- Step 5 — Bounce ingestion: extend the IMAP pass to detect DSN
  ("mailer-daemon", status 5.1.1 / "Address not found"), match the failed
  recipient back to a `email_sends` row, set `status='bounced'` + flag the lead.
  *Verify:* a real bounce in the inbox flips that send to `bounced` and flags the
  lead; bounce rate becomes queryable.

## Verification gate

_Filled DURING execution with live evidence (2026-06-23)._

- [x] Scratch SQL (before): queued first-emails matching placeholder patterns →
      **34 of 409 (~8.3%)**, 281 distinct domains.
- [x] Log line: batch skipping a placeholder address pre-compose, **zero Gemini**:
      ```
      [batch] skipped business=ChIJpxVp5pulvJURE3C-nCiCYkY reason=bad_email email=ejemplo@mail.com
      batch_item => {"state":"skipped_no_evidence","disposition":"skipped_bad_email","last_error":"email_invalid:ejemplo@mail.com"}
      gemini_cost_rows delta = 0
      ```
- [x] Verifier probe (live, port-25 open in this env):
      `tuemail@email.com → invalid (4ms, no net)` · `dead-domain → invalid (59ms, DNS)` ·
      `svittordev@gmail.com → valid (1459ms, SMTP RCPT)` · `nonexistent@gmail.com → invalid (1121ms, RCPT 550)`.
      Catch-all path verified in code (random-localpart RCPT downgrades to unknown).
- [x] SQL (after): `email_sends` shows **3 `bounced` rows** matched from real DSNs in
      the live inbox (`checkReplies => {"checked":21,"matched":0,"bounced":3}`):
      `info@adc-dentalcare.com`, `info@beachway.com`, `secretaria@estudioarmando.ar`
      — each flagged `email_validity.result='invalid', source='bounce'`. `getBounceCount()` 0→3.
- [x] Lead-queue distinction: `getOutreachLeads` now returns `email_validity` per row;
      live distribution across 406 queued leads = **327 unknown / 79 invalid** (valid
      populates once a lead is probed by a batch). Dot is 3-state (filled green / hollow
      muted / ⚠ warn) + provenance tooltip ("Email found during enrichment, not the map
      scrape — deliverability not guaranteed"). tsc-clean; visual confirmation pending
      operator glance.
- [x] `npx tsc --noEmit` clean — server (in container) **and** client.
- [x] **Reviewer subagent pass** (feature-dev:code-reviewer). Two findings fixed:
      (1) `smtpProbe` timer now `clearTimeout`'d inside `done()` on every exit path
      (was only cleared in the `close` handler — leaked a live timer tick per probe);
      (2) `getFollowUpLeads`/`getRepliedLeads` were doing per-row validity queries
      (N+1) — unified all four lead builders through one map-based `resolveValidity`
      helper fed by `getEmailValidityMany` (one query/page). Counter-conflation finding
      (bad-email skips bump the `skipped_no_evidence` aggregate) accepted as the slice's
      deliberate no-schema-churn tradeoff — row-level `disposition='skipped_bad_email'`
      distinguishes them; parked as a follow-up. Architecture boundaries clean.

## Completion record

- Commit SHAs: _(uncommitted — operator to review/commit)_
- What changed:
  - **`server/src/db/index.ts`** — `isPlaceholderEmail` (local-part/template blocklist)
    folded into `validateEmail`; `email_validity` cache table + repo fns
    (`getEmailValidity`, `upsertEmailValidity`, `getEmailValidityMany`,
    `getFirstEmailForBusiness`, `markEmailSendBounced`, `getBounceCount`);
    `OutreachLead.email_validity` populated across all four lead builders via one
    batched `resolveValidity` helper.
  - **`server/src/env.ts`** — `EMAIL_VERIFY_SMTP_PROBE` (default on),
    `EMAIL_VERIFY_TIMEOUT_MS` (5000), `EMAIL_VERIFY_CACHE_TTL_DAYS` (30).
  - **`server/src/services/emailVerifier.ts`** (new) — MX + SMTP-RCPT + catch-all
    probe, cached, fail-open to `unknown`.
  - **`server/src/services/batchOrchestrator.ts`** — pre-analyze/pre-compose gate at
    top of `processItem`; `invalid` → `skipped_no_evidence`/`skipped_bad_email`, zero
    Gemini.
  - **`server/src/services/replyChecker.ts`** — `parseDsnRecipients` (RFC 3464,
    permanent-only) + a mailer-daemon/postmaster IMAP pass that flips matched sends to
    `status='bounced'`, flags the address, broadcasts `email:bounced`.
  - **`client/src/lib/outreachApi.ts`** + **`client/src/components/Outreach/LeadQueue.tsx`**
    — `email_validity` type + 3-state dot (valid/unknown/invalid) + enrichment-provenance
    tooltip; row-disable now keys off `email_validity==='invalid'`.
- Live evidence: 34/409 placeholders measured; batch skip of `ejemplo@mail.com` with
  Gemini delta 0; 3 real DSN bounces ingested from the inbox (0→3); queue distribution
  327 unknown / 79 invalid.
- Follow-ups / new parked items:
  - Dedicated `batch_runs.skipped_bad_email` counter so the batch UI can separate
    bad-email skips from no-evidence skips (currently both bump `skippedNoEvidence`;
    only the row-level `disposition` distinguishes them).
  - Optional: surface bounce rate + bounced leads in the outreach UI (data is now
    queryable via `getBounceCount` / `email_sends.status='bounced'`).
  - Optional: extend the deliverability probe to the manual `/send` + scheduled-send
    worker paths (currently batch-only by decision; send paths use the expanded
    `validateEmail` + cached validity).
