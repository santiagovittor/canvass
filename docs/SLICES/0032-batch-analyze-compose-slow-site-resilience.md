# Slice 0032: Batch analyze/compose slow-site resilience — no lead lost to a self-timeout

## Intent

Slice `0031` killed the *contention* mass-failure (timeouts 25/30 → 4/30) but left a
parked floor: on run `0d4a4131` (30 leads, clear lane, RPD healthy) **4 items still
dead-lettered** on `analyze_timeout`/`compose_timeout`. Those are **self-inflicted**, not
contention: a genuinely slow site overruns the per-item wall-clock budget and the lead is
marked `failed` (terminal) — even though the work was about to finish.

Two compounding faults make this lossy:

1. **A slow sub-stage can dominate the whole analyze budget.** `runPremiumAnalysis` runs
   render → signatures → **psi** → vision inside one 120s `withTimeout`
   (`batchOrchestrator.ts:120`). PSI alone has a **60s** internal timeout
   (`psiClient.ts:8`, `TIMEOUT_MS = 60_000`) and is *non-essential enrichment that already
   degrades to null*. A 60s PSI + a slow render + a retrying vision call blows 120s →
   `analyze_timeout`.
2. **The wall-clock timeout dead-letters in-flight work that doesn't stop.** `withTimeout`
   is `Promise.race` (`batchOrchestrator.ts:46`) — it **does not cancel** the inner
   `runPremiumAnalysis`. The analysis keeps running and completes as a `done` row seconds
   later, but the batch already transitioned the item to `failed` (`driveRun` catch,
   `batchOrchestrator.ts:218`). The lead is lost despite a successful analysis sitting in
   the DB.

The user requirement is explicit: **these functions (batch analyze + compose) must be
flawless every time** — a slow site may delay a lead, never dead-letter it. This slice
makes both stages *recoverable* instead of *terminal* on their own slowness, and bounds the
slow sub-stage so the budget is predictable. It also closes the one remaining `0031`
verification debt — the **F2 contrived-overlap live proof**.

Roadmap: new `bug·4` follow-up to the `0022` reliability line, sibling of `0031`
(`bug·3`) — same failure surface (`analyze_timeout`/`compose_timeout` dead-letters),
different cause (self-slowness vs. contention).

## Out of scope

- **No contention re-work.** `0031`'s yield (A) + Gemini priority (B) stay exactly as
  shipped. This slice is orthogonal — it handles the *clear-lane* residual.
- **No raising of Gemini ceilings** (`GEMINI_RPM`/`RPD`/`MAX_CONCURRENT`) — same `0031`
  out-of-scope rule.
- **No in-flight cancellation plumbing** (proposed: let the timed-out analysis complete and
  reuse it via `0031`'s F2 guard + TTL freshness — see plan). Threading an `AbortSignal`
  through `renderSite`/Playwright/PSI/vision is a larger change; flagged as the fallback if
  "let-complete + reuse" proves insufficient.
- **No change to genuinely-failing renders.** `render.outcome === 'browser_error'` → `failed`
  stays terminal (a real dead site, not a slow one). Only *timeouts* become recoverable.
- **No send-path / scrape-path / schema-destructive changes.** Any new column is additive.
- **No parallelism.** "Jobs run sequentially" + `BATCH_PREPARE_CONCURRENCY` semaphore
  unchanged.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Reuse-only registry.** Reuse `runPremiumAnalysis`, `composeVerifiedEmail`,
  `withTimeout`, `transitionItem`, `listResumableItems`, `getRunningAnalysis` (the `0031`
  F2 helper), `createPremiumAnalysisRunning`, `getLatestPremiumAnalysis`, `isAnalysisFresh`,
  `fetchPsi`/`runPsi`. Do not reimplement.
- **Additive only** — a new `attempt_count` column (if chosen) is `NOT NULL DEFAULT 0`; no
  destructive migration. Follow the existing `db/migrate.ts` additive pattern.
- **Jobs run sequentially** — the analyze worker stays one-at-a-time; retries are serial.
- **tsc clean gate** — `npx tsc --noEmit` in the server container before done.
- **SSE only** — any new disposition rides existing `batch:progress`; no polling.
- **No false absence** — symbols below were grepped and confirmed present.

## Diagnose-first checklist

Done BEFORE any edit. Operator approves the implementation plan before edits begin.

- [x] Files read: `batchOrchestrator.ts` (`processItem`, `driveRun`, `withTimeout`),
      `premiumAnalyzer.ts` (`runPremiumAnalysis`, stages, `runPsi`), `psiClient.ts`
      (`TIMEOUT_MS = 60_000`), `db/batch.ts` (`transitionItem`, `listResumableItems`,
      `NON_TERMINAL_STATES`, no `attempt_count`), `db/premium.ts` (`getRunningAnalysis`,
      `isAnalysisFresh`, `createPremiumAnalysisRunning`), `env.ts` (batch + gemini
      timeouts), `db/schema.ts` (`batchItems` columns).
- [x] Symbols cataloged:
  - `batchOrchestrator.ts`: `withTimeout()` (`:46`, Promise.race, **no cancel**);
    analyze wrap `:120`; compose wrap `:156`; `driveRun` catch dead-letters non-Gemini
    errors → `transitionItem 'failed'` (`:218`); finalize loop `:230`; semaphore
    `BATCH_PREPARE_CONCURRENCY`.
  - `premiumAnalyzer.ts`: `stage('psi', () => runPsi(...))` (`:429`); PSI/vision already
    degrade to null on failure; `GeminiRpdExhausted` re-thrown (`:453`).
  - `psiClient.ts`: `TIMEOUT_MS = 60_000`; `fetch(url, { signal: AbortSignal.timeout(...) })`;
    degrades to `UNKNOWN` on timeout.
  - `db/batch.ts`: `NON_TERMINAL_STATES = [pending, analyzing, analyzed, composing,
    composed, verifying, verified]`; `transitionItem(item, state, {disposition,lastError})`;
    no attempt counter column.
  - `db/schema.ts`: `batchItems` = `state`, `disposition`, `last_error`, `created_at`,
    `updated_at` — **no `attempt_count`**.
  - env: `BATCH_ANALYZE_TIMEOUT_MS`(120000), `BATCH_COMPOSE_TIMEOUT_MS`(180000),
    `GEMINI_TIMEOUT_MS`(30000), `GEMINI_TOTAL_CAP_MS`(Settings), `BATCH_STALL_TIMEOUT_MS`(600000).
- [x] Research / confirmed:
  - `withTimeout` Promise.race does not abort the losing promise — the inner
    `runPremiumAnalysis` runs to completion after `analyze_timeout` fires (the lossy core).
  - `0031` F2 `getRunningAnalysis(businessId)` already guards against double-render: a retry
    that finds the prior render still `running` will skip→resumable; once it completes,
    `isAnalysisFresh` TTL reuse finishes the lead with **no re-render**. → "let-complete +
    retry" is non-redundant by construction.
  - Re-drive gap (carried from `0031` F2): a resumable item is only re-driven by
    `resumeBatch`/boot, **not** automatically within a running `driveRun`. Bounded in-run
    re-drive is needed or timed-out items sit until the stall watchdog fails them.
- [x] Open questions for the operator — resolved (operator delegated; goal = email
      quality + fewest failures + no AI slop + more leads):
  1. **K = 2** retries before terminal.
  2. **PSI: NOT capped.** Deviation from the proposed batch-PSI cap — capping degrades
     the analysis (null PSI → weaker anchors → *more generic* emails), which fights the
     stated quality/anti-slop goal. Instead **raise `BATCH_ANALYZE_TIMEOUT_MS` 120→180s**
     so a full-quality analyze (render + full 60s PSI + vision) fits the budget; P2 makes
     the rare overrun lossless anyway.
  3. **`attempt_count` column** (additive).
  4. **Bounded in-run re-drive** (sleep on a stagnant pass; `MAX_STAGNANT_PASSES` floor).
  5. **No new disposition.** Reuse `failed` + a descriptive `last_error`
     (`analyze_timeout_exhausted_after_N`) — keeps the operator's slow-vs-broken signal
     with **zero client/UI change** (the per-lead outcome list already shows `last_error`).

### Open questions for the operator

1. **Retry budget `K`** before a timeout becomes terminal `failed`. Recommend **`2`**
   (analyze + compose each get up to 2 timeout-retries; with the in-flight analysis
   completing in the background, retry #2 almost always reuses a now-`done` fresh row).
2. **PSI budget inside the batch analyze path.** PSI is enrichment that degrades to null.
   Recommend a tight **~20s** cap (wrap `stage('psi', …)` in `withTimeout(...,
   'psi_slow')` that degrades to null, or thread a shorter per-call timeout) so PSI can
   never consume more than ~⅙ of the 120s budget. Keep the 60s default for the
   *non-batch* auto-analyze queue, or tighten globally? Recommend **batch-context only**.
3. **Attempt tracking storage.** New additive `attempt_count INTEGER NOT NULL DEFAULT 0`
   on `batch_items` (clean, queryable) **vs.** encoding attempts in `last_error`.
   Recommend the **column**.
4. **In-run re-drive vs. defer to resume.** Recommend **bounded in-run re-drive**: after
   `Promise.all`, if resumable items remain *and* made progress *and* are under `K`
   attempts, re-loop `listResumableItems` (closes the gap without a new timer).
5. **New terminal disposition for an exhausted-retry slow site** — distinct
   `failed_slow` disposition vs. reuse `failed`? Recommend **`failed_slow`** (so the
   operator can tell "genuinely slow" from "broken" in the outcome breakdown).

## Implementation plan

_Proposed. Operator approves before edits in the fresh session._

### P1 — Give a full-quality analyze room in the budget (chosen over capping PSI)

- **Step P1 (as built)** — Raise `BATCH_ANALYZE_TIMEOUT_MS` **120 → 180s** (`env.ts`,
  Settings-overridable). Sized for worst-case-LEGIT: render ~20s + full PSI ≤60s + vision
  ≤ Gemini total cap. **PSI is intentionally NOT capped** — keeping the full analysis
  preserves the anchors compose relies on (quality / anti-slop). Overruns past 180s are
  recoverable via P2, not terminal. Still well under the 600s stall watchdog.
  - _Verify:_ `getNumber('BATCH_ANALYZE_TIMEOUT_MS') === 180000`; a real example.com
    analyze (render 1.6s + PSI 9.3s + vision) completes inside budget.

### P2 — Make analyze/compose timeouts recoverable, not terminal

- **Step P2a** — Add bounded attempt tracking (Q3). Additive
  `attempt_count` on `batch_items`; bump on each timeout-retry of an item.
- **Step P2b** — In `driveRun`'s catch, branch on the timeout sentinel
  (`err.message === 'analyze_timeout' | 'compose_timeout'`): if `attempt_count < K`
  (Q1), **do not dead-letter** — revert the item to a resumable state (`pending`),
  increment `attempt_count`, leave the in-flight analysis running. Only at
  `attempt_count >= K` → terminal `failed` (disposition `failed_slow`, Q5). All other
  errors keep dead-lettering immediately (unchanged).
  - _Verify:_ contrive an analyze timeout (PSI/vision slow on item X) → X reverts to
    `pending`, `attempt_count=1`, **not** `failed`; the prior analysis row finishes `done`.
- **Step P2c** — Bounded in-run re-drive (Q4). After `Promise.all`, if resumable items
  remain and progress was made and any are under `K`, re-fetch `listResumableItems` and
  re-drive (a bounded `while`, not recursion). On retry, `0031` F2's `getRunningAnalysis`
  skips the still-running render; once `done` + TTL-fresh, the item composes and queues.
  - _Verify:_ the timed-out X from P2b is re-driven in the **same run**, reuses the
    now-`done` analysis (no second render — exactly one bundle dir), and reaches
    `sent_specific`/`held_generic` instead of sitting until the stall watchdog.

### P3 — Close the 0031 F2 contrived-overlap live proof

- **Step P3** — A throwaway gate script in `server/src/scripts/` (mirror
  `geminiReliabilityGate.ts`): enqueue business X → claim it (`claimNextPending`, flips
  X to `running`) → start a batch including X → assert exactly one render of X, one
  `completePremiumAnalysis(id)`, one `premium/<X>/<id>` bundle dir, X's item reverts to
  `pending` (not a duplicate render), no duplicate cost-ledger row for X.
  - _Verify:_ script prints `OK F2` with the asserted counts; run in the server container.

## Verification gate

_Filled DURING execution with live evidence._

- [x] `npx tsc --noEmit` clean (server in container) — `EXIT:0` after each phase (A
      schema/db/migrate, B env/orchestrator, C gate scripts).
- [x] Migration applied: `PRAGMA table_info(batch_items)` →
      `…,last_error,attempt_count,created_at,updated_at` (additive, default 0). Server
      reboots clean on the new code.
- [x] Budget raised: `getNumber('BATCH_ANALYZE_TIMEOUT_MS') === 180000`; the
      timeout-recovery gate log shows a real example.com analyze finishing in-budget
      (`▶ render … ok 1.6s`, `▶ psi … ok 9.3s`, `✓ premium done 7.0s`).
- [x] **P2 timeout-recovery gate** (`batchTimeoutRecoveryGate.ts`, forces analyze_timeout
      via the 1000ms registry-min budget on a synthetic forceRefresh lead) → **2/2,
      `OK TIMEOUT-RECOVERY`**:
      - first `analyze_timeout` → item reverts to `pending`, `attempt_count=1` — **NOT
        dead-lettered**.
      - after `K=2` → terminal `failed`, `last_error='analyze_timeout_exhausted_after_2'`
        (slow ≠ broken).
- [x] **F2 contrived-overlap gate** (`batchF2OverlapGate.ts`, the 0031 debt) → **7/7,
      `OK F2`**: with a seeded `running` analysis, the batch reverts the item to `pending`,
      starts **no second render** (one analysis row, no bundle dir, no cost-ledger row),
      seeded row untouched.
- [x] Side-effects clean: tiny budget restored to 180000 (not left persisted), zero gate
      leftovers, server healthy (`autoAnalyze.backlog=286`).
- [ ] **Real 30-lead slow-site batch → 0 timeout dead-letters** — deferred to an operator
      live run (real Gemini budget on live data; same posture as 0031). The
      recovery+ceiling mechanism is proven deterministically by the gate above; this item
      confirms the end-to-end outcome on production leads.

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - **P1** `env.ts` — `BATCH_ANALYZE_TIMEOUT_MS` 120→180s (full-quality analyze fits;
    PSI deliberately not capped, to protect anchor quality / anti-slop).
  - **P2a** `schema.ts` + `db/index.ts` (CREATE) + `db/migrate.ts` (additive ALTER) —
    `batch_items.attempt_count`; `db/batch.ts` `bumpBatchItemAttempt()`.
  - **P2b** `batchOrchestrator.ts` — driveRun catch branches on the timeout sentinels:
    `< K` → bump + revert to `pending` (recoverable; the in-flight analysis finishes and
    is reused via the 0031 F2 guard + TTL, no re-render); `>= K` → terminal `failed`
    tagged `…_exhausted_after_N`. All other errors dead-letter as before.
  - **P2c** `batchOrchestrator.ts` — single pass → bounded in-run re-drive `while` loop;
    a stagnant pass (every remaining item waiting on its in-flight analysis) sleeps
    `REDRIVE_DELAY_MS` before retrying, `MAX_STAGNANT_PASSES` safety floor → stall
    watchdog backstop.
  - **P3** new `scripts/batchF2OverlapGate.ts` + `scripts/batchTimeoutRecoveryGate.ts`
    (committed regression gates).
- Follow-ups / new parked items:
  - End-to-end 30-lead slow-site outcome pending an operator live run (gate-proven
    mechanism; deferred to avoid spending Gemini budget on live data).
  - `failed_slow` as a first-class disposition (with client label) was **not** added —
    reused `failed` + `last_error`. Revisit only if the outcome UI needs the distinction.
