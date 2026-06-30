# Slice 0058: Batch limiter reservoir wedge + await-hardening

## Intent

Batch compose-prepare mass-failed: the most recent 30-lead run finished 4 queued /
6 skipped / **20 `failed` with `last_error='stalled'`**. Root cause was NOT compose
or the model — it was the shared Gemini rate limiter (`geminiRateLimiter.ts`). The
Bottleneck `reservoir` auto-refill never re-armed after `applyRpm()` (which
`initLimiterFromSettings` calls at every boot, because the DB overrides the env RPM),
so the single Gemini lane **wedged permanently after ~`RPM` calls**. Every later
call hung → no item transitions → the slice-0023 stall watchdog declared the run
wedged and force-failed all non-terminal items. A 30-lead batch needs >`RPM` calls
so it always wedged; 15-lead batches finished under the cap and mostly survived;
lowering `GEMINI_RPM` 120→40 made the wedge hit 3× sooner. This slice deletes the
broken reservoir and removes three secondary fragilities that turned slowness into
mass failure.

## Out of scope

- Provider/cost policy (NIM vs Gemini, RPM/concurrency values) — operator config,
  left at the operator's settings.
- Gemini prepay credit top-up — a billing action, not code. See
  memory `project_gemini_credits_and_limiter`.
- composeVerifiedEmail / verify / gate internals — untouched.

## Constraints (SPEC invariants)

- Single shared Gemini limiter; SSE-only realtime; additive only.
- `enqueueForSend` stays the one transaction that creates a `scheduled_sends` row
  and flips the item to `queued_for_send` — never a duplicate send.
- Stall watchdog (slice 0023) remains the backstop for a genuine wedge.

## Diagnose-first checklist

- [x] Files read: `batchOrchestrator.ts`, `geminiRateLimiter.ts`, `premiumAnalyzer.ts`,
  `playwrightRenderer.ts`, `db/batch.ts`, `db/premium.ts`, `premiumAnalysisQueue.ts`,
  `env.ts`, `settingsRegistry.ts`.
- [x] Symbols catalogued: limiter `reservoir`/`reservoirRefreshInterval`, `applyRpm`,
  `withTimeout`, F2 guard, `TIMEOUT_SENTINELS`, `transitionItem` / `TERMINAL_BUMP`,
  `enqueueTxn` / `hasActiveScheduledSend`, `BATCH_ANALYZE_TIMEOUT_MS`.
- [x] DB queried (`app_settings`, `batch_runs`, `batch_items`, `premium_analyses`):
  confirmed 20 items `state=failed last_error='stalled'`, 10 orphaned `running`
  analysis rows, `GEMINI_RPM=40` + `GEMINI_MODEL=nim:...` set 06-28.

## Implementation plan (as built)

- **R1 — Rate limiter (the fix):** drop `reservoir`/`reservoirRefreshAmount`/
  `reservoirRefreshInterval`; rate-limit by `minTime = 60000/RPM` alone. `applyRpm`
  updates only `minTime`. (verify: Gemini `call #` climbs past `RPM` continuously.)
- **R2 — Analyze awaited, never abandoned:** replaced
  `withTimeout(runPremiumAnalysis, BATCH_ANALYZE_TIMEOUT_MS)` with a direct `await`;
  on any throw the analysis row is reset to `pending` so it is never left orphaned
  `running` (which the F2 guard bounced forever). Removed `analyze_timeout` from
  `TIMEOUT_SENTINELS`; deleted now-dead `BATCH_ANALYZE_TIMEOUT_MS`
  (env + registry) and `scripts/batchTimeoutRecoveryGate.ts`.
- **R3 — Watchdog clock:** `transitionItem` (and `bumpBatchItemAttempt`) now bump
  `batch_runs.updated_at` on **every** transition, not just terminal — a
  slow-but-progressing run keeps resetting the watchdog clock.
- **R4 — Enqueue terminalizes already-scheduled leads:** when `hasActiveScheduledSend`
  is true, `enqueueTxn` now transitions the item to `queued_for_send`
  (`disposition='already_scheduled'`) instead of returning without terminalizing —
  previously the item stayed non-terminal and the driver re-composed it every pass
  forever.
- **R5 — Bounded `chromium.connect`:** pass `{ timeout: PREMIUM_RENDER_TIMEOUT_MS }`
  (was unbounded; matters now that analyze is awaited).

## Verification gate (live evidence)

- [x] `npx tsc --noEmit` clean (server).
- [x] Pre-fix DB: latest run `7c0bc13e` = 30 total, 4 queued, 6 skipped,
  **20 failed (`last_error='stalled'`)**; 10 orphaned `running` analyses.
- [x] Reproduced live (pre-rate-fix): every run halted at exactly `call #40` (= RPM),
  Gemini lane silent → watchdog killed the run.
- [x] Post-fix, same 30 leads (dry-run, forceRefresh): Gemini `call #` climbed
  **past 40 to #191+** continuously; composes succeeded (`✓ … sent_specific`);
  **fail=0**; q4s climbed 0→13 — the stall mode is gone. (Run did not reach 30/30
  only because the Gemini prepay balance hit `429 credits depleted` mid-run — a
  billing limit, not the bug.)

## Completion record

- Commit SHAs: <this commit>
- What changed: 7 files — `geminiRateLimiter.ts` (reservoir→minTime),
  `batchOrchestrator.ts` (analyze await + orphan-safe + sentinel narrow),
  `db/batch.ts` (watchdog clock + enqueue terminalize), `playwrightRenderer.ts`
  (bounded connect), `env.ts` + `settingsRegistry.ts` (drop dead
  `BATCH_ANALYZE_TIMEOUT_MS`), deleted `scripts/batchTimeoutRecoveryGate.ts`.
- Follow-ups / parked:
  - **Top up Gemini prepay credits** — vision + verify + NIM fallback all bill
    Gemini, so a dry balance 429s the whole batch. Blocks live full-batch proof.
  - Optional throughput: with the wedge gone, raise `GEMINI_RPM` (→120) and
    `GEMINI_MAX_CONCURRENT` (→3–4) for fast batches; both provider-agnostic.
  - Reviewer pass on `batchOrchestrator.ts` (send-adjacent) before relying on it.
