# Slice 0049: PSI / Analysis Backfill for the Email Pool

## Intent

Give the email-lane score a real website-quality input across the whole pool, not
a fraction of it. Diagnosis `0043` (**F6**) found a genuine rankable number
already exists — PSI mobile score (0–100) in `premium_analyses.psi_json` — but
only **99 of the 425** untouched email-pool leads have one (121 have any completed
premium analysis), and the on-row `outreach_analysis_json` is populated for just
32 businesses. So "rank by improvement urgency" (low PSI / many gaps) currently
covers ~23% of the lane. This slice backfills premium analysis for the pool leads
that lack it, reusing the existing analyzer + TTL reuse, so slice 0045's
`visiblePain` component has data to rank on. Recommended slice #5.

**Project vocabulary (one line).** A paced backfill that enqueues
`requestPremiumAnalysis(businessId)` for every untouched, has-site, has-email lead
without a fresh `premium_analyses` row, reusing `premiumAnalyzer` (render → PSI →
vision) under the existing TTL gate and the slice-0031/0032 contention controls,
then exposes the latest PSI to the queue score.

## Out of scope

- Changing the analyzer pipeline (render/PSI/vision) — reuse `premiumAnalyzer` and
  `requestPremiumAnalysis` verbatim.
- The scoring math (**0044**) and the queue wire-up (**0045**) — this slice only
  raises PSI **coverage**; 0045 reads whatever is present (and degrades when it
  isn't).
- The batch compose/send flow — analysis only; no emails sent.
- No-site leads — they have no website to analyze.

## Constraints

- **Reuse-only** — `requestPremiumAnalysis` (premiumAnalysisQueue),
  `premiumAnalyzer`, `getLatestPremiumAnalysis`. No new analysis path.
- **TTL reuse (SPEC cost budget)** — honor `REUSE_ANALYSIS_TTL_DAYS`; skip leads
  with a fresh done analysis. Idempotent, resumable.
- **Single-lane Gemini contention (slices 0031/0032).** Vision shares one
  rate-limited Gemini lane + Playwright with live batch prepares. The backfill
  must **yield** to a running batch (reuse the 0031 auto-analyze yield gate, not
  the operator pause flag) and run at low priority so it never starves an
  interactive batch. Pace it; do not flood the queue.
- **Requires `PLAYWRIGHT_WS_URL`** — if unset, premium analysis is unavailable
  (`/premium-analyze` returns 503); the backfill is a no-op with a clear log, not
  a crash.
- **Bound slow sites (slice 0032)** — respect `BATCH_ANALYZE_TIMEOUT_MS` and the
  PSI internal-timeout bound so one slow site can't dominate.
- **Additive only**, **tsc clean gate**.

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/services/premiumAnalysisQueue.ts` — `requestPremiumAnalysis`,
    queue draining, priority, the 0031 yield gate.
  - `server/src/services/premiumAnalyzer.ts` — render → signatures → PSI → vision;
    TTL reuse; where `psi_json` is written.
  - `server/src/db/premium.ts` — `getLatestPremiumAnalysis`, `getBusinessWebsite`,
    `DetectedSig`, `SignalMap`.
  - `server/src/db/psiCache.ts` — `PsiData` (`mobileScore`, `lcp`).
  - `server/src/routes/outreachQueue.ts:212-252` — `/premium-analyze`,
    `/premium/:businessId` (the existing single-lead trigger to fan out from).
  - `docs/SLICES/0031-*.md` + `0032-*.md` — the contention controls to respect.
- [ ] Symbols to catalog: `REUSE_ANALYSIS_TTL_DAYS`, `BATCH_ANALYZE_TIMEOUT_MS`,
  `BATCH_PREPARE_CONCURRENCY`, the 0031 yield-while-batch-running flag,
  `premium_analyses.status`/`psi_json`.
- [ ] Online topics: none.
- [ ] Open questions: backfill the **whole** has-site untouched pool (~326
  missing) or only the **top-N by current LeadScore** to spend Playwright/Gemini
  budget where ranking matters most? (Default: top-N by score first, then drain
  the rest when idle — spends the analysis budget on leads likely to be sent.)

## Implementation plan

_Approved before edits._

- **Step 1 — Selector.** db helper: untouched, has-site, has-email leads with no
  fresh done `premium_analyses` row (LEFT JOIN + TTL check). Order by current
  LeadScore (0044) so the highest-priority leads analyze first. Cap per run.
  *(verify: count ≈ the 326 missing; ordering puts A/B-grade leads first.)*
- **Step 2 — Paced enqueuer.** `backfillPremiumAnalysis(limit)` iterates the
  selector and calls `requestPremiumAnalysis(businessId)`, relying on the queue's
  own pacing/priority and the 0031 yield gate so a live batch always wins the
  lane. Log `[psi-backfill] queued N (skipped M fresh)`. *(verify: log; queue
  depth rises; a concurrently-started batch is not starved — 0031 live proof
  style.)*
- **Step 3 — Trigger.** One-off `scripts/` `tsx` task (container-run) for the
  initial drain, plus optionally a bounded idle-tick drain. Guard on
  `PLAYWRIGHT_WS_URL`. *(verify: running it raises PSI coverage of the pool.)*
- **Step 4 — Expose PSI to the score.** Ensure 0045's `getOutreachLeads` reads the
  latest `premium_analyses` PSI per row (cheap join) so `visiblePain` now has data
  for the backfilled leads. *(verify: pool PSI-coverage count rises from ~99
  toward 425; queue order shifts as urgency data fills in.)*

## Verification gate

_Filled DURING execution (2026-06-27, small proof drain — `backfillPsi 3`)._

- [x] **SQL before/after.** Pool PSI coverage **35 / 361 → 37 / 361** (`needing` 326 → 324),
      delta **+2** from 3 queued. The 3rd lead's render came back non-`ok` (no PSI — expected;
      not every site yields a PSI). Baseline is lower than the slice's older 99/425 estimate
      because the *untouched* pool has churned (many analyzed leads were since contacted and
      left the pool), which only sharpens the case for the backfill.
- [x] **Log:** `[psi-backfill] queued 3 (skipped 0 fresh)`.
- [x] **TTL skips on re-run.** The 2 backfilled ids are no longer returned by
      `getLeadsNeedingPsiBackfill` (selector excludes covered leads → idempotent);
      `isAnalysisFresh(id, 14)` → `true` for both; `autoEnqueueForAnalysis([those ids])`
      → `{ enqueued: 0, skipped: 2 }` (TTL gate, no re-queue, no kick).
- [x] **Contention.** Reuses the queue loop's `isBatchRunning()` yield verbatim
      (`premiumAnalysisQueue.ts:63`) — backfill rows are FIFO-newest = lowest priority and
      can't starve interactive work; the loop returns while any batch is `running` and the
      batch kicks it back on run-end. Pre-flight confirmed `running batches: 0`, so the proof
      drain actually drained rather than yielding.
- [x] **curl** `/api/outreach/premium/ChIJJ9ouBcHKvJURbHAGyrhahvA` (Estudio Jurídico Enzetti —
      an AR legal lead the selector ranked high) → `psi.mobileScore: 79`. Through the real
      `getOutreachLeads` read path that lead is grade **A**, score **0.8251**, and its
      `visiblePain` is now data-driven: **0.4 (neutral) → 0.1260 (PSI 79)**, moving the
      lead's email-lane score 0.8799 → 0.8251.
- [x] `npx tsc --noEmit` **clean** (server container) — gated after each of the 3 phases.

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - `server/src/db/index.ts` — new `getLeadsNeedingPsiBackfill(limit)` selector (pool
    predicate + SQL `NOT EXISTS` PSI filter, ranked by email-lane LeadScore, capped); and
    `getOutreachLeads` now feeds the latest done `premium_analyses.psi_json` `mobileScore`
    into `psiMobile` via a correlated subquery + tolerant `psiMobileOf` parse.
  - `server/src/services/autoAnalyzeEnqueue.ts` — new `backfillPremiumAnalysis(limit)`:
    `PLAYWRIGHT_WS_URL`-guarded, routes the selected ids through `autoEnqueueForAnalysis`
    so the TTL gate, dedup, FIFO low-priority drain, and slice-0031 batch-yield are reused.
  - `server/src/scripts/backfillPsi.ts` — one-off container-run drain: before/after pool
    coverage, enqueue, in-process drain poll, checkpoint.
  - Reuse-only: no analyzer-pipeline change, no scoring-math change, no emails sent.
- Operator note: this session ran only a **3-lead proof drain**. To raise coverage across
  the pool, run `docker compose -f docker-compose.dev.yml exec -T server sh -c "cd /app/server && npx tsx src/scripts/backfillPsi.ts 400"`
  (idempotent/resumable; yields to live batches; ~30–40s/lead).
- Follow-ups: `gapCount` is still passed `null` on read (deriving it needs a full
  signals/analysis parse per row). Persist `psi_mobile` + `gap_count` as additive
  `businesses` columns if the per-read join proves costly; otherwise leave on-read.
