# Slice 0020: Surface Gemini provider-quota exhaustion (stop the silent failures)

> Derived from `0017` finding (e) / S3. Independent of `0018`/`0019` but best
> after `0019` so the banner has the Automate surface to live on. Operator
> decision: **auto-resume** when quota recovers.

## Intent

The operator's "I want to know when I ran out of Gemini credits, because that's
when things start failing." Today there are two exhaustion conditions handled
very differently. The app's *own* daily budget (`GEMINI_RPD`) throws a typed
`GeminiRpdExhausted`, pauses the batch, and shows a banner — clean. But Google's
*provider-side* quota/billing exhaustion returns HTTP `429 RESOURCE_EXHAUSTED`,
which the rate limiter treats as a transient retry, exhausts the retry budget,
and then re-throws as a generic error — so in a batch it silently marks each lead
`failed`, and in the single-lead path it shows raw error text. The system already
parses the real reason (`describeGeminiError` extracts `reason`, `quotaMetric`,
`quotaLimitValue`, `retryDelayMs`) but only writes it to `console.error`. This
slice classifies provider-quota exhaustion distinctly, broadcasts it over SSE,
pauses the batch with a dedicated reason that **auto-resumes** when quota
recovers, and shows a calm non-technical banner.

**Project vocabulary:** In `geminiRateLimiter.ts`, when the bounded retry budget
is exhausted on a `429` whose `describeGeminiError` reason is `RESOURCE_EXHAUSTED`
(and it is *not* the app's own `GeminiRpdExhausted`), throw a new typed
`GeminiProviderExhausted` carrying the parsed `GeminiErrorDesc`. `batchOrchestrator`
catches it like `GeminiRpdExhausted` — pause with `pauseReason =
'provider_quota_exhausted'` — and a server-side backoff timer re-probes and
auto-resumes when a call succeeds. Broadcast a `gemini:exhausted` SSE; the
Automate batch surface (`0019`) and a global banner render it; the single-lead
compose path maps it to a friendly message instead of raw text.

## Out of scope

- Changing rate-limit/retry tuning (`GEMINI_RPM`, `GEMINI_RPD`,
  `GEMINI_TOTAL_CAP_MS`) — only *classification + surfacing + auto-resume*.
- Billing/quota *increase* automation. We detect and pace around exhaustion; we
  don't raise limits.
- Vision/PSI/Playwright failures (those remain per-lead `failed`; this slice is
  Gemini-quota-specific).
- The Automate surface itself (`0019`); this slice only adds a reason + banner it
  can render. If shipped before `0019`, render the banner globally (e.g. near
  `ActiveRunsStrip`) and let `0019` adopt it.

## Constraints

- **SSE only** (`SPEC.md`; `ui.md`). New `gemini:exhausted` (and a
  `gemini:recovered`) event via `broadcast()` (`sse.ts:77`); optionally include
  current exhaustion state in the connect-time snapshot so a fresh client knows
  immediately. No polling on the client.
- **Reuse the limiter + orchestrator** (`SPEC.md` registry): classification lives
  in `geminiRateLimiter.ts` next to the existing `GeminiRpdExhausted`
  (`:12-21`), `describeGeminiError` (`:103-134`), and `isRetryable` (`:83-87`).
  The batch pause/resume reuses the existing `setRunStatus`/`driveRun` path
  (`batchOrchestrator.ts:199-204,254-260`).
- **Additive only**: `pauseReason` is already a free-text column (it stores
  `gemini_rpd_exhausted`, `user_paused`, …), so `provider_quota_exhausted` needs
  **no schema change**. Any persisted "provider exhausted since" flag must be an
  additive column or in-memory state.
- **No false certainty** (`SPEC.md`): only classify as provider-exhausted after
  the retry budget is spent on a genuine `429` — a soft per-minute 429 usually
  clears within the retry budget, and if it doesn't, the auto-resume re-probe is
  safe (it just retries later).
- **Non-technical copy** (brief): the banner says what happened + what the app is
  doing about it ("Gemini quota reached — preparing new emails is paused and will
  resume automatically when quota frees up"), not a stack trace or status code.

## Diagnose-first checklist

Mostly done in `0017` (e). Confirm before editing:

- [ ] Files to read: `server/src/services/geminiRateLimiter.ts:12-21,73-143,200-259`,
      `server/src/services/batchOrchestrator.ts:182-226`,
      `server/src/sse.ts:18-82`, `server/src/services/stageTracker.ts:43-83`,
      `client/src/pages/Outreach.tsx:185-213` (single-lead error surfacing),
      `client/src/components/ActiveRuns/ActiveRunsStrip.tsx:43-54` (already shows
      `pauseReason`), `client/src/hooks/useSSE.ts`.
- [ ] Symbols to catalog: `GeminiRpdExhausted`, `describeGeminiError`,
      `GeminiErrorDesc` (`reason`/`quotaMetric`/`retryDelayMs`), `isRetryable`,
      `withGeminiRate`'s `onFailedAttempt`/`AbortError` exit (`:240-256`),
      `setRunStatus`, `pauseReason` usages.
- [ ] Decide the recovery probe: a dedicated low-frequency timer (e.g. every
      15–30 min, exponential up to a cap) that, while any run is paused with
      `provider_quota_exhausted`, calls `resumeBatch` — `driveRun` naturally
      re-attempts; if the next Gemini call still 429s, it re-pauses (no thrash).
      Confirm this re-pause loop is idempotent and rate-safe.
- [ ] Decide scope of detection: batch path (pause) **and** single-lead compose
      path (friendly message). The single-lead path can't pause a run, so it just
      surfaces the banner + maps the error.
- [ ] Open questions for the operator: resolved — **auto-resume**. (Re-probe
      cadence is Claude's call; default 15-min start, back off to ~1h, reset on
      success.)

## Implementation plan

_Proposed by `0017`. Operator approves before edits._

- **Step 1 — Typed provider-exhaustion error.** In `geminiRateLimiter.ts`, add
  `GeminiProviderExhausted extends Error` carrying the `GeminiErrorDesc`. In the
  `onFailedAttempt`/abort exit (`:240-256` / `:234`), when the error is a `429`
  with `reason==='RESOURCE_EXHAUSTED'` and the budget is spent, throw
  `GeminiProviderExhausted(desc)` instead of the bare `AbortError`. Keep soft
  429s on the existing retry path.
  *(Verify by: a unit-ish manual test or a forced 429 (temporarily bad key /
  mocked status) yields `GeminiProviderExhausted`, while a 503 still retries.)*
- **Step 2 — Broadcast.** On throwing/observing exhaustion, `broadcast('gemini:exhausted',
  { reason, quotaMetric, retryDelayMs, at })`; on a later successful call,
  `broadcast('gemini:recovered', { at })`. Track a module-level
  `providerExhaustedSince` so the connect-time snapshot (`sse.ts:register`) can
  include current state for fresh clients.
  *(Verify by: SSE log shows `gemini:exhausted` once at exhaustion, `gemini:recovered`
  on recovery.)*
- **Step 3 — Batch pause + auto-resume.** In `batchOrchestrator.ts:198-205`, add
  a `catch (err instanceof GeminiProviderExhausted)` arm mirroring the RPD arm:
  `setRunStatus(runId, 'paused', 'provider_quota_exhausted')` + `broadcastProgress`.
  Add a recovery timer (per the diagnose decision) that resumes paused
  `provider_quota_exhausted` runs; on a successful probe, emit `gemini:recovered`.
  *(Verify by: force exhaustion mid dry-run batch → run pauses with the new
  reason; on recovery (or manual key restore) → run resumes automatically.)*
- **Step 4 — Global banner.** Add a small calm banner component fed by a
  `useGeminiHealth()` hook subscribing to `gemini:exhausted`/`recovered` (+
  snapshot). Render it where it's visible regardless of tab (near
  `ActiveRunsStrip` in `App.tsx:192`, or inside the Automate surface if `0019`
  shipped). Non-technical copy.
  *(Verify by: banner appears on exhaustion, disappears on recovery; copy carries
  no status code.)*
- **Step 5 — Single-lead path.** In `Outreach.tsx:208-213` (and the WA/follow-up
  generate handlers), map a `GeminiProviderExhausted`-originated error to the
  same friendly message instead of raw `err.message`.
  *(Verify by: trigger a single-lead generate while exhausted → friendly message,
  not raw text.)*

## Verification gate

_Filled DURING execution with live evidence._

> **Design note (operator request mid-build):** scope widened from "surface
> exhaustion" to **always-on health with a beforehand warning**. Consolidated the
> `gemini:exhausted`/`gemini:recovered` pair into a single `gemini:health` event
> carrying `{status: healthy|low|exhausted, rpdCount, rpdCeiling, provider}`. The
> app's own `GEMINI_RPD` daily counter (read live, no extra calls) is the honest
> early-warning proxy — flips to `low` at ≥80% so the operator can top up before
> calls fail. Provider exhaustion has no pre-signal, so it only flips `exhausted`
> on a real 429.

- [x] **Classification** — verified against the real `errorDetails` shape via the
      same `describeGeminiError` the live path uses: a `429` with
      `reason=RESOURCE_EXHAUSTED` (+ `RetryInfo.retryDelay` parsed to 27000ms)
      classifies as provider exhaustion; a `503` does **not** (stays on the retry
      path → no false banner). The log line `[gemini] … FAILED status=429
      reason=RESOURCE_EXHAUSTED …` is emitted by `logGeminiFailure` on the failing
      attempt, and classification fires only after the whole retry budget is spent.
- [x] **SSE over the wire** — `curl`-equivalent read of `/events` returned the
      connect-time snapshot `event: gemini:health` →
      `{"status":"healthy","rpdCount":29,"rpdCeiling":1000,"provider":{"exhausted":false,…}}`.
      A fresh client sees health immediately, no polling.
- [x] **Health state machine** — `markGeminiExhausted` → snapshot `status=exhausted`,
      `provider.exhausted=true`, `isGeminiExhausted()=true`; `markGeminiSuccess` →
      provider cleared (auto-recovery). RPD band: counter at 85% → `low`, at ceiling
      → `exhausted`; live counter saved and restored exactly (8/8 assertions PASS).
- [x] **Batch pause + auto-resume** — orchestrator gains a
      `GeminiProviderExhausted` catch arm mirroring the proven `GeminiRpdExhausted`
      arm: `setRunStatus(runId,'paused','provider_quota_exhausted')` (additive
      free-text `pause_reason`, no schema change) + a 15m→1h backoff recovery timer
      that `resumeBatch`es paused runs until a Gemini call succeeds; re-arms on boot
      for runs paused before a restart. Verified by construction + tsc; an
      end-to-end forced-429 *batch* run was not exercised live (no spare
      provider-exhausted key on hand) — the catch arm is identical in shape to the
      RPD arm already proven in slice 0013.
- [x] **Banner / chip (all 3 states, live render via headless Chromium on the
      running client)**:
      - healthy → `gemini-health--healthy`, *"Gemini · Healthy — emails generating normally · 29/1000"*
      - low → `gemini-health--low`, *"Daily budget almost used — top up soon (resets at midnight PT) · 850/1000"*
      - exhausted → `gemini-health--exhausted`, *"Daily budget reached — preparing emails is paused, resumes at midnight PT · 1000/1000"* (provider-429 variant: *"Quota reached — … resumes automatically when quota frees up"*). No status codes in copy.
- [x] **Soft 429 does not trip exhaustion** — classification gates on the *final*
      failure being `429 + RESOURCE_EXHAUSTED`; a 429 that clears within the retry
      budget resolves to success → `markGeminiSuccess` → never `exhausted` (the 503
      assertion above proves the non-429 branch stays retryable).
- [x] **Single-lead path** — `/generate`, `/wa-generate`, `/generate-follow-up`
      catch `GeminiProviderExhausted` → `503 {error, code:'provider_quota_exhausted'}`;
      `Outreach.tsx` maps the code to the calm message instead of raw `503 {…}` text.
- [x] `npx tsc --noEmit` clean — server (in container) after every phase + client.

## Completion record

- Commit SHAs: _pending commit_
- What changed:
  - **New** `server/src/services/geminiHealth.ts` — single health authority
    (provider-exhaustion latch + live RPD band), `gemini:health` broadcast on
    transitions, connect-time snapshot.
  - **New** `client/src/hooks/useGeminiHealth.ts` + `client/src/components/GeminiHealthBanner.tsx`
    — always-on health chip; `globals.css` `.gemini-health` tokens.
  - `geminiRateLimiter.ts` — `GeminiProviderExhausted` typed error; final-failure
    classification wrap; health hooks (success/exhaust/rpd-refresh).
  - `geminiComposer.ts` — propagate `GeminiProviderExhausted` (was reburied as
    generic "Composer structured output failed").
  - `batchOrchestrator.ts` — pause arm + recovery timer + boot re-arm.
  - `sse.ts` — connect-time `gemini:health` snapshot.
  - `outreachQueue.ts` — friendly `503` + code on the 3 compose routes.
  - `App.tsx` / `Outreach.tsx` — mount chip; map friendly message.
- Follow-ups / new parked items: optional persisted exhaustion-history for the
  Analytics tab; per-model quota attribution from the cost ledger; consider a
  configurable low-threshold (currently hardcoded 80%).
