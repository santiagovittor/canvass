# Slice 0054: Cost-per-outcome read-model + cached-token instrumentation

## Intent

Make the cost cuts measurable against *quality*, not just dollars. Slice 0051 (F7)
found that the durable `gemini_cost_log` ledger can attribute spend per stage and
per lead, but it is never joined to the outreach outcome — so we can prove a lead
*cost* $X but not whether the cheaper NIM model (slice 0052) or the gated vision
(slice 0053) changed the **reply rate**. This slice adds a small read-model that
joins `gemini_cost_log` → `email_sends` / `businesses.outreach_status` to report
**cost-per-sent and cost-per-reply by stage and model**, so every cut lands with a
before/after number (the 2026 "never cut tokens without a quality gate" rule, 0051
Sources). It also folds in the cheap instrumentation gap: record
`cachedContentTokenCount` in `recordCost` so we can finally *see* whether Gemini's
implicit caching is already discounting the static system prompts. Traces to
ROADMAP `0054` (from 0051 F2 + F7). Read-only reporting + one logged field — no
behavior change.

## Out of scope

- **Building explicit context caching.** Slice 0051 F2 sized it small, and slice
  0052 moves the text stages to **free** NIM — caching a $0 stage saves nothing.
  Explicit caching is **deferred (YAGNI)** until a high-volume stage stays on paid
  Gemini and the instrumentation here shows implicit caching isn't already
  covering it. This slice only *measures*; it builds no cache.
- **A full analytics UI.** A script (`costReport.ts` sibling) + an optional health
  field is enough; no new dashboard surface unless the operator asks.
- **Changing send/compose/verify behavior.** Pure observability.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Additive only** — the read-model is queries over existing tables; the one
  schema touch (if any) is an additive column or a view. No destructive migration.
- **Reuse-only** — extend `getCostRollups` (`db/`) and the `costReport.ts`
  pattern; don't fork a parallel ledger.
- **No false-absence claims** — `gemini_cost_log` keys on `business_id` /
  `analysis_id` (`geminiRateLimiter.ts:193`); `email_sends` carries status +
  `business_id`; `businesses.outreach_status` carries `replied`. Confirm join keys
  before asserting the join is possible.
- **SSE-only realtime** if any live surface is added (no polling).

## Diagnose-first checklist

Done BEFORE any edit. The operator approves the implementation plan before edits
begin.

- [ ] **Files to read:**
  - `server/src/services/geminiRateLimiter.ts` — `recordCost` (`:178-201`): add
    `cachedContentTokenCount` read from `usageMetadata` (one field; ledger column
    additive). Confirm the SDK populates it for Gemini 2.5 implicit caching.
  - `server/src/db/index.ts` — `getCostRollups` (cited by `costReport.ts:10`):
    extend with an outcome join; confirm `gemini_cost_log` columns
    (`business_id`, `analysis_id`, `label`, `model`, `in_tokens`, `out_tokens`,
    `usd`).
  - `server/src/db/analytics.ts` — existing reply/sent counts
    (`outreach_status='replied'`, `email_sends.status='sent'`) to reuse the same
    definitions (don't redefine "reply").
  - `server/src/scripts/costReport.ts` — the print pattern to extend / clone for a
    `costPerOutcome.ts`.
- [ ] **Symbols to catalog:** `getCostRollups`, `insertGeminiCost`,
  `gemini_cost_log` schema, `email_sends` schema, `outreach_status`,
  `cachedContentTokenCount`, the analytics "real reply" filter
  (`db/analytics.ts:10-12`).
- [ ] **Online topics to research:**
  - 2026 LLM cost-attribution patterns: per-outcome / per-feature rollups
    (Braintrust, Uptrace — 0051 Sources) to mirror the column shape
    (prompt/completion/cached tokens + $ + outcome).
  - Whether Gemini 2.5 implicit caching reports `cachedContentTokenCount` reliably
    via `@google/generative-ai`.
- [ ] **Open questions for the operator:**
  1. **Outcome granularity:** cost-per-sent + cost-per-reply by stage×model is the
     core. Also want per-lane (email vs no-site) and per-locale (es-AR/es-ES/en)?
  2. **Surface:** script-only (run on demand), or also a small read-only number in
     the existing health/analytics surface (SSE)?
  3. **Reply-rate sample size:** replies are ~3.5% on a few hundred sends — the
     cost-per-reply number is noisy at low N. OK to report it with an explicit
     confidence caveat rather than gate decisions on it until N grows?

## Implementation plan

Approved 2026-06-29. Additive/read-only; no send/compose/verify behavior change.

- **Step 1 — cached-token instrumentation.** `gemini_cost_log` gains
  `cached_tokens` (CREATE TABLE + additive `ALTER`-if-missing backfill, mirroring the
  `email_sends` migration). `insertGeminiCost` + `recordCost`
  (`geminiRateLimiter.ts`) thread `usageMetadata.cachedContentTokenCount ?? 0`;
  `getCostRollups.byStage` + `costReport.ts` surface it (`cached=`).
- **Step 2 — cost-per-outcome read-model + script.** `getCostPerOutcome` /
  `getCostOutcomeTotals` in `db/analytics.ts` (placed there to **reuse** `replied()`
  — single-sourced reply def). `LEFT JOIN gemini_cost_log → DISTINCT sent
  businesses → businesses`; no `business_id` filter so null-context rows reconcile
  Σ usd exactly. New `scripts/costPerOutcome.ts` prints cost-per-sent /
  cost-per-reply by stage×model, an optional `YYYY-MM-DD` before/after split, a
  low-N caveat, and a reconciliation footer.

Deferred (slice's own optional questions): per-lane / per-locale dimensions and an
SSE/health surface — script-only until the operator asks. Explicit caching stays
deferred; this slice only measures.

## Verification gate

Live evidence, captured 2026-06-29 (server dev container):

- [x] **Ledger row carries `cached_tokens`; a real Gemini call shows its value.**
      Two real `gemini-2.5-flash` calls (probe, since deleted) wrote rows
      `in=1819 out=1 cached=0 ~$0.0005` — the field is captured/written end-to-end
      via the live `recordCost` path. Observed value **0** across every stage incl.
      the fresh call ⇒ **implicit caching is not currently discounting** these prompts
      (exactly the question the slice posed). Caveat/follow-up: a 0 can't be
      distinguished from the endpoint omitting the field; if a high-volume *paid*
      stage later needs cache proof, confirm the API emits `cachedContentTokenCount`
      (may require the explicit `cachedContent` API).
- [x] **Report reconciles.** All-time: `Σ stage = pipeline total = costReport rollup
      = $1.4991`. Authoritative equality (ungrouped pipeline total == `costReport`
      rollup over the same window) is **exact**; the per-stage Σ is an informational
      cross-check that drifts ≤ $0.0001 from summing per-stage `ROUND(usd,4)`.
      Reply/sent reuse `db/analytics.ts`: cost-set ⊆ global — global
      `sent(distinct)=263 replied=5`, cost-set `sentLeads=73 repliedLeads=0`
      (`subset ok: yes`).
- [x] **Cost-per-reply across the 0052/0053 windows.** Split at `2026-06-28`
      (NIM-swap deploy): **compose** spend `$0.3188` (paid Gemini, `$0.0094/sent`)
      *before* → **$0.0000** (free NIM) *after* — the cut is now a number.
      `cost/reply` is `—` in both windows: the 5 real replies all **predate the
      ledger**, so cost-per-reply only becomes computable as new ledger-era leads
      reply (low-N caveat fires until N ≥ 30).
- [x] **`npx tsc --noEmit` clean** (server, in container) — both phases.

## Completion record

- Commit SHAs: _feature_ `ba1aa60` · _SHA record_ (this docs commit)
- What changed: `gemini_cost_log.cached_tokens` (additive col + backfill ALTER);
  `recordCost`/`insertGeminiCost`/`getCostRollups` thread it; `costReport.ts` shows
  `cached=`. New read-model `getCostPerOutcome` + `getCostOutcomeTotals`
  (`db/analytics.ts`, reuse `replied()`) and `scripts/costPerOutcome.ts`
  (cost-per-sent / cost-per-reply by stage×model, before/after split, low-N caveat,
  exact reconciliation). No behavior change.
- Follow-ups / new parked items:
  1. **Implicit caching observed = 0%** on all stages incl. a fresh real call — if a
     high-volume *paid* stage reappears, confirm the endpoint actually emits
     `cachedContentTokenCount` before sizing explicit caching (slice 0051 F2).
  2. **Cost-per-reply not yet computable** — the 5 existing replies predate the
     ledger; revisit once ledger-era leads reply (N ≥ 30).
  3. Per-lane / per-locale breakdown + SSE health number deferred until requested.
