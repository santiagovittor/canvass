# Slice 0025: Best-reachable email selection (not just the first)

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F3**. Depends on `0024` (validity signal must be trustworthy first).

## Intent

**Plain English.** When a business lists several emails, stop blindly using the
first one. If the first address is the wrong/unreachable one, pick a reachable
alternate instead of skipping the whole lead. About 1 in 9 emailed leads has more
than one address (the operator's Estudio Garrafa is exactly this case). Important:
we still send to **one** address per lead — we do **not** email several contacts
at the same company, because that trips corporate spam defenses into blocking the
whole domain. The win is choosing the best single target, with the others as
fallback.

**Project vocabulary.** Replace the `parseEmails(emails_json)[0]` send-target
selection (`db/index.ts:552-558`, used by `batchOrchestrator.ts:95`) with a
`selectBestEmail(businessId)` that ranks all parsed candidates by cached/probed
validity (`valid` > `unknown` > `invalid`) — reusing `verifyEmailDeliverable` /
`getEmailValidityMany` — and returns the single best. Surface the chosen address
through the existing lead/queue path.

## Out of scope

- Multi-send / sending to >1 address per lead (explicitly rejected — domain-block
  risk, `0022` F3 + sources).
- Changing how emails are *found* (`socialEnricher.extractEmails` unchanged).
- The validity classification logic itself — that is `0024`.

## Constraints (`docs/SPEC.md`)

- **Reuse** `verifyEmailDeliverable` (`emailVerifier`), `getEmailValidity` /
  `getEmailValidityMany`, `parseEmails` — do not reimplement validity or parsing.
- **Reuse** the batch gate site (`batchOrchestrator.processItem:95`) and the
  send-path target resolution — selection must be consistent across batch gate,
  queue display, and actual send (`emailSender`).
- **Additive only**; no schema change required (selection is computed from
  `emails_json` + `email_validity`). If a "chosen email" needs persisting for the
  queue, use an additive column or compute on read.
- **Probe budget discipline** — selecting may probe more than one address;
  bound it (reuse `EMAIL_VERIFY_TIMEOUT_MS`, cache results) so a multi-email lead
  can't stall a batch.

## Diagnose-first checklist

- [ ] Files to read: `server/src/db/index.ts:460-558` (`parseEmails`,
      `getFirstEmailForBusiness`, validity helpers), `server/src/services/
      batchOrchestrator.ts:94-104` (the gate that calls it),
      `server/src/services/emailSender.ts:47-103` (send target),
      `server/src/services/emailVerifier.ts` (probe + cache).
- [ ] Symbols to catalog: every caller of `getFirstEmailForBusiness` and every
      `parseEmails(...)[0]` / `?.[0]` (grep both — must all route through the new
      selector to stay consistent), `OutreachLead.emailsJson` flow into the queue.
- [ ] SQL (re-confirm): 74 leads with >1 email; spot-check Garrafa's full
      `emails_json` to confirm a reachable alternate exists.
- [ ] Decide tie-break beyond validity: among equal validity, prefer the original
      first (stable) or a role/person heuristic? Default: validity rank, then
      original order (simplest; no heuristic guessing).
- [ ] Open questions for the operator: none required.

## Implementation plan

_Operator approves before edits._

- **Step 1 — `selectBestEmail(businessId)`.** New repo/service fn: parse all
  emails, look up cached validity for each (`getEmailValidityMany`), probe the
  uncached ones within the budget, return the highest-ranked single address
  (`valid` > `unknown` > `invalid`; ties keep original order). If all are
  `invalid`, return the best-effort first (so the lead still has a target and the
  gate's own `invalid` skip — post-`0024` — decides).
  *(Verify: Garrafa → returns a reachable alternate, not the M365 `info@`.)*

- **Step 2 — Route all target resolution through it.** Replace
  `getFirstEmailForBusiness` usage at `batchOrchestrator.ts:95` and the send
  target in `emailSender`/the send route with `selectBestEmail`. Keep one source
  of truth so the queue shows the same address that gets emailed.
  *(Verify: the queue, the batch gate, and the actual send all reference the same
  selected address for a multi-email lead.)*

- **Step 3 — Surface the chosen email in the queue (light).** The lead row should
  show which address will be used (and ideally its validity dot from slice 0013).
  Compute on read; no schema churn.
  *(Verify: a multi-email lead's queue row displays the selected reachable address.)*

## Verification gate

_Filled DURING execution with live evidence._

- [x] SQL/probe: live `selectBestEmail('ChIJXQXhUm57GpYRopcIKf1R0Mg')` (Estudio
      Garrafa, 4 emails) → **`easergiom@gmail.com`**, NOT the first
      `jcgarrafa@bariloche.com.ar` (cached `unknown`). The first gmail probed
      `valid` and short-circuited. `pickBestCachedEmail(['…invalid','…valid'])`
      → the valid one; all-invalid → original first. (DB: 74 multi-email leads,
      matching the diagnosis count.)
- [x] Batch path: `batchOrchestrator.processItem` resolves `to` via
      `selectBestEmail` then gates on `verifyEmailDeliverable(to)` (cache hit) →
      a reachable alternate is selected, not skipped.
- [x] Grep proof: no remaining `parseEmails(...)[0]` (or two-statement
      `emails[0]`) on a send-target path. Reviewer caught the manual `/send`
      route (`outreachQueue.ts`) still using `emails[0]`; fixed to
      `selectBestEmail`. Only export paths (`routes/businesses.ts`,
      `services/sheets.ts`) keep `[0]` — out of scope.
- [x] `npx tsc --noEmit` clean — server (in container) after each phase + final.
- [x] Reviewer subagent pass (send-path) — flagged the manual-send miss (now
      fixed) and a benign double-probe in the batch gate (cache hit, kept
      intentionally; correctness preserved).

## Completion record

- Commit SHAs: `a7c9a0e`
- What changed:
  - `db/index.ts`: + `getBusinessEmails`, + pure `pickBestCachedEmail`
    (cached-only ranker for list queries); removed dead `getFirstEmailForBusiness`.
  - `emailVerifier.ts`: + `selectBestEmail(businessId)` — probes uncached
    candidates via `verifyEmailDeliverable`, short-circuits on first `valid`,
    all-invalid → original first.
  - Send-target sites repointed to `selectBestEmail`: batch gate
    (`batchOrchestrator.ts`), scheduled transmit (`scheduledSendWorker.ts`),
    manual send route (`outreachQueue.ts`).
  - Queue surfacing: `getOutreachLeads`/`getNoSiteLeads`/`getFollowUpLeads`/
    `getRepliedLeads` now rank ALL emails via cached map → `first_email`
    carries the selected best-reachable address (zero client change; it already
    backs the "Para:" line + queue row).
- Follow-ups / new parked items:
  - Batch gate double-probes the selected address (`selectBestEmail` then
    `verifyEmailDeliverable(to)`) — cache hit, negligible; could collapse by
    returning `{ addr, validity }` if probe budget ever tightens.
  - CSV/Sheets export still uses `parseEmails(...)[0]` (export, not send) — left
    as-is per scope.
