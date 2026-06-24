# Slice 0019: Relocate the batch runner to an Automate tab + make the long run legible

> Derived from `0017` findings (c)(d) / S2 — the centerpiece. The operator's #1
> feature. Prereq: `0018` (so the taller surface isn't itself clipped).

## Intent

"Run batch" prepares a batch of leads (validity-gate → analyze → compose →
verify → gate → enqueue) and is the operator's most important feature, but today
it lives in a ~120px strip on top of the lead queue, shows only `processed/total`
+ a row of counts, gives no ETA and no sense of what's happening, and collapses
every per-lead failure into a single reason-less number. This slice gives it a
dedicated, inviting home — a new top-level **Automate** tab — and wires it to the
signal the backend *already emits*: which lead is in flight, the live pipeline
stage, elapsed, a computed ETA, accumulated cost, and an expandable list of
per-lead outcomes (including failure reasons). No new orchestration — the data
exists; this is read + render + a thin SSE subscription.

**Operator-chosen placement:** a new **Automate** tab (top-level), intended to
become the home for all automations over time (batch prepare now; daily digest
`0008` and auto-compose-schedule `0009` later). This slice moves only the batch
runner there; the scheduled-send console stays in Outreach for now (noted as a
follow-up to avoid scope creep).

**Project vocabulary:** Add an `'automate'` view to `App.tsx`; build an
`AutomatePage` hosting a redesigned `BatchRunner` that subscribes to the existing
`batch:progress` (`batchOrchestrator.ts:57-71`) and `outreach:stage`
(`stageTracker.ts:92-123`) SSE channels, derives an ETA from `EXPECTED_MS`
(`StageTracker.tsx:17`) and/or observed throughput, and renders per-lead
dispositions read from `batch_items` (`server/src/db/batch.ts`). Retarget the
batch chip in `ActiveRunsStrip` to navigate to `'automate'`.

## Out of scope

- **Moving the scheduled-send console** (BusinessContext right rail:
  `Outreach.tsx:629-641`) into Automate — desirable, but a separate slice. Leave
  it in Outreach.
- Any change to the prepare pipeline itself (`processItem`,
  `composeVerifiedEmail`, the gate/governor). This is a presentation slice.
- Provider-quota "out of credits" banner — that is `0020` (this slice should
  leave a clear seam for it: render `pauseReason` honestly so `0020` can add the
  new reason without rework).
- Full design-token conformance of the new surface — build it on tokens from the
  start (don't add new sub-12px/hex debt), but the global sweep is `0021`.

## Constraints

- **SSE only** (`SPEC.md`; `ui.md` Realtime). Subscribe to existing
  `batch:progress` + `outreach:stage` via `useSSE`; the connect-time
  `runs:snapshot` (`sse.ts:69-74`) already rehydrates an in-flight batch
  (`Outreach.tsx:161-172` shows the pattern — reuse `getActiveRuns()`). No
  polling, no `setInterval` data fetch (a local UI tick to animate the bar, like
  `StageTracker.tsx:73-78`, is fine — it is not a data poll).
- **Client architecture** (`rules/architecture.md`): all HTTP through
  `lib/batchApi.ts` / `lib/activeRunsApi.ts`; no `fetch(` in `.tsx`; logic in a
  hook, not the component.
- **Reuse, don't reimplement** (`SPEC.md` registry): batch control via
  `startBatch/pauseBatch/resumeBatch/cancelBatch` (`lib/batchApi.ts` →
  `batchOrchestrator`); stage rendering can reuse/extend `StageTracker.tsx`.
- **Additive only** if any new field is needed (prefer deriving on the client
  from existing `batch:progress` + `batch_items`; add a server field only if a
  value genuinely isn't reconstructable).
- **DESIGN/ui**: the new surface uses `--text-*`/spacing tokens, `.btn-primary`/
  `.btn-secondary`, raised-pane elevation tokens for the action surface
  (`DESIGN.md §4` raised panes / action strips). No tiny type, no raw hex.

## Diagnose-first checklist

Mostly done in `0017` (c)(d). Confirmed before editing (2026-06-23):

- [x] Files read (all of the listed paths).
- [x] Symbols catalogued:
  - `batch:progress` payload (`batchOrchestrator.ts:60-70`): `{ runId, status,
    total, processed, skippedNoEvidence, heldGeneric, queuedForSend, failed,
    pauseReason }`. **No current-lead, no cost** in this payload.
  - `outreach:stage` payload (`stageTracker.ts`): `{ id, businessId, stage?,
    phase: 'start'|'end'|'retry'|'done', status?, durationMs?, retryDelayMs?,
    totalMs?, costUsd?, anchor?, disposition?, error? }`. Carries **businessId**
    (→ current lead) and **costUsd** on `phase:'done'` (→ accumulate run cost).
  - `BatchProgress` type: `client/src/lib/batchApi.ts:18-28`.
  - `BatchItemRow` (`db/schema.ts:84-98`): `state`, `disposition`, `lastError`,
    `businessId` — **no business name** (need a join for the outcome list).
  - `EXPECTED_MS`: `StageTracker.tsx:17-19` (per-stage ms).
  - `View` union: `App.tsx:130` and `ActiveRunsStrip.tsx:5` (two copies, keep in
    sync).
  - Batch concurrency default = **3** (`env.ts:37`) → up to 3 leads in flight;
    "current lead" = most-recently-active businessId from `outreach:stage`.
- [x] Per-lead outcome list — **reuse, don't add a new endpoint.**
  `GET /api/batch/:id` (`routes/batch.ts:24-28`) already returns `{ run, items }`
  via `getBatchItems` and is already wrapped by `batchApi.getBatch`. Items lack
  the business name, so extend `getBatchItems` with a one-query join on
  `businesses.name` (additive). No new `/runs/:id/items` route needed; this is
  more reuse-faithful than a duplicate read.
- [x] ETA method: (b) observed mean ms/lead × remaining once ≥2 processed; fall
  back to (a) `sum(EXPECTED_MS)` × remaining for the first lead. Pause → freeze
  with an honest "paused" label, no countdown.
- [x] Tab label: default to **Automate** (operator's own suggestion; no blocker).

## Implementation plan

_Proposed by `0017`. Operator approves before edits._

- **Step 1 — Add the Automate view shell.** Extend the `view` union in
  `App.tsx:130` with `'automate'`; add a tab button (`App.tsx:160-189`); render
  `<AutomatePage/>` in a `.view-fill` branch (`App.tsx:244-256`). Update the
  `View` type in `ActiveRunsStrip.tsx:5` and any shared type.
  *(Verify by: the Automate tab appears and switches; empty page renders.)*
- **Step 2 — Move batch state ownership into a hook.** Create
  `hooks/useBatchRun.ts` that owns `batchProgress` + `batchRunIdRef`, the
  `batch:progress` subscription (`Outreach.tsx:431-436`), and mount-time
  rehydration via `getActiveRuns()` (`Outreach.tsx:161-172`). `AutomatePage`
  consumes it. Remove the batch state from `Outreach.tsx` and delete the in-queue
  `<BatchRunner>` (`Outreach.tsx:565-574`) once the new home works.
  *(Verify by: start a dry-run batch from Automate; counts update live; switch
  tabs and return — run rehydrates, not lost.)*
- **Step 3 — Build the legible runner.** Redesign `BatchRunner` (or a new
  `BatchConsole`) as a comfortable raised surface: start controls (presets +
  custom N + dry-run), and while active: progress bar, current lead name + live
  stage (subscribe `outreach:stage` filtered to the in-flight lead — reuse
  `StageTracker`/`useStageProgress` rendering), elapsed, **ETA**, accumulated
  cost, and per-disposition counts with plain labels (queued / skipped / held /
  failed).
  *(Verify by: during a real run, the surface shows the current lead + stage
  advancing, an ETA that decreases, and counts that match the DB.)*
- **Step 4 — Per-lead outcome list.** Add a `GET /api/runs/:id/items` read
  (route → `getBatchRun`/items in `db/batch.ts`) and render an expandable list of
  leads with their disposition and `lastError` reason (the reason already
  persisted at `batchOrchestrator.ts:208`). This is the answer to "sometimes it
  fails and I don't know why."
  *(Verify by: force a failure (e.g. a bad-MX lead) and confirm its reason shows
  in the list, not just an aggregate `failed` number.)*
- **Step 5 — Retarget navigation.** `ActiveRunsStrip` batch chip → navigate to
  `'automate'` (`ActiveRunsStrip.tsx:43-54`).
  *(Verify by: clicking the running batch chip lands on Automate.)*
- **Step 6 — ETA honesty.** Ensure ETA never claims completion early and degrades
  gracefully when paused (show "paused" not a frozen countdown).
  *(Verify by: pause mid-run — ETA pauses with an honest label.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-24, run
`352a945f-4b23-469b-87f9-bd0a991545f9`, dry-run, 3 leads). Captured by driving
the live SPA through the dev playwright browser → `http://<client>:5173`,
Automate tab._

- [x] **Screenshot: Automate tab, batch running.** The raised console renders
      title "Preparando batch", `1/3`, amber progress bar, and the metric strip
      **ETA `1m 24s` · Transcurrido `3s` · Costo `$0.0000`** (all
      `--font-mono`), the per-disposition row **queued 0 · skipped 0 · held 1 ·
      failed 0**, and the "Resultados por lead (1)" disclosure. The
      `ActiveRunsStrip` chip up top now reads "Outreach batch 1/3 · 0 queued"
      and the **Automate** tab is active. Live update confirmed: between two
      shots `Transcurrido` advanced `3s → 4s` and `held` went `0 → 1`, driven
      only by SSE (no poll). *(The current-lead + `StageTracker` block renders
      only while a lead is mid-stage; both shots landed in a between-stage
      instant under the 503 storm below, so that block isn't visible in them —
      the code path is `BatchConsole.tsx:151-158`.)*
- [x] **Screenshot: per-lead outcome list with a real reason.** Expanding
      "Resultados por lead" shows **"Estudio Jurídico Lara & Asociados"** (the
      business name comes from the new `getBatchItems` LEFT JOIN — `businesses`
      has no FK from `batch_items`, so without the join this would be a raw
      `place_id`) with reason **"No anchor survived verification — would send
      generic. Held."** and a **held** badge. This is the slice's core intent —
      a reason, not a reason-less aggregate.
- [x] **Rehydration:** start batch → switch to **Scraper** → return to
      **Automate** → the running console is still shown (not reset). Verified
      programmatically (`showedRunningBeforeSwitch=true`,
      `showedRunningAfterReturn=true`) and by screenshot `automate-rehydrated`.
      A cold page-load also rehydrates (every screenshot above is a fresh page
      that found the in-flight run via `getActiveRuns()` on mount).
- [◑] **SSE events while on Automate.** The live `/events` stream was captured
      and delivered `runs:snapshot` carrying the in-flight batch
      (`{"type":"batch","runId":"352a945f…","status":"running","total":3,
      "processed":1,"heldGeneric":1,…}`) — the exact connect-time rehydration
      payload `useBatchRun` consumes. `outreach:stage` / `batch:progress`
      emission is proven by (a) the broadcast call sites
      (`stageTracker.ts:66-120`, `batchOrchestrator.ts:60-70`) and (b) the
      server stage log for this run:
      `[09ca5a] ▶ verify … ok 25.0s` / `▶ gate … ok 0.0s` /
      `✓ compose done 287.4s — anchor=vision_opp_1, disposition=held_generic`.
      A clean capture-window line for `outreach:stage` was not obtained because
      Gemini `gemini-2.5-flash` was returning a sustained `503` storm ("This
      model is currently experiencing high demand"), stretching each lead to
      ~5 min with long quiet backoff gaps between stage boundaries; this is the
      known upstream flakiness ([[project_gemini_model_map]]), not a defect in
      the SSE wiring. The UI's live counter advance (above) confirms the client
      is in fact consuming these events.
- [x] **SQL matches UI.** `SELECT disposition, state, last_error, count(*) FROM
      batch_items WHERE batch_id='352a945f…' GROUP BY 1,2,3`:
      `1 | state=held_generic | disp=held_generic | err=No anchor survived
      verification — would send generic. Held.` plus `2 | state=composing |
      disp=null | err=null` (the two leads still mid-pipeline when the run was
      cancelled to stop Gemini spend). The one terminal row equals the UI's
      `held 1` count and the exact reason string shown in the outcome list; the
      two non-terminal items are correctly absent from the outcome list (it
      filters to terminal states).
- [x] **`npx tsc --noEmit` clean** — client (`-p client/tsconfig.json`) and
      server (in the dev container, `cd /app/server && npx tsc --noEmit`). Both
      after every step and after the final orphan deletion.

## Completion record

- Commit SHAs: _pending — changes are in the working tree on
  `feat/no-website-lane` (alongside other in-progress slices); not committed in
  this session._
- What changed:
  - **New top-level Automate tab.** `App.tsx` `view` union + tab button +
    `.view-fill` branch rendering `<AutomatePage/>`. `ActiveRunsStrip` `View`
    type extended; the batch chip now navigates to `'automate'` (was
    `'outreach'`).
  - **`hooks/useBatchRun.ts` (new)** — lifts all batch ownership out of
    `Outreach.tsx`: `batch:progress` subscription, `getActiveRuns()` mount
    rehydration, `outreach:stage` tracking for current-lead (latest
    `phase:'start'` businessId) + accumulated cost (sum `costUsd` on
    `phase:'done'`), and `start/pause/resume/cancel`.
  - **`components/Automate/AutomatePage.tsx` + `BatchConsole.tsx` (new)** — the
    legible raised surface: idle start controls (presets 15/30/60 + custom N +
    dry-run) and, while active, progress bar, ETA (observed mean ms/lead ×
    remaining once ≥2 processed; `42s`/lead fallback for lead 1; frozen with a
    `—` label when paused), elapsed, accumulated cost, per-disposition counts,
    honest `pauseReason` (a clean seam for slice 0020), reused `StageTracker`
    for the in-flight lead, and an expandable per-lead `OutcomeList`.
  - **`server/src/db/batch.ts`** — `getBatchItems` now LEFT JOINs `businesses`
    to return `name` + `locCountry` (`BatchItemWithBusiness`); additive, one
    query. `routes/batch.ts` `GET /api/batch/:id` already passes it through; no
    new endpoint. `lib/batchApi.ts` gains the `BatchItem` type.
  - **`StageTracker.tsx`** — prop widened to the minimal structural shape
    `{ id; locCountry }` so the console can reuse it without fabricating a full
    `OutreachLead`.
  - **`Outreach.tsx`** — removed all batch state/handlers and the in-queue
    `<BatchRunner>`; `components/Outreach/BatchRunner.tsx` deleted (provably
    unused after the move, per CLAUDE.md §3).
- Follow-ups / new parked items:
  - Move the scheduled-send console into Automate; host `0008` digest +
    `0009` auto-compose-schedule here.
  - Slice 0020 wires the real provider-quota banner onto the `pauseReason`
    seam (`BatchConsole` already renders `gemini_rpd_exhausted` honestly).
  - The ETA elapsed anchor resets on AutomatePage remount (tab switch) because
    it's keyed on first-seen-time, not run start — acceptable for now; revisit
    if operators want true wall-clock elapsed.
