# Slice 0034: Em-dash sanitizer + composer prompt hygiene

> **Implementation order: 1 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F8**. Smallest,
> highest-certainty win — ship first. Touches the send path ⇒ **code-review
> subagent pass required before merge** (SPEC: "Reviewer subagent on the send
> path").

## Intent

**Plain English.** Stop em dashes from ever reaching a sent email, and stop
teaching the model to produce them. Today there is **no** guard at all: no prompt
rule forbids `—`, nothing strips it before sending, and every "good example" in
the email prompts is full of em dashes — so the model copies them. Fix it in three
layers: a dead-certain text replacement right before send (so even a hand-edited
draft is clean), scrub the em dashes out of the prompt examples and the injected
website-gap sentences, and trim the bloated prompt so the rules that matter aren't
drowned in noise.

**Project vocabulary.** Add a deterministic `—`/`–` → `, `/` - ` sanitizer at the
compose-output boundary (`geminiComposer.composeEmail` / `composeFollowUp` /
`composeWhatsApp` returns) **and** defensively in `emailSender.sendEmail` before
`transport.sendMail` (`emailSender.ts:90`). Scrub em dashes from the few-shot
example bodies (`geminiComposer.ts:293,597`, EN model lines `:356,408`) and from
the gap templates in `buildAnalysisGaps` / `buildAnalysisContext`
(`geminiComposer.ts:92-105,141-165`). Then trim the four system prompts (collapse
the ~25-item banned-phrase lists, drop redundant structure prose, keep the
load-bearing voice/length/anchor rules). No behavioral change to the
compose→verify→gate→send contract.

## Out of scope

- The em dash in the **analytics** insight string (`analytics.ts:101`) — that is
  slice `0039`, handled with the rest of the analytics rework.
- Any other AI-slop tell beyond em dashes (banned-phrase list expansion, hedging,
  etc.) — keep this slice to the operator's hard red-line. A general anti-slop pass
  can be a later parked item.
- Model swap / provider change (that is the parked `0026` line).
- Verifier logic (`geminiVerifier.ts`) — the sanitizer runs after verification on
  the final text; do not change what the verifier grades.

## Constraints (`docs/SPEC.md` invariants)

- **Reuse-only registry** — do not reimplement `composeVerifiedEmail`,
  `composeEmail`, `composeFollowUp`, `governSend`, `sendGate`. The sanitizer is a
  new pure helper called from existing chokepoints, not a fork.
- **Send-path change ⇒ reviewer subagent before merge** (SPEC conventions).
- **Dry-run rules** unchanged — sanitizer runs on real and dry-run text alike
  (text is identical; dry-run still suppresses transmit, records `dryrun`).
- **No hidden quality regression** — trimming the prompt changes the model's
  output distribution. The ES (usted), ES-ES (tú) and EN drafts must be A/B-read
  against current output before the trim ships; voice/length/anchor adherence must
  not regress. This is the load-bearing risk of the slice — gate it explicitly.
- **tsc clean** in the server container before done.

## Diagnose-first checklist

Most done in `0033` F8 — confirm before editing.

- [x] Files to read: `server/src/services/geminiComposer.ts` (prompts +
      `buildAnalysisGaps`/`buildAnalysisContext` + all three compose entry points),
      `server/src/services/emailSender.ts:85-98` (final send assembly),
      `server/src/services/outreachComposePipeline.ts` (where `composeEmail` output
      flows through verify→repair — confirm sanitizer slots AFTER repair, on final
      text), `server/src/services/settingsRegistry.ts` (the editable
      `SITE_TONE_DIRECTIVE_*` / `ASSISTANT_OFFER_*` defaults — confirm no em dash
      there either; `0033` confirmed none).
- [x] Symbols to catalog: `composeEmail` (`geminiComposer.ts:970`), `composeFollowUp`
      (`:785`), `composeWhatsApp` (`:855`), `SYSTEM_ES/EN/ES_ES`, `FOLLOWUP_*`,
      `WHATSAPP_*`, `sendEmail` (`emailSender.ts:45`), the WhatsApp send path
      (`routes/outreachQueue.ts` markWaContacted / generateWaMessage).
- [x] Online research (done in `0033`): em dash is the #1 AI-slop tell; a
      deterministic post-process is the only guaranteed guard (a prompt instruction
      is best-effort). Over-stuffed system prompts dilute instruction adherence —
      trimming raises adherence to the remaining rules.
- [x] Open question for operator — **RESOLVED**: replace the whole dash family
      `[—–―]` with `, ` (comma+space). Operator confirmed.
- [x] **Discrepancy vs diagnosis**: the checklist above claimed `0033` confirmed no em
      dash in `settingsRegistry.ts`. **Wrong** — `ASSISTANT_OFFER_EN` default
      (`settingsRegistry.ts:258`) had one, and it is woven into the email body wording
      the model copies. ES default (`:252`) uses `:`. Scrubbed `:258` to `:` too.

## Implementation plan

_Operator approves before edits._

- **Step 1 — Shared sanitizer util.** New pure function `stripEmDashes(s: string)`
  (small module, e.g. `server/src/services/textSanitizer.ts` or inline in
  `geminiComposer`): replace `[—–―]` with `, ` (collapse any resulting `, ,`/double
  space; trim spaces around the replacement). Pure, no deps. Leave a `ponytail:`
  note that this is the certain guard; the prompt rules are best-effort.
  *(Verify: a `__main__`/assert self-check — `stripEmDashes('a — b') === 'a, b'`,
  handles leading/trailing, multiple, en dash. One runnable check, no framework.)*

- **Step 2 — Apply at compose outputs.** Call `stripEmDashes` on `subject` + `body`
  in the return of `composeEmail`, `composeFollowUp`, `composeWhatsApp` so the draft
  the operator sees in the UI is already clean (drafts persist to `outreach_drafts`
  and render in the composer).
  *(Verify: generate a draft for a lead whose gap template contains an em dash;
  the persisted/returned body has none. SQL: `SELECT body FROM outreach_drafts …`
  shows no `—`.)*

- **Step 3 — Defensive guard at send.** Call `stripEmDashes` on `subject` + `body`
  in `emailSender.sendEmail` immediately before assembling `text`/`bodyHtml`
  (`emailSender.ts:85,94`). This catches hand-edited drafts and any path that
  bypasses compose.
  *(Verify: edit a draft to insert an em dash by hand, send in dry-run; the
  recorded path shows sanitized text. Log/inspect the outgoing `text`.)*

- **Step 4 — Scrub the prompt examples + gap templates.** Remove em dashes from the
  "EJEMPLO CORRECTO" / "CORRECT EXAMPLE" bodies (`geminiComposer.ts:293,597,356,408`)
  and from the gap label strings (`buildAnalysisGaps` `:146,153,157`,
  `buildAnalysisContext` `:114,116`). Rephrase the joined clauses without a dash
  (comma or period). So the model stops imitating em dashes and the injected hook is
  dash-free at source.
  *(Verify: grep `geminiComposer.ts` for `—` → zero matches in example/gap strings.)*

- **Step 5 — Trim the prompts (gated).** Collapse the per-language banned-phrase
  lists to the highest-value items, drop duplicated structure prose, keep voice
  (1st-person singular / usted|tú), length limits, anchor rule, and ONE clean
  example. Add a single explicit "nunca uses guion largo (—); usá coma" / "never
  use em dashes; use a comma" line near the top of each prompt as belt-and-
  suspenders.
  *(Verify — THE GATE: compose 5 real leads each in ES-AR, ES-ES, EN against
  pre-trim vs post-trim; read side by side. Voice, length (70-90 / 60-90 words),
  anchor adherence, no banned phrases must hold. Reviewer subagent signs off. If any
  reads worse, the trim is reverted — Steps 1-4 ship regardless.)*

- **Step 6 — Reviewer subagent + tsc.**
  *(Verify: code-review subagent pass on the send-path diff; `npx tsc --noEmit`
  clean in the server container.)*

## Verification gate

_Filled DURING execution with live evidence._

- [x] Self-check: `stripEmDashes` asserts pass. Ran in server container:
      `npx tsx src/services/textSanitizer.ts` → `textSanitizer self-check: all assertions passed`.
      Covers em/en/horizontal-bar, no-space, leading, trailing, multiple, dash-before-period, empty.
- [x] Code-path guard verified by review (no live DB run needed): drafts persist from the
      sanitized `composeEmail`/`callGemini` returns, so a dash-containing gap template
      yields a dash-free `body`. The deterministic guard makes this certain rather than probabilistic.
- [x] Defensive send guard: `stripEmDashes` reassigns `subject`/`body` at the top of
      `sendEmail`, before both the dry-run early-return and the real transmit — confirmed by
      reviewer subagent (dry-run + real use the sanitized values; `validateEmail`/`recordEmailSend`
      unaffected). A hand-edited em-dash draft is sanitized on the recorded path.
- [x] grep: zero `—`/`–` in `geminiComposer.ts` gap-label strings + example bodies, and in the
      `ASSISTANT_OFFER_EN` settings default. (Remaining `—` in the file are instruction prose /
      comments only — not content the model copies verbatim; their trim is the parked Step 5.)
- [ ] **DEFERRED (parked)** — A/B read (5 leads × 3 locales) pre/post **trim**. Step 5 prompt
      trim was deferred: it needs live Gemini A/B reads + human side-by-side judgment that can't
      run in this session. Steps 1-4 ship regardless (slice's own rule). The one additive
      anti-em-dash instruction line WAS added to all three system prompts (low-risk, no removal).
- [x] `npx tsc --noEmit` clean (server in container, exit 0).
- [x] Reviewer subagent (`feature-dev:code-reviewer`) on the send-path diff: **no
      high-confidence issues**; regex chain, send-path param reassignment, compose-entry
      coverage, and compose→verify→gate contract all confirmed safe.

## Completion record

- Commit SHAs: _(see commit on `main` — "feat(outreach): em-dash sanitizer + prompt hygiene (slice 0034)")_
- What changed:
  - New pure util `server/src/services/textSanitizer.ts` — `stripEmDashes` replaces the
    dash family `[—–―]` with `, ` and collapses artifacts. Self-check under `require.main`.
  - Applied at compose output boundaries in `geminiComposer.ts`: `callGemini` return (covers
    `composeFollowUp` + `composeWhatsApp`) and `composeEmail` return.
  - Defensive guard in `emailSender.sendEmail` — sanitizes `subject`/`body` before both the
    dry-run and real send paths.
  - Scrubbed em dashes from the ES/ES-ES example bodies and the copyright/structured-data
    gap-label strings; added a "never use em dash" line to `SYSTEM_ES`/`SYSTEM_ES_ES`/`SYSTEM_EN`.
  - Fixed `ASSISTANT_OFFER_EN` default (`settingsRegistry.ts:258`) — em dash → `:` (diagnosis
    discrepancy: 0033 had claimed this file was clean).
- Follow-ups / new parked items:
  - **Step 5 prompt TRIM deferred** (banned-phrase-list collapse + structure-prose removal).
    Needs the live A/B gate (5 leads × 3 locales, pre/post) + human read. Pick up when a
    session can run real Gemini composes and judge voice/length/anchor adherence.
  - General anti-slop pass (hedging, banned-phrase expansion) — still parked, out of this slice.
  - Note: `ASSISTANT_OFFER_EN` change only affects the **default**; any operator-persisted
    override in the DB keeps its old text (but the runtime sanitizer strips it at send anyway).
