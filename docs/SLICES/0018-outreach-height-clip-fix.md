# Slice 0018: Outreach height-clip fix (running banner stops cutting off buttons)

> Derived from `0017` finding (f) / S1. Smallest, highest-certainty fix —
> tackle this first; it unblocks the primary actions before `0019` adds a taller
> batch surface.

## Intent

When any run is active, the always-mounted `ActiveRunsStrip` ("running banner")
appears below the tab strip and pushes the Outreach content down. The Outreach
page hardcodes its height to `calc(100vh - 44px)`, which accounts only for the
40px tab strip (and is even 4px wrong), so the grid becomes taller than its
parent. The parent is `overflow:hidden`, so the bottom of the center column
(send / skip / schedule buttons) and the right rail (scheduler controls) get
clipped below the viewport and can't be reached. This slice makes the Outreach
root fill its flex parent instead of using an absolute viewport calc — the same
pattern every other view already uses — and adds a responsive single-column
fallback. Traces to ROADMAP `0018` (from `0017` S1).

**Project vocabulary:** Replace the `height: calc(100vh - 44px)` literal on the
Outreach root grid (`Outreach.tsx:560`) with flex-parent sizing (`height:100%;
min-height:0`), relying on `.view-fill { flex:1; min-height:0 }`
(`globals.css:96-100`) to size the column correctly whether or not
`ActiveRunsStrip` (`App.tsx:192`) is rendered. Add an `@media` fallback for the
fixed `300px 1fr 320px` grid.

## Out of scope

- The batch runner relocation/enrichment (that is `0019`).
- Any change to `ActiveRunsStrip` behaviour or other views (Scraper/Explorer/
  Analytics already size correctly via flex — do not touch them).
- Design-token / type conformance (that is `0021`).

## Constraints

- `docs/SPEC.md`: no invariant blocks this; pure client layout.
- `.claude/rules/ui.md`: no inline `style={}` except genuinely dynamic values —
  this fix *removes* a brittle inline height, moving sizing to flex. Prefer a
  class in `globals.css` over a new inline literal.
- Do not introduce `dvh`/`svh` here: the offending chrome is app-injected (the
  strip), not browser chrome, so flex sizing is the correct tool (see `0017` (f)
  + Sources). A `dvh` swap would not fix the strip's contribution.
- Respect `prefers-reduced-motion` is not relevant (no motion added).

## Diagnose-first checklist

Already done in `0017` (f). Confirm before editing:

- [ ] Files to read: `client/src/pages/Outreach.tsx:556-563`, `client/src/App.tsx:134-256`,
      `client/src/styles/globals.css:80-100,202-205`,
      `client/src/components/ActiveRuns/ActiveRunsStrip.tsx:70-91`.
- [ ] Symbols to catalog: `.app-root`, `.view-fill`, `.app-grid` (the working
      flex reference), `.tab-strip` height (40px), `.active-runs-strip` height.
- [ ] Confirm the parent chain: `.app-root` (flex column) → `.tab-strip` →
      `ActiveRunsStrip` → `.view-fill` (`flex:1; min-height:0; overflow:hidden`) →
      `<Outreach>` root grid.
- [ ] Open questions for the operator: none.

## Implementation plan

_Proposed by `0017`. Operator approves before edits._

- **Step 1 — Make the Outreach root fill its parent.** In `Outreach.tsx:557-563`,
  change `height: 'calc(100vh - 44px)'` to `height: '100%'` and add
  `minHeight: 0` so the grid tracks `.view-fill`'s flex height. Consider moving
  the whole style object to a `.outreach-grid` class in `globals.css` to satisfy
  the "no inline style" rule.
  *(Verify by: with no run active, Outreach looks unchanged; the page still fills
  the viewport exactly.)*
- **Step 2 — Prove the banner case.** Start any run (e.g. a keyword scrape or a
  dry-run batch) so `ActiveRunsStrip` renders, switch to Outreach, and confirm
  the bottom send/skip/schedule buttons and the right-rail scheduler controls are
  fully visible and not clipped.
  *(Verify by: screenshot with the strip visible — all three columns' bottom
  controls reachable; no content under the viewport edge.)*
- **Step 3 — Responsive fallback.** Add an `@media (max-width: 1100px)` (or the
  project's existing 1279px breakpoint) rule that collapses the Outreach grid to
  a single column (stack queue → composer → context) so the three columns don't
  crush on a narrow window. Mirror the `.app-grid` fallback style
  (`globals.css:202-205`).
  *(Verify by: narrow the window below the breakpoint — columns stack, nothing
  overflows horizontally.)*
- **Step 4 — Regression check the other views.** Scraper/Explorer/Analytics/
  Settings still size correctly (they were never broken).
  *(Verify by: tab through each with a run active; no clipping introduced.)*

## Verification gate

_Filled DURING execution with live evidence (playwright-core against the live
Vite dev server @ :5173; measured `.outreach-grid` vs its `.view-fill` parent)._

- [x] **Strip-visible case** — synthetic 33px strip injected before `.view-fill`
      (simulates `ActiveRunsStrip`). Grid `top` shifted 40 → 73px, but `bottom`
      stayed 800 and `gridH` shrank 760 → **727** to track the parent
      (`fitsParent:true`, `bottomInView:true`). Left "Prepare 15 leads" + queue
      footer "1/17" and right scheduler Reschedule/Cancel rows all on-screen, no
      clip. Screenshot `0018-b-strip.png`.
      *Old `calc(100vh-44px)` would have held height 756 → bottom 829 → 29px
      clipped below the viewport. Bug eliminated.*
- [x] **No-run case** — grid `top` 40 (below 40px tab strip), `bottom` 800,
      `gridH` = `parentH` = 760, cols `300px 820px 320px`, no horizontal
      overflow. Layout unchanged. Screenshot `0018-a-norun.png`.
- [x] **Narrow case** (viewport 1000px < 1279) — `grid-template-columns`
      collapses to a single `1000px` column, `horizOverflow:false`. Screenshot
      `0018-c-narrow.png`.
- [x] `npx tsc --noEmit` clean (client): "No errors found".
- [x] Regression — only `.outreach-grid` added/applied; Scraper/Explorer/
      Analytics/Settings untouched (still flex-sized via `.view-fill` / `.app-grid`).

## Completion record

- Commit SHAs: _(pending)_
- What changed:
  - `client/src/styles/globals.css` — added `.outreach-grid` (flex-parent sizing:
    `height:100%; min-height:0; overflow:hidden`, `grid 300px 1fr 320px`) + an
    `@media (max-width:1279px)` single-column fallback (`1fr; overflow-y:auto`),
    mirroring the existing `.app-grid` breakpoint.
  - `client/src/pages/Outreach.tsx` — replaced the root grid's inline `style={}`
    object (incl. the brittle `height: calc(100vh - 44px)`) with
    `className="outreach-grid"`.
- Note: Vite (Docker, Windows bind mount) needed a `docker compose restart client`
  to pick up the edits — FS events are swallowed on the bind mount (known issue).
- Follow-ups / new parked items: none. Batch runner relocation stays parked in
  `0019`; token/type conformance in `0021`.
