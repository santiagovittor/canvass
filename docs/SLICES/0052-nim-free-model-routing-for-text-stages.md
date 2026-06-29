# Slice 0052: Route compose + verify to free NVIDIA NIM (Gemini as fallback)

## Intent

Cut the text-stage Gemini spend (compose 21% + verify 17% ≈ **38% of all spend**,
slice 0051 F6/g) to **near $0** by routing compose, verify, follow-up and WhatsApp
through the **free** NVIDIA NIM provider that is already wired into the codebase
(slice 0026's `nim:` seam) and whose API key is already in `.env`
(`NVIDIA_NIM_API_KEY=nvapi-…`). NIM exposes 100+ OpenAI-compatible models for free
(40 RPM tier). The swap is a *settings change behind a quality gate*, not new
plumbing: flip `GEMINI_MODEL` / `GEMINI_VERIFIER_MODEL` to a `nim:<model-id>` and
make Gemini the **fallback** (reverse of today), so a NIM credit/rate limit
degrades gracefully back to Gemini instead of failing. Ships the immediate cost
cut the operator asked for. Traces to ROADMAP `0052` (from 0051 F6 + the operator's
"switch to free NVIDIA models" directive). The verifier stays a correctness
invariant — if it runs on NIM, it must A/B-agree with the Gemini verifier before
it's trusted.

## Out of scope

- **Vision routing.** `runVision` (`visionClient.ts:60`) calls the Gemini SDK
  directly with image `Part`s; the `nim:` seam (`aiProvider.ts`) is text-only
  today. Vision stays on `gemini-2.5-flash`; its cost is handled by *gating* in
  slice 0053, not by NIM.
- **New provider plumbing.** The `nim:` provider, rate/timeout/RPD/cost machinery,
  and the 5xx quarantine→fallback already exist (slice 0026). This slice selects
  models + flips primary/fallback + adds the quality gate; it does not rewrite the
  transport.
- **Removing or weakening the verifier.** Off the table (SPEC correctness
  invariant). The verifier may *run on a cheaper provider*, never be skipped to
  save cost.
- **Explicit context caching** (slice 0051 F2) — moot for any stage moved to free
  NIM; deferred to 0054's instrumentation.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Reuse-only registry** — route through the existing `withGeminiRate` +
  `makeGenerate` (`aiProvider.ts:39`) + `createQuarantine`; do not add a parallel
  client. `composeVerifiedEmail` / `geminiVerifier` keep their contracts.
- **Verifier owns claims** — a NIM verifier must be proven to grade at least as
  strictly as the Gemini verifier (no extra unsupported claims slipping through)
  before it becomes primary.
- **No silent quality regression** — every model swap ships with a measured
  before/after acceptance/disposition comparison (2026 consensus, 0051 Sources).
- **Cost guardrails stay authoritative** — `GEMINI_RPM`/`GEMINI_RPD` bound the
  shared Bottleneck limiter; NIM's free tier is **40 RPM**, below today's
  `GEMINI_RPM=120`, so the limiter (or a NIM-specific reservoir) must be retuned
  or NIM will 429.
- **Em-dash sanitizer** (`stripEmDashes`) stays on the output boundary regardless
  of provider — a different model is a different slop risk.
- **Settings via registry** — model ids are live-tunable `string` fields
  (`settingsRegistry.ts:131,135,151,160`); no hardcoding, no env-only switch.
- **No false-absence claims** — confirmed: NIM seam exists, key present, 2 NIM
  calls already in `gemini_cost_log` (`nim:deepseek-ai/deepseek-v4-flash`, $0).

## Diagnose-first checklist

Done BEFORE any edit. The operator approves the implementation plan before edits
begin.

- [ ] **Files to read:**
  - `server/src/services/aiProvider.ts` — `providerFor`, `makeNimGenerate`
    (`:69-121`): NIM uses `response_format: { type: 'json_object' }` and **ignores
    `responseSchema`** — so the composer's structured-output schema is *not*
    enforced server-side on NIM; the zod `ComposedEmailSchema.parse` + 3-attempt
    loop (`geminiComposer.ts:1001`) is the only net. Measure NIM JSON parse-failure
    rate.
  - `server/src/services/geminiComposer.ts` — `callGeminiStructured` (`:970`) +
    `callGemini` (`:815`): both read `getString('GEMINI_MODEL')`; the existing
    5xx-only quarantine→fallback (`:990,1019,1030`).
  - `server/src/services/geminiVerifier.ts` — `callGeminiVerifier` (`:147`) reads
    `GEMINI_VERIFIER_MODEL` + `GEMINI_VERIFIER_FALLBACK_MODEL` (already documented
    to accept `nim:`, `settingsRegistry.ts:165`).
  - `server/src/services/geminiRateLimiter.ts` — `recordCost` ($0 for `nim:`
    rows, `:185`), `extractStatus`/`isRetryable` (`:100-112`), the shared
    Bottleneck reservoir (`:39-46`). Confirm whether NIM credit-exhaustion surfaces
    as a 402/429/403 and whether `isRetryable` + the quarantine route it to the
    fallback (today fallback fires on **5xx**, `geminiComposer.ts:1019` — a NIM 402
    would NOT trip it; this gap must be closed).
  - `server/src/services/modelQuarantine.ts` — strike/quarantine semantics to mirror
    for a NIM-primary world (NIM-down → route to Gemini).
  - `server/src/services/settingsRegistry.ts` — the four model fields + `GEMINI_RPM`
    (`:179`) + `GEMINI_MAX_CONCURRENT` (`:188`).
- [ ] **Symbols to catalog:** `GEMINI_MODEL`, `GEMINI_VERIFIER_MODEL`,
  `GEMINI_COMPOSER_FALLBACK_MODEL`, `GEMINI_VERIFIER_FALLBACK_MODEL`, `GEMINI_RPM`,
  `providerFor`, `makeNimGenerate`, `withGeminiRate`, `createQuarantine`,
  `recordCost`, `NVIDIA_NIM_BASE_URL`. Disposition signals to gate on:
  `verification_json.status` / `disposition` (`sent_specific`/`held_generic`/
  `verifier_failed`), batch outcomes in `db/batch.ts`.
- [ ] **Online topics to research:**
  - Current **free** NIM model ids best at multilingual (Spanish AR *voseo*/usted +
    ES *tú*) instruction-following + reliable JSON: candidates
    `meta/llama-3.3-70b-instruct`, `qwen/qwen2.5-72b-instruct`,
    `deepseek-ai/deepseek-v3.x`, `nvidia/llama-3.x-nemotron`. Pick 2–3 to A/B.
  - NIM free-tier **actual** limits in 2026: 40 RPM confirmed; whether the
    "1,000 inference credits" is a hard cap that exhausts (→ Gemini fallback must be
    bulletproof) or effectively unlimited. **Verify before making NIM the sole
    primary.**
  - NIM `json_object` reliability vs schema-enforced output for these models.
- [ ] **Open questions for the operator:**
  1. **Verifier on NIM — yes or pinned to Gemini?** The verifier is correctness-
     critical. Recommended: keep `GEMINI_VERIFIER_MODEL` on Gemini *until* a NIM
     verifier proves ≥ parity (agreement rate on a labeled sample); move compose to
     NIM first (lower risk — the Gemini verifier still grades it). Confirm.
  2. **Fallback direction.** Make NIM primary + Gemini fallback (recommended:
     free-first, paid safety net) — accepting that a NIM credit/limit event adds
     latency on the fall-through? Or NIM only as the *fallback* (conservative:
     Gemini primary, NIM absorbs 503 storms for free)?
  3. **RPM retune.** OK to lower `GEMINI_RPM` to ~40 (NIM ceiling) when NIM is
     primary, or give NIM its own reservoir so Gemini-fallback keeps 120?

## Implementation plan

Operator-question answers (all landed on the slice's recommended, reversible defaults):
1. **Compose → NIM now; verifier stays Gemini** (`gemini-2.5-flash`). Verifier is a
   correctness invariant; flipping it needs a proven agreement study. Live evidence
   also showed the NIM verifier is too slow (repeated 30s timeouts), so it is *not*
   a viable primary today. The verify flip stays a lever for a later slice.
2. **NIM primary + Gemini fallback** (free-first, paid safety net).
3. **RPM retuned to 40** — the gate proved the 40 RPM concern is real (a dense loop
   bursts NIM); `GEMINI_RPM 120 → 40` (≈1500 ms spacing). At `maxConcurrent=1` this
   never binds the slow serialized Gemini vision path.

- Step 1 — **A/B 5 candidate models against the live NIM `/v1/models` + chat API**
  (`meta/llama-3.3-70b-instruct`, `nvidia/llama-3.3-nemotron-super-49b-v1`,
  `deepseek-ai/deepseek-v4-flash`, `qwen/qwen2.5-72b-instruct`,
  `mistralai/mistral-small-3.1-24b`). Winner: **`meta/llama-3.3-70b-instruct`** —
  3/3 valid JSON, 3/3 full shape, 0 voseo leaks, clean usted Spanish, ~10 s/call.
  Nemotron: 2/3 JSON, slower (17 s), stiffer tone. deepseek-v4-flash (the id already
  in the ledger): **now hangs/times out**. qwen + mistral: not in the catalog.
- Step 2 — **closed the fallback-trigger gap** (`geminiComposer.ts`): when NIM is
  primary, any terminal failure (429/402/403/5xx/timeout/persistent bad-JSON) routes
  to the Gemini fallback — the old gate fired on 5xx only. A NIM **429** is treated
  as transient (retry + per-lead fallback) and does *not* quarantine the whole batch
  onto paid Gemini; only 402/403/5xx quarantine. Follow-up/WhatsApp (`callGemini`)
  got the same NIM→Gemini fallback (previously had none).
- Step 3 — **retuned `GEMINI_RPM` 120 → 40** (live override, applied on restart).
- Step 4 — **flipped `GEMINI_MODEL` → `nim:meta/llama-3.3-70b-instruct`** (live DB
  override; registry default stays `gemini-2.5-flash` as the safe restore point);
  `GEMINI_COMPOSER_FALLBACK_MODEL` stays `gemini-2.5-flash-lite`;
  `GEMINI_VERIFIER_MODEL` stays `gemini-2.5-flash`.

## Verification gate

Live gate (`_nimGate.ts`, dry-run, 6 real AR+EN leads reusing existing premium
analyses; deleted after the run). Evidence from the run on 2026-06-29:

- [x] **Ledger $0**: NIM pass ledger — `compose nim:meta/llama-3.3-70b-instruct` 12
      calls **$0.000000**, `verify` $0, with `compose-fallback gemini-2.5-flash-lite`
      1 call $0.000364. Every NIM row is $0.
- [x] **Disposition parity**: baseline → NIM = **6/6 `sent_specific`** (baseline
      sent=6 held=0 fail=0; NIM sent=6 held=0 fail=0). The compose swap changed no
      disposition.
- [x] **JSON parse-failure within budget**: NIM compose fell through to Gemini on
      **1/6 leads (17%)** — within the ≤50% budget. NIM emits JSON that parses but
      occasionally misses the strict `ComposedEmailSchema` (short/incomplete output);
      the 3-attempt loop + Gemini fallback catches it (draft still valid). Raw probe:
      3/3 valid JSON on the held sample.
- [x] **Forced NIM failure → Gemini fallback**: `GEMINI_MODEL=nim:meta/__nonexistent__`
      → primary exhausted (**status=404**) → fell back to `gemini-2.5-flash-lite`,
      draft produced, disposition `sent_specific`. Log + ledger both show the fallback.
- [x] **No NIM 429** across the serialized run at `GEMINI_RPM=40` — 0 leads hit 429.
- [x] **Em-dash sanitizer clean** on NIM output — 0 leaks across the 6 NIM drafts.
- [x] `npx tsc --noEmit` clean (server in container) after every phase.
- Bonus — **NIM-as-verifier**: repeated 30 s timeouts (one verify took 61.6 s);
      directional disposition agreement held, but the latency rules it out as the
      verifier primary. Verifier stays on Gemini (decision #1).

## Completion record

- Commit SHAs: _this commit_
- What changed:
  - `geminiComposer.ts` — `callGeminiStructured` falls back to Gemini on *any*
    terminal NIM-primary failure (was 5xx-only); NIM 429 stays transient (no batch
    quarantine), 402/403/5xx quarantine. `callGemini` (follow-up/WhatsApp) gained a
    NIM→Gemini fallback it never had.
  - `settingsRegistry.ts` — documented `nim:` routing on `GEMINI_MODEL`.
  - Live settings (DB overrides): `GEMINI_MODEL=nim:meta/llama-3.3-70b-instruct`,
    `GEMINI_RPM=40`; `GEMINI_VERIFIER_MODEL` + `GEMINI_COMPOSER_FALLBACK_MODEL`
    unchanged (Gemini). Server restarted so the RPM limiter picked up 40.
  - No new plumbing; the `nim:` seam (slice 0026) carried the swap.
- Follow-ups / new parked items:
  - **Raise NIM structured hit-rate** (currently ~17% fall-through to Gemini): try a
    `max_tokens` floor on the NIM request and/or a tighter "return ALL keys" nudge in
    the composer prompt, so more compose calls land fully free.
  - **Verifier on NIM** remains a lever — needs a labeled agreement study *and* a NIM
    model fast enough for the verify pass (llama-3.3-70b times out); revisit when a
    faster free model lands. Cutting verify (17% of spend) is the next win.
  - The `nim:deepseek-ai/deepseek-v4-flash` id in old ledger rows now hangs — avoid.
