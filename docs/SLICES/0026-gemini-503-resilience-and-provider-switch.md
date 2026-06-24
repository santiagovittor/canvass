# Slice 0026: Gemini 503 resilience + Settings-driven provider switch (NVIDIA NIM fallback)

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F6**. Best after `0023` (so a slow provider can't re-wedge a batch).

## Intent

**Plain English.** Gemini's servers were overloaded — ~88% of our requests came
back "model experiencing high demand" (a Google-side 503), with zero quota
errors. It's their capacity, not our account. This slice does two things: (1)
makes generation survive a 503 storm instead of burning retries and wedging, and
(2) lets us point the compose/verify step at a different, cheaper/free model —
NVIDIA NIM (DeepSeek-V4-Flash / Kimi K2.5/K2.6 / Nemotron-3, free, OpenAI-
compatible) — **switchable from the Settings tab**, used either as a reliable
fallback when Gemini is down or to offload cost for the text task. Vision stays on
Gemini. A new model is adopted only if its Spanish (usted) and English drafts read
as well as today's — the quality bar is explicit, never hidden.

**Project vocabulary.** Generalize the compose/verify model call behind a provider
field so `GEMINI_MODEL` / `GEMINI_VERIFIER_MODEL` settings can resolve to either
the Gemini SDK or an OpenAI-compatible endpoint (NVIDIA NIM via `undici`), keeping
`withGeminiRate`'s rate/timeout/retry/RPD wrapper. Extend the existing composer
503 quarantine (`COMPOSE_503_QUARANTINE_MINUTES`) to the verifier, and add a
provider fallback hop on a sustained 503.

## Out of scope

- Changing the **vision** path (stays Gemini — `visionClient.ts`).
- Auto-tuning rate limits; billing automation.
- Building a full multi-provider router — minimum viable: Gemini + one
  OpenAI-compatible provider (NIM), selected per model setting.
- The batch timeout/watchdog — that is `0023` (prerequisite).

## Constraints (`docs/SPEC.md` + `rules/architecture.md`)

- **Reuse** `withGeminiRate` (`geminiRateLimiter.ts`) as the throttle/timeout/retry
  authority for *every* provider call — do not add a second rate path. The 429
  RPD / `GeminiProviderExhausted` classification stays Gemini-specific.
- **undici only** for the OpenAI-compatible HTTP call — **no axios, no openai SDK
  unless it's already a dep** (it is not; prefer a thin `undici` fetch to
  `/v1/chat/completions`). No banned packages.
- **Env validated by zod at boot** — `NVIDIA_NIM_API_KEY` (optional),
  `NVIDIA_NIM_BASE_URL` (default the NIM endpoint). Missing key + a NIM model
  selected → clear boot/setting error, no silent default.
- **Settings-driven** (operator request): provider/model is changed from the
  Settings tab (`settingsRegistry.ts` already has `GEMINI_MODEL`,
  `GEMINI_VERIFIER_MODEL`, fallback model) — extend, don't fork.
- **No quality regression hidden** (SPEC + operator): a provider/model swap must
  pass an A/B read on real ES/EN drafts before it can be set as primary; record
  the comparison.
- **SSE-only** for any health surface (reuse `gemini:health` / `geminiHealth.ts`).

## Diagnose-first checklist

Mostly done in `0022` F6. Confirm before editing:

- [ ] Files to read: `server/src/services/geminiRateLimiter.ts:88-100,245-302`
      (retry + final classification), `server/src/services/geminiComposer.ts:
      750-950` (model resolution + the existing 503 fallback + quarantine),
      `server/src/services/geminiVerifier.ts:120-…` (verify model, no fallback
      today), `server/src/services/settingsRegistry.ts:124-164` (model settings +
      `COMPOSE_503_QUARANTINE_MINUTES`), `server/src/env.ts`,
      `server/src/services/geminiHealth.ts`.
- [ ] Symbols to catalog: `getGenerativeModel` call sites (composer/verifier/
      vision), `GEMINI_COMPOSER_FALLBACK_MODEL`, the quarantine state, the JSON
      response shape both providers must return (`{subject, body}` for compose;
      the verdict schema for verify), `recordCost`/`GEMINI_PRICING` (add NIM = $0).
- [ ] Research/confirm: NIM `/v1/chat/completions` request+response shape, the
      exact model ids (`deepseek-ai/deepseek-v4-flash`, `moonshotai/kimi-k2.5`,
      `nvidia/nemotron-3-…` — confirm live), JSON/structured-output support, the
      ~40 RPM shared free ceiling (matters under batch concurrency — may need a
      provider-specific Bottleneck reservoir).
- [ ] Open questions for the operator: resolved — NIM is the candidate; adopt as
      primary only if quality A/B passes, else keep as fallback / cost-offload.

## Implementation plan

_Operator approves before edits._

- **Step 1 — Verifier 503 quarantine + bounded storm.** Extend the composer's
  `COMPOSE_503_QUARANTINE_MINUTES` pattern to `geminiVerifier` so a verifier
  primary that 5xx-storms quarantines and routes to its fallback/secondary
  instead of re-storming. Confirm the retry budget can't be re-armed unboundedly
  per item (ties to `0023`).
  *(Verify: a forced verify-503 storm quarantines after the threshold and stops
  hammering; no per-item retry explosion.)*

- **Step 2 — Provider abstraction behind the model setting.** Introduce a thin
  `generateText(provider, model, prompt, {signal})` seam that the composer +
  verifier call *through* `withGeminiRate`. `provider` derives from the model id
  (e.g. a `nim:` prefix or a separate `*_PROVIDER` setting). Gemini path unchanged;
  NIM path = `undici` POST to `${NVIDIA_NIM_BASE_URL}/v1/chat/completions` with the
  key, parsing the OpenAI-shaped response into the same `{subject, body}` / verdict
  JSON. Add `NVIDIA_NIM_API_KEY` + `NVIDIA_NIM_BASE_URL` to `env.ts` + settings.
  *(Verify: setting `GEMINI_MODEL` to a NIM model id makes compose calls hit NIM
  and return valid `{subject, body}` JSON; switching back to Gemini works with no
  restart.)*

- **Step 3 — Fallback hop on sustained Gemini 503.** When the Gemini primary is
  quarantined (Step 1) and a NIM model is configured, route compose/verify to NIM
  rather than failing the lead. Keep vision on Gemini regardless.
  *(Verify: with Gemini forced to 503, a batch still produces drafts via NIM; cost
  ledger shows $0 NIM rows.)*

- **Step 4 — Quality A/B (the bar).** Generate the same N real leads' drafts
  (mixed Argentina-usted + English) on `gemini-2.5-flash` vs the candidate NIM
  model; read both. Adopt NIM as primary **only if** it reads as well (voice,
  usted register, anchor specificity) AND the verifier's claim-grounding holds on
  the new model. Otherwise keep NIM as fallback/offload only. Record the
  comparison in the verification gate.
  *(Verify: side-by-side drafts captured; decision + rationale recorded; no
  silent quality drop.)*

- **Step 5 — Rate ceiling.** If NIM's ~40 RPM shared limit throttles batch
  concurrency, give the NIM provider its own Bottleneck reservoir (mirror the
  Gemini limiter) so it self-paces instead of 429-ing.
  *(Verify: a concurrency-3 batch on NIM does not 429; throughput acceptable.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-24, dev container, real NIM key)._

- [x] **`npx tsc --noEmit` clean — server (in container)** — passed after each of 4 phases
      and again after the review fixes.
- [x] **NIM transport / masquerade proven live** — `makeGenerate('nim:…')` calls
      `integrate.api.nvidia.com/v1/chat/completions` and returns a valid `GenResult`:
      `deepseek-ai/deepseek-v4-flash` ~1.2s, `meta/llama-3.3-70b-instruct` ~4.7s, both
      JSON + `usageMetadata` mapped (`prompt_tokens→promptTokenCount`,
      `completion_tokens→candidatesTokenCount`). `moonshotai/kimi-k2.6` timed out (slow
      reasoning model — rejected as candidate). Live model list confirmed the slice's ids
      exist: `deepseek-v4-flash`, `kimi-k2.6`, `nemotron-3-super-120b-a12b`.
- [x] **Settings switch Gemini↔NIM with no restart; both return valid JSON** — flipping
      `GEMINI_MODEL` via `setSetting` routed `composeEmail` to NIM and back, no restart,
      both produced valid structured drafts.
- [x] **A/B drafts (ES usted + EN) captured side-by-side** — real `composeEmail` pipeline,
      same two leads (Argentina-usted abogado, EN dentist), `gemini-2.5-flash` vs
      `nim:deepseek-ai/deepseek-v4-flash`:
      - AR/usted: both held `usted` (Tiene/su/conversarlo), anchored on the exact gap
        (móviles), first-person-singular voice. NIM read slightly *more* specific
        ("clientes que buscan abogados desde el celular"). Both declared exactly 1 claim
        (the anchor) — no undeclared/hallucinated website claim.
      - EN: both anchored on the booking gap with a soft modal; NIM hit the 4-paragraph
        structure cleanly. 1 declared claim each.
      - **Latency**: NIM is slower/variable — one EN call exceeded the 30s
        `GEMINI_TIMEOUT_MS`, then auto-retried via `withGeminiRate` and succeeded (~44s
        total). Proves the timeout/retry wrapper handles slow NIM; also why NIM is wired
        as fallback, not silently promoted to primary.
      - **Adoption decision**: quality bar **met** (voice + usted + anchor specificity +
        clean claim-grounding all hold). Default kept **Gemini primary, NIM available as
        fallback** (the 503-resilience goal) — primary-promotion left to the operator given
        NIM's higher/variable latency. To promote: set `GEMINI_MODEL=nim:deepseek-ai/deepseek-v4-flash`
        from Settings. Tradeoff recorded, not hidden.
- [x] **Cost ledger shows NIM rows at $0** — live ledger lines:
      `compose nim:deepseek-ai/deepseek-v4-flash … ~$0.0000` vs
      `compose gemini-2.5-flash … ~$0.0009`. `recordCost` $0-prices any `nim:` model.
- [x] **Verifier 5xx quarantine + fallback** — quarantine state machine verified
      deterministically: fresh→not quarantined, 1 strike→no, 2 strikes same model→quarantined,
      success→cleared, split strikes across models→no quarantine. The 5xx→fallback *routing*
      is code-traced + the NIM fallback transport is proven live (above). A real
      Google-side 503 storm can't be manufactured on demand — left as an operator live item.
- [x] **Reviewer subagent pass (compose/verify send-path)** — `feature-dev:code-reviewer`.
      Two real bugs found + fixed: (1) `withGeminiRate` bypassed all machinery when
      `GEMINI_API_KEY` unset, skipping NIM-only calls past rate/RPD/timeout — now gated so
      `nim:` models stay governed; (2) **pre-existing** `env.ts` defaulted
      `GEMINI_COMPOSER_FALLBACK_MODEL` to `gemini-3-flash` (a known-404) which overrode the
      registry's `gemini-2.5-flash-lite` and defeated the composer's 503-fallback — realigned.
- [ ] **Forced Gemini 503 batch + NIM concurrency-3 no-429** — operator live items: need a
      real 503 storm + a live batch run. Mechanism (quarantine→NIM fallback, serialized
      limiter under NIM's ~40 RPM) proven in parts above.

## Completion record

- **What changed**:
  - New `server/src/services/aiProvider.ts` — provider seam. `makeGenerate({modelId,…})`
    routes by `nim:` model-id prefix: Gemini SDK path (byte-identical to old inline calls)
    vs `undici` POST to NIM `/v1/chat/completions`, wrapping the OpenAI response into the
    `GenResult` subset (`text()` + `usageMetadata`) the call sites already consume. NIM
    errors carry `.status` so `withGeminiRate` + the quarantine classify them like Gemini.
    Missing `NVIDIA_NIM_API_KEY` + a `nim:` model → clear throw, no silent default.
  - New `server/src/services/modelQuarantine.ts` — `createQuarantine(minutesKey,label)`,
    the composer's 5xx state machine extracted so the verifier reuses it.
  - `geminiComposer.ts` — routes `callGemini` + `callGeminiStructured` through `makeGenerate`;
    inline quarantine replaced by `createQuarantine`. Existing 5xx→fallback now reaches NIM
    transparently when `GEMINI_COMPOSER_FALLBACK_MODEL` is a `nim:` id (Step 3, composer).
  - `geminiVerifier.ts` — adds the same quarantine + a new `GEMINI_VERIFIER_FALLBACK_MODEL`
    that fires on a verifier 5xx storm (may be `nim:`) (Steps 1 + 3, verifier).
  - `geminiRateLimiter.ts` — `recordCost` prices `nim:` models at $0; `withGeminiRate`
    keeps `nim:` calls on the full machinery even without a Gemini key (review fix).
  - `env.ts` — `NVIDIA_NIM_API_KEY` (optional) + `NVIDIA_NIM_BASE_URL`
    (default `https://integrate.api.nvidia.com`); realigned the `GEMINI_COMPOSER_FALLBACK_MODEL`
    default to `gemini-2.5-flash-lite` (review fix).
  - `settingsRegistry.ts` — `GEMINI_VERIFIER_FALLBACK_MODEL` string + `NVIDIA_NIM_API_KEY`
    masked secret.
- **Provider switch UX**: set any model setting to `nim:<model-id>` from the Settings tab.
  Candidate proven: `nim:deepseek-ai/deepseek-v4-flash`.
- **Step 5 (NIM-specific reservoir) intentionally skipped** (`ponytail:` note in
  `aiProvider.ts`): the shared limiter runs `maxConcurrent=1` + RPM spacing, so NIM stays
  under its ~40 RPM free ceiling at default settings. Add a reservoir only if the operator
  raises `GEMINI_MAX_CONCURRENT` and NIM 429s.
- **Follow-ups / parked**:
  - Operator live items: force a real Gemini 503 → confirm verifier quarantine→NIM on a
    full batch; confirm NIM concurrency-3 batch does not 429.
  - Operator decision: promote NIM to primary (`GEMINI_MODEL=nim:…`) vs keep as fallback —
    quality bar met; latency is the only reason it's not promoted by default.
  - Known ceiling: NIM calls still count against `GEMINI_RPD` (one rate path, per slice).
