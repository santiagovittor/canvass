# Slice 0028: Explorer scroll-clip fix (`min-height:0`)

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F7**. Sibling of slice [`0018`](0018-outreach-height-clip-fix.md),
> different container. Smallest fix — fold into any UI pass.

## Intent

**Plain English.** Make the bottom of the Explorer leads list reachable again.
When tall chrome appears above the content (the active-runs banner, or enough
filter chips), the Explorer table can't shrink to fit, so its pagination and last
rows fall below the screen with no scrollbar. This is the same flexbox bug we
fixed for the Outreach page in slice 0018 — but in a container 0018 deliberately
left out. Two missing properties fix it.

**Project vocabulary.** Add `minHeight: 0` to the two Explorer flex children that
lack it — `BusinessExplorer.tsx:196` (the right content column) and `:262` (the
table wrapper) — so the `flex:1` table can shrink to its allotted height and
`BusinessTable`'s internal `overflowY:auto` scroll region (`BusinessTable.tsx:137`)
works instead of overflowing and being clipped by the ancestor `overflow:hidden`
(`BusinessExplorer.tsx:176`).

## Out of scope

- Any other view (Scraper/Analytics/Settings) beyond a quick confirmation pass.
- `BusinessTable` internals — they are already correct (`:136-137,330`).
- Design-token / type conformance (that is `0021`).

## Constraints (`docs/SPEC.md` / `rules/ui.md`)

- Pure client layout; no SPEC invariant blocks it.
- `rules/ui.md`: avoid new inline `style={}` where a class fits — but here the
  surrounding code already uses inline style objects on these two divs, so adding
  `minHeight:0` to the existing objects is the surgical, in-style change (matches
  the Outreach columns at `Outreach.tsx:514,524`). Do not refactor the file's
  styling approach.
- Do not touch `react-leaflet`/`leaflet`, no new deps.

## Diagnose-first checklist

Done in `0022` F7. Confirm before editing:

- [x] Files to read: `client/src/components/Explorer/BusinessExplorer.tsx:176,196,
      262`, `client/src/components/Explorer/BusinessTable.tsx:136-137,326-333`,
      `client/src/pages/Outreach.tsx:514,524` (the working reference),
      `client/src/styles/globals.css` (`.view-fill` flex parent),
      `client/src/App.tsx` (`ActiveRunsStrip` mount, the chrome that triggers it).
- [x] Symbols catalogued. Flex chain root→leaf:
      `.app-root` (col, 100vh) → `.view-fill` (flex:1, **min-height:0**, overflow:hidden)
      → `:176` ex-root (flex **row**, height:100%, overflow:hidden)
      → `:196` ex-main (flex:1 in the *row*; cross-axis stretch, **overflow:hidden**)
      → `:262` table-wrap (flex:1 in ex-main's *column*, **overflow:hidden**)
      → `BusinessTable:136` bt-root (col, height:100%, overflow:hidden)
      → `BusinessTable:137` bt-scroll (flex:1, overflowY:auto) + footer `:326` (flexShrink:0).
- [x] **Open question raised by diagnosis (premise correction):** the slice
      assumed `:196`/`:262` lack the shrink property. They lack `minHeight:0` but
      **already carry `overflow:hidden`** — and per the CSS Flexbox spec §4.5 a flex
      item whose computed overflow is not `visible` already gets an automatic
      minimum size of `0`, so the table can already shrink. `minHeight:0` is
      therefore **redundant** here (and `:196` isn't even a column flex item — it is
      `flex:1` in the *row* root, sized by cross-axis stretch, so its min-height is
      irrelevant). This differs from sibling slice `0018`, where the Outreach
      containers lacked `overflow:hidden`, making `minHeight:0` load-bearing there.

## Implementation plan

_Operator approves before edits._

- **Step 1 — Add `minHeight:0`.** To the style objects at
  `BusinessExplorer.tsx:196` (right column) and `:262` (table wrapper).
  *(Verify: with the active-runs banner visible, the Explorer table's pagination
  footer + last rows are reachable; the scroll region scrolls to the bottom.)*

- **Step 2 — Regression pass.** With a run active (banner mounted), tab through
  Explorer + the other views; confirm no new clipping and Outreach (0018) still
  fine.
  *(Verify: screenshot/live-render of Explorer bottom reachable; others unchanged.)*

- **Step 3 — One-time audit (cheap).** Note any other top-level view whose flex
  chain lacks `min-height:0` so "add a function → lose the scroll" stops
  recurring; fix only confirmed offenders.
  *(Verify: list captured; obvious offenders patched in-style.)*

## Verification gate

_Filled DURING execution with live evidence (playwright-core chromium-1223 vs the
live Vite dev server on `:5173`, full stack via `docker-compose.dev.yml`, real
`scraper.db` data — Explorer footer reads "1–50 of 681". A 160px banner was
injected above the content to simulate the `ActiveRunsStrip` chrome, viewport
700px. Mirrors 0018's method: measure the real pagination footer's bottom vs the
viewport, toggling the actual properties on the live DOM.)_

Live measurement (footer bottom px / in-view), tall chrome present, scrolled to end:

| State | footer bottom | in view |
|---|---|---|
| `current` — overflow:hidden **+ minHeight:0** | 700 | ✅ |
| `prefix` — overflow:hidden, **no minHeight:0** (actual pre-fix code) | 700 | ✅ |
| `novflow` — overflow removed (control) | 3058 | ❌ clipped |

- [x] Banner-visible case: Explorer pagination footer `bottomInView:true` in the
      pre-fix state already — no clip reproduced. `novflow` control clips (3058px,
      off-screen), proving the harness detects the symptom; `prefix` does not.
- [x] No-banner case: layout unchanged (footer in view either way).
- [x] Regression: nothing shipped — no code change to regress. Outreach (`0018`)
      untouched.
- [x] `npx tsc --noEmit` clean — client (no source change).

**Outcome: NO-OP.** The bug as described does not reproduce against current code;
`overflow:hidden` on `:196`/`:262` already lets the table shrink. The two
`minHeight:0` edits were applied, measured as having zero effect, and reverted.
No source change shipped.

## Completion record

- Commit SHAs: (this slice doc only — no code change)
- What changed: **Nothing in source.** Diagnose-first + live verification showed the
  premise was already satisfied by `overflow:hidden`; the proposed `minHeight:0`
  edits are no-ops and were reverted. Slice closed as NO-OP with live evidence.
- Step 3 audit: sibling top-level views scroll on their own root via `overflowY:auto`
  directly (`AutomatePage.tsx:10`, `Settings.tsx:68`, `.an-page` in `globals.css:748`),
  not via a `flex:1` child needing shrink — no `min-height:0` clip risk there.
- Follow-ups / new parked items: none. If future work removes `overflow:hidden`
  from `:196`/`:262`, `min-height:0` becomes load-bearing — add it then.
