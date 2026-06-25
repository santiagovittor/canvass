# Slice 0035: Explorer scroll — reproduce, then fix the real container

> **Implementation order: 2 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F4**, *corrected*.
> **Reproduce-first slice** — the two obvious suspects are already cleared, so the
> bug is elsewhere. Do not ship a presumed one-line fix; reproduce live first.

## Intent

**Plain English.** The operator keeps hitting "the Explorer won't scroll
vertically — I can't see all the info in the side panels," and it keeps coming
back. The catch: the two containers everyone blames already work. The leads table
was checked in slice `0028` and proven fine (that fix was a verified NO-OP). The
left filter/location panel already has its own scrollbar. So the real cause is
something neither prior pass touched. This slice's job is to **reproduce the bug
on the live app at the operator's real window size first**, find the container
that actually clips, then fix exactly that — once and for all, with the flex chain
audited so it stops recurring.

**Project vocabulary.** Reproduce the Explorer vertical-clip at the operator's
viewport with `ActiveRunsStrip` mounted (the chrome that historically triggers
it), against the live Vite dev server + real `scraper.db`. Inspect the full flex
chain `App.tsx` `.app-root` → `.view-fill` → `BusinessExplorer.tsx:176` (row) →
`:178` (left col) / `:196` (main col) → `:262` (table wrap) → `BusinessTable` and
`FilterPanel.tsx:81-90`. Identify the genuinely clipping node, fix it in-style,
then one-time-audit every top-level view's flex chain.

## Out of scope

- Re-litigating the table flex chain (`:196`/`:262`) **unless** reproduction proves
  it — `0028` already showed `overflow:hidden` lets it shrink; `minHeight:0` there
  was a measured no-op.
- The Outreach right-rail scroll — that is its own bug, slice `0036`.
- Design-token / type conformance (`0021`).
- Any non-Explorer view beyond the audit pass.

## Constraints (`docs/SPEC.md` / `rules/ui.md`)

- Pure client layout; no SPEC invariant blocks it.
- `react-leaflet`/`leaflet` pinned — the Explorer minimap-free table view doesn't
  touch them; don't.
- `rules/ui.md`: match the file's existing inline-style approach on these divs; do
  not refactor the styling system. No tiny-type "fix" that hides a layout problem.
- **No false-fix**: `0028`'s lesson is binding — every claimed cause is proven by
  live measurement (footer/last-row bottom px vs viewport), not by reading CSS.

## Diagnose-first checklist

Partly done in `0033`/`0028`. The reproduction is the first real step.

- [x] Already cleared: table chain (`0028` NO-OP — `overflow:hidden` on
      `BusinessExplorer.tsx:196,262` already permits shrink); left panel has inner
      scroll (`FilterPanel.tsx:86` `overflowY:auto; height:100%`).
- [ ] **Reproduce (Step 1 — gating).** Live Explorer at the operator's actual
      viewport (ask: laptop height? assume ~700-800px), `ActiveRunsStrip` mounted
      (start or fake an active run), real data (681+ leads). Confirm whether the
      clip is the table bottom, the left panel bottom, the whole page, or
      horizontal-masquerading-as-vertical. Capture the clipping element + its
      computed `overflow`/`height`/`min-height`/`flex`.
- [ ] Files to read on repro: `client/src/App.tsx` (`.app-root` height + view mount
      + `ActiveRunsStrip`), `client/src/styles/globals.css` (`.view-fill`,
      `.app-root`), `BusinessExplorer.tsx:176-278`, `FilterPanel.tsx:81-90`,
      `BusinessTable.tsx:136-137,326-333`.
- [ ] Symbols to catalog: the real flex parent of the Explorer view; whether
      `ActiveRunsStrip` is `position`-flow or absolute; whether `.view-fill` keeps
      `min-height:0` when the strip mounts.
- [ ] Open question for operator: **at what window size / which panel** does it
      clip — the leads list, or the left filters, or both? A screenshot at the
      moment it happens would pin it instantly. *(If the operator can repro on
      demand, capture their viewport + which scrollbar is missing.)*

## Implementation plan

_Operator approves before edits. Steps 2+ are conditional on Step 1's finding._

- **Step 1 — Reproduce live (no edit).** Playwright-core chromium vs `:5173`, full
  `docker-compose.dev.yml` stack, operator viewport, `ActiveRunsStrip` mounted.
  Measure the bottom of the last leads row / pagination footer / left-panel Export
  button vs viewport height. Identify the single element whose content extends past
  its clipped box.
  *(Verify: a reproduction screenshot + the offending element's computed style. If
  it does NOT reproduce, STOP and report — like `0028`, do not invent a fix; ask the
  operator for a repro screenshot at their size.)*

- **Step 2 — Fix the proven container (in-style).** Apply the minimal CSS to the
  element Step 1 identified — likely candidates if proven: a missing `min-height:0`
  on a column flex ancestor that lacks `overflow:hidden`; `.view-fill` losing its
  shrink when the strip mounts; or a left-column height not propagating to
  `FilterPanel`'s `height:100%`. Fix only the proven node.
  *(Verify: re-measure — last row + pagination + left-panel Export all reachable
  with the strip mounted, at the operator viewport. Toggle the property live to
  confirm it is load-bearing, not cosmetic.)*

- **Step 3 — Flex-chain audit (the "once and for all").** Walk every top-level view
  (Explorer, Outreach, Scraper, Analytics, Automate, Settings) and record each
  root→scroll-region chain; patch any other view with the same proven defect.
  *(Verify: a short table of view → scroll mechanism; confirmed offenders patched,
  others noted as sound.)*

- **Step 4 — Regression + tsc.**
  *(Verify: Outreach `0018` still fine; `npx tsc --noEmit` clean, client.)*

## Verification gate

_Filled DURING execution with live evidence (mirror `0028`'s method: real DOM
measurement, viewport-aware, property toggled to prove load-bearing)._

> **Premise corrected during repro.** The bug is NOT in the Explorer — it is in
> the **Scraper view** (`.app-grid`). Operator confirmed: *"it is not at the
> explorer, this happens in the scraper, left and right panels show some buttons
> at the bottom but i cant see them or click them because i cant scroll."*
> Explorer reproduced as **sound** (NO-OP, like `0028`).

- [x] **Explorer is sound (NO-OP).** Live, widths 1920/1680, heights 1080/900/800/700,
      real data (749 leads), `ActiveRunsStrip` mounted (real Premium-analysis run +
      injected fake strip): `.view-fill`/explorer row never clip (`flex:1 1 0%`,
      `min-height:0`); table scroller `overflowY:auto` (scrollH 2711 vs clientH
      435–815); FilterPanel `overflowY:auto`, wheel test scrollTop **0→76**; footer
      always 10px above viewport edge; Export `inView:true`. No third clipping node.
- [x] **Root cause (Scraper) captured.** Instrumented the full chain @1680×800:
      `html/body/#root/.app-root` = 800px ✓; `.app-grid` clientH **690**, scrollH
      **10725**, `overflow:hidden` → CLIPPED; grid columns ×3 height **10724.5px**,
      `min-height:auto`. Grid items default `min-height:auto` refuse to shrink below
      content → `grid-template-rows:1fr` blows the row to full content height; the
      column overflow is clipped with **no scrollbar**. Bottom buttons unreachable.
- [x] **Post-fix reachable.** After `minmax(0,1fr)` + Sidebar single-scroll, @1680×700,
      scraper view, polygon drawn:
      - Results col: capped 590, ResultsTable scrolls internally (scrollH 10575 in
        441px), **Export CSV `inView:true`**.
      - Sidebar col: root `overflowY:auto`, scrollH 1288 in 590; scrollTop **0→698**,
        last section (Schedules) bottom 700 reachable, **"Start Scrape" `inView:true`
        after scroll** (was `inView:false`, unreachable, pre-fix).
- [x] **Property proven load-bearing (control).** `.app-grid` scrollH/clipped:
      `1fr` → 10725 / **clipped:true** (every column unreachable); `minmax(0,1fr)` →
      690 / **clipped:false** (columns capped, scroll). Sidebar `overflowY`:
      `visible` → Start Scrape unreachable; `auto` → scrolls, reachable.
- [x] **Audit (all top-level views @700px, no real unreachable-clip offenders):**
      | View | Root | Scroll mechanism | Status |
      |---|---|---|---|
      | Scraper | `.app-grid` `minmax(0,1fr)` | columns cap; Sidebar root-scroll, map center, ResultsTable `overflowY:auto` | **FIXED** |
      | Explorer | `.view-fill` `flex:1;min-h:0` | table + FilterPanel `overflowY:auto` | sound (proven live) |
      | Outreach | `.view-fill`→`.outreach-grid` | own grid/rail scroll (right-rail = slice 0036) | sound, no blowout |
      | Automate | `.view-fill` | page-internal | sound |
      | Analytics | `.view-fill` | page-internal | sound |
      | Settings | `.view-fill` | page-internal | sound |
      (Leaflet panes / collapsed `disclosure-panel-inner` flagged with `clientH:0` are
      absolutely-positioned/animating elements, not flex clips — false positives.)
- [x] `npx tsc --noEmit` clean (client).

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - **`client/src/styles/globals.css`** — `.app-grid` `grid-template-rows: 1fr` →
    `minmax(0, 1fr)`. Caps the row track so grid columns (whose default
    `min-height:auto` blew the row out to 10725px) shrink to the available height
    and scroll internally instead of clipping. Root cause of the operator's
    "panels won't scroll" — fixes the **right** panel outright.
  - **`client/src/components/Sidebar/Sidebar.tsx`** (both render variants) — root
    `<div>` gets `overflowY:auto` + `minHeight:0`; the bottom "Schedules" section
    drops its `flex:1` inner-scroll so the **whole sidebar is one scroll region**
    (operator-approved). Fixes the **left** panel: Area/Search/Scheduler no longer
    clip off-screen.
- Diagnosis correction: slice premise (Explorer, from `0033` F4) was wrong.
  Explorer is sound (NO-OP). Real defect was the Scraper `.app-grid`.
- Follow-ups / new parked items:
  - `0033` F4 should be re-pointed Explorer→Scraper (stale finding).
  - Outreach right-rail scroll remains **slice 0036** (untouched here).
