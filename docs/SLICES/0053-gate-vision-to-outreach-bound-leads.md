# Slice 0053: Gate vision to outreach-bound leads (cut the 61% sink)

## Intent

Stop spending the single biggest cost line on leads nobody contacts. Slice 0051
(F1/g) measured that **vision is 61% of all AI spend ($0.88 of $1.44)**, that it
runs once per analyzed website lead via auto-analyze (slice 0001), and that **~88%
of analyzed leads (≈553 of 630) never reach compose** — so roughly **$0.73 of
spend buys vision nobody acted on**. This slice gates the vision stage so it runs
on leads that are actually worth emailing — above a lead-score bar (slices 0044+)
and/or only when a lead is queued/prepared for outreach — instead of
unconditionally on every scrape. Same render+PSI signal collection where cheap;
the expensive Gemini *vision* call is what gets gated. Traces to ROADMAP `0053`
(from 0051 F1). Reuses `leadScore.ts`; no change to the verifier or the
compose→verify guarantee.

## Out of scope

- **Render / signatures / PSI.** Those are local or Google-PSI (not Gemini vision)
  and are cheaper; this slice gates the **vision Gemini call** specifically. Keep
  collecting the cheap signals unless diagnosis shows render itself is the latency
  cost worth deferring.
- **Removing the auto-analyze pipeline** (slice 0001). It still runs; this slice
  decides *whether the vision step inside it fires* for a given lead.
- **Lead-score logic** (slices 0044–0050). Reused as the gate input, not changed.
- **Vision-on-NIM.** Routing vision to a free multimodal provider is a separate,
  larger effort (image seam); out of scope here — gating is the lever.

## Constraints

`docs/SPEC.md` invariants that apply:

- **Reuse-only registry** — gate via `computeLeadScore` (`leadScore.ts`); do not
  invent a second scoring signal. `premiumAnalyzer.runPremiumAnalysis` is reused.
- **Additive only** — a gate flag / threshold is a `settingsRegistry` field +
  (if needed) an additive column; no destructive migration, no silent default.
- **Reuse the TTL gate** — `isAnalysisFresh` (`db/premium.ts`) still prevents
  re-analysis; vision-gating composes with it, doesn't bypass it.
- **No quality regression that hides** — deferring vision must not silently strip
  the visible-pain ranking signal (PSI/vision feed slice 0049's score); the
  tradeoff is surfaced and the on-demand path is real.
- **Idempotent / restart-safe queue** — a lead that crosses the threshold later
  must be (re)enqueueable for vision; the gate is re-evaluable, not one-shot.

## Diagnose-first checklist

Done BEFORE any edit. The operator approves the implementation plan before edits
begin.

- [ ] **Files to read:**
  - `server/src/services/premiumAnalyzer.ts` — where `runVision`
    (`visionClient.ts:60`) is invoked inside `runPremiumAnalysis`; what depends on
    its output (`vision_json`, the anchor ranker, slice 0049 PSI/visible-pain).
  - `server/src/services/autoAnalyzeEnqueue.ts` + `premiumAnalysisQueue.ts` — the
    auto path that enqueues every website lead; the natural gate point.
  - `server/src/services/leadScore.ts` (+ `leadScore.test.ts`) — `computeLeadScore`
    inputs/lanes/grades; what's available pre-analysis (rating, reviews, category,
    website) vs what needs analysis (PSI, vision) — confirm the gate uses only
    pre-vision signals so it doesn't create a chicken-and-egg.
  - `server/src/db/index.ts` — `getOutreachLeads` (`:727`) ordering / how
    "queued for outreach" is expressed; whether a "prepared" state exists to hang
    the on-demand vision off (batch prepare path, `batchOrchestrator.ts`).
- [ ] **Symbols to catalog:** `runPremiumAnalysis`, `runVision`,
  `autoEnqueueForAnalysis`, `isAnalysisFresh`, `computeLeadScore`, the lead-score
  grade thresholds, `premium_analyses.vision_json`, any "prepared"/queue state.
- [ ] **Online topics to research:**
  - 2026 guidance on **selective/conditional enrichment** (analyze-on-intent vs
    analyze-everything) for cost control in lead pipelines.
  - Whether deferring the expensive analysis until intent measurably hurts ranking
    quality vs cost saved (the F1 tradeoff).
- [ ] **Open questions for the operator:**
  1. **Gate shape:** (a) score threshold (e.g. grade ≥ B) at auto-analyze enqueue,
     (b) defer all vision until a lead is queued/prepared for outreach, or (c)
     both (threshold for auto, on-demand for anything promoted later)? Recommended:
     (c) — cheap signals for everyone, vision only for above-bar or
     about-to-be-contacted leads.
  2. **The 0049 dependency:** slice 0049 backfills PSI/analysis so visible-pain can
     rank. If vision is gated, the no-vision leads have no visible-pain score — OK
     to rank them on the cheaper owned signals (rating/reviews/category/PSI) and
     add vision only when promoted?
  3. **Threshold value:** what grade/score is "worth a vision call" today, given
     the ~$0.0013/call cost and the daily send cap of 15–30?

## Implementation plan

_Approved by the operator (plan mode) before edits. Gate shape = recommended option (c)._

**Key diagnosis findings**

- **Vision does NOT feed the lead-score ranking.** `getOutreachLeads` (`db/index.ts`)
  scores from `psi_json` + `signals_json` + owned fields; `gapCount` is already `null`.
  Vision only feeds the compose pitch + signal upgrades + the inspector. ⟹ gating vision
  leaves the queue order **byte-identical** (answers open-q 2).
- **Freshness-storm trap.** `isAnalysisFresh` required `visionJson`; skipping vision would
  re-enqueue the lead on every future scrape (worse than the spend cut). Fixed by a
  persisted "gated = complete" marker.
- **Three entry paths share one async queue** ⟹ intent persisted on the row, not inferred.

**Gate shape (option c).** Cheap signals (render/PSI/signatures) run for everyone. The paid
Gemini vision call fires only when: `force_vision=1` (operator/batch/scripts) **OR**
`outreach_status` already set (operator acted) **OR** the lead's **email-lane LeadScore grade
≥ `VISION_MIN_GRADE`** (default **B**). The gate reuses `computeLeadScore` with pre-vision
signals only (owned fields + the in-run PSI + ad-intent from the just-detected signals;
`gapCount: null` — same inputs `getOutreachLeads` ranks on), so no chicken-and-egg.

**Changes** (all additive; no destructive migration):

- `db/schema.ts` + `db/index.ts` col-add — `force_vision`, `vision_gated` on `premium_analyses`.
- `settingsRegistry.ts` — `VISION_MIN_GRADE` enum (A/B/C/D, default B; D = gate off). Auto-rendered in Settings.
- `db/premium.ts` — `enqueuePremiumAnalysis(id, forceVision)` (set/upgrade col), `createPremiumAnalysisRunning(id, forceVision)`, `completePremiumAnalysis` writes `vision_gated`, `isAnalysisFresh` treats `vision_gated=1` as complete.
- `db/index.ts` — `getVisionGateContext(businessId)` (reuses `parseEmails`/`pickBestCachedEmail`/`resolveValidity`/`getEmailValidityMany`).
- `premiumAnalyzer.ts` — `gradeAtLeast` + `shouldRunVisionByGate`; wrap the vision block in the gate; persist `vision_gated`.
- Callers — `requestPremiumAnalysis` (manual route) and `batchOrchestrator` force vision; batch also treats a `vision_gated` latest row as stale so the forced re-run actually fires vision; dev gate scripts force vision.

Step 1 — gate auto-analyze on grade (cheap signals still collected, no vision row for a low lead). ✓
Step 2 — on-demand vision when a gated lead is promoted (manual analyze / batch). ✓

## Verification gate

_Live evidence from `src/scripts/visionGateGate.ts` (server container), 2026-06-29._

- [x] **Ledger: vision spend is the dominant line and the gate scopes it.** Ledger at run
      time: `vision = 669 calls, $0.886` of `$1.4991` all-Gemini = **59%** (matches the slice's
      61% F1 finding). Grade histogram of the 361 has-website eligible leads:
      `{A:81, B:112, C:84, D:84}` ⟹ **C+D = 168 (46.5%)** now skip vision on the auto path
      (and the never-composed share is larger still). Default bar = grade B.
- [x] **A below-threshold lead completes analysis with no `vision` ledger row.** "Estudio
      America" (grade **D**): `render ok 16s → psi score=68 → [vision] gated (below grade bar,
      not promoted)`. Result `visionGated=true, hasVision=false`, **0 vision ledger rows for the
      lead**, est cost **$0.0000**. Cheap signals collected; zero Gemini spend.
- [x] **A promoted lead gets exactly one on-demand vision call before compose.** Same lead via
      the FORCE path: `visionGated=false`, `vision call #1 … ~$0.0014`, global vision ledger
      **667 → 668 (+1)**, `$0.8833 → $0.8846`. Exactly one call; `vision_json` then populated, so
      the subsequent compose reads it.
- [x] **The bar is a bar, not an off-switch.** "Blackbook Properties" (grade **A**) via the AUTO
      path (force=false): `visionGated=false`, vision ran, `hasVision=true`.
- [x] **Lead-score ranking unchanged.** `getOutreachLeads` never reads `vision_json`
      (`db/index.ts` selects `psi_json`+`signals_json`; `gapCount` is `null`). The grade
      histogram above was produced by `getOutreachLeads` post-change. `leadScore.test.ts` green.
- [x] **`npx tsc --noEmit` clean** (server, in container) after every phase.
- [x] `GATE PASS ✓` from `visionGateGate.ts`.

## Completion record

- Commit SHAs: _(feat SHA recorded in the follow-up docs commit, per repo convention)_
- What changed: Added a lead-score cost gate on the Gemini **vision** call. Cheap signals
  (render/PSI/signatures) still run on every analyzed lead; vision now fires only for
  forced (operator manual-analyze / batch prepare / dev gates), already-promoted
  (`outreach_status` set), or above-bar leads (email-lane LeadScore grade ≥
  `VISION_MIN_GRADE`, default B). Two additive `premium_analyses` columns: `force_vision`
  (input intent, persisted so the async worker honors it) and `vision_gated` (output fact,
  counted as COMPLETE by `isAnalysisFresh` to stop a re-render storm). New
  `VISION_MIN_GRADE` setting (live-tunable, auto-rendered). New `getVisionGateContext`
  reuses the existing email-lane scoring inputs. `getVisionGateContext` +
  `shouldRunVisionByGate` reuse `computeLeadScore` — no second scoring signal. Batch
  staleness treats a gated row as stale so a prepared lead re-runs with vision.
  Verification gate `src/scripts/visionGateGate.ts` added.
- Follow-ups / new parked items:
  - **Vision-on-NIM** (free multimodal provider) remains the separate larger lever — gating
    is the cheaper win shipped here.
  - The gate recomputes the email-lane grade from the in-run PSI, which can differ from the
    queue's grade (queue uses the last persisted PSI). Only matters within ~0.12 of the B
    boundary; if it ever bites, persist a `lead_grade` column and read it in both places.
  - `VISION_MIN_GRADE` default B is the calibration knob — retune from real reply data once
    enough sends accrue (same note as `leadScore.ts`).
