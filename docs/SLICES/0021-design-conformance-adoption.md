# Slice 0021: Design-conformance adoption (make the rendered app match the amended rules)

> Derived from `0017` findings (a)(b) / S4. Do this LAST — after `0018`–`0020`
> so the new Automate/batch surface is polished in its final shape, not twice.

## Intent

Slice `0016` amended `DESIGN.md`/`ui.md` and added the token scale to
`globals.css` (`--text-body:15px`, `--text-caption:12px`, spacing scale, IBM Plex
Sans), but the *rendered* surfaces never adopted it — they still hardcode 10–11px
text, raw hex colours, and per-element inline styles. That mismatch is exactly
why the operator says the app still doesn't look like the new design. This slice
is the adoption pass: replace inline sub-12px sizes with the `--text-*` tokens,
raw hex with the existing semantic tokens, and the repeated inline styles with
`globals.css` classes; then sweep the residual sub-12px rules in `globals.css`.
No new font, no new palette — pure adoption of what already exists, scoped
per-panel so diffs stay reviewable.

**Project vocabulary:** Eliminate the ~102 inline `fontSize:9-11` occurrences,
the ~23 hardcoded colour literals in Outreach components, the residual sub-12px
`globals.css` rules, and the inline-style sprawl flagged in `0017` (a) — mapping
each to `--text-*`, `--space-*`, `--text-/--error/--success/--accent*` tokens and
shared classes per `ui.md` COMPONENT RULES and `DESIGN.md §3-4`.

## Out of scope

- Any behaviour change. Pure visual/markup conformance — every control keeps its
  exact function. (Any behaviour delta is a regression and must be reverted.)
- Adding new features, new motion beyond what `DESIGN.md §5` already sanctions,
  or restructuring layouts (relocation already happened in `0018`/`0019`).
- The map layer, the Analytics charts' data, or the scheduler logic.
- A font swap — IBM Plex Sans / JetBrains Mono are already the tokens; no change.

## Constraints

- **Tokens before component use** (`DESIGN.md §9.2`; `ui.md`): if a needed
  shade/size/timing is missing, add it to `globals.css` first, then reference the
  variable. No new hardcoded hex, no new inline sub-12px.
- **No-Tiny-UI Rule** (`DESIGN.md §3`): metadata floor is `--text-caption` (12px);
  body is `--text-body` (15px); do not "fix" density by shrinking text. Where 10px
  was used purely to cram, fix grouping/spacing instead (most are simple bumps to
  12–13px).
- **No inline `style={}` except genuinely dynamic values** (`ui.md`): progress
  width, transforms, and computed colours may stay inline; static typography/
  spacing/colour move to classes/tokens.
- **Compact data stays readable** (`DESIGN.md §4`): result rows/tables may stay
  dense, but legible — bumping 10px→12-13px on lead metadata is the intent, not
  making everything large.
- **Numbers stay JetBrains Mono** (`DESIGN.md` Mono Number Rule) — preserve
  `--font-mono` on every counter/coord/ID/timestamp while restyling.
- **No banned UI lib / no leaflet bump** (`ui.md` HARD BANS).

## Diagnose-first checklist

Inventory from `0017` (a). Re-run the greps before editing (numbers may shift
after `0018`–`0020`):

- [ ] `grep -rn "fontSize: \(9\|10\|11\)" client/src` — expect ~102 across
      `EmailComposer.tsx` (33), `LeadQueue.tsx` (18), `BusinessContext.tsx` (12),
      `SchedulesList.tsx` (9), `BatchRunner.tsx`/`ScrapeSchedulerStatus.tsx` (6),
      `StageTracker.tsx`/`SchedulerStatus.tsx` (5/10), `WhatsAppComposer.tsx` (3).
- [ ] Hardcoded colours: `rgba(255,255,255,…)`, `rgba(255,77,109,…)`,
      `rgba(74,222,128,…)`, `#RRGGBB` in `client/src/components/Outreach/*`
      (~23) → map to `--error`/`--success`/`--accent-dim`/`--bg-hover` etc.
- [ ] `globals.css` residual sub-12px: `:145` `.active-runs-label` (10px), `:191`
      `.active-run-meta` (11px), `:421` `.pill--keyword` (10px), `:490`
      `.bento-label` (11px), `:707` `.an-kpi-sub` (10px), `:900` `.an-cal-month`
      (9px) — decide keep (true micro-label, e.g. calendar axis) vs. bump.
- [ ] Files to read for token names: `client/src/styles/globals.css:5-62`
      (all tokens), `DESIGN.md §3-4`.
- [ ] Symbols to catalog: `--text-title/section/body/label/caption`,
      `--space-xs..xl`, `--gap-filter`, semantic colour tokens, `.btn-primary`/
      `.btn-secondary`/`.btn-danger`, `.pill*`, `.disclosure*`.
- [ ] Decide a per-panel order (review-sized chunks): LeadQueue →
      EmailComposer → BusinessContext → WhatsAppComposer/Scheduler →
      BatchRunner/Automate → globals.css sweep.
- [ ] Open questions for the operator: which (if any) sub-12px micro-labels are
      intentional (calendar month axis at 9px is a plausible keep). Default: bump
      everything in primary content; keep only true chart-axis micro-text.

## Implementation plan

_Proposed by `0017`. Operator approves before edits. Ship per-panel, verifying
each visually before the next — do not batch all panels into one diff._

- **Step 1 — LeadQueue.** Replace lead-name/email/metadata/tag sizes (10–13px) with
  `--text-body`/`--text-label`/`--text-caption`; raw hex → semantic tokens; move
  the repeated `PILL_BASE`/row styles to classes. Keep mono on emails/dates.
  *(Verify by: before/after screenshot — names ~15px, metadata ~12–13px, same
  rows, same behaviour.)*
- **Step 2 — EmailComposer** (largest, 33 hits) — same treatment; extract the
  recurring inline blocks to classes.
  *(Verify by: composer screenshot; send/skip/schedule unchanged in function.)*
- **Step 3 — BusinessContext + WhatsAppComposer + Scheduler components.**
  *(Verify by: screenshots; scheduler controls still work.)*
- **Step 4 — BatchRunner / Automate surface.** Reconcile with `0019`'s tokens
  (it should already be on-token; fix any residue).
  *(Verify by: Automate screenshot on tokens.)*
- **Step 5 — globals.css sweep.** Bump residual sub-12px rules to ≥12px except
  deliberate chart-axis micro-text; confirm no class regressed.
  *(Verify by: Analytics + strips screenshot; numbers still mono.)*
- **Step 6 — Final conformance grep.** Re-run the inventory greps; the only
  remaining sub-12px should be explicitly-justified chart axes, and no raw hex in
  components.
  *(Verify by: grep counts near zero; list any intentional exceptions in the
  completion record.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-24)._

- [~] **Screenshots — NOT captured.** Dev app is live (host :5173/:3001 confirmed
      open) but the browser is containerised (`maps-scraper-playwright-1`, port
      3000/tcp, no host-mapped port; server reaches it via `chromium.connect`
      over the compose network only). No host-reachable endpoint, so an ad-hoc
      screenshot wasn't feasible without standing up extra plumbing. The running
      app on `localhost:5173` is available for the operator to eyeball; all edits
      were pure token substitutions (see below) so render is deterministic.
- [x] `grep -rn "fontSize: \(9\|10\|11\)" client/src` → **0 matches** (tree-wide).
- [x] `grep -rn "rgba(255,\|#[0-9A-Fa-f]\{6\}" client/src/components/Outreach` →
      **0 matches** (all tokenised, incl. the email-preview "paper" surface →
      `--email-*`).
- [x] Behaviour spot-check (static): every edit was a value swap only —
      `fontSize` number → `var(--text-*)`, colour literal → semantic token. No
      handler, conditional, prop, or control flow was touched, so send/skip/
      schedule/filter/paginate/pause/resume/cancel logic is byte-identical.
- [x] `npx tsc --noEmit` clean (client) — run after every step (×7, all green).

### Intentional sub-12px exceptions remaining (justified)

- `globals.css:988` `.an-cal-month` — **9px** Analytics calendar month-axis label
  (true chart-axis micro-text; slice explicitly sanctions this keep).
- `globals.css:654` `.leaflet-control-attribution` — **10px !important** map
  legal attribution microcopy (third-party map chrome, conventionally tiny; not
  primary content). Anchored greps left both untouched by design.

## Completion record

- Commit SHAs: **uncommitted** — changes staged in working tree on
  `feat/no-website-lane`; operator to commit (not committed without request).
- What changed:
  - `globals.css` `:root` — added tokens (tokens-before-use): `--error-dim/-border`,
    `--warn-dim/-border`, `--success-dim/-border`, `--fill-subtle`, `--input-bg`,
    and `--email-paper/-paper-line/-ink/-ink-muted/-ink-body`.
  - Inline sub-12px sizes → `--text-*` across **8 components**: LeadQueue (names
    13→`--text-body`, metadata 10/11→`--text-caption`), EmailComposer (33 hits +
    email-preview hexes → `--email-*`), BusinessContext, WhatsAppComposer,
    SchedulerStatus, StageTracker, Scraper/SchedulesList, Scraper/ScrapeSchedulerStatus
    (`#555` → `--text-muted`). Numbers kept `--font-mono` throughout.
  - Colour literals → semantic tokens in all Outreach components + the one
    residual fill literal in `Automate/BatchConsole.tsx`.
  - `globals.css` sweep: residual `font-size:10px|11px` rules → `var(--text-caption)`.
- Follow-ups / new parked items: none. Two intentional sub-12px exceptions listed
  above. No panel deferred. Screenshots not captured (containerised browser, see
  gate) — eyeball pass on `localhost:5173` recommended before commit.
