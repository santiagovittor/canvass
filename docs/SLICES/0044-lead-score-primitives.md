# Slice 0044: Lead Score Primitives

## Intent

Build the deterministic scoring math the whole prioritization program rests on,
as one pure, testable module — `server/src/services/leadScore.ts` — with **no DB,
no HTTP, no UI**. It exposes per-signal scoring functions (establishment from
review count, Bayesian-weighted rating, category-fit, reachability, visible-site-
pain) and a single `computeLeadScore(input, lane)` composite that returns a 0–1
score, an A–D grade, and the component breakdown. Every consumer slice (0045
queue re-sort, 0048 no-site scoring) calls this module; none reimplements the
math. Traces to diagnosis `0043` findings **F1** (no scoring exists), **F5**
(rating noisy alone), and recommended slice #1/#6.

**Project vocabulary (one line).** Add a pure `leadScore.ts` exporting
`computeLeadScore(input: LeadScoreInput, lane: 'email' | 'nosite')` plus its
component functions, deterministic and side-effect-free, consumed by
`getOutreachLeads` / `getNoSiteLeads` in later slices.

## Out of scope

- Wiring the score into any query, route, or UI — that is slice **0045** (email
  lane) and **0048** (no-site lane).
- Persisting a score column or any migration — the score is computed on read.
- Probing email validity or backfilling PSI — slices **0046** / **0049**. This
  module only *consumes* whatever signal values it is handed; it never fetches.
- Tuning the final weights against real reply data — ships with calibrated
  defaults + a documented knob; retune is a follow-up once replies accumulate.

## Constraints

- **No side effects** — `leadScore.ts` is a `client/src/lib`-style pure module but
  lives server-side (it needs the `EmailValidity` type). No imports from `db/`,
  no Drizzle, no `fetch`, no Date.now in the scoring math (determinism).
- **tsc clean gate** — `npx tsc --noEmit` (server container) must pass.
- **Reuse-only registry** — does not touch the send path; no registry module is
  re-implemented. Import the `EmailValidity` type from `../db` (already exported,
  used by `emailVerifier.ts:6`).
- **Determinism** — same input ⇒ same score, always. This is what makes the queue
  order stable and explainable (open question 4 in 0043: show the grade).

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/services/emailVerifier.ts` — `EmailValidity` type + valid/unknown/
    invalid semantics (the reachability input).
  - `server/src/db/index.ts:620-665` — `OutreachLead` / `RawLeadRow` shape (the
    fields available to score: `rating`, `reviewCount`, `category`,
    `email_validity`, `phone`, `website`).
  - `geminiComposer.ts:120-170` (`buildAnalysisGaps`) — how `gapCount` is derived,
    so `visiblePainScore` blends PSI + gapCount consistently with the composer.
- [ ] Symbols to catalog: `EmailValidity` ('valid'|'unknown'|'invalid'),
  `PsiData.mobileScore`, the 26 category strings (legal/dental/realestate cluster
  vs bookable-service vs other — see 0043 §(a)/(f) for the real category names in
  the DB: `Abogado`, `Bufete`, `Servicios legales`, `Dentist`/`Dentista`,
  `Real estate agency`/`Agencia inmobiliaria`, `Peluquería`, `Veterinario`,
  `Gimnasio`, `Restaurante`, `Centro de estética`).
- [ ] Online topics: none new — calibration uses 0043's research (verified email
  = 2× reply ⇒ reachability is the heaviest email-lane weight).
- [ ] Open questions for the operator: confirm grade cutoffs are for display only
  (A ≥ 0.75 / B ≥ 0.55 / C ≥ 0.35 / D < 0.35) and that category-fit may treat
  legal/dental/real-estate as the top tier (matches both the inventory and the
  2026 AI-automation niche research).

## Implementation plan

_Approved by operator before edits._

- **Step 1 — Types.** Define `LeadScoreInput` (`rating`, `reviewCount`,
  `category`, `emailValidity: EmailValidity | null`, `hasPhone`,
  `psiMobile: number | null`, `gapCount: number | null`) and `LeadScoreResult`
  (`score: number` 0–1, `grade: 'A'|'B'|'C'|'D'`, `components: Record<string,
  number>`). *(verify by: `tsc` clean.)*
- **Step 2 — Component functions, each pure and individually exported:**
  - `establishmentScore(reviewCount)` — log-scaled:
    `clamp01(log10((reviewCount ?? 0) + 1) / log10(500))`. 0 reviews → 0, ~500+ →
    1. *(verify: 0→0, 49→~0.63, 500→1.)*
  - `weightedRating(rating, reviewCount)` — Bayesian shrinkage toward prior
    `C = 4.07` (the real DB mean, 0043 §b) with weight `m = 20`:
    `((m*C + n*R) / (m + n)) / 5`, returns `C/5` when rating null. Kills the
    720 low-review 5.0s (F5). *(verify: rating 5/n 2 ≈ 0.83, rating 4.6/n 400 ≈
    0.92.)*
  - `categoryFitScore(category)` — case-insensitive regex map: legal/dental/
    medical/real-estate → 1.0; bookable service (peluquer, veterinari, gimnas,
    restaur, estétic, café, bar, hotel) → 0.6; else 0.3; null/blank → 0.3.
  - `reachabilityScore(emailValidity, hasPhone, lane)` — email lane:
    valid 1.0 / unknown 0.5 / null(unprobed) 0.4 / invalid 0.0; nosite lane:
    `hasPhone ? 1.0 : 0.0`.
  - `visiblePainScore(psiMobile, gapCount)` — `psi` null → neutral 0.4; else
    `0.6 * clamp01((100 - psi) / 100) + 0.4 * clamp01((gapCount ?? 0) / 4)`.
    Lower PSI / more gaps ⇒ higher urgency.
- **Step 3 — Composite `computeLeadScore(input, lane)`** with per-lane weights:
  - email: reachability 0.40, visiblePain 0.20, establishment 0.20, categoryFit
    0.20.
  - nosite: establishment 0.45, weightedRating 0.30, categoryFit 0.25; then
    multiply by `reachabilityScore` as a 0/1 gate (no phone ⇒ score 0, drops out).
  - Missing signals contribute their neutral default (never zero the whole lead
    for one absent field — graceful degradation so 0045 can ship before 0046/0049
    land). Map to grade by the cutoffs above. Expose `components` for the UI.
  - `// ponytail: weights + category map are the calibration knob — retune from
    real reply data once 0039 analytics has enough sends.`
- **Step 4 — One runnable self-check** (`leadScore.test.ts`, plain `assert`, no
  framework): monotonicity (more reviews ⇒ ≥ establishment), the F5 case
  (5.0/n=2 ranks below 4.6/n=400), reachability ordering (valid > unknown >
  unprobed > invalid), graceful degradation (all-null input still yields a finite
  grade), determinism (same input twice ⇒ identical result). *(verify by: run the
  file under tsx in the server container; all asserts pass.)*

## Verification gate

_Filled DURING execution (server container `maps-scraper-server-1`)._

- [x] `tsx leadScore.test.ts` → all asserts pass. Covers worked examples
      (establishment 0→0 / 49→0.63 / 500→1; weightedRating 5·2→0.83 / 4.6·400→0.92),
      monotonicity, F5 (`weightedRating(5,2) < weightedRating(4.6,400)`),
      reachability ordering (valid > unknown > unprobed > invalid),
      nosite phone gate (0/1), visiblePain urgency, all-null graceful degradation,
      and determinism. Output:

      ```
      leadScore.test.ts: all asserts passed
      ```

- [x] Manual table — grades read sensibly (`computeLeadScore` over 6 inputs):

      ```
      A  0.814  email   680rev 4.2 Restaurante valid psi55 g2
      C  0.395  email   2rev 5.0 Restaurante unprobed
      A  0.945  email   400rev 4.6 Abogado valid psi40 g4
      C  0.422  email   120rev 4.1 Dentista invalid psi60 g1
      A  0.852  nosite  680rev 4.2 Restaurante nosite phone
      C  0.479  nosite  2rev 5.0 Restaurante nosite phone
      ```

      The 680-review 4.2 restaurant (A 0.814) outranks the 2-review 5.0 (C 0.395) on
      both lanes; the top-tier Abogado with a slow, gappy site + valid email scores
      highest (A 0.945); an invalid email drags the dentist down to C despite a
      top-tier category (reachability is the heaviest email-lane weight).

- [x] `npx tsc --noEmit` clean (server container) — `TSC_CLEAN`, ran after both
      steps 1–3 and step 4.

## Completion record

- Commit SHAs: `6ae4b8c` feat(outreach): lead score primitives (slice 0044)
- What changed: added pure, side-effect-free `server/src/services/leadScore.ts`
  (`computeLeadScore(input, lane)` + the five individually-exported component
  functions `establishmentScore` / `weightedRating` / `categoryFitScore` /
  `reachabilityScore` / `visiblePainScore`, plus `LeadScoreInput` / `LeadScoreResult`
  / `Grade` / `Lane` types). `EmailValidity` is a type-only import from `../db`, so
  no runtime DB/HTTP/Date dependency — determinism holds. Added
  `server/src/services/leadScore.test.ts` (plain `node:assert`, no framework).
  Nothing wired into queries/routes/UI yet — that is 0045 (email) / 0048 (nosite).
- Follow-ups / new parked items: weight retune after reply data accrues
  (`ponytail:` knob in `computeLeadScore`); consumers 0045 / 0048 import this module.
