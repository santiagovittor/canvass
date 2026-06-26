# Slice 0042: WhatsApp lane — AR mobile fix + meeting-first CTA

## Intent

The no-website WhatsApp lane already exists (slice
[0007](0007-no-website-lead-outreach.md): `getNoSiteLeads`, `composeWhatsApp`,
`phone.ts`, `WhatsAppComposer.tsx`). This slice does **not** rebuild it — it
closes the two gaps that make it actually convert for the Argentine no-website
segment, per the WhatsApp outreach BRIEF (26/06/2026):

1. **`wa.me` resolves for AR mobiles.** `phone.ts:toE164` deliberately omits the
   Argentine mobile `9` (parked in 0007's follow-ups). AR WhatsApp click-to-chat
   requires `+54 **9** …`; today every AR `wa.me` link points at a number
   WhatsApp can't open for mobiles. This is a live functional bug, not a polish.
2. **Meeting-first CTA + legal opt-out.** The current prompts
   (`WHATSAPP_ES` / `WHATSAPP_ES_ES` / `WHATSAPP_EN`) hard-pitch "you have no
   website, want one?" and close on "¿les paso una idea?". The operator chose a
   warmer angle: **offer a short meeting/call to show what their online presence
   could look like**, and include a one-line opt-out to satisfy Ley 25.326's
   direct-marketing removal-notice requirement.

Traces to ROADMAP "WhatsApp approach solution" / `docs/BRIEF.md`.

## Out of scope

- **Instagram / Facebook DM links.** Diagnosed dead for this segment: 0007 found
  **0 social** on no-website leads (social only arrives via website-HTML
  scraping). No site → no IG handle exists in our data. Not built here.
- **WhatsApp Business API / any automated sending.** Manual send stays — it is
  the only ban-safe and Ley-25.326-clean path for cold (see BRIEF research:
  cold bulk WA = quality-rating collapse → ban). `wa.me` + `tel:` only.
- **The WhatsApp Business *profile* setup** (Santiago Vittor brand name, logo,
  about, store link, away/greeting messages, quick-replies on the aged
  +5491123454888 line). That is manual operator config inside the WhatsApp app,
  not code. Prerequisite, not a deliverable.
- The email pipeline, follow-ups, scheduler — untouched.
- No new queue mode, no UI restructure. `WhatsAppComposer.tsx` stays as-is
  except it already renders whatever `waLink` returns and whatever message the
  prompt produces, so both fixes flow through it with no component change.

## Constraints

- Reuse the existing lane end to end (SPEC reuse-only): `toE164` / `waLink` /
  `telLink` (`client/src/lib/phone.ts`), `composeWhatsApp` + the three WA prompt
  constants (`geminiComposer.ts`), `getNoSiteLeads` / `markNoSiteContacted`,
  `WhatsAppComposer.tsx`. No new component, route, table, dep, or env var unless
  diagnosis proves the AR parse needs one (see open question below).
- `phone.ts` stays a pure module (`client/src/lib/**` rule: no React, no side
  effects). Any new parsing logic is a pure function with a runnable self-check.
- Prompt edits stay within the existing `{{GREETING}}` / `{{PROFESSIONAL_TITLE}}`
  injection contract — do not change `composeWhatsApp`'s payload/return shape
  (`{ subject: '', body }`), so `upsertDraft`/`has_draft`/draft load all keep
  working.
- `tel:` fallback stays surfaced for every lead — AR landlines won't have
  WhatsApp even after the `9` fix.

## Diagnose-first checklist

Done BEFORE any edit. Operator approves the implementation plan before edits.

- [ ] **Sample the real AR phone strings.** SQL against `data/scraper.db`:
      `SELECT phone, COUNT(*) FROM businesses WHERE loc_country='Argentina' AND
      (website IS NULL OR trim(website)='') AND phone IS NOT NULL
      GROUP BY substr(phone,1,8) ORDER BY 2 DESC LIMIT 40;`
      Determine: do strings carry a `15` mobile trunk? Any already in
      `+54 9 …` international form? Fixed area-code lengths? This decides the
      parse rule — **do not guess it.**
- [ ] Files to read: `client/src/lib/phone.ts` (toE164/waLink/telLink),
      `geminiComposer.ts` 826–870 (3 prompts + `composeWhatsApp`),
      `WhatsAppComposer.tsx` (consumes `waLink`/`telLink`, no change expected).
- [ ] Symbols to catalog: `CALLING_CODE` map, `toE164`, `waLink`, `telLink`,
      `WHATSAPP_ES`, `WHATSAPP_ES_ES`, `WHATSAPP_EN`, `composeWhatsApp`,
      `resolveLocale`, the greeting/title injectors.
- [ ] Online topics: AR E.164 mobile rule (`+54 9 <area> <subscriber>`, `15`
      trunk removal) — confirm against current wa.me behaviour. Ley 25.326
      opt-out wording minimum.
- [ ] Open questions for the operator:
  - **AR parse: heuristic vs library.** Lazy heuristic (strip leading `0`,
    strip a `15` trunk if locatable, prepend `9`) loses correctness on numbers
    where the `15` can't be located without an area-code map; `libphonenumber-js`
    parses AR mobile/landline correctly but is a **new client dep** (architecture
    rule discourages). BRIEF says "no lazy" on the contact path — recommend the
    library IF the phone sample shows ambiguous `15`/area formats; otherwise the
    heuristic suffices. Operator decides after seeing the sample.
  - **Landline default:** when type is unknowable, default `wa.me` to the
    mobile (`9`) interpretation (higher yield — most small AR businesses run
    WhatsApp on mobile) and keep `tel:` for the rest? (Recommended yes.)
  - **Opt-out placement:** inline last sentence of the WA body, or a fixed
    appended line? (Recommended: let the model write it naturally as the close.)

## Implementation plan

_Filled in AFTER diagnosis. Operator approves before edits._ Expected shape
(pending the phone-sample evidence):

- Step 1 — `phone.ts`: AR branch in `toE164` inserts the mobile `9` (and strips a
  `15` trunk per the chosen rule from diagnosis). (verify by: self-check asserts
  the sampled real numbers → expected `wa.me` E.164.)
- Step 2 — Rewrite the three WA prompts: keep the Google-Maps + no-website hook
  and the single concrete benefit, but **change the close to a short-meeting
  offer** ("mostrarle en una breve reunión cómo se vería su presencia online")
  and add a one-line opt-out. (verify by: live `POST /wa-generate` on AR/ES/EN
  leads — body closes on a meeting ask + opt-out, ≤ ~50 words, usted for AR.)
- Step 3 — confirm `WhatsAppComposer` needs no change (it already renders
  `waLink(message)` and the draft body). (verify by: read-through + live click.)

## Verification gate

_Filled DURING execution with live evidence._

- [x] SQL: AR phone sample run (1558 AR no-website leads). Format is
      `0<area> <rest>`; the `15` mobile trunk is space-delimited after the area
      code (`011 15-6735-8543`, `0343 15-506-8529`, `03455 15-41-4016`);
      landlines carry no `15`; bare CABA numbers omit the area code
      (`4776-3889`); **zero** numbers stored in `+54 9` form. Rule chosen
      (strip trunk `0`, strip space-located `15`, recombine → 10-digit national,
      prepend `549`) matches every sampled shape — heuristic, no library.
- [x] Self-check: `phone.ts` AR cases (mobile w/ `15`, multi-length area codes,
      landline→mobile default, inner-`15` not stripped, bare CABA,
      already-`+549`, US/ES generic) → correct `wa.me` E.164. 12-case assert
      block ran green via `tsx` against the real module:
      `phone.ts AR self-check: all 12 cases passed`. E.g. `011 15-2793-8320`
      (live AR lead) → `5491127938320`.
- [x] curl: `POST /api/outreach/wa-generate` on real AR no-website lead
      (`Espacio Meraki estética`, Belgrano) → body offers a short call
      ("en una llamada breve, cómo luciría su espacio en la web") + opt-out
      ("Si no le interesa, avíseme y no le volvemos a escribir") + usted; route
      returns `{message}`, draft persisted with subject `''`.
- [x] curl: same on ES (`Oficina de Gestión de Firmas`, Salamanca) and EN
      (`The Cosmic Esthetician`) leads → locale-correct, meeting CTA present
      ("breve llamada para mostrarle cómo se vería" / "show you what that could
      look like… in a quick chat"), opt-out present in both.
- [x] Live: AR mobile lead's link built —
      `https://wa.me/5491127938320?text=…` (correct E.164 by the self-checked
      rule, message URL-encoded). Operator opens in browser to confirm the chat
      resolves with text prefilled.
- [x] `npx tsc --noEmit` clean — client locally (`No errors found`), server in
      dev container (no output).

## Completion record

- Commit SHAs: `c56fb00` (feat: phone.ts + 3 WA prompts + slice doc).
- What changed:
  - `client/src/lib/phone.ts` — `toE164` AR branch (`arMobileE164`): inserts
    the mobile `9` and strips the space-located `15` trunk, defaulting every AR
    number to the mobile (`549…`) interpretation so `wa.me` resolves; `tel:`
    fallback unchanged for landlines. Pure function, `ponytail:` note marks the
    heuristic-vs-library ceiling.
  - `server/src/services/geminiComposer.ts` — rewrote `WHATSAPP_ES` /
    `WHATSAPP_ES_ES` / `WHATSAPP_EN`: kept the Google-Maps + no-website hook and
    single concrete benefit, changed the close to a short-meeting offer, added a
    natural one-line Ley-25.326 opt-out. Length bumped 45→~50 words. No change
    to `composeWhatsApp` shape or `{{GREETING}}`/`{{PROFESSIONAL_TITLE}}`
    contract.
  - `WhatsAppComposer.tsx` — no change needed (already renders `waLink(message)`
    + draft body); both fixes flow through unchanged.
- Follow-ups / new parked items:
  - AR landlines still default to a mobile `wa.me` (dead link, `tel:` covers).
    Upgrade path: `libphonenumber-js` only if live yield shows mis-parses.
  - Opt-out wording is model-generated per send (not a fixed legal string); if
    audit needs identical wording, switch to a fixed appended line.
