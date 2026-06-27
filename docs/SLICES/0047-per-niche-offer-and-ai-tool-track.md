# Slice 0047: Per-Niche Offer + Un-gate the AI-Tool Track

## Intent

Fix the operator's headline symptom: the offer is generic and the "I can build
you a custom AI tool for whatever you need" pitch is essentially never said.
Diagnosis `0043` (**F3**) found the composer carries exactly **one** fixed AI
product (a 24-hour chat assistant), and on the Spanish lane the prompt explicitly
**silences** it whenever the site has 1–2 detectable gaps
(`geminiComposer.ts:262-264` — `Si gapCount 1–2: … No menciones el asistente`),
which is the common case. So most with-website leads hear only "I can add a
contact form." This slice (a) gives the three densest verticals — legal, dental/
medical, real estate — a concrete *productized* AI hook, (b) un-gates the AI offer
so it can ride **alongside** the site-gap fix as a parallel value-add instead of
either/or, and (c) adds a soft "and I build custom tools for specific needs" line.
2026 research is explicit that *specific productized* offers beat open-ended
"I build anything," so the operator's "unlimited" instinct is translated into a
few concrete per-category offers. Recommended slice #3.

**Project vocabulary (one line).** Rework the offer assembly in
`geminiComposer.ts` — `buildOfferContext` (`:222-228`), the `ASSISTANT_OFFER_*`
strings (`:1013`), and the gap-count gate inside `SYSTEM_ES` (`:262-264`) /
`SYSTEM_EN` (`:363-368`) — to inject a category-aware productized offer and allow
the assistant/custom-tool line as a non-exclusive benefit, while keeping every
factual claim inside `geminiVerifier`'s gate.

## Out of scope

- The verifier, send gate, governor, or compose pipeline structure — reuse
  `composeVerifiedEmail` unchanged; this slice only changes *prompt/offer text and
  the offer-selection branch*, not the loop.
- The no-site (WhatsApp) lane offer — its own composer path
  (`composeWhatsApp`, `WHATSAPP_*`) and slice **0048**/0042. This slice is the
  **has-website** email lane.
- Lead ranking (**0044/0045**).
- Making offer wording editable in Settings (parked item) — keep it in-code here;
  Settings-editability is a later slice.

## Constraints

- **Verifier still owns claims (SPEC invariant, already encoded
  `geminiComposer.ts:267-271`).** The AI tool/assistant is *a service I provide*
  (always true) → present as a benefit. **Never assert THIS business lacks an
  assistant / tool** unless `requiredAnchor.fact` proves it. The un-gating must
  not turn the offer into an unverifiable claim about their site. Any new offer
  text must pass `geminiVerifier.verifyDraft` → `sendGate`.
- **Reuse-only registry** — `composeVerifiedEmail`, `anchorRanker`,
  `geminiVerifier`, `sendGate` unchanged.
- **No em dashes** — the existing `PUNCTUACIÓN`/`PUNCTUATION` rules
  (`geminiComposer.ts:232`, `:352`) stay; new few-shot examples must not introduce
  `—` (coordinate with slice 0034 if it lands first).
- **Length + structure limits unchanged** — 70–90 words AR / 60–90 EN, 4
  paragraphs; the productized offer must fit the existing offer paragraph, not add
  one.
- **Voice** — first-person singular only (`implemento`, not `implementamos`).
- **tsc clean gate** + **reviewer subagent on the send path** (SPEC convention —
  composer changes get a code-review pass before merge).

## Diagnose-first checklist

- [ ] Files to read:
  - `server/src/services/geminiComposer.ts` — `buildOfferContext` (222-228),
    `buildAnalysisGaps` (120-170, the `gapCount`), `SYSTEM_ES` (230-347),
    `SYSTEM_EN` (349-425), the `{{OFFER_CONTEXT}}` / `{{ASSISTANT_OFFER}}`
    injection (996-1054), `ASSISTANT_OFFER_ES/EN` (via `getString`,
    `settingsRegistry.ts`).
  - `server/src/services/geminiVerifier.ts` — what counts as a website claim vs a
    service-benefit, so the new offer text stays verifiable.
  - `.claude/skills/cold-email-outreach/prompts/argentina.md` + `english.md` +
    `references/website-analysis.md` — the skill's source-of-truth copies to keep
    in sync.
  - `server/src/services/outreachComposePipeline.ts` — confirm offer text flows
    through verify→repair unchanged.
- [ ] Symbols to catalog: `getCategoryBucket` (used in `buildAnalysisGaps`),
  `BOOKABLE_CATS`, `FOOD_CATS`, `requiredAnchor`, `gapCount` thresholds (0 / 1–2 /
  3+), `getString('ASSISTANT_OFFER_ES'|'_EN')`.
- [ ] Online topics: confirm 2026 productized-niche offers per vertical (0043
  research already names: clinics/salons → AI booking + no-show reminders; real
  estate → lead-intake/qualification bot; law firms → intake & document
  automation). One refresh search is enough.
- [ ] Open questions: operator confirms the three lead offers per vertical and
  agrees the "custom tool for your specific need" line stays a **soft secondary**
  sentence, not the headline (per research).

## Implementation plan

_Approved before edits._

- **Step 1 — Category → productized offer map.** Add `buildNicheOffer(category)`
  returning a one-line concrete hook by `getCategoryBucket`:
  legal → intake/document automation; health/dental → booking + no-show reminder
  agent; real-estate → lead-intake/qualification bot; food → online menu/orders;
  bookable-service → online booking + WhatsApp auto-reply; else → the generic
  improve line. Feeds `{{OFFER_CONTEXT}}`. *(verify: each bucket yields its line;
  tsc.)*
- **Step 2 — Un-gate the AI offer.** Change the `SYSTEM_ES` gate (`:262-264`) so
  `gapCount 1–2` may *also* offer the assistant/custom-tool as a parallel benefit
  in the second sentence of the offer paragraph (still ONE paragraph, ≤2
  sentences), keeping the `requiredAnchor` rule that forbids claiming they lack
  one. Mirror in `SYSTEM_EN`. *(verify: regenerate a few 1–2-gap leads → the AI
  line now appears; verifier still passes.)*
- **Step 3 — Soft custom-tool line.** Extend `ASSISTANT_OFFER_ES/EN` (or add a
  sibling) so the offer can close with a soft "y desarrollo herramientas a medida
  para necesidades puntuales" / "and I build custom tools for specific needs" —
  framed as capability, never as "you lack." *(verify: verifier classifies it as a
  service-benefit, not a site claim.)*
- **Step 4 — Sync skill prompt files + few-shot.** Update the skill's
  `argentina.md` / `english.md` copies and any few-shot example to show the new
  productized offer; scrub em dashes. *(verify: skill files match code intent.)*
- **Step 5 — Reviewer pass.** Run a code-review subagent over the composer diff
  (send-path convention). *(verify: review clean.)*

## Verification gate

_Filled DURING execution (2026-06-27, live `composeVerifiedEmail` via the same data
path as `POST /api/outreach/generate`, 3 real Argentina leads with premium analysis)._

- [x] **Live: 3 leads, each vertical-specific + non-generic.**
  - **Legal** (Bufete, `ChIJHanRhmgLu5URj0p4QK9zsdw`) — subject `seguridad en su bufete`,
    `status=ok`, anchor `absent_hasSSL`:
    > El sitio de su bufete no cuenta con certificado de seguridad SSL activo. Esto suele
    > generar alertas de 'sitio no seguro' que espantan a sus visitas.
    >
    > Instalo el certificado SSL para proteger su sitio. **También armo un asistente con
    > IA que ordena las consultas iniciales.**
  - **Dental** (Dentista, `ChIJBS4J6Q61vJURkl1KN_IjlyE`) — subject `turnos para su dentista`,
    `status=ok`, anchor `present_whatsapp-link`:
    > El sitio de Odontología Dra. Alejandra Scava en Belgrano usa WhatsApp Link. Esta
    > forma de contacto puede generar una carga manual al gestionar turnos.
    >
    > **Implemento un agente que toma turnos online y envía recordatorios para reducir las
    > ausencias.** Así se optimiza la gestión y se mejora la experiencia de los pacientes.
  - **Real-estate** (Agencia inmobiliaria, `ChIJFSFHcqii9pURPw9B0s06iVU`) — subject
    `asistente inmobiliario belgrano`, `status=ok`, anchor `no_assistant`:
    > El sitio de Agustin Kreiber en Belgrano parece no tener un asistente automático 24/7.
    > Esto puede provocar que los visitantes no obtengan respuesta fuera de horario.
    >
    > **Para inmobiliarias, armo un asistente que capta y califica consultas de propiedades
    > las 24 horas.** Responde al instante y registra cada mensaje.
- [x] **`gapCount 1–2` now mentions the assistant (previously suppressed).** The legal lead
      has a single gap (SSL) yet the offer rides the SSL fix **and** the AI assistant in one
      2-sentence paragraph — the exact behavior the old `Si gapCount 1–2 … No menciones el
      asistente` gate forbade. `verification.status=ok` ∈ `SEND_ALLOWED_STATUSES`.
- [x] **Negative: no unanchored absence claim.** The only absence phrasing (real-estate
      `parece no tener un asistente`) is hedged AND backed by anchor `no_assistant`; verifier
      returned `violations=[]`. No body asserted a lacking feature without an anchor.
- [x] **No `—`** in any generated body (`EM_DASH:false` on all three) or new few-shot/skill text.
- [x] **Code-review subagent pass** (`feature-dev:code-reviewer`): verdict **Clean**, no
      issues ≥80 confidence; verifier-safety, voice, register, banned-phrase, length, and
      reuse constraints all checked.
- [x] **`npx tsc --noEmit` clean** (server container) after every code phase + final.

**Caveat (EN lane):** `ASSISTANT_OFFER_EN` has a persisted operator override in
`app_settings` (byte-identical to the *old* default) that masks the new soft custom-tool
sentence. `ASSISTANT_OFFER_ES` has no override → new soft line live. EN leads will not show
the soft line until the operator clears/re-saves that setting. ES (primary lane) unaffected.
Per-vertical niche offers reach EN regardless (via `buildOfferContext` → `{{OFFER_CONTEXT}}`).

## Completion record

- Commit SHAs: _(recorded in a follow-up docs commit)_
- What changed:
  - `geminiComposer.ts`: new `buildNicheOffer(category, isSpanish)` — real-estate via
    regex (`/real estate|inmobiliar/i`, no `getCategoryBucket` bucket exists), then
    `getCategoryBucket` → legal / health / food / beauty|fitness niche line; `null` for
    professional/other. `buildOfferContext` has-site branch now returns the niche line
    when present (feeds EN `{{OFFER_CONTEXT}}`). New `{{NICHE_OFFER}}` token added to
    `SYSTEM_ES` + `SYSTEM_ES_ES` offer sections, injected via `.replaceAll`. The
    `gapCount 1–2` gate rewritten in both ES prompts: the assistant/niche offer may now
    ride **alongside** the `siteGaps[0]` fix (still 1 paragraph, ≤2 sentences, ≤90 words);
    the ASSISTANT GATE block broadened to cover the niche offer (still forbids unanchored
    "you lack one"). EN needed no gate change (already permissive).
  - `settingsRegistry.ts`: appended the soft custom-tool sentence to `ASSISTANT_OFFER_ES`
    + `ASSISTANT_OFFER_EN` **defaults** (reworded off the slice's banned `a medida` →
    `herramientas específicas … necesidad puntual`).
  - `.claude/skills/cold-email-outreach/prompts/argentina.md` + `english.md`: documented
    `{{NICHE_OFFER}}` + the un-gate; scrubbed em/en dashes.
- Diagnosis corrections to the original plan: `{{OFFER_CONTEXT}}` is **EN-only** (ES uses
  `siteGaps`/`gapCount`) so the niche offer reaches ES via the new `{{NICHE_OFFER}}` token,
  not `{{OFFER_CONTEXT}}`; there is **no `realestate`/`bookable` bucket** so real-estate is
  regex-matched inside `buildNicheOffer`; the slice's literal soft line used the banned
  phrase `a medida` and was reworded.
- Follow-ups:
  - **EN soft line dormant** until the operator clears the persisted `ASSISTANT_OFFER_EN`
    override in Settings (see Verification gate caveat). Offer to clear it on request.
  - Pre-existing unused var `hasChatSig` (`geminiComposer.ts` `buildAnalysisGaps`) left in
    place — unrelated to this slice.
  - Make offer wording Settings-editable (parked); revisit per-vertical hooks once reply
    data shows which convert.
