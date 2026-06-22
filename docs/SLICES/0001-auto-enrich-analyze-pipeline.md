# Slice 0001: auto-enrich-analyze-pipeline

## Intent

Every newly-scraped lead — from a polygon schedule (`runJobSync`), a keyword
schedule (`runKeywordJobSync`), or an instant keyword scrape
(`POST /api/keyword-scrape/instant`) — should automatically flow into premium
analysis without a manual trigger, the same way social/location enrichment
already does via `kickEnrichment()`. Scraping and analysis must overlap: a lead
becomes analyzable the moment it lands (analysis reads only `business.website`,
which gosom returns at scrape time), so analysis of cell N runs while cell N+1
is still scraping. Auto-analysis must honor the existing `REUSE_ANALYSIS_TTL_DAYS`
reuse gate (never re-analyze a fresh, complete lead) and the `geminiRateLimiter`
cost guardrails (RPM, persisted Pacific-date RPD budget). The operator must be
able to pause the auto-analyze stream independently of scraping. This is
ROADMAP rank 1. Compose/verify/gate/schedule stay out — those are slice
`0003-auto-compose-schedule-high-confidence`.

## Out of scope

- **Compose / verify / gate / schedule.** This slice stops at a completed
  `premium_analyses` row. No email is composed, no send is queued. (Slice 0003.)
- **The batch prepare path** (`batchOrchestrator.ts`,
  `startBatch`/`driveRun`/`processItem`). Auto-analyze must not route through the
  batch state machine; the batch run is an explicit operator action over a chosen
  set of leads. The two paths may *share* the TTL gate (see open questions) but
  this slice does not rewrite the orchestrator.
- **The analysis itself.** `premiumAnalyzer.runPremiumAnalysis` (render →
  signatures → PSI → vision) is reused unchanged. No new detectors, rubrics, or
  signal logic.
- **Enrichment changes.** Social/location enrichment already auto-runs; this
  slice does not touch `enrichmentQueue.ts` or `socialEnricher.ts` beyond
  understanding ordering. (The slice name says "enrich + analyze"; enrich is
  already automatic — the real work is the analyze half.)
- **New UI surface.** A pause control belongs in the existing scheduler/health
  UI; designing it is deferred unless the operator wants it in-scope.
- **Backfill of pre-existing un-analyzed leads.** This slice wires the
  going-forward path; a one-shot backfill of the existing table is separate.

## Constraints

Applicable `docs/SPEC.md` invariants (linked, not restated):

- **Reuse-only registry.** Drive analysis through the existing
  `premiumAnalysisQueue` / `runPremiumAnalysis` machinery and the
  `geminiRateLimiter` (`withGeminiRate`, `GeminiRpdExhausted`). Do not
  reimplement analysis, queueing, or rate limiting.
- **Additive schema only.** If a new pause flag or backlog marker needs
  persistence, it goes through `appSettings` (key/value) or a new column/table —
  never a destructive migration.
- **Run migrations before prepares.**
- **tsc clean gate** — `npx tsc --noEmit` in the server container.
- **Node 20 in container** for all server dev/typecheck/scripts.
- **No false absence claims** — grep before asserting a symbol is missing.
- **`website` is stored as `''`, not `NULL`** (see memory
  `project_website_empty_string`): any "has a website" filter must be
  `website IS NOT NULL AND website != ''`, not `isNotNull(website)` alone.
- **Dedup by `place_id` only** — the auto-enqueue must not create duplicate
  analysis work for a re-scraped `place_id`; the TTL gate is what prevents that.
- **Cost / perf budgets** (SPEC §"Cost / perf budgets"): `GEMINI_RPD` default
  1000 (persisted, Pacific-keyed), `GEMINI_RPM` default 120,
  `REUSE_ANALYSIS_TTL_DAYS`, `BATCH_ANALYZE_TIMEOUT_MS` 120000. Auto-analyze must
  live inside these, not alongside them.
- **Idempotent, restart-safe queue.** Pending work lives in DB rows
  (`premium_analyses.status='pending'`) and resumes after restart via
  `resetOrphanedRunning()` + `kickPremiumAnalysis()` at boot. Preserve that
  property.

## Diagnose-first checklist

Done BEFORE any edit. The operator approves the implementation plan before edits
begin.

### Files read

- [x] `server/src/services/scrapeSchedulerWorker.ts` — 60s poller; calls
  `runJobSync` (polygon) and `runKeywordJobSync` (keyword); pause via
  `SCRAPE_SCHEDULES_PAUSED` (`appSettings.getBool`/`setSetting`); health struct
  pattern (`getScrapeSchedulerHealth`, `setScrapeSchedulerPaused`).
- [x] `server/src/services/jobRunner.ts` — `runJobSync` returns
  `{ jobId, businessesFound }` (**no** businessIds); `runKeywordJobSync` returns
  `{ added, deduped, businessIds }` (**has** businessIds); both call
  `kickEnrichment()` after upsert; `upsertRawResults` writes `job_id` on INSERT
  only.
- [x] `server/src/routes/keywordScrape.ts` — `POST /instant` → `runKeywordJobSync`
  (foreground, awaited).
- [x] `server/src/services/enrichmentQueue.ts` — the pattern to clone:
  `kickEnrichment()` running/rekick flag, DB-backed work selection, decoupled
  from job status, idempotent.
- [x] `server/src/services/premiumAnalysisQueue.ts` — existing sequential
  background analyze worker: `kickPremiumAnalysis()`, `requestPremiumAnalysis()`,
  `claimNextPending()` loop. **Does NOT apply the TTL gate** and **does NOT catch
  `GeminiRpdExhausted`** (it marks the analysis `failed` on any throw).
- [x] `server/src/services/batchOrchestrator.ts` — the **only** place the TTL
  reuse gate currently lives (`processItem`, lines ~93–116:
  `getLatestPremiumAnalysis` + `REUSE_ANALYSIS_TTL_DAYS` staleness check +
  `createPremiumAnalysisRunning`), and the **only** place
  `GeminiRpdExhausted` → pause/resume is handled.
- [x] `server/src/services/premiumAnalyzer.ts` — `runPremiumAnalysis(row)`;
  reads `biz.website` only (no dependency on enrichment output); vision is the
  sole Gemini call in the analyze stage (render/signatures are local; PSI is the
  Google PSI API, not Gemini).
- [x] `server/src/db/premium.ts` — `enqueuePremiumAnalysis` (dedups against open
  pending/running row), `createPremiumAnalysisRunning`, `claimNextPending`,
  `getLatestPremiumAnalysis`, `resetOrphanedRunning`, `completePremiumAnalysis`.
- [x] `server/src/services/geminiRateLimiter.ts` — `withGeminiRate`, RPM
  Bottleneck reservoir, persisted RPD via `reserveGeminiRpd`,
  `GeminiRpdExhausted` (carries count/ceiling/pacificDate).
- [x] `server/src/services/stageTracker.ts` — `withAnalysis` / `stage` /
  `addCost`; per-analysis cost accumulation + `[gemini][cost]` log line already
  exists (rolling $-per-lead is observable today).
- [x] `server/src/index.ts` — boot order: `resetOrphanedRunning()` →
  `resumeInterruptedBatches()` → `kickPremiumAnalysis()`; workers started at end.

### Symbols to catalog

- Enqueue/claim: `enqueuePremiumAnalysis`, `createPremiumAnalysisRunning`,
  `claimNextPending`, `getLatestPremiumAnalysis`, `resetOrphanedRunning`.
- Worker: `kickPremiumAnalysis`, `requestPremiumAnalysis`, the `loop()` in
  `premiumAnalysisQueue.ts`.
- Scrape returns: `runJobSync` (jobId only) vs `runKeywordJobSync` (businessIds).
- TTL gate logic in `batchOrchestrator.processItem` (the staleness predicate).
- Rate guard: `withGeminiRate`, `GeminiRpdExhausted`, `reserveGeminiRpd`,
  `REUSE_ANALYSIS_TTL_DAYS`, `GEMINI_RPD`, `GEMINI_RPM`.
- Pause precedent: `SCRAPE_SCHEDULES_PAUSED`, `appSettings.getBool/setSetting`,
  `setScrapeSchedulerPaused`, `getScrapeSchedulerHealth`.
- DB filter trap: `businesses.website` (`''` vs `NULL`), `businesses.jobId`.

### Online topics researched

- **Queue-worker vs event-driven vs orchestrator-extension (Node/TS + SQLite,
  2026).** Consensus: a durable, SQLite-backed sequential job queue (work lives
  in a status column, claimed by a polling/kicked worker, survives restarts) is
  the standard pattern for long-running sequential tasks where ordering and
  crash-recovery matter — exactly what `premiumAnalysisQueue` already is.
  Event-driven (in-memory emitter) is favored only for many short non-blocking
  tasks; it loses durability. **Implication:** reuse the existing queue; the new
  work is *enqueueing* from the scrape paths, not a new worker architecture.
  ([dev.to](https://dev.to/mashraf_aiman/give-your-sqlite-queries-their-own-workers-a-practical-guide-for-nodejs-developers-3d74),
  [node-persistent-queue](https://github.com/damoclark/node-persistent-queue),
  [jasongorman.uk](https://jasongorman.uk/writing/sqlite-background-job-system/))
- **Backpressure when a fast producer (scraper) outpaces a slow consumer
  (Gemini + Playwright analyze).** 2026 guidance for rate-limited LLM pipelines:
  bound the queue and decide a policy when full (reject / degrade / shed) rather
  than appending unboundedly; combine static rate limits with reactive
  backpressure; exponential backoff alone leaves systems oscillating in
  sustained overload. Here the consumer is *already* bounded (sequential worker +
  RPM reservoir + persisted RPD budget), so the producer can only ever build a
  durable DB backlog, not exhaust memory. The open question is whether that
  backlog needs an explicit cap/priority or whether the existing rate guards +
  durability are sufficient at solo-operator scale.
  ([tianpan.co](https://tianpan.co/blog/2026-04-15-backpressure-llm-pipelines),
  [dasroot.net](https://dasroot.net/posts/2026/02/rate-limiting-backpressure-llm-apis/),
  [battle-tested-patterns](https://totoro-jam.github.io/battle-tested-patterns/patterns/backpressure/))

### Open questions for the operator

1. **Architecture — reuse the queue (recommended).** Plan to have each scrape
   path enqueue its new leads into the existing `premiumAnalysisQueue` (insert
   `pending` rows, then `kickPremiumAnalysis()`), mirroring how scrape calls
   `kickEnrichment()`. Alternative: an event-driven in-memory trigger, or
   extending `batchOrchestrator`. Confirm reuse-the-queue is the intended shape.

2. **Where does the TTL reuse gate live?** Today the
   `REUSE_ANALYSIS_TTL_DAYS` staleness check exists *only* in
   `batchOrchestrator.processItem`. For auto-enqueue to "respect the TTL gate,"
   the freshness check must apply at the auto path too — otherwise every scrape
   re-analyzes fresh leads. Options: **(a)** extract the staleness predicate into
   one shared helper (e.g. `db/premium.ts` or a small `analysisReuse.ts`) and
   call it from both the auto-enqueue and the batch — single source of truth
   (recommended); **(b)** apply it only at enqueue time in the auto path and
   leave batch as-is (two copies). Which?

3. **Cost/budget behavior in the auto worker.** `premiumAnalysisQueue` currently
   marks an analysis `failed` if anything throws — including
   `GeminiRpdExhausted`. `batchOrchestrator` instead *pauses* and resumes after
   the midnight-Pacific RPD reset, leaving the item resumable. For auto-analyze
   at scrape volume, hitting RPD is realistic. Should the auto worker adopt the
   pause-and-resume-after-reset semantics (recommended — don't burn a `failed`
   row and lose the lead on a transient budget cap), or is marking it for retry
   some other way acceptable?

4. **Pause granularity.** Add a separate `AUTO_ANALYZE_PAUSED` setting
   (independent of `SCRAPE_SCHEDULES_PAUSED`), checked by the auto path so
   pausing analysis does not pause scraping and vice-versa. Two sub-decisions:
   (a) does pause **stop enqueuing new** leads, **stop the worker draining**, or
   **both**? (Scrape scheduler precedent: pause stops claiming new but lets an
   in-flight run finish.) (b) Is one global pause enough, or do you want
   per-source pause (e.g. pause auto-analyze for instant scrapes only)?
   Recommendation: one global `AUTO_ANALYZE_PAUSED`; pause stops the worker from
   claiming new rows; enqueue still records `pending` rows so nothing is lost and
   they drain on resume.

5. **Backpressure when scrape outpaces analyze for hours.** A long polygon run
   can enqueue hundreds of leads faster than the sequential analyzer (render
   ~20s + PSI + vision, one at a time, capped by RPM/RPD) can drain them. The
   backlog is durable (DB rows) and self-rate-limited, so it cannot crash the
   process — it just grows and ages. Decision: **(a)** accept an unbounded
   durable backlog (recommended for solo scale; surface backlog depth in health),
   **(b)** cap pending depth and shed/skip beyond it, or **(c)** prioritize
   newest-first (LIFO) so freshly-scraped leads analyze before a stale backlog.
   Note `claimNextPending` is currently oldest-first (FIFO). Which policy?

6. **Polygon enqueue source.** `runJobSync` returns only `{ jobId,
   businessesFound }` — no businessIds. To enqueue its leads either (a) query
   `businesses WHERE job_id = ? AND website != ''` after the run (recommended —
   no signature change, and it naturally picks up only rows with a site), or
   (b) change `runJobSync` to return businessIds like `runKeywordJobSync`.
   Preference?

7. **Websiteless leads.** Filter them out at enqueue (`website != ''`) so no
   junk `premium_analyses` rows are created, vs. enqueue everything and let
   `runPremiumAnalysis` short-circuit to `renderOutcome='no_website'`. Recommend
   filtering at enqueue. Agree?

8. **Does the instant (foreground) keyword scrape auto-enqueue too?** Intent
   says yes. Confirm that `POST /api/keyword-scrape/instant` should fire the same
   auto-enqueue as the scheduled paths (it already returns `businessIds`, so this
   is the cheapest path to wire).

## Implementation plan

Approved operator decisions are folded in: reuse `premiumAnalysisQueue` (Q1);
shared TTL helper, one source of truth (Q2); RPD-exhausted never fails a lead
(Q3); a `AUTO_ANALYZE_PAUSED` setting (Q4); unbounded FIFO backlog, depth
surfaced (Q5); polygon enqueues by query-after-run (Q6); website filter at
enqueue, both `IS NOT NULL` and `!= ''` (Q7); instant keyword scrape enqueues
too via its returned ids (Q8).

Phases are ordered so each one type-checks and is independently verifiable.
Phases 1–3 are foundational and change **no** externally-visible behavior except
the RPD-failure fix and a new (initially unused) pause flag; phases 4–5 turn the
feature on; phase 6 adds observability; phase 7 is the live gate.

### Phase 1 — Extract the TTL reuse gate into one shared helper (zero batch behavior change)

- **Intent.** Make the staleness/freshness decision callable from both the
  auto-enqueue path and `batchOrchestrator`, with byte-for-byte the same
  predicate the batch uses today.
- **Diagnose-first.** Re-read `batchOrchestrator.processItem` (lines ~93–103)
  immediately before extracting; mirror the predicate exactly:
  `!premium || premium.status !== 'done' || !premium.completedAt || ttlDays === 0
  || now - completedAt > ttlDays*86400000 || !detectedSigsJson || !psiJson ||
  !visionJson || !signalsJson`. Note `forceRefresh` is a **batch-only** concern
  and must stay in the caller — do NOT bake it into the shared helper.
- **Files / symbols.** `server/src/db/premium.ts` — new export
  `isAnalysisFresh(businessId, ttlDays): boolean` (returns `true` when reuse is
  safe = NOT stale), built on the existing `getLatestPremiumAnalysis`.
  `server/src/services/batchOrchestrator.ts` — replace the inline `isStale`
  computation with `const isStale = forceRefresh || !isAnalysisFresh(businessId, ttlDays);`,
  keeping the `getNumber('REUSE_ANALYSIS_TTL_DAYS')` read where it is.
- **Invariants.** Reuse-only registry (one gate, no second copy); additive only;
  services/db layering (the predicate reads DB → lives in `db/premium.ts`).
- **Verify.** `npx tsc --noEmit` clean; read-through confirms the batch predicate
  is unchanged (same booleans, same TTL source). Unlocks the "TTL reuse honored"
  gate.

### Phase 2 — `GeminiRpdExhausted` handling in `premiumAnalysisQueue` (no lead ever fails on a budget cap)

- **Intent.** Today `premiumAnalysisQueue.loop`'s catch marks the row `failed`
  on *any* throw — including `GeminiRpdExhausted`. Make the RPD cap a
  pause-and-resume, not a failure.
- **Diagnose-first.** Read `premiumAnalysisQueue.loop` and the
  `GeminiRpdExhausted` class in `geminiRateLimiter.ts`; read how
  `batchOrchestrator.driveRun` already handles it (catch → `setRunStatus('paused',
  'gemini_rpd_exhausted')`, item left resumable). Confirm whether a single-row
  `running → pending` reset helper exists; `resetOrphanedRunning()` is global, so
  a per-row reset is likely needed (additive helper
  `resetAnalysisToPending(id)`).
- **Cleanest shape (and the explanation Q3 asks for).** Handle it *in the queue
  loop*: catch `GeminiRpdExhausted` **before** the generic failure branch, reset
  that row to `pending` (so it is re-claimed later, never lost), and `return`
  from the loop (stop draining — do NOT `continue`, or the loop hot-spins
  re-claiming the same row and re-hitting the fast-failing `reserveGeminiRpd`).
  Leave `batchOrchestrator`'s existing pause/resume in place: it sits a layer up,
  is still correct, and removing it is out of scope. Net: both callers are
  RPD-safe; the queue gains the protection the auto path needs without touching
  the batch.
- **Files / symbols.** `server/src/services/premiumAnalysisQueue.ts` (import
  `GeminiRpdExhausted`, branch in catch); `server/src/db/premium.ts`
  (`resetAnalysisToPending` if no single-row reset exists).
- **Invariants.** Reuse-only (`withGeminiRate` / `GeminiRpdExhausted` unchanged);
  idempotent + restart-safe (pending rows resume at boot via
  `resetOrphanedRunning` + `kickPremiumAnalysis`); no lead marked `failed` for an
  RPD cap.
- **Verify.** Force a low `GEMINI_RPD`, trigger analysis, confirm the row returns
  to `pending` (not `failed`), the loop stops, and a later kick drains it.
  Unlocks the "cost guardrail" gate.

### Phase 3 — `AUTO_ANALYZE_PAUSED` setting + worker honors it

- **Intent.** A global pause for auto-analyze, independent of
  `SCRAPE_SCHEDULES_PAUSED`. Pause stops the **worker** from claiming new rows;
  enqueue still records `pending` rows (nothing lost); an in-flight analysis
  finishes.
- **Diagnose-first.** Read how `SCRAPE_SCHEDULES_PAUSED` is registered/defaulted
  (settings registry / `appSettings`) and how `setScrapeSchedulerPaused` +
  `getScrapeSchedulerHealth` expose/toggle it; mirror that precedent for
  `AUTO_ANALYZE_PAUSED` (default `false`).
- **Files / symbols.** settings registry (register `AUTO_ANALYZE_PAUSED`);
  `server/src/services/premiumAnalysisQueue.ts` — at the top of the `loop`
  iteration, `if (getBool('AUTO_ANALYZE_PAUSED')) return;` (claim-time check, so
  the current analysis completes and no new one starts). Toggling/exposure mirror
  the scrape-scheduler setter + health field (route in Phase 6).
- **Invariants.** Settings via `appSettings`/registry (no silent default,
  validated); reuse-only; enqueue path deliberately ignores the flag.
- **Verify.** Set the flag true, scrape: scraping + enrichment still run, the
  analyze worker claims nothing (no new `[gemini]`/render lines), pending rows
  accumulate; unset → backlog drains. Unlocks the "pause honored" gate.

### Phase 4 — Auto-enqueue from polygon scrape (query-after-run)

- **Intent.** After a scheduled polygon run, enqueue its website-bearing leads
  into the analyze queue, mirroring how scrape already calls `kickEnrichment()`.
- **Diagnose-first.** `runJobSync` returns only `{ jobId, businessesFound }`
  (no ids — leave its signature alone, Q6a). Confirm the architecture rule that
  DB access lives in `db/` → the by-job query is a new `db/` helper.
- **Files / symbols.** `server/src/db/businesses.ts` (or the businesses repo) —
  new `getAnalyzableBusinessIdsForJob(jobId): string[]` =
  `WHERE job_id = ? AND website IS NOT NULL AND website != ''`.
  A shared `autoEnqueueForAnalysis(businessIds)` (new
  `server/src/services/autoAnalyzeEnqueue.ts`, or an export added to
  `premiumAnalysisQueue.ts`): per id, skip if `isAnalysisFresh(id, ttlDays)`
  (Phase 1), else `enqueuePremiumAnalysis(id)`; `kickPremiumAnalysis()` once at
  the end. `server/src/services/scrapeSchedulerWorker.ts` — in the polygon
  branch after `finishScheduleRun`/`updateScheduleAfterRun`, call
  `getAnalyzableBusinessIdsForJob(jobId)` → `autoEnqueueForAnalysis(...)`.
- **Invariants.** `website` `''` vs `NULL` (both checks, Q7); reuse-only;
  services→db only; FIFO (use existing `claimNextPending`, unchanged); dedup by
  `place_id` upstream + `enqueuePremiumAnalysis`'s open-row dedup.
- **Verify.** Trip a due polygon schedule; new `premium_analyses` rows appear for
  its website leads with no manual call; analyze logs interleave with scrape
  logs (overlap). Unlocks "auto-enqueue fires" + "overlap" gates.

### Phase 5 — Auto-enqueue from keyword scrape + instant (use returned ids)

- **Intent.** Keyword schedules and the instant endpoint both auto-enqueue, using
  the `businessIds` `runKeywordJobSync` already returns.
- **Diagnose-first.** `runKeywordJobSync` returns
  `{ added, deduped, businessIds }` where `businessIds` are the newly-inserted
  rows; it already calls `kickEnrichment()` after upsert. Those ids may include
  websiteless rows, so the website filter must still apply — reuse the same
  `autoEnqueueForAnalysis` helper (it filters per id) rather than trusting the
  raw id list.
- **Files / symbols.** `server/src/services/jobRunner.ts` — in
  `runKeywordJobSync`, right after `kickEnrichment()`, call
  `autoEnqueueForAnalysis(businessIds)`. Placing it here means **both** callers
  (the scheduler keyword branch *and* `POST /api/keyword-scrape/instant`, Q8) get
  it for free, with no route change.
- **Invariants.** website filter inside the shared helper (Q7); reuse-only; the
  helper's per-id `isAnalysisFresh` skip keeps re-scrapes from re-analyzing fresh
  leads; enqueue ignores `AUTO_ANALYZE_PAUSED` (rows recorded, drained later).
- **Verify.** `curl POST /api/keyword-scrape/instant` with real leads → new
  `premium_analyses` rows appear automatically; same for a keyword schedule.
  Unlocks "auto-enqueue fires" for the keyword/instant sources.

### Phase 6 — Backlog depth (and pause state) in the health snapshot

- **Intent.** Make the unbounded FIFO backlog observable (Q5): surface the count
  of `premium_analyses` where `status='pending'`, plus the `AUTO_ANALYZE_PAUSED`
  state from Phase 3.
- **Diagnose-first.** Read `getScrapeSchedulerHealth` and the
  `schedulerStatus` route to choose the right snapshot to extend (analyze backlog
  most naturally rides the scrape-scheduler health, or a small dedicated field).
- **Files / symbols.** `server/src/db/premium.ts` — `countPendingAnalyses():
  number`. The health service/route — add `analyzeBacklog` and
  `autoAnalyzePaused` (+ `pausedAt`) to the snapshot the UI already consumes.
- **Invariants.** SSE/health pattern unchanged; db access in `db/`; no polling
  added.
- **Verify.** Enqueue several leads with the worker paused; the health snapshot
  reports the expected pending count; it drops to 0 after unpause + drain.

### Phase 7 — Live verification gate

- **Intent.** Execute the slice's `## Verification gate` end-to-end with real
  leads and paste evidence; this is where the gate checkboxes get filled.
- **Files / symbols.** None (verification only).
- **Invariants.** Live verification gates (real DB rows / logs, not assertions);
  `npx tsc --noEmit` clean in the server container; Node 20 in container.
- **Verify.** All `## Verification gate` items below pass with pasted output.

> **Diagnose-first carry-ins (read before writing the named code):** the exact
> staleness predicate in `batchOrchestrator.processItem` (Phase 1); the
> `GeminiRpdExhausted` recovery shape + whether a single-row pending reset
> exists (Phase 2); the `SCRAPE_SCHEDULES_PAUSED` registration/setter/health
> precedent (Phase 3); the businesses repo file + the right health snapshot to
> extend (Phases 4/6).

## Verification gate

_Filled in DURING execution with live evidence — not after, not assertions._
Proposed shape:

- [ ] **Auto-enqueue fires on scrape.** Run an instant keyword scrape (or trip a
  due schedule) against a few real businesses with websites; observe new
  `premium_analyses` rows appear without any manual analyze call:
  `SELECT business_id, status, created_at FROM premium_analyses ORDER BY created_at DESC LIMIT 10;`
- [ ] **Overlap.** Server log shows analyze `[<id>] ▶ render …` / `[gemini]`
  lines interleaved with `[jobRunner]`/scheduler scrape lines for the same run —
  analysis of early leads starts before scraping finishes.
- [ ] **Leads reach `done`.** After the worker drains:
  `SELECT status, count(*) FROM premium_analyses GROUP BY status;` shows the new
  leads `done` (or `no_website` outcome), none stuck `running`.
- [ ] **TTL reuse honored.** Re-scrape the same `place_id`s within
  `REUSE_ANALYSIS_TTL_DAYS`; confirm NO new analysis runs (no second
  `[gemini]` vision call, no new `running` row) — the fresh row is reused.
- [ ] **Pause honored independently.** Set `AUTO_ANALYZE_PAUSED` true, scrape;
  confirm scraping + enrichment still run but the analyze worker claims nothing
  (no new `[gemini]`/render lines); unset and confirm the backlog drains.
- [ ] **Cost guardrail.** Rolling `[gemini][cost]` log lines show the expected
  ~$ per analyzed lead (vision call only at this slice); RPD reservation
  (`rpd N/1000`) advances; if RPD is forced low, the worker degrades per the
  decision in open question #3 rather than crashing or silently dropping leads.
- [ ] `npx tsc --noEmit` clean (server in container).

## Completion record

- Commit SHAs: …
- What changed: …
- Follow-ups / new parked items: …
