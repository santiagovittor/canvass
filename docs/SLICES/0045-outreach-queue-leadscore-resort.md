# Slice 0045: Outreach Queue — LeadScore Re-sort (email lane)

## Intent

Replace the email queue's "newest scraped first" ordering with the composite
**LeadScore** from slice 0044, so the best opportunities sit at the top of the
Outreach queue instead of the most recent scrape. Surface the score as an A–D
grade per lead so the operator can see *why* a lead ranks high. Traces to
diagnosis `0043` findings **F1** (queue is `ORDER BY scraped_at DESC`, no scoring)
and **F9** (small, well-ranked sends are the reply-rate lever); recommended
slice #1.

**Project vocabulary (one line).** Change `getOutreachLeads`
(`db/index.ts:715`) from SQL `ORDER BY b.scraped_at DESC` + SQL pagination to:
load all eligible rows, compute `computeLeadScore(row, 'email')`, sort by score
desc (tie-break `scraped_at desc`), then paginate in TS; add `score` + `grade` to
the `OutreachLead` shape and render the grade chip in `LeadQueue.tsx`.

## Out of scope

- The scoring math itself — owned by **0044** (this slice only consumes
  `computeLeadScore`).
- Probing email validity / backfilling PSI — **0046** / **0049**. This slice
  ranks on whatever validity/PSI is already **cached**; unprobed → neutral. The
  ranking simply sharpens as those backfills land.
- The no-site lane — **0048** (same pattern, separate slice).
- Any filter behaviour change in `buildOutreachWhere` — eligibility is untouched;
  only ordering changes.

## Constraints

- **Reuse `computeLeadScore` (0044)** — do not inline scoring math here.
- **Additive only** — no new column, no migration. Score is computed on read.
  *(If profiling later shows the load-all sort is too slow, the upgrade is a
  materialized `lead_score` column refreshed on write — out of scope here.)*
- **Eligibility unchanged** — keep every condition in `buildOutreachWhere`
  (`db/index.ts:681-713`), including the slice 0029 active-scheduled-send
  exclusion. Only the `ORDER BY` + pagination strategy changes.
- **Validity read is cache-only** — the sort calls `resolveValidity` /
  `getEmailValidityMany` (already used at `db/index.ts:737`), never
  `verifyEmailDeliverable` (no network in the read path; probing is 0046's job).
- **UI rules** — the grade chip uses existing tokens (`globals.css`), JetBrains
  Mono for the letter, no new colors hardcoded; follows `.claude/rules/ui.md`.
- **tsc clean gate.**

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/db/index.ts:620-761` — `OutreachLead`, `RawLeadRow`,
    `buildOutreachWhere`, `getOutreachLeads` (the function being changed).
  - `server/src/services/leadScore.ts` (from 0044) — `computeLeadScore` signature.
  - `server/src/routes/outreachQueue.ts:45-60` — `/leads` route (passes through;
    likely no change beyond the response already carrying the new fields).
  - `client/src/lib/outreachApi.ts` — the `OutreachLead` client type + fetch.
  - `client/src/components/Outreach/LeadQueue.tsx` — where the row renders (add
    the grade chip; mirror the existing `has_draft` pencil-icon pattern).
- [ ] Symbols to catalog: `getOutreachLeads` return type `{ rows, total }`,
  `pickBestCachedEmail`, `resolveValidity`, `getEmailValidityMany`, the page size
  (25), the `gapCount` source for `visiblePain` (compute from
  `outreach_analysis_json` if present, else null → neutral).
- [ ] Online topics: none.
- [ ] Open questions: show the grade as a letter chip (A–D) only, or letter +
  numeric score on hover? (Default: letter chip, score in a `title`/tooltip.)

## Implementation plan

_Approved before edits._

- **Step 1 — Extend the row shape.** Add `score: number` and `grade: 'A'|'B'|'C'|'D'`
  to `OutreachLead` (`db/index.ts:620-653`). *(verify: tsc.)*
- **Step 2 — Re-sort `getOutreachLeads`.** Drop `LIMIT/OFFSET` from `leadsSQL`;
  select all eligible rows (count query unchanged). For each row build the
  `LeadScoreInput` (rating, reviewCount, category, `email_validity` from the
  existing `validityMap`, `hasPhone`, `psiMobile` from the latest
  `premium_analyses` PSI if cheaply joinable else null, `gapCount` from
  `outreach_analysis_json` if present else null), call `computeLeadScore(.,
  'email')`, attach `score`/`grade`. Sort by `score` desc, then `scraped_at` desc.
  `slice((page-1)*25, page*25)`. *(verify: SQL/log — top of page 1 is the highest
  score, not the newest `scraped_at`.)*
  - `// ponytail: load-all-then-sort is fine at ~425 eligible rows; if the
    eligible pool exceeds a few thousand, move to a materialized lead_score
    column ordered in SQL.`
- **Step 3 — PSI join (optional, cheap).** If joining latest PSI per business in
  one extra query is simple, include `psiMobile`; otherwise pass null (score
  degrades gracefully — 0049 backfill + a later wire-up can add it). Keep it lazy:
  don't N+1 query per row. *(verify: one extra query at most; tsc.)*
- **Step 4 — Surface the grade.** Add `score`/`grade` to the client `OutreachLead`
  type (`outreachApi.ts`); render a small grade chip in `LeadQueue.tsx` next to
  the name (letter in JetBrains Mono, neutral surface token, amber only for grade
  A to signal "top opportunity" — restrained, per ui.md). *(verify: screenshot —
  A-grade leads visibly sorted to top with a chip.)*

## Verification gate

_Filled DURING execution (live DB, server container `maps-scraper-server-1`)._

- [x] **Score-desc, not scraped_at-desc.** `getOutreachLeads(1,25)` over the live
      DB — top 5 `grade | score | scraped_at | name`:

      ```
      A  0.880  2026-06-25T16:56:02Z  Byrne Real Estate Group
      A  0.880  2026-06-25T16:53:47Z  54 Realty
      A  0.845  2026-06-25T16:55:02Z  Simi Lakhani Realtor at Keller Williams Classic Realty
      A  0.831  2026-06-25T16:56:02Z  The Mangin Team at Real Broker LLC ...
      A  0.814  2026-06-22T21:34:30Z  Estudio jurídico EOT | Abogados Previsionales en CABA
      ```

      Scores non-increasing across page 1: **true**. The OLD `ORDER BY scraped_at
      DESC` would have surfaced the 2026-06-26 scrapes first (e.g. "ESTUDIO JURÍDICO
      ACP"); row 1 now differs from the newest-scraped lead. Re-sort confirmed.

- [x] **curl** `GET /api/outreach/leads?page=1` → rows carry `score` + `grade`;
      `total=361` (eligibility clause byte-unchanged, so identical to pre-change).

- [x] **Screenshot (browser, live-verified).** Outreach → "Nuevos" at
      `http://localhost:5173`: the top of the queue shows seven amber `A` chips in
      score order (Byrne Real Estate Group, 54 Realty, Simi Lakhani, The Mangin
      Team, Estudio jurídico EOT, Real Estate of Florida, Florida Blue Realty) —
      same order + count (361) as the curl — then the first neutral (gray) `B` chip
      at "the ThinkLiveBe team", with more `B` chips below (Nude Aesthetics, Estudio
      Enzetti, Estudio HFA, SkinLocal, TruGlo Dental, neodental). Chip letters are
      JetBrains Mono; amber appears only on grade A, B/C/D stay neutral (ui.md). The
      native `title` score tooltip is present in the JSX but Chrome's native tooltip
      doesn't render into CDP screenshots. (Initial attempt was blocked by the
      extension being offline; re-run after the operator brought it up.)

- [x] **Regression (0029)** — `buildOutreachWhere` is untouched, including the
      `NOT EXISTS (… scheduled_sends … status IN ('scheduled','claimed','deferred'))`
      exclusion; `total` unchanged (361) confirms eligibility intact. Only the
      `ORDER BY` + pagination strategy changed.

- [x] **`npx tsc --noEmit` clean** — server container (`TSC_CLEAN`, after both type
      + re-sort edits) and client container (`TSC_CLEAN`, after type + chip edits).

## Completion record

- Commit SHAs: `14736b8` feat(outreach): rank email queue by LeadScore (slice 0045)
- What changed:
  - `server/src/db/index.ts` — `getOutreachLeads` now loads ALL eligible rows (SQL
    `LIMIT/OFFSET` dropped, `ORDER BY scraped_at DESC` kept as the tie-break),
    scores each via `computeLeadScore(., 'email')` (0044), stable-sorts by `score`
    desc, and paginates with `slice()` in TS. Added optional `score`/`grade` to the
    `OutreachLead` shape; imported `computeLeadScore` (pure → no runtime cycle:
    leadScore imports `EmailValidity` as a *type*). `psiMobile`/`gapCount` passed
    `null` (read path stays network-free; PSI cache is URL-keyed with JS TTL, not
    cheaply joinable — defers to 0049 + a later wire-up).
  - `client/src/lib/outreachApi.ts` — added optional `score`/`grade` to client
    `OutreachLead`.
  - `client/src/components/Outreach/LeadQueue.tsx` — grade chip beside the name in
    "Nuevos" mode (JetBrains Mono letter, amber only for A, neutral otherwise,
    numeric score in `title`). Reused existing tokens; no new globals/deps.
- Eligibility (`buildOutreachWhere`, incl. 0029 active-scheduled exclusion) and the
  count query are unchanged — only ordering/pagination changed.
- Follow-ups: wire `psiMobile` once 0049 backfill lands (then `gapCount` becomes
  meaningful too — `visiblePainScore` is neutral while PSI is null); consider a
  materialized `lead_score` column only if profiling demands it.
