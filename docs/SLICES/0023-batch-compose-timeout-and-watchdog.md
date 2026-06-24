# Slice 0023: Batch compose timeout + run-level watchdog

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F1**. Highest-priority reliability fix — ship first.

## Intent

**Plain English.** Stop the "Prepare a batch" run from freezing forever. Today one
Gemini request that never comes back can silently block the whole batch with no
error and no progress (the operator's 47-minute stuck run). This slice puts a
time limit on the compose step of each lead — so a stuck lead is dropped to
`failed` and the batch keeps going — and adds a safety net that fails/pauses any
run that stops making progress. After this, a 15-lead batch finishes in bounded
time, every time, or tells you why it stopped.

**Project vocabulary.** Wrap the `composeVerifiedEmail` call in
`batchOrchestrator.processItem` in the existing `withTimeout` helper (mirroring
the analyze stage already wrapped at `batchOrchestrator.ts:118`), and add a
run-level stall watchdog (reusing the recovery-timer pattern at
`batchOrchestrator.ts:254-271`) that detects a `running` run whose `updated_at`
has not advanced within a bound and finalizes/pauses it with an SSE-visible
reason.

## Out of scope

- The upstream Gemini 503 storm itself + provider switch — that is `0026`.
- Concurrency model changes (the single-slot Bottleneck stays; do not raise
  `maxConcurrent` here).
- The validity gate, email selection, sender rotation, UI scroll — separate slices.

## Constraints (`docs/SPEC.md`)

- **Reuse** `composeVerifiedEmail` (`outreachComposePipeline.ts`) and the existing
  `withTimeout` helper (`batchOrchestrator.ts:44-51`) — do not reimplement either.
- **Reuse** the batch state machine (`transitionItem`, `setRunStatus`,
  `listResumableItems`, `getBatchRun`) and `broadcastProgress` SSE.
- **SSE-only** for any new state surface — emit through `broadcastProgress` /
  `broadcast`, no polling.
- **Additive only** — `pause_reason` is free-text (stores `gemini_rpd_exhausted`,
  `provider_quota_exhausted`, …), so a new `stalled_timeout` reason needs no
  schema change. Any new env var added to `env.ts` with a zod default.
- **Failure isolation** is the existing contract (`batchOrchestrator.ts:215-219`):
  a thrown item → `failed`, batch continues. The compose timeout must throw, not
  swallow.

## Diagnose-first checklist

Mostly done in `0022` F1. Confirmed before editing:

- [x] Files read: `batchOrchestrator.ts` (full), `env.ts`, `settingsRegistry.ts`,
      `appSettings.ts`, `geminiRateLimiter.ts`, `db/batch.ts`, `util/time.ts`.
- [x] Symbols cataloged. **Key finding:** `getNumber` resolves through
      `settingsRegistry.getField`, so a new tunable MUST be added to BOTH `env.ts`
      AND `settingsRegistry.FIELDS` (exactly like `BATCH_ANALYZE_TIMEOUT_MS`:
      env.ts:39 + registry:216, with `envVar`). The `driveRun` catch arm
      (`:215-219`) is the default arm — a plain `Error('compose_timeout')` (not an
      `Rpd`/`Provider` subclass) lands there → item `failed`. Run `updated_at`
      advances on `setRunStatus` + terminal-bump statements (`db/batch.ts:20-29`);
      non-terminal item transitions bump the *item*, not the run.
- [x] **Slot release: NO leak.** `callWithTimeout` (`geminiRateLimiter.ts:195-207`)
      runs *inside* `limiter.schedule(async () => await callWithTimeout(...))`. On
      timeout it calls `ac.abort()` and the `Promise.race` rejects → the scheduled
      async fn throws → Bottleneck settles (rejects) the job → **slot freed within
      `GEMINI_TIMEOUT_MS`**. The comment at `:192-194` already asserts this; the
      structure guarantees it. ⇒ **the per-item compose timeout is
      belt-and-suspenders, not load-bearing.** (Confirmed live: see gate — the
      orphaned `[gemini] compose call` kept running after the item already failed at
      the 1s timeout, then completed and released its slot normally.)
- [x] `BATCH_COMPOSE_TIMEOUT_MS` default **180000ms** (per proposal).
- [x] Operator decision: **fail-and-finalize** on stall. Also flagged a tuning
      issue — worst-case-legit single item ≈ analyze(120s)+compose(180s) = ~300s
      before a run-counter bump, so the slice's `BATCH_STALL_TIMEOUT_MS` proposal of
      300000 would false-trigger. **Raised the default to 600000ms** (above
      worst-case-legit, well under "stuck").

## Implementation plan

_Operator approves before edits._

- **Step 1 — Per-item compose timeout.** In `processItem`, wrap the
  `composeVerifiedEmail(...)` call (`batchOrchestrator.ts:154`) in
  `withTimeout(…, getNumber('BATCH_COMPOSE_TIMEOUT_MS'), 'compose_timeout')`,
  exactly like analyze at `:118`. A timeout throws → the `driveRun` catch arm
  (`:215-219`) marks the item `failed` (`disposition:'failed'`,
  `lastError:'compose_timeout'`) and the batch continues. Add
  `BATCH_COMPOSE_TIMEOUT_MS` to `env.ts` (default 180000) and the settings
  registry so it is tunable.
  *(Verify: inject a hanging compose (temporary mock / unreachable model) → the
  lead transitions to `failed` at the timeout, the other leads keep processing,
  the run finalizes. Log line `compose_timeout` present.)*

- **Step 2 — Run-level stall watchdog.** Add a low-frequency sweeper (mirror
  `scheduleRecoveryProbe` at `:254-271`, `unref`'d) that, for every `running`
  run, checks `now - getBatchRun(runId).updatedAt`. If it exceeds
  `BATCH_STALL_TIMEOUT_MS` (default e.g. 300000) with no progress, mark all
  non-terminal items `failed` (`last_error='stalled'`) and finalize the run (or
  pause with `pause_reason='stalled_timeout'` per the operator's choice), then
  `broadcastProgress`. Arm it from `startBatch`/`resumeBatch`; re-arm on boot in
  `resumeInterruptedBatches`.
  *(Verify: a run artificially wedged with no item progress for the bound →
  watchdog finalizes/pauses it with the new reason; SSE shows it; no lingering
  `running` zombie.)*

- **Step 3 — Confirm slot release (from diagnose item).** If Step-1's
  investigation found the Bottleneck slot can leak on a never-settling fetch,
  ensure `callWithTimeout`'s abort path in `geminiRateLimiter.ts:195-207`
  provably rejects the `limiter.schedule` job so the slot frees. Add one runnable
  check (a forced never-resolving fetch → the limiter slot is released within
  `GEMINI_TIMEOUT_MS`). If no leak exists, record that and skip.
  *(Verify: forced-hang check frees the limiter; subsequent calls proceed.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-24)._

- [x] **Compose timeout (e2e).** Forced `BATCH_COMPOSE_TIMEOUT_MS=1000`, ran a
      dry-run batch on 2 fresh-analysis leads. Result:
      ```
      [probe] started run=501f6f50-...
      [gemini] compose call #1 ... (rpd 61/1000)   ← orphaned compose continues post-timeout
      [probe] RESULT run.status=done processed=2 failed=2
        item business=ChIJ7xlsL3...  state=failed disposition=failed last_error=compose_timeout
        item business=ChIJOYYspz...  state=failed disposition=failed last_error=compose_timeout
      ```
      Both items failed at the timeout, the batch continued, the run finalized
      `done`. The still-running `[gemini] compose call` after the item failed
      confirms the no-leak finding (background compose completes + releases its slot
      while the item is already dead-lettered).
- [x] **Stall watchdog (real sweep).** Seeded a `running` run with `updated_at`
      backdated 60s, bound `BATCH_STALL_TIMEOUT_MS=30000`, ran the real
      `sweepStalledRuns()`:
      ```
      [batch] stall watchdog — run=62412024-... no progress for 60s; failing 1 item(s) + finalizing
      [probe] RESULT status_after=done failed=1
        item state=failed disposition=failed last_error=stalled
      [probe] NEGATIVE-CONTROL fresh run status_after=running (expect running)
      ```
      Wedged run finalized + item `stalled`; the fresh running run was correctly
      NOT swept (proves the `updated_at` offset math + bound comparison).
- [x] **SQL: no `running` zombie.** Post-test:
      `runs by status: [{"status":"canceled","n":14},{"status":"done","n":20}]`
      (zero `running`); `items compose_timeout: 2  stalled: 1` — matches the tests.
- [x] **`npx tsc --noEmit` clean** — server, in container (after every phase + final).
- [ ] Reviewer subagent pass — not auto-run (harness: agents only on explicit
      request). Operator can trigger via `/code-review` on this branch.

## Completion record

- Commit SHAs: _(uncommitted — awaiting operator)_
- What changed:
  - `env.ts` + `settingsRegistry.ts`: added `BATCH_COMPOSE_TIMEOUT_MS` (default
    180000) and `BATCH_STALL_TIMEOUT_MS` (default 600000), both `Batch &
    Automation` group, both tunable (mirror `BATCH_ANALYZE_TIMEOUT_MS`).
  - `batchOrchestrator.ts`: wrapped `composeVerifiedEmail` at the compose stage in
    `withTimeout(…, 'compose_timeout')`; added the run-level stall watchdog
    (`sweepStalledRuns` + unref'd self-rescheduling sweep, mirror of the recovery
    probe), armed from `startBatch`/`resumeBatch`/`resumeInterruptedBatches`.
- Follow-ups / new parked items:
  - Step 3 runnable slot-release check intentionally skipped — the
    `limiter.schedule(callWithTimeout)` structure already guarantees release; no
    leak to guard. (Recorded in diagnose checklist.)
  - Upstream Gemini 503 storm + provider switch is `0026` (out of scope here; 503s
    were observed during the live test but are absorbed by existing retry/backoff).
