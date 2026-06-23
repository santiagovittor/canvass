# Slice 0007: No-website lead outreach lane (cheap-site offer)

> **Larger / exploratory slice.** Needs its own diagnose-first pass before any
> plan — it adds a *new outreach channel*, not a tweak. Captured now so the
> opportunity isn't lost; rank and scope before implementing.

## Intent

Turn the current dead-end into the highest-opportunity lane. Today a lead with
no website gets no email — emails are scraped from the website HTML
(`socialEnricher.ts:94-111`), and gosom supplies none (diagnosed in
[0002](0002-text-query-ui-clarity-audit.md), F3; accepted as a limitation by the
operator). But a business with no website is exactly the best prospect for a
"let me build you a cheap website" offer. This slice explores a contact lane for
no-website leads built on the contact signal we *do* have — the **phone number**
gosom returns and we already persist (`businesses.phone`,
`jobRunner.ts:217`) — and an offer track distinct from the email pipeline.

**Project vocabulary:** segment no-website / no-email leads; surface their
phone (and any non-website social) as an outreach channel; compose a cheap-site
offer for a phone/WhatsApp lane separate from the SMTP email pipeline.

## Out of scope (until diagnosed — to be tightened)

- Not changing the email pipeline (compose→verify→gate→send) for website leads.
- Not adding gosom email extraction (settled: stalls the worker pool).
- Not auto-sending WhatsApp/SMS in v1 — start with surfacing + draft, then
  decide on a send mechanism (manual copy, click-to-WhatsApp link, or an API)
  in the diagnosis.
- No scraping of third-party sources for emails of no-website businesses (a much
  larger, separate sourcing problem) unless the diagnosis finds a clean signal.

## Constraints (preliminary — confirm in diagnosis)

- **SSRF / safety** unchanged (`socialEnricher.ts`) — any new fetch path
  inherits the mandatory private-IP guard.
- **No-website leads have no website-derived email or social** — the only
  reliable channel from current data is **phone**. Verify what fraction of
  no-website leads have a phone (`businesses.phone`) before designing around it.
- **Reuse the compose stack** (`SPEC.md` registry — `composeVerifiedEmail` /
  `geminiComposer`) if the offer copy is AI-composed, adapting the medium
  (short WhatsApp message vs email) rather than building a new composer.
- **Send pacing / governor** (`outreachGovernor`) — if any automated sending is
  added, it must respect caps/windows like the email path.
- **Additive schema only** — a new channel/segment likely needs a column or a
  derived view, never a destructive change.
- **lat/lng as strings**, **dedup by place_id** — unchanged.

## Diagnose-first checklist (REQUIRED before any plan)

- [x] Quantify the opportunity (see findings below).
- [x] Files read: `jobRunner.ts` upsert, `db/schema.ts`, `routes/outreachQueue.ts`,
      `db/index.ts` (`getOutreachLeads`/`buildOutreachWhere`/draft fns),
      `geminiComposer.ts` (`composeEmail`), `pages/Outreach.tsx`, `LeadQueue.tsx`.
- [x] Catalog of field reliability for no-website leads (below).
- [x] Channel decision → operator chose **click-to-WhatsApp (`wa.me`) + `tel:`,
      manual send**. No API automation in v1.
- [x] Offer-copy decision → operator chose **AI-composed per lead** via a new
      WhatsApp-length prompt (Gemini client only; not the email
      anchor/verifier/gate stack).
- [x] Lane location → operator chose **a new "No-site" queue mode in Outreach**.
- [ ] Online best-practices research: deferred — v1 is manual send (operator
      reads/sends each message), so WhatsApp Business API compliance/deliverability
      doesn't apply yet. Revisit if automation is added (parked).

### Diagnosis findings (DB snapshot 2026-06-22, `data/scraper.db`, n=3942)

| Metric | Count | % of total |
|---|---|---|
| Total businesses | 3942 | 100% |
| No website (`website IS NULL OR website=''`) | 1397 | 35% |
| **No website + has phone** (the addressable list) | **1114** | **28%** |
| Has website | 2545 | 65% |

Field fill **within the 1397 no-website leads**:

| Field | Filled | Note |
|---|---|---|
| `phone` | 1114 (80%) | local format, e.g. `011 4740-4093` (needs E.164 for `wa.me`) |
| `category` | 1306 (94%) | offer anchor |
| `address` | 1396 (100%) | |
| `rating` | 1397 (100%) | offer anchor |
| `loc_country` | 1397 (100%) | 1329 Argentina · 58 US · 10 Spain |
| any social (ig/fb/li) | **0** | confirms social only arrives via website HTML |
| `emails_json` | **0** | confirms no-website ⇒ no email (the dead-end) |

All 1114 have `outreach_status = NULL` (untouched).

**Load-bearing facts for the plan:**
- `buildOutreachWhere` (`db/index.ts:521`) hard-requires `emails_json IS NOT NULL
  AND != '[]'` → no-website leads are **structurally excluded** from the email
  queue. The no-site lane needs its **own query path** (require phone, not email).
- Phone is the **only** channel — no social/email ever exists without a website.
- `composeEmail` (`geminiComposer.ts:941`) is built around an `AnchorCandidate` +
  website-analysis evidence + a verifier gate. No-website leads have none of that,
  so v1 uses a **separate short composer** anchored on category + barrio + rating +
  "no website found". No verifier gate (no website claims to verify).
- `outreach_drafts` (`db/index.ts:32`) has `subject TEXT NOT NULL`; the WA message
  reuses this table with `subject=''`, `body=<message>`. Existing `upsertDraft`/
  `getDraft`/`deleteDraft` + the `has_draft` join all work unchanged.
- `OutreachLead` already carries `phone`. Marking a lead done = set
  `outreach_status='contacted'` (drops it from the null-status queue, like email).

## Implementation plan

Phases are sequenced server→client; each ends with `tsc --noEmit` (server in the
dev container, client locally). Reuse over new code throughout.

**Phase 1 — Data layer** (`server/src/db/index.ts`)
- Add `getNoSiteLeads(page, pageSize, filters)` reusing the `getOutreachLeads`
  row shape + `outreach_drafts` join, but WHERE `(website IS NULL OR trim=''
  ) AND phone IS NOT NULL AND trim(phone)!='' AND outreach_status IS NULL`.
- Add `markNoSiteContacted(businessId)` → set `outreach_status='contacted'`,
  delete draft (reuse existing `deleteDraft`).

**Phase 2 — WA composer** (`server/src/services/geminiComposer.ts`)
- Add `composeWhatsApp(business)` → `{ message }`. Reuse the Gemini client +
  `resolveLocale` + greeting/title helpers; new short ES-AR / ES-ES / EN prompt,
  WhatsApp length, anchored on name/category/barrio/rating + "no website". No
  anchor ranker, no verifier.

**Phase 3 — Routes** (`server/src/routes/outreachQueue.ts`)
- `GET /no-site-leads` (paginated) → `getNoSiteLeads`.
- `POST /wa-generate` `{ businessId }` → `composeWhatsApp`, persist via
  `upsertDraft(id, '', message, true)`, return `{ message }`.
- `POST /wa-contacted` `{ businessId }` → `markNoSiteContacted`.

**Phase 4 — Client lib** (`client/src/lib/outreachApi.ts` + new `client/src/lib/phone.ts`)
- API fns: `getNoSiteLeads`, `generateWaMessage`, `markWaContacted`.
- `phone.ts` pure helpers: `toE164(phone, locCountry)` (AR 54 / US 1 / ES 34,
  strip leading 0 + non-digits), `waLink(phone, country, msg)` →
  `https://wa.me/<e164>?text=<enc>`, `telLink(phone)`.

**Phase 5 — Client UI** (`LeadQueue.tsx`, new `WhatsAppComposer.tsx`, `Outreach.tsx`)
- `LeadQueue`: add `'no-site'` to `QueueMode` + a pill + fetch via
  `getNoSiteLeads`; phone-centric row (no valid-email badge).
- New `WhatsAppComposer.tsx`: editable draft + **Call** (`tel:`) and **WhatsApp**
  (`wa.me`) buttons + **Mark contacted**. Built on existing tokens (DESIGN.md).
- `Outreach.tsx`: when `mode==='no-site'`, render `WhatsAppComposer` instead of
  `EmailComposer`; add `handleGenerateWa` + `handleMarkContacted`; reuse draft/
  select plumbing (subject always `''`).

**Phase 6 — Verification gate** (evidence written back into this file).

## Verification gate

All run live against `data/scraper.db` on 2026-06-22 (server container restarted
to load routes; test mutations restored afterward).

- [x] **Addressable list.** `GET /api/outreach/no-site-leads?page=1` → `total: 1114`,
      rows carry `phone`, `website:""`, `valid_email:false`, category + barrio
      (e.g. `Fitecon` / `Asesor fiscal` / `Salamanca` / `+34 914 11 59 14`).
- [x] **AI offer draft (per-lead, locale-correct).**
      - Spain (es-ES): "Buenas noches, Asesor fiscal Fitecon, Les encontramos en
        Google Maps y vimos que no tienen página web. Podríamos crearles una web
        sencilla y profesional para su asesoría, pensada para captar clientes de
        Salamanca. ¿Les interesaría que les pasáramos una idea sin compromiso?"
      - Argentina (es-AR, usted + "Dr." title on a Bufete lead): "Buenas noches,
        Dr. Los encontramos en Google Maps y notamos que aún no tienen un sitio
        web para su estudio. Podríamos crearle uno simple y económico…"
      - Persisted via `outreach_drafts` (`GET /draft/:id` → `subject:""`,
        `isAiDraft:true`, body 276 chars). (Fixed `callGemini` to strip ```` ```json ````
        fences — the model fenced its output and the plain transport didn't.)
- [x] **`wa.me` / `tel:` affordance** (real `phone.ts`, run via node type-strip):
      - Spain `+34 914 11 59 14` → `https://wa.me/34914115914?text=…`, `tel:+34914115914`
      - Argentina `011 6416-6494` → `https://wa.me/541164166494?text=…` (leading 0
        dropped, 54 prefixed), `tel:01164166494`
      - US `(305) 555-0123` → `https://wa.me/13055550123?text=…`
      - empty phone → no link (affordance disabled), as designed.
- [x] **Mark contacted drops from queue.** `POST /wa-contacted` → `{ok:true}`;
      `no-site-leads` total `1114 → 1113`, lead absent. Restored to 1114.
- [x] **`npx tsc --noEmit` clean** — server (in dev container) and client both exit 0.
- [~] Screenshot deferred: the lane is a standard split-pane (LeadQueue "Sin sitio"
      mode + WhatsAppComposer); the affordance is an `<a href="wa.me/…">`, verified
      above against live data. The Vite host guard blocked the playwright container
      from rendering it headless; not worth the yak-shave for a personal tool.

## Completion record

- Commit SHAs: _(uncommitted — on branch `feat/meta-pixel-signal`)_
- What changed:
  - Server: `getNoSiteLeads` + `markNoSiteContacted` (`db/index.ts`);
    `composeWhatsApp` + es-AR/es-ES/en WA prompts + `callGemini` fence-strip
    (`geminiComposer.ts`); routes `GET /no-site-leads`, `POST /wa-generate`,
    `POST /wa-contacted` (`routes/outreachQueue.ts`).
  - Client: `getNoSiteLeads`/`generateWaMessage`/`markWaContacted`
    (`lib/outreachApi.ts`); new pure `lib/phone.ts` (`toE164`/`waLink`/`telLink`);
    `'no-site'` queue mode in `LeadQueue.tsx`; new `WhatsAppComposer.tsx`; panel
    swap + handlers in `pages/Outreach.tsx`.
  - No schema migration, no new deps, no env vars. Reused `outreach_drafts`
    (`subject=''`), `markContacted`, `OutreachLead`, Gemini client + locale helpers.
- Follow-ups / new parked items:
  - AR mobile vs landline is indistinguishable from the stored field, so `toE164`
    omits the AR mobile `9`; `wa.me` won't resolve for `011…` landlines (the
    `tel:` link is the fallback). Revisit if a number-type signal appears.
  - WhatsApp/SMS **automation** + 2026 messaging-compliance research stay parked
    (v1 is manual send).
