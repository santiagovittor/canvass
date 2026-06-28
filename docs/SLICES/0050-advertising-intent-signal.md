# Slice 0050: Advertising-Intent Signal (ad-tech detection)

## Intent

Boost leads that already pay to acquire customers — a business spending on ads is
self-identifying as a willing buyer of marketing/web/AI services, the highest-
intent firmographic signal available for cold SMB outreach (2026 research, 0043
**F8**). The diagnosis recommended Meta Ad Library (roadmap `0010`) as the source.
**Investigation result (do not relitigate): the Meta Ad Library *API* cannot
deliver this for Argentina.** Outside the EU/UK the API returns only political /
social-issue ads; broad commercial-ad data sits behind the CASD-gated Content
Library (~$371/mo + $1,000 setup, academic/NGO/news affiliation only, as of Jan
2026). So the named API is a dead end for Buenos Aires SMBs.

Instead, derive the same "is-advertising" signal **for free from data we already
render**: a website carrying a **Meta Pixel, Google Ads/AdWords conversion tag, or
Google Tag Manager** is actively running paid acquisition. `premiumAnalyzer`
already renders each site and scans signatures (the analysis bundle already
reports `hasAnalytics`), so this is an owned-signal add with no API, no cost, and
no ToS risk — exactly the F8 "owned signals first" direction. This slice adds
ad-tech detection to the analyzer and an `advertisingIntent` boost to the
LeadScore. Recommended slice #7.

**Project vocabulary (one line).** Extend the `premiumAnalyzer` signature scan to
flag Meta Pixel / Google Ads / GTM presence, persist it in the existing
`premium_analyses` signals JSON, and add an `advertisingIntent` component to
`computeLeadScore` (0044) that boosts leads whose site runs ad pixels.

## Out of scope

- The Meta Ad Library API, the Content Library, and any paid ad-intelligence
  vendor — rejected above; **do not** build against them. (Re-evaluate only if the
  operator funds the CASD path or targets EU leads.)
- Scraping the public Ad Library web UI per business — ToS-gray, brittle,
  rate-limited; explicitly out of scope.
- The scoring composite (**0044**) structure — this slice adds one component +
  one input field; it does not restructure the weights beyond adding the term.
- No-site leads — no website to scan; their advertising intent is unobservable
  here (they may advertise on Instagram, but we have no socials for them — F10).

## Constraints

- **Owned-signal only (F8)** — no external API, no new dependency. Detection runs
  inside the existing render/signature scan.
- **Reuse `premiumAnalyzer`** — add signatures to the existing scan; do not add a
  second fetch/render of the site (SSRF + cost). The site is already rendered.
- **Reuse `computeLeadScore` (0044)** — add `advertisingIntent` as a new optional
  input + a modest additive component; absent data → neutral (graceful, like every
  other signal).
- **Additive only** — store the flags in the existing `premium_analyses`
  `signals_json` / `detected_sigs_json`; no new table required. If a top-level
  boolean is wanted on `businesses`, it's an additive column.
- **tsc clean gate.**

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/services/premiumAnalyzer.ts` — the signature/signal scan; where
    `hasAnalytics` and `detected_sigs` are produced; confirm whether Meta Pixel /
    Google Ads / GTM are already among the scanned signatures.
  - `server/src/db/premium.ts` — `SignalMap`, `DetectedSig`, how signals persist.
  - `server/src/services/leadScore.ts` (0044) — add the `advertisingIntent`
    component.
  - `server/src/services/geminiComposer.ts:120-170` — optionally use the signal in
    `buildAnalysisGaps`/offer (a business already advertising is a strong fit for
    the AI-tool offer — ties to 0047).
  - `roadmap 0010` note + `docs/SLICES/0010` if created — record the API-rejection
    rationale so it isn't re-attempted.
- [ ] Symbols to catalog: existing signature keys (analytics, pixel?, gtm?,
  adwords/gtag-conversion?), `signalsJson` shape, `getCategoryBucket`.
- [ ] Online topics: confirm current Meta Pixel (`fbq(`, `connect.facebook.net/
  …/fbevents.js`), Google Ads (`gtag('config','AW-…')`, `googleadservices.com/
  pagead/conversion`), and GTM (`googletagmanager.com/gtm.js`) fingerprints
  (stable, but verify the 2026 snippets). **Re-confirm nothing about the Meta Ad
  Library API has changed for AR commercial ads before assuming it's still a dead
  end** (sources below).
- [ ] Open questions: should `advertisingIntent` only *boost* (never penalize
  non-advertisers), to avoid burying good leads who simply don't run pixels?
  (Default: boost-only, small weight.)

## Implementation plan

_Approved before edits._

- **Step 1 — Detect ad-tech in the scan.** In `premiumAnalyzer`, add signature
  matchers for Meta Pixel, Google Ads conversion/gtag, and GTM against the already-
  fetched HTML/network log; record `runsMetaPixel` / `runsGoogleAds` / `hasGtm`
  (and a derived `advertisingIntent: boolean`) into the existing signals JSON. No
  extra render. *(verify: a known advertiser's analysis shows the flags true; a
  static brochure site shows false.)*
- **Step 2 — Score component.** Add `advertisingIntent` to `LeadScoreInput` (0044)
  and a **boost-only** term in `computeLeadScore` (e.g. +0.10 to the email-lane
  score when true, 0 otherwise; never negative). Re-grade. *(verify: an advertiser
  lead's grade rises; a non-advertiser is unchanged, not lowered.)*
- **Step 3 — Wire into the queue read.** 0045's `getOutreachLeads` already reads
  the latest `premium_analyses`; surface the new flag into the score input.
  *(verify: queue moves a Meta-Pixel lead up; `score.components.advertisingIntent`
  is set.)*
- **Step 4 — (optional) Offer tie-in (0047).** When `advertisingIntent` is true,
  the offer may note ROI framing ("you're already paying for clicks — an AI
  assistant converts more of them"), still verifier-safe as a benefit. *(verify:
  generated copy stays within the verifier gate.)*

## Verification gate

_Filled DURING execution (2026-06-27, live against scraper.db + running stack)._

- [x] **Live detection — 4 real re-analyses (render + DOM + network), all flags from
      real markup, with correct true-negatives:**
      ```
      Blackbook Properties (condoblackbook.com)
        meta=PRESENT pixelId=3542489292692782 | gAds=UNKNOWN | gtm=PRESENT GTM-PZ2S43DL
      Varghese Summersett (versustexas.com)
        meta=PRESENT | gAds=PRESENT conversionId=AW-961787641 (dom:aw_id) | gtm=PRESENT
      Daspit Law Firm (daspitlaw.com)
        meta=PRESENT | gAds=PRESENT AW-10793683258 (network:doubleclick_pagead,dom:aw_id) | gtm=UNKNOWN
      Michael & Associates (zealousadvocate.com)
        meta=PRESENT | gAds=PRESENT AW-10789344381 (network:doubleclick_pagead,dom:aw_id) | gtm=UNKNOWN
      ```
      Static/non-advertiser case proven deterministically in `metaPixelSignalTest.ts`:
      a GA4-only brochure (`G-…` + google-analytics.com/g/collect) → hasGoogleAds /
      hasGtm / hasMetaPixel all UNKNOWN (the `G-` GA4 id is correctly NOT read as `AW-`).
- [x] **Score — boost-only, real grade flips.** Across the 361-lead email queue the
      +0.10 boost flipped 3 real leads up a band and lowered none:
      `Law Offices of Bill Knox 0.505 (C) → 0.605 (B)`,
      `Erica Diaz Team 0.476 (C) → 0.576 (B)`,
      `Kiosco El Preferido 0.315 (D) → 0.415 (C)`. Non-advertisers carry
      `components.advertisingIntent = 0` (identical to pre-slice). `leadScore.test.ts`
      asserts `advertiser = non-advertiser + 0.10`, never negative, grade never lower.
- [x] **curl `GET /api/outreach/leads?page=1`** (after server restart — tsx-watch
      misses bind-mount edits): advertisers carry `components.advertisingIntent = 0.1`
      and rank higher — `#1 Blackbook Properties A 0.933 (adInt 0.1)` outranks
      `#3 Byrne Real Estate A 0.880 (adInt 0)`. 234 advertisers (Meta Pixel) in DB,
      10 in the current email pool, first boosted advertiser ranks #1 of 361.
      (Note: surfaced as `lead.components.advertisingIntent`; `score` stays a number —
      not restructured into `score.components`, which would have broken the client.)
- [x] Doc: roadmap row `0010` flagged **rejected for AR (see 0050)**; the API-coverage
      rationale lives in this slice's Intent + Sources.
- [x] `npx tsc --noEmit` clean in the server container after every phase.

## Completion record

- Commit SHAs: _recorded in follow-up commit._
- What changed:
  - **`premiumAnalyzer.ts`** — new `detectGoogleAds` + `detectGtm` (mirror
    `detectMetaPixel`); `detectSignals` now writes `hasGoogleAds` / `hasGtm` beside the
    existing `hasMetaPixel`; both keys added to `RAW_FETCH_BOOLEAN_KEYS`. Meta Pixel was
    already a persisted owned signal — reused, not rebuilt.
  - **`leadScore.ts` / `leadScore.test.ts`** — optional `advertisingIntent?: boolean` on
    `LeadScoreInput`; boost-only `+0.10` email-lane term (`AD_INTENT_BOOST`), recorded in
    `components.advertisingIntent`, clamped at 1.0; nosite lane untouched.
  - **`db/index.ts`** — `getOutreachLeads` gains a `signals_json` correlated subquery and
    `advertisingIntentOf()` (Meta Pixel OR Google Ads PRESENT); passes it into the score
    and exposes `components` on the lead row.
  - **`geminiComposer.ts`** — `buildAdIntentContext` appends a bias-only ROI framing hint
    to `{{OFFER_CONTEXT}}` when advertising; verifier-safe by construction (asserts no
    fact about their ads). Derived from the `signalMap` already in scope — no new plumbing.
  - **`metaPixelSignalTest.ts`** — extended with advertiser + GA4-brochure fixtures.
  - **`ROADMAP.md`** — row `0010` flagged rejected for AR.
- **Decision (reversible):** `advertisingIntent` triggers on **Meta Pixel OR Google Ads
  conversion only**. GTM is detected and stored (`hasGtm`) but is NOT a sole trigger —
  it sits on too many analytics-only sites to discriminate buyers, so triggering on it
  would fire on ~everyone and flatten the signal. One boolean in `advertisingIntentOf`
  reverses this if the operator wants GTM included.
- Follow-ups: revisit Meta Content Library only if the operator funds CASD access
  or targets EU leads; consider detecting more ad/CRM tags (HubSpot, TikTok pixel)
  as additional intent signals; the 234 existing Meta-Pixel rows will gain
  `hasGoogleAds`/`hasGtm` keys only as they are re-analyzed (TTL refresh / batch).

## Sources (API-coverage investigation)

- [Meta Ad Library Free API 2026: Quota, Fields, Limits — adlibrary.com](https://adlibrary.com/posts/meta-ad-library-free-api-2026)
- [Facebook Ad Library API: Complete Guide (2026) — adlibrary.com](https://adlibrary.com/guides/facebook-ad-library-api)
- [Meta Ad Library API — Facebook](https://www.facebook.com/ads/library/api)
- [Meta Ad Library tools — Transparency Center](https://transparency.meta.com/researchtools/ad-library-tools)
