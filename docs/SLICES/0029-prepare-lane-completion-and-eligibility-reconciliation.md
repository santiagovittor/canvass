# Slice 0029: Prepare-lane completion state + eligibility reconciliation

> Derived from an operator bug report on the Automate tab (post-`0019` redesign).
> Two coupled defects: a finished batch leaves no completion signal, and the
> Prepare queue keeps showing leads that were already prepared + scheduled (they
> are visibly in the Send/"Enviar" queue, yet still selectable in
> Prepare/"Preparar"). New ROADMAP entry — promote from this report.

## Intent

Make the Prepare lane honest about what it has already done. When a batch
finishes, show a persistent completion summary (queued / skipped / held / failed)
that the operator must acknowledge — a finished run can no longer vanish
silently. And make a lead that is already scheduled disappear from the Prepare
staging list, so the operator can only ever stage leads that are genuinely still
preparable — no double-prepare, no double-send. The fix is two-layered: the
server's "eligible to prepare" predicate must exclude leads with an active
scheduled send (today it only excludes `contacted`), and the client must
re-derive the staging list when a run completes.

## Out of scope

- The Send/"Enviar" lane — it already live-updates over `send-scheduler:tick`
  SSE (`useScheduledSends.ts:25`) and is correct. Do not touch it.
- The batch engine, gate, governor, compose/verify pipeline. This slice changes
  *what is listed as eligible* and *how completion is surfaced*, not how a lead
  is processed.
- The no-website / WhatsApp lane (`getNoSiteLeads`) — separate query, already
  filters `outreach_status IS NULL` against a different population. Leave it.
- Open-tracking, reply visibility, second-sender — unrelated.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Reuse-only.** The "active scheduled send" predicate already exists as
  `stmtHasActiveScheduledSend` (`db/index.ts:1008`, status IN
  `'scheduled','claimed','deferred'`). Express the staging exclusion as the same
  predicate (a `NOT EXISTS` subquery in `buildOutreachWhere`); do **not** invent
  a second definition of "active send" that can drift from the enqueue dedup
  guard.
- **SSE only, no polling.** Completion + list reconciliation must be driven off
  the existing `batch:progress` stream (terminal status) — no `setInterval`, no
  poll loop. `useBatchRun` already owns `batch:progress`.
- **Dry-run is unaffected by design.** `OUTREACH_DRY_RUN` / per-run `dryRun`
  suppresses the *transmit*, not the *schedule*: `enqueueForSend` still inserts a
  real `scheduled_sends` row (`status='scheduled'`) in dry-run, which is why the
  lead shows in "Enviar". The `NOT EXISTS` exclusion therefore drops dry-run and
  real leads identically — verify both.
- **Additive only.** No schema change is needed (the `scheduled_sends` row and
  its index already exist). If any index is added for the subquery, additive.
- **Shared predicate awareness.** `buildOutreachWhere` feeds BOTH the Automate
  staging list AND the main Outreach-tab lead queue (`getOutreachLeads`). The
  exclusion is correct for both surfaces (you should not re-compose a lead that
  already has a pending send), but the diff touches both — call it out in the
  plan and verify the Outreach tab still lists the right leads.

## Diagnose-first checklist

**Diagnosis already done in the originating session — findings recorded below.
Operator still approves the implementation plan before edits.**

- [x] Files read:
  - `client/src/components/Automate/PrepareLane.tsx`,
    `AutomatePage.tsx`, `SendLane.tsx`, `BatchConsole.tsx`
  - `client/src/hooks/useBatchRun.ts`, `useLeadStaging.ts`,
    `useScheduledSends.ts`
  - `client/src/lib/batchApi.ts`, `outreachApi.ts`
  - `server/src/services/batchOrchestrator.ts`, `db/batch.ts`,
    `db/index.ts` (`buildOutreachWhere`, `getOutreachLeads`, `markContacted`,
    `stmtHasActiveScheduledSend`)
  - `server/src/routes/outreachQueue.ts`
- [x] Symbols cataloged:
  - **Completion gap:** `PrepareLane` `active = status === 'running' || 'paused'`
    (line 41). Terminal `done`/`canceled` (`batchApi.ts:15`) flips `active`→false
    → `BatchRunView` unmounts → snaps to staging table. No terminal/summary
    render path; final counts live unused in `progress`.
  - **Stale list, client:** `useLeadStaging` fetches only on mount/`search`
    change (`useLeadStaging.ts:23-36`); no dependency on batch run status; never
    refetches on completion; selection set is never cleared after a run.
  - **Stale list, server (root):** `buildOutreachWhere` conditions are
    `emails_json IS NOT NULL`, `!= '[]'`, **`outreach_status IS NULL`**
    (`db/index.ts:635-638`). Scheduling does NOT set `outreach_status` —
    `enqueueForSend` (`db/batch.ts:112-122`) only creates the `scheduled_sends`
    row + transitions the batch_item to `queued_for_send`. `outreach_status`
    flips to `'contacted'` only on real transmit (`markContacted`,
    `db/index.ts:828-834`); dry-run never flips it. ⇒ a scheduled-but-unsent lead
    remains `outreach_status IS NULL` ⇒ stays eligible ⇒ even a perfect client
    refetch would NOT drop it. The exclusion must key on an active
    `scheduled_sends` row.
  - **Reuse primitive:** `stmtHasActiveScheduledSend` — `business_id = ? AND
    status IN ('scheduled','claimed','deferred')` (`db/index.ts:1008-1010`).
- [x] Research (UX/UI patterns) — see "UX/UI patterns" section below.
- [x] Open questions — **resolved by operator:**
  - Completion summary: **both** — a persistent acknowledge card (stays until
    "Preparar más"/dismiss) AND a transient toast echo. The card carries the
    structured human-readable outcome ("25 leads preparados y agendados · 3
    fallaron por email inválido…"), modern/fresh, with entrance + count
    transitions; it must *feel* finished, not just report numbers.
  - Run *start*: **optimistic-remove** the staged ids immediately, then reconcile
    against the server eligibility on completion.
  - Terminal-but-unscheduled leads **return to the eligible list, de-emphasized**
    (visually subordinate so the operator sees they weren't lost but they don't
    compete with fresh eligible leads). `skipped_no_evidence` returns plainly.
    `held_generic` returns too, but is the natural candidate for a future
    "offer the chatbot I can build" track — **parked**, not built here
    (see Follow-ups).

## UX/UI patterns (research)

Established patterns for "long-running batch action over a selectable list".
Goal: the operator always knows a run finished, and the list never lies about
what is still actionable.

1. **Terminal/completion state of the progress surface (primary).** A progress
   view should resolve into an explicit *done* state, not disappear. Replace the
   live `BatchRunView` with a completion card on terminal status showing the
   outcome ledger — `queued N · skipped N · held N · failed N` — plus a primary
   action ("Preparar más" → clears selection + returns to staging) and, if
   `failed > 0`, a path to the per-lead failures (`getBatch` items already carry
   `lastError`). Persistent until acknowledged; this is the direct fix for "no
   indicator". Aligns with `ui.md` disclosure/▸ completion guidance and the
   existing `BatchConsole` legibility work (0019).

2. **Toast as a secondary, non-blocking echo (optional).** A transient "Lote
   listo · 12 en cola" toast is good acknowledgement but must NOT be the only
   signal — toasts are missable and ephemeral, which is how this bug would still
   feel half-broken. Use it to *augment* the persistent card, never replace it.

3. **Optimistic removal + authoritative reconcile (the list).** On run start,
   remove the staged ids from the visible list immediately (they are in-flight —
   prevents re-selecting/re-submitting the same lead mid-run). On terminal
   status, refetch the eligibility query (now server-authoritative) so the list
   converges to truth: scheduled leads gone, genuinely-still-eligible leads
   (e.g. held/skipped, if the operator wants them retryable) reappear. Clear the
   selection set on completion so stale checkboxes don't carry over.

4. **Single source of truth for "eligible".** The membership predicate of the
   Prepare list must equal reality: "has a deliverable email AND is not already
   contacted AND has no active scheduled send." Deriving it server-side (one
   predicate, reused by both lead surfaces) prevents the client and server from
   disagreeing — the structural cause of this class of bug.

5. **Idempotency made visible.** Because the engine already guards double-enqueue
   (`enqueueTxn` + `hasActiveScheduledSend`, `db/batch.ts:117-118`), the UI
   should reflect that guarantee rather than depend on it: a lead that cannot be
   re-prepared should not be *selectable* to be re-prepared.

## Implementation plan

_Proposed — operator approves before edits._

- **Step 1 (server eligibility, the root fix).** Add to `buildOutreachWhere`
  (`db/index.ts`) a `NOT EXISTS (SELECT 1 FROM scheduled_sends s WHERE
  s.business_id = b.id AND s.status IN ('scheduled','claimed','deferred'))`
  condition, mirroring `stmtHasActiveScheduledSend`. Consider extracting the
  status tuple to one shared const so the enqueue guard and this exclusion can
  never drift.
  *(verify by: SQL — a business with an active scheduled_sends row is absent from
  `getOutreachLeads({validEmail:true})`; the main Outreach tab still lists
  un-scheduled leads.)*
- **Step 2 (client reconcile).** `useLeadStaging` gains a `refetch()` and a way
  to optimistically drop ids. `PrepareLane`/`useBatchRun` calls: optimistic-drop
  staged ids on `start`; on `batch:progress` terminal status, `refetch()` +
  `clear()` selection.
  *(verify by: live — stage 5, run, on completion the 5 (scheduled ones) are gone
  from Prepare and present in Enviar; no manual reload.)*
- **Step 3 (completion state — card + toast).** Treat `done`/`canceled` as a
  third lane state in `PrepareLane` (not just `active` vs idle). Render a
  **completion summary card** built from the final `progress` counts +
  `getBatch(runId)` dispositions, written as a clear structured human sentence —
  e.g. "25 leads preparados y agendados · 3 fallaron (email inválido) · 2 sin
  evidencia". Primary "Preparar más" (acknowledge → idle + cleared selection);
  a failures affordance (expand to per-lead `lastError`) when `failed > 0`.
  Design bar: **modern/fresh, feels nice** — entrance transition (panel/disclosure
  160–240ms per `ui.md`), count-up or staged reveal of the outcome numbers, amber
  only as the success/primary accent, JetBrains Mono for the numerals, tokens
  from `globals.css` (no raw hex, no `Loading...`). Respect `prefers-reduced-motion`.
  Also fire a transient **toast** echo ("Lote listo · 25 en cola") as a secondary
  signal — never the only one. If no toast primitive exists yet, build a small
  custom one in `client/src/ui/` (banned: native/alert).
  *(verify by: screenshot of the completion card + toast after a real run; counts
  match `getBatch(runId)` dispositions; reduced-motion path checked.)*
- **Step 4 (held/skipped visibility — decided).** Terminal-but-unscheduled leads
  return to the eligible list **de-emphasized** (subordinate row treatment — e.g.
  muted text + a small "sin evidencia"/"genérico" tag — so they read as "still
  here, lower priority", not fresh). The completion copy states it ("9 en cola ·
  3 siguen disponibles, sin evidencia"). `held_generic` returns the same way; its
  chatbot-offer track is parked, not built here.
  *(verify by: after a run with held/skipped outcomes, those leads are present but
  visually subordinate; fresh eligible leads are not.)*

## Verification gate

_Filled DURING execution with live evidence._

- [ ] SQL: `SELECT b.id FROM businesses b JOIN scheduled_sends s ON
  s.business_id=b.id AND s.status IN ('scheduled','claimed','deferred')` ∩
  `getOutreachLeads({validEmail:true})` → **empty** (no scheduled lead is
  eligible). Run for a dry-run batch AND a real batch.
- [ ] SQL: count of eligible leads strictly decreases by the number queued after
  a run (held/skipped behaviour per Step 4 accounted for).
- [ ] Live: stage N → run → on completion, queued leads vanish from Preparar with
  no reload; appear in Enviar. Recorded.
- [ ] Live: completion summary card appears on `done` and on `canceled`; persists
  until "Preparar más"; counts equal `getBatch(runId)` dispositions.
- [ ] Regression: the main Outreach-tab lead queue still lists the correct
  (un-scheduled, un-contacted) leads.
- [ ] Gate script (regression guard, pattern of `server/src/scripts/batchLiveGate.ts`):
  after `enqueueForSend`, assert the business is absent from
  `getOutreachLeads({validEmail:true})`. Asserts the predicate, both modes.
- [ ] `npx tsc --noEmit` clean (client on host; server in container).

## Behaviour & regression-prevention notes

Why this bug existed and how the slice stops it recurring:

- **The structural cause** is a predicate mismatch: "eligible to prepare" was
  defined as `outreach_status IS NULL`, but the lifecycle has an intermediate
  state — *scheduled, not yet sent* — that this predicate ignored. Any future
  list that means "still actionable" must encode *every* state that makes a lead
  no longer actionable, not just the terminal one. The reused
  `hasActiveScheduledSend` tuple is the canonical list; key off it.
- **The regression guard is the gate script**, not a UI assertion: it pins the
  invariant "a lead with an active scheduled send is never returned as eligible"
  at the data layer, where the bug actually lived. A UI test would have missed
  the dry-run case.
- **Completion must be a state, not a transition.** The lane had only
  active/idle; "done" fell through to idle and was lost. Modeling the terminal
  run as its own acknowledged state means a finished run can never be silently
  swallowed again — the same shape the Send lane already has for its queue.
- **Edge cases to exercise:** cancel mid-run (partial queued set must still
  reconcile); a lead held_generic (no scheduled row — confirm intended
  visibility); re-opening the Automate tab mid-run (rehydration via
  `getActiveRuns` already handled — confirm completion still fires on the live
  terminal event after rehydrate); two quick consecutive batches (selection from
  the first must not bleed into the second).

## Completion record

- Commit SHAs: …
- What changed: …
- Follow-ups / new parked items:
  - **Chatbot-offer track for `held_generic` leads.** A lead held as generic
    (no assertable website anchor) is the natural prospect for a "I can build you
    a chatbot/site" offer — a distinct outreach track, like the no-website
    WhatsApp lane (`0007`). Park; rank later.
