# Slice 0031: Batch/auto-analyze coordination — yield + Gemini priority

## Intent

A batch prepare run launched right after a large scrape failed 25 of 30 leads.
Root cause is contention, not a crash: the auto-analyze backlog (filled by the
scrape via `autoEnqueueForAnalysis` and drained by `premiumAnalysisQueue`) and
the batch both funnel through **two shared single-lane resources** —

1. the **one** module-level Gemini `Bottleneck` limiter (`maxConcurrent: 1`,
   `geminiRateLimiter.ts:39`); every Gemini call (backlog **vision** + batch
   **compose/verify** + batch inline **vision**) is serialized through it, and
2. the **one** shared Playwright browser (`chromium.connect(PLAYWRIGHT_WS_URL)`,
   `playwrightRenderer.ts:81`); the batch renders stale leads inline at
   `BATCH_PREPARE_CONCURRENCY=3` on top of the queue's render.

The batch wraps each item in **wall-clock** deadlines (`BATCH_ANALYZE_TIMEOUT_MS`
120s, `BATCH_COMPOSE_TIMEOUT_MS` 180s, `batchOrchestrator.ts:120,158`) that count
**queue-wait** time. With the backlog hammering the single Gemini lane, a batch
item's calls sit behind dozens of backlog vision calls (`minTime ≈ 500ms`,
`maxConcurrent 1`) → the wall-clock budget blows → `analyze_timeout` /
`compose_timeout` → item `failed` (dead-letter). That is the 25/30. (RPD
exhaustion would *pause*, not fail — confirming this was contention, not budget.)

This slice delivers the agreed two-part coordination, plus the fold-in fixes that
make the two functions correct under concurrency:

- **(A) Yield** — the auto-analyze queue stops *claiming new* work while any
  batch run is `running`; it resumes (kicked by the batch) when the run leaves
  `running`. The batch re-runs stale analysis inline anyway, so nothing is lost —
  the backlog just waits ~10 min.
- **(B) Priority** — batch-originated Gemini calls are scheduled ahead of backlog
  vision calls in the shared limiter, covering the in-flight overlap window and
  any other concurrent Gemini consumer (manual analysis, follow-up compose).

Roadmap: new `bug·3` follow-up to the `0022` reliability line (sibling of
`0023`'s compose-timeout/watchdog — same failure surface, contention cause).

## Out of scope

- **No raising of ceilings.** Do not enlarge the Playwright container, bump
  `GEMINI_MAX_CONCURRENT`, `GEMINI_RPM`, or `GEMINI_RPD`. Coordination, not more
  lanes (more lanes = more cost + more provider-429 risk).
- **No parallel batch runs / worker pools.** "Jobs run sequentially" invariant
  stays. The analysis worker stays single-lane; we coordinate it, we do not
  parallelize it.
- **No send-path changes.** `sendGate` / `outreachGovernor` /
  `scheduledSendWorker` / `outreachComposePipeline` internals untouched (we only
  *wrap* compose calls in a priority context from the batch side).
- **No scrape-path changes.** `jobRunner` / `scrapeSchedulerWorker` /
  `autoEnqueueForAnalysis` enqueue behavior unchanged.
- **No schema changes.** All state needed is already queryable
  (`listRunsByStatus`, `countPendingAnalyses`).
- Unrelated lint noted but **not** touched (surgical rule): `useLeadStaging.ts:27`
  async hint; scratchpad `verify-live-0028.mjs` unused vars.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Reuse-only registry.** Call `withGeminiRate` / the existing limiter,
  `composeVerifiedEmail`, `runPremiumAnalysis`, `kickPremiumAnalysis`,
  `setAutoAnalyzePaused`, `listRunsByStatus`. Do not reimplement any.
- **Jobs run sequentially** — the analyze worker remains one-at-a-time.
- **Additive only** — no destructive migrations (none needed here).
- **No false absence** — symbols below were grepped and confirmed present.
- **tsc clean gate** — `npx tsc --noEmit` in the server container before done.
- **SSE only** — health changes ride existing `premium:progress` / scheduler
  status payload; no polling added.

## Diagnose-first checklist

- [x] Files read: `batchOrchestrator.ts`, `premiumAnalysisQueue.ts`,
      `geminiRateLimiter.ts`, `playwrightRenderer.ts`, `premiumAnalyzer.ts`,
      `autoAnalyzeEnqueue.ts`, `stageTracker.ts`, `db/premium.ts`,
      `routes/batch.ts`, `routes/scrapeSchedules.ts`, `db/batch.ts` (callers).
- [x] Symbols cataloged:
  - `premiumAnalysisQueue.ts`: `loop()`, `kickPremiumAnalysis()`,
    `getAutoAnalyzeHealth()`, `setAutoAnalyzePaused()`, `AutoAnalyzeHealth`,
    module flags `running`/`rekick`/`_pausedAt`.
  - `batchOrchestrator.ts`: `driveRun()`, `processItem()`, terminal exits
    (`setRunStatus … 'done'|'paused'|'canceled'`), `activeRuns`.
  - `geminiRateLimiter.ts`: `withGeminiRate()`, `runWithRetry()`,
    `limiter.schedule(...)` (`:258`), the Bottleneck instance.
  - `stageTracker.ts`: `als` (separate `AsyncLocalStorage` — confirms a second,
    independent ALS coexists without clobbering).
  - `db/premium.ts`: `createPremiumAnalysisRunning()` (**reuses** an open
    pending/running row, flips pending→running), `claimNextPending()`,
    `countPendingAnalyses()`, `getLatestPremiumAnalysis()`.
  - `db/batch.ts`: `listRunsByStatus()`; `routes/scrapeSchedules.ts:61` returns
    `getAutoAnalyzeHealth()` in the scheduler status payload.
  - env: `BATCH_PREPARE_CONCURRENCY`(3), `BATCH_ANALYZE_TIMEOUT_MS`(120000),
    `BATCH_COMPOSE_TIMEOUT_MS`(180000), `GEMINI_RPM`(120), `GEMINI_MAX_CONCURRENT`.
- [x] Research: Bottleneck `schedule({ priority }, fn)` — priority `0–9`, default
      `5`, **lower runs first**; with `maxConcurrent:1` it reorders the *queued*
      jobs (the in-flight one finishes); on reservoir refill, higher-priority
      jobs drain first. Confirmed sufficient for (B).
- [x] Confirmed: no import cycle introduced — `batchOrchestrator` →
      `premiumAnalysisQueue` → (`db/premium`, `db/batch`); no edge back to
      `batchOrchestrator`.
- [x] Open questions for the operator (below) answered before edits:
      **(1)** priority = **`1`** (jump all backlog); **(2)** manual single-lead analysis
      **stays at default priority** (not yield-gated); **(3)** health = **`deferred`
      flag only** (no new SSE banner).

### Open questions for the operator

1. **Priority aggressiveness (B).** Batch jumps *all* backlog (priority `1`) vs.
   gentle yield (`4`)? Recommend **`1`** — the batch is the time-boxed,
   user-facing operation; backlog is opportunistic.
2. **Manual single-lead analysis** (`requestPremiumAnalysis`, user-triggered)
   during a batch: also yield/deprioritize, or let it run at normal priority?
   Recommend **leave at default priority** (low volume, user intent) — it
   competes only mildly and (A) does not gate it. Flag if you'd rather it yield.
3. **Health surface (A2).** Is adding a `deferred` flag to `AutoAnalyzeHealth`
   enough, or do you want a distinct SSE banner? Recommend the flag only — the
   scheduler status payload already carries `autoAnalyze`.

## Implementation plan

_Proposed. Operator approves before edits in the fresh session._

### A — Yield auto-analyze while a batch is running

- **Step A1** — In `premiumAnalysisQueue.ts loop()`, gate claiming on *both* the
  existing `AUTO_ANALYZE_PAUSED` user flag **and** a new `isBatchRunning()`
  predicate (`listRunsByStatus(['running']).length > 0`, imported from
  `db/batch`). When a batch is running, `return` (same as pause: stop claiming,
  let the in-flight item finish, leave pending rows waiting).
  - **Correctness (F1):** do **not** reuse / write `AUTO_ANALYZE_PAUSED` for the
    batch gate. That flag is the operator's *manual* toggle
    (`scrapeSchedules.ts:80–87`); auto-resuming it on batch-end would clobber a
    manual pause. The batch gate is stateless (a live query) — no bookkeeping,
    self-healing across restarts, never touches the user flag.
  - _Verify:_ scrape ~30 leads → `countPendingAnalyses() > 0`; start a batch →
    no new `[premiumAnalysisQueue] running` log lines while the run is `running`.
- **Step A2** — Batch wakes the queue on every terminal exit. In
  `batchOrchestrator.ts driveRun()`, after the run leaves `running` (finalize to
  `done`, and the `paused`/budget exits), call `kickPremiumAnalysis()` (new
  import). Also covers `pauseBatch`/`cancelBatch`. Idempotent kick.
  - _Verify:_ on batch `done`, `[premiumAnalysisQueue] running` lines resume and
    `countPendingAnalyses()` drains to 0.
- **Step A3 (health honesty)** — Extend `AutoAnalyzeHealth` with
  `deferred: boolean` (true when `backlog > 0` and a batch is running). Set in
  `getAutoAnalyzeHealth()`. Operator sees "waiting for batch", not a stalled
  queue. (Aligns with the proactive-health-visibility preference.)
  - _Verify:_ during a batch, `GET /api/scrape-schedules/...status` →
    `autoAnalyze.deferred === true`, `backlog > 0`.

### B — Batch Gemini calls get scheduling priority

- **Step B1** — In `geminiRateLimiter.ts`, add a dedicated
  `AsyncLocalStorage<number>` for priority (a *separate* ALS instance from
  `stageTracker`'s — they coexist, neither clobbers the other). Export
  `withGeminiPriority(priority, fn)`. In `runWithRetry`, read the current
  priority (default `5`) and pass it: `limiter.schedule({ priority }, fn)` at
  `:258`.
  - _Verify (unit-ish):_ a temporary script running two concurrent
    `withGeminiRate` calls (one wrapped `withGeminiPriority(1,…)`, one default)
    logs the priority call's `[gemini] call #N` first.
- **Step B2** — In `batchOrchestrator.ts`, wrap the per-item work
  (`processItem` body, or the `driveRun` per-item lambda) in
  `withGeminiPriority(BATCH_PRIORITY, …)`. Because the priority ALS propagates
  across the nested `runPremiumAnalysis` / `composeVerifiedEmail` calls, every
  batch Gemini call (inline vision + compose + verify) inherits high priority;
  the backlog queue calls `runPremiumAnalysis` *without* the wrapper → default
  `5`. `BATCH_PRIORITY` per operator answer (default `1`).
  - _Verify:_ with (A) temporarily disabled to isolate (B): start a backlog
    drain + a batch together; batch `compose`/`verify` `[gemini] call #N` lines
    interleave **ahead** of backlog `vision` calls; batch items avoid
    `compose_timeout`.

### F — Fold-in correctness fixes in the touched functions

- **F1 — user-flag collision** (covered in A1): batch gate is separate from
  `AUTO_ANALYZE_PAUSED`. This is the load-bearing correctness fix for (A).
- **F2 — same-business double-render race.** `createPremiumAnalysisRunning`
  reuses an *already-`running`* row when one exists (`db/premium.ts:55–69`). If
  the queue claimed business X (flipped pending→running) and is mid-render at the
  instant the batch picks X, the batch reuses that **same row id**, and both
  render → both write the **same** bundle dir (`premium/<businessId>/<row.id>`,
  `premiumAnalyzer.writeBundle`) and both call `completePremiumAnalysis(sameId)`.
  (A) shrinks this to a narrow in-flight window but does not eliminate it. Lazy
  guard: in `processItem`, if the latest open row for the business is already
  `running` (i.e. the queue owns it), **do not** start a second render — treat
  the item as resumable (skip this pass; the stall watchdog / next resume picks
  it up after the in-flight analysis completes), or briefly await its completion.
  Decide the minimal of the two during implementation; prefer "skip → resumable"
  (smaller diff, no new wait loop).
  - _Verify:_ contrive an overlap (enqueue X, manually claim it, start a batch
    including X) → exactly one render of X, one `completePremiumAnalysis(id)`,
    one bundle dir; no `EEXIST`/overwrite, no duplicate cost ledger rows for X.
- **F3 — dead-code / consistency sweep** (touched files only): remove any import
  left unused after the edits; keep `AutoAnalyzeHealth` consumers (client types,
  if any reference the shape) in sync with the new `deferred` field; confirm no
  orphaned `_pausedAt` logic. Do not touch unrelated code.

## Verification gate

_Filled DURING execution with live evidence._

**Verified now (static + mechanism + live wiring):**

- [x] `npx tsc --noEmit` clean (server in container) — `EXIT:0`, no errors.
- [x] Clean boot with the new imports — `docker compose restart server` → schedulers
      tick, no crash, **no import-cycle** at runtime (premiumAnalysisQueue → db/batch;
      batchOrchestrator → premiumAnalysisQueue; no edge back).
- [x] Backlog exists: live `GET /api/scrape-schedules/status` →
      `autoAnalyze.backlog = 287` (real pending backlog; gate-#1 condition met without
      needing a fresh scrape).
- [x] **A3 health field wired end-to-end** — same live response carries the new field:
      `"autoAnalyze":{"backlog":287,"paused":false,"pausedAt":null,"deferred":false}`.
      No batch running → `deferred:false` (correct: `backlog>0 && isBatchRunning()`).
- [x] **B priority mechanism** — isolated self-check (`verify-priority-0031.mjs`,
      real Bottleneck + AsyncLocalStorage, no DB/Gemini):
      `priority reordering=[A-occupy,C-prio1,B-prio5]` (a later-submitted prio-`1` job
      jumps ahead of an earlier prio-`5` job under `maxConcurrent:1`) and
      `als-nested=1 als-default=5` (priority survives nested awaits; defaults to `5`
      outside the context). This is exactly the `withGeminiPriority` →
      `limiter.schedule({priority})` path.

**Requires an operator live run** (each needs a real batch consuming Gemini budget on
live data — not auto-run to avoid spending budget / interfering with the active scraping
seen in `recentRuns`). What to look for:

- [ ] Log: during a batch `running`, **no** new `[premiumAnalysisQueue] running`
      lines (queue yielded). After `done`, lines resume (A1 gate + A2 kick).
- [ ] Log: batch `[gemini]` compose/verify calls interleave **ahead** of backlog
      vision calls (B priority in the live limiter).
- [ ] Batch outcome: 30-lead run concurrent with a fresh backlog → failures from
      `analyze_timeout`/`compose_timeout` ≈ 0 (was 25/30):
      `SELECT disposition, count(*) FROM batch_items WHERE batch_id=? GROUP BY 1;`
- [ ] curl: `GET /api/scrape-schedules/status` → `autoAnalyze.deferred=true`
      mid-batch (already `false` confirmed at rest above).
- [ ] F2: contrived overlap (enqueue X, manually claim it → 'running', start a batch
      including X) → exactly one render, one `completePremiumAnalysis(id)`, one bundle
      dir; the batch item reverts to `pending` and is re-picked on resume via TTL-fresh
      reuse (no second render, no `EEXIST`, no duplicate cost ledger row).

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - **A1** `premiumAnalysisQueue.loop()` — added stateless `isBatchRunning()`
    (`listRunsByStatus(['running']).length>0`) gate; queue stops claiming new work while
    a batch runs. Kept **separate** from `AUTO_ANALYZE_PAUSED` (F1 — never clobbers the
    operator's manual pause).
  - **A2** `batchOrchestrator.driveRun()` finally → `kickPremiumAnalysis()` on every
    driver exit (done/paused/canceled); idempotent + self-gating.
  - **A3** `AutoAnalyzeHealth.deferred:boolean` (`backlog>0 && isBatchRunning()`),
    surfaced via the existing scheduler status payload. (No client type consumes the
    `autoAnalyze` shape — F3 client-sync was a no-op.)
  - **B1** `geminiRateLimiter` — dedicated priority `AsyncLocalStorage` +
    `withGeminiPriority(priority, fn)`; `runWithRetry` reads it (default `5`) and passes
    `limiter.schedule({ priority }, …)`.
  - **B2** `batchOrchestrator` — per-item work wrapped in `withGeminiPriority(1, …)`;
    propagates across nested `runPremiumAnalysis`/`composeVerifiedEmail`.
  - **F2** `db/premium.getRunningAnalysis(businessId)` + guard in `processItem`: if the
    queue/manual already owns an in-flight `running` row, skip → revert item to `pending`
    (resumable) instead of double-rendering the shared row/bundle.
- Follow-ups / new parked items: live operational verification (4 items above) pending an
  operator batch run. Unrelated lint left untouched per scope (`useLeadStaging.ts:27`,
  scratchpad `verify-live-0028.mjs`).
