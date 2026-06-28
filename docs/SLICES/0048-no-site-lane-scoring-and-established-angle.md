# Slice 0048: No-Site Lane Scoring + "Established, No Website" Angle

## Intent

Rank the no-website lane — the biggest, cheapest, fully-untapped pool — and lead
its message with the provable hook. Diagnosis `0043` found the no-site lane is
**1,630** leads (**1,292** phone-reachable, 3× the email pool) yet sorted purely
by scrape recency (`getNoSiteLeads`, `db/index.ts:790`), with **177** untouched
leads that are phone-reachable, rated ≥ 4.3, and have ≥ 50 reviews — established,
popular businesses with **no website at all** (**F2**, **F7**). The top no-site
categories by review volume are bookable service businesses (Restaurante avg
**680** reviews, Cafetería, Bar, Veterinario, Peluquería). This slice sorts the
WhatsApp lane by `computeLeadScore(., 'nosite')` and feeds the establishment hook
("you have 400+ reviews and no website yet") into the WhatsApp composer.
Recommended slice #4.

**Project vocabulary (one line).** Change `getNoSiteLeads` (`db/index.ts:768`)
from `ORDER BY b.scraped_at DESC` to load-all → `computeLeadScore(row, 'nosite')`
→ sort desc → paginate (mirroring 0045), surface the grade in the no-site queue,
and pass `reviewCount`/`rating` emphasis into `composeWhatsApp` so the opener
anchors on established demand.

## Out of scope

- The scoring math (**0044**) and the email-lane re-sort (**0045**) — this is the
  no-site twin; reuse the same primitive with `lane: 'nosite'`.
- The WhatsApp send mechanics, `wa.me` AR mobile fix, opt-out copy — slice
  **0042** owns those. This slice changes **ordering** + the **opener anchor**,
  not the send path.
- Email/social enrichment for no-site leads — **F10**: they have zero socials;
  phone/WhatsApp only. Do not add social scraping here.

## Constraints

- **Reuse `computeLeadScore` (0044)** with the `nosite` weighting (establishment-
  heavy, phone as a 0/1 reachability gate).
- **Reuse `composeWhatsApp`** (`geminiComposer.ts:867+`, `WHATSAPP_ES/EN`) — adjust
  the opener guidance/inputs, do not fork the composer.
- **Eligibility unchanged** — keep `getNoSiteLeads`'s conditions
  (`db/index.ts:770-780`: no website, has phone, `outreach_status IS NULL`).
- **Quality tradeoff to honor (F7).** Pure review-count ranking buries the ~1,800
  leads with 0–9 reviews, some of which are brand-new businesses who may want a
  first site most. The `nosite` score must keep a floor for low-review leads (via
  the `categoryFit` + `weightedRating` components) so startups are ranked low, not
  excluded. **Do not add a hard review-count cutoff.** State this in the PR.
- **Additive only**, **tsc clean gate**.

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/db/index.ts:768-825` — `getNoSiteLeads` (the function changed).
  - `server/src/services/leadScore.ts` (0044) — `computeLeadScore(., 'nosite')`.
  - `server/src/services/geminiComposer.ts:819-925` — `composeWhatsApp`,
    `WHATSAPP_ES/EN`, the `BusinessForEmail`-style input (already receives
    `rating`, `reviewCount`).
  - `server/src/routes/outreachQueue.ts:71-113` — `/no-site-leads`,
    `/wa-generate`, `/wa-contacted`.
  - `client/src/components/Outreach/` — the no-site queue component (grade chip,
    mirror 0045).
- [ ] Symbols to catalog: `getNoSiteLeads` `{ rows, total }`, `composeWhatsApp`
  input fields, `markNoSiteContacted`.
- [ ] Online topics: none (0043 research covers no-website SMB value).
- [ ] Open questions: should the no-site lane become the **primary** daily volume
  lane (it's 3× and cheaper), or stay secondary to email? (0043 open question 2.)

## Implementation plan

_Approved before edits._

- **Step 1 — Re-sort `getNoSiteLeads`** exactly as 0045 did for the email lane:
  drop SQL `LIMIT/OFFSET`, score each row with `lane: 'nosite'`, sort score-desc
  (tie-break scraped_at-desc), paginate in TS. Phone is guaranteed present by the
  query, so the reachability gate is effectively 1; ranking is establishment ×
  weightedRating × categoryFit. *(verify: page-1 top = high-review service
  business, e.g. the 680-review restaurant, not the newest scrape.)*
  - `// ponytail: same load-all-then-sort ceiling as 0045 (~1.3k rows, fine).`
- **Step 2 — Grade chip** in the no-site queue (reuse the 0045 chip component).
  *(verify: screenshot.)*
- **Step 3 — Establishment-anchored opener.** Pass an explicit
  `establishmentHint` (e.g. `reviewCount` band) into `composeWhatsApp` and adjust
  `WHATSAPP_ES/EN` so the opener can anchor on provable demand: "tiene 400 reseñas
  y todavía no tiene sitio web" — concrete, true, non-generic. Keep the meeting-
  first CTA + opt-out from slice 0042 intact. *(verify: generate 3 no-site WA
  drafts → opener cites the review count; CTA/opt-out unchanged.)*
- **Step 4 — Low-review floor check.** Confirm a 0-review no-site lead still
  ranks (low, not absent). *(verify: it appears on a later page, not dropped.)*

## Verification gate

_Filled DURING execution (2026-06-27)._

- [x] SQL/log: `GET /api/outreach/no-site-leads?page=1` top rows are highest
      `score` (total=1292). Page-1 top:

      name                                  | category    | grade | score | reviewCount
      FULCO & ASOCIADOS Estudio Jurídico    | Bufete      | A     | 0.911 | 158
      Renzo Gutierrez ... Abogados          | Bufete      | A     | 0.909 | 166
      DTLA Smile                            | Dentist     | A     | 0.901 | 160
      Panchos Coquito                       | Restaurante | A     | 0.888 | 5255
      Estudio Jurídico LB                   | Abogado     | A     | 0.885 | 113
      ...
      Dopo Café Palermo Soho                | Cafetería   | A     | 0.881 | 622
      Los Pinos                             | Restaurante | A     | 0.876 | 3305

      Sorted strictly score-desc (was `scraped_at DESC`).
- [x] Screenshot: `Sin sitio · WhatsApp` queue (1292) renders an **A** grade chip
      on every row, in score order. The literal "600+-review restaurant at #1"
      did NOT hold — top-tier categories (legal/dental/medical, `categoryFit`=1.0)
      out-rank the bigger-review restaurants because score = establishment·0.45 +
      weightedRating·0.30 + categoryFit·0.25 (0044 math, out of scope here). The
      high-review service businesses still rank **A** right behind (Panchos 5255 at
      #4, Dopo Café 622, Los Pinos 3305) — the intent (establishment surfaced over
      scrape-recency) is met.
- [x] Live: 3 `POST /api/outreach/wa-generate` drafts anchor the opener on the
      review-count band, all conservative-true, CTA + opt-out intact:
      - Dopo Café (622) → "Con más de 600 reseñas ... no tienen sitio web"
      - Veterinaria Daniela (1131) → "con 1100+ reseñas, aún no tienen web"
      - Panchos Coquito (5255) → "noté sus más de 5200 reseñas pero aún sin web"
      Each ends with the meeting/demo CTA ("cómo se vería ... online") + the
      slice-0042 opt-out ("si no le interesa, avíseme y no le vuelvo a escribir").
- [x] Floor: a 0-review no-site lead is present, low rank, not excluded — e.g.
      `Estudio Impositivo Contable SAE` (grade D, score 0.319, reviewCount 0) on the
      last page. Its WA draft (band=null) opens WITHOUT citing reviews
      ("noté que aún no tienen un sitio web") — F7 honored, no hard cutoff, no
      fabricated demand for startups.
- [x] `npx tsc --noEmit` clean — server container (after P1 + P3) and client
      container (after P2).

## Completion record

- Commit SHAs: _pending (recorded in follow-up commit)._
- What changed:
  - `server/src/db/index.ts` — `getNoSiteLeads` re-sorted exactly like 0045's email
    lane: dropped SQL `LIMIT/OFFSET`, load all eligible rows, score each with
    `computeLeadScore(row, 'nosite')`, stable sort score-desc (scraped_at-desc
    tie-break via the SQL order), paginate in TS. Rows now carry `score`/`grade`.
  - `server/src/services/geminiComposer.ts` — added `establishmentHintBand()`
    (floor reviewCount to a clean band: ≥100→nearest 100, [50,100)→50, <50→null) and
    passed `establishmentHint` into `composeWhatsApp`'s payload. Added one rule to
    each of `WHATSAPP_ES`/`WHATSAPP_ES_ES`/`WHATSAPP_EN`: when the hint is a number,
    anchor the opener on "<band>+ reseñas y todavía sin web"; when null, use the
    generic no-website hook (so startups aren't pitched a demand they lack).
  - `client/src/components/Outreach/LeadQueue.tsx` — widened the 0045 grade-chip
    gate from `mode === 'new'` to also cover `mode === 'no-site'`.
  - Quality tradeoff honored (F7): no hard review-count cutoff; 0-review leads still
    rank (grade D) and get a review-free opener. The `nosite` weights and the band
    thresholds are the calibration knobs — retune from real reply data.
- Follow-ups: decide primary-vs-secondary lane priority (open question); consider
  a "new business / no reviews yet" sub-bucket with its own first-site angle.
