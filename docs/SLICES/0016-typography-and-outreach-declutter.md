# Slice 0016: Typography/breathing-room + Outreach declutter

> Derived from diagnosis [`0011`](0011-ux-clarity-and-outreach-audit.md) findings
> **(g)/(h)**. Addresses BRIEF symptoms 2, 3, 4 (small/unserious font, no
> breathing room, bloated Outreach filters). **This is the slice that resolves
> the design-freedom tension** the operator raised.

## Intent

**Plain English:** The app reads small, cramped, and a bit unserious, and the
Outreach filters are crowded. The operator wants larger, more legible, more
"serious" type with more breathing room, and explicitly asked for more design
freedom than the current rules allow. Bump the type scale and spacing, optionally
trial a more serious font, and tuck the secondary Outreach filters behind a
disclosure — without deleting any working behavior. Because the current look is
mandated by `DESIGN.md` and `rules/ui.md`, those rules get **amended first, on
purpose**, with a written rationale — not silently overridden.

**Project vocabulary:** Amend `DESIGN.md §3` (type scale, the No-Display-Heading
rule) and `rules/ui.md` BANNED-DEFAULTS/AESTHETICS, then raise the scale (body
→ 15–16px, metadata → 12–13px, line-height → ~1.5), loosen spacing tokens, and
collapse the secondary `LeadQueue` filter rows behind a "Filtros" disclosure with
the already-computed active-count badge (`LeadQueue.tsx:160-165`).

## Out of scope

- Functional changes to filtering/outreach behavior — every filter keeps working,
  just relocated.
- Reworking other tabs' layouts beyond the shared type/spacing tokens.
- Abandoning the dark "Darkroom" aesthetic or the mono-numbers invariant — the
  amendment *loosens* scale/font latitude, it does not throw out the system.

## Constraints (`docs/SPEC.md`) — and the tension it resolves

- **`rules/ui.md` and `DESIGN.md` are the source of truth and cannot be silently
  overridden** (`rules/ui.md` header). Therefore: **amend them first**, in the
  same slice, with rationale, then implement. This is the deliberate resolution
  of the diagnosis's recorded constraint tension.
- **Mono-numbers invariant stays** (`DESIGN.md:137`) — every number in
  `JetBrains Mono`. The amendment may grow sizes, not break this rule.
- **No banned UI libs / no inline styles except dynamic** (`rules/ui.md`
  COMPONENT RULES). Disclosure built from existing primitives in
  `client/src/ui/` (or a new custom one) — no Radix/shadcn.
- **Tokens live in `globals.css` first** — new sizes/spacing become variables,
  not per-component hardcodes (`rules/ui.md`).
- **Progressive disclosure, not deletion** — keep discoverability via the
  active-filter-count badge (2026 PD guidance, cited in `0011`).

## Diagnose-first checklist

- [ ] Files to read: `DESIGN.md §3` + `:139` (No-Display-Heading),
      `.claude/rules/ui.md` (BANNED DEFAULTS, REQUIRED AESTHETICS),
      `client/src/styles/globals.css:41-42` (font tokens) + the size/spacing
      declarations, `client/src/components/Outreach/LeadQueue.tsx:204-347` (filter
      stack), `:160-165` (active-filter count), `:28-46` (PILL styles).
- [ ] Symbols to catalog: every `font-size` / `padding` token in `globals.css`;
      `--font-ui`, `--font-mono`; the inline `fontSize: 10/11/12/13` literals in
      `LeadQueue.tsx` (these need to move to tokens to scale coherently).
- [ ] Online topics: 2026 type scales (Perfect Fourth 1.333 / Major Second 1.125
      for dense UI), body 16px+ / line-height 1.5–1.75, "serious tool" fonts
      (IBM Plex Sans, Atkinson Hyperlegible), progressive disclosure for filters.
      (All sourced in `0011`.)
- [ ] Live render check (per `feedback_redesign_aesthetic_era`): critique the
      *real* rendered Outreach surface, not an imagined one; if redesigning,
      move the surface language, don't just resize.
- [ ] Open questions for operator: keep `Outfit` (just bigger) or trial a more
      "serious" face (e.g. IBM Plex Sans) for UI text? Mono stays `JetBrains
      Mono` either way. Recommend showing both in a quick before/after.

## Implementation plan

_Draft — operator approves before edits; the rules amendment is itself part of
the deliverable and needs sign-off._

- Step 1 — **Amend `DESIGN.md §3` + `rules/ui.md`**: new type scale (e.g. body
  15–16px / label 13–14px / caption 12px / line-height 1.5), looser spacing
  tokens, and (if chosen) an approved UI-font option. Written rationale tying
  back to BRIEF symptoms 2–3 and 2026 guidance. *Verify:* operator signs off on
  the amended rules before any component edit.
- Step 2 — Add the new size/spacing tokens to `globals.css`; migrate the
  hardcoded `fontSize`/padding literals in `LeadQueue.tsx` (and shared Outreach
  components) to tokens. *Verify:* numbers still `JetBrains Mono`; type visibly
  larger; tsc clean.
- Step 3 — (If font trial chosen) wire the new UI face with `system-ui` fallback,
  preserving mono-numbers. *Verify:* before/after screenshot pair for the
  operator.
- Step 4 — Collapse secondary `LeadQueue` filters (email / country / website
  rows, `:321-345`) behind a "Filtros" disclosure; keep mode-pills + search
  always visible; show the active-count badge so hidden active filters stay
  discoverable. *Verify:* every filter still works (set one inside the
  disclosure → list updates); badge reflects active count.

## Verification gate

_Filled DURING execution with live evidence._

- [x] **Amendment (operator-approved).** `DESIGN.md §3` rewritten: UI face
      promoted Outfit → **IBM Plex Sans** with a dated rationale block tying it to
      BRIEF symptoms 2–3 and the operator's explicit font choice; §8 Do's + the
      token-header `fontFamily`s updated to match. `.claude/rules/ui.md` HARD-BANS
      Fonts line + Typography "Default" line updated to "IBM Plex Sans default
      (slice 0016), Outfit approved alternate". (`.claude/` is gitignored, so the
      `ui.md` change shows on disk but not in `git diff` — verified via grep:
      `:17` and `:35` carry the new wording.) `git diff --stat` shows DESIGN.md
      among the tracked changes.
- [~] **Before/after screenshots.** NOT captured. Live screenshots need the full
      dev stack (gosom Docker + Express + Vite); the server side requires the
      Docker container (better-sqlite3 native build). Type/spacing + collapsed
      filters were verified by `vite build` (CSS/font/bundle valid) and code
      trace, not a rendered capture. Can capture if the operator brings the stack
      up. Mono-numbers invariant preserved (no `--font-mono` declarations touched;
      the new Disclosure count badge uses `--font-mono`).
- [x] **Manual / code trace.** Every relocated filter keeps its original handler
      (`handleCountry`, `handleHasWebsite`, `handleCategory`, the `setValidEmailOnly`
      pills) — only the JSX moved inside `<Disclosure>`. Search input + mode pills
      stay outside the disclosure (always visible). The disclosure badge reads a
      new `hiddenFilterCount` (country/website/category/email-non-default);
      `activeFilterCount` (header label) extended with the email term.
- [x] **client `npx tsc --noEmit` clean** (run after Phase 2 and Phase 3:
      "TypeScript: No errors found"). **`vite build` green** (137 modules, built
      in 3.39s). Server untouched — no server tsc needed (no server file changed).

## Completion record

- Commit SHAs: _not committed_ (operator did not request a commit; changes staged
  in working tree on branch `feat/no-website-lane`).
- What changed:
  - **Rules amended first:** `DESIGN.md §3`/§8/token-header + `.claude/rules/ui.md`
    promote IBM Plex Sans to the default UI face, with written rationale.
  - **Tokens:** `globals.css` gains a type-scale (`--text-title/section/body/
    label/caption`, `--leading-body`) + spacing scale (`--space-*`, `--gap-filter`);
    `--font-ui` swapped to `'IBM Plex Sans','Outfit',system-ui`; body line-height
    set; `.input-field`/`.pill` retoned to the larger caption/body sizes.
  - **Font load:** `index.html` Google-Fonts link now requests IBM Plex Sans.
  - **Disclosure primitive:** new `client/src/components/ui/Disclosure.tsx` +
    `.disclosure*` CSS (grid-rows animation, reduced-motion aware, mono count badge).
  - **LeadQueue declutter:** secondary `new`-mode filters (category, email,
    country, website) moved behind a `Filtros` disclosure with an active-count
    badge; search + mode pills stay visible; inline `fontSize: 10/11/12` filter
    literals migrated to caption/label tokens.
- Follow-ups / new parked items:
  - Live before/after screenshots still owed once the dev stack is up.
  - Doc drift not fixed (out of scope): `rules/ui.md` still says primitives live
    in `client/src/ui/`; actual path is `client/src/components/ui/`.
  - Other tabs only inherit the font/token changes; no per-tab spacing pass done
    (intentionally out of scope).
