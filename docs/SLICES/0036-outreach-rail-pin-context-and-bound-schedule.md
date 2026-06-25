# Slice 0036: Outreach right rail — pin lead context, bound the schedule list

> **Implementation order: 3 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F5**. Small,
> self-contained UX fix.

## Intent

**Plain English.** When you're writing an email, the right-hand panel should keep
the business's info in front of you — its name, website, what the research found.
Right now a global list of every scheduled email sits at the top of that panel with
no height limit, so once a few emails are scheduled the list grows tall and shoves
the business info way down, and you have to scroll endlessly to see what you're even
writing about. Fix: keep the lead's identity pinned and visible, and put the
scheduled-emails list in its own bounded, collapsible box (or move it out of the
compose rail entirely — it isn't even specific to the lead you're on).

**Project vocabulary.** Restructure `BusinessContext.tsx` so the single
`overflowY:auto` column (`:312-326`) no longer renders the unbounded
`ScheduledSection` (`:34-43`, `flexShrink:0`, `items.map` over all rows) **above**
the lead identity. Pin lead name/category/website to the top; relocate the global
scheduled list + `SchedulerStatus` into a bounded region (max-height + internal
scroll) or a `Disclosure`/drawer with a count badge. Behavior (cancel, reschedule,
pause/resume) preserved.

## Out of scope

- The scheduler engine, queue semantics, governor, `scheduledSendWorker` — pure
  presentation change.
- `SchedulerStatus.tsx` internals beyond placement (unless it also grows unbounded;
  confirm during diagnose).
- The Explorer scroll bug (slice `0035`).
- Any change to what data is fetched (`listScheduled`, `getScheduledQueueStatus`).

## Constraints (`docs/SPEC.md` / `rules/ui.md`)

- **SSE-only realtime** — the scheduled list already updates via
  `send-scheduler:tick` (`Outreach.tsx:378`); do not add polling.
- `rules/ui.md`: dark geospatial console; raised/floating surfaces use
  `--shadow-*`, resting panels flat; **progressive disclosure** for secondary
  content is explicitly endorsed; JetBrains Mono for the times/counts; comfortable
  spacing, no tiny-type fix. Use the approved `Disclosure`/`InspectorPanel`
  primitives or build one in `client/src/ui/` if missing — no third-party UI kit.
- No new inline `style={}` except dynamic values; move repeated values to tokens if
  introducing new ones.
- `react-leaflet` pinned — the lead minimap (`BusinessContext.tsx:469`) stays as-is.

## Diagnose-first checklist

Done in `0033` F5 — confirm before editing.

- [x] Files to read: `client/src/components/Outreach/BusinessContext.tsx`
      (`ScheduledSection` `:26-126`, the two render columns `:278-307` empty-state
      and `:312-507` lead state), `client/src/components/Outreach/SchedulerStatus.tsx`
      (is it also unbounded?), `client/src/pages/Outreach.tsx:569-581` (props wiring),
      `client/src/ui/` (existing `Disclosure`/`InspectorPanel` primitives?).
- [x] Symbols to catalog: `ScheduledSection`, `SchedulerStatus`, `scheduled`,
      `queueStatus`, handlers `onCancelScheduled`/`onRescheduleScheduled`/
      `onPauseScheduler`/`onResumeScheduler`/`onCancelScheduledById`/
      `onCancelAllPending`.
- [x] Open question for operator: should the global scheduled list **stay** in the
      compose rail (bounded + collapsible) or **move** to a dedicated scheduler
      surface (it's global, not lead-scoped)? *Recommend: bound + collapse in place
      for this slice (smallest change that fixes the pain); a dedicated scheduler
      view can be a later parked item.* Also: what must be **always visible while
      composing** — name + website + the research chips? *Recommend pin name +
      category + website badge + `LeadResearch`; everything else can scroll.*

## Implementation plan

_Operator approves before edits._

- **Step 1 — Reorder the rail.** In `BusinessContext.tsx` lead-state column, move
  the lead identity block (name/flag `:328-340`, rating `:352`, category `:367`,
  location `:387`, website `:401`, `LeadResearch` `:440`) **above** the global
  `SchedulerStatus` + `ScheduledSection`. Lead context first, queue second.
  *(Verify: with 6+ scheduled sends, the lead name + website + research are visible
  without scrolling at the operator viewport.)*

- **Step 2 — Bound the scheduled list.** Wrap `ScheduledSection`'s item list in a
  region with `max-height` (≈ 3-4 rows) + `overflowY:auto` + `minHeight:0`, so N
  scheduled emails scroll *within* their box instead of growing the rail. Keep the
  count badge (`:50`) visible as the at-a-glance signal.
  *(Verify: 10 scheduled sends → the list box scrolls internally; the rail height is
  stable; lead context unaffected.)*

- **Step 3 — Collapse behind disclosure (progressive disclosure).** Put
  `SchedulerStatus` + the bounded scheduled list inside a `Disclosure` titled e.g.
  "Scheduled (N)" with the count badge, default collapsed when a lead is selected
  (so composing is unobstructed) and expandable on demand. Empty-state column
  (`:278`) can keep it open since there's nothing to compose.
  *(Verify: selecting a lead collapses the queue by default; expanding shows it
  bounded; cancel/reschedule/pause still work from inside.)*

- **Step 4 — Conformance + tsc.** Tokens for any new spacing/max-height; reduced-
  motion respected on the disclosure animation; JetBrains Mono on times/counts.
  *(Verify: `rules/ui.md` final-check list; `npx tsc --noEmit` clean, client.)*

## Verification gate

_Filled DURING execution with live evidence._

Method: Playwright (`playwright-core` 1.52 → `ws://playwright:3000`) driving the
live Vite app, **route-mocking** `/api/outreach/scheduled` (10 fake rows) +
`/api/scheduled/status` so no DB writes and no real emails were created;
non-destructive (cancel/reschedule never clicked). Viewport 1440×900,
`reducedMotion: 'reduce'`.

- [x] **Identity pinned, queue collapsed.** With 10 scheduled, lead "Mullen &
      Mullen Law Firm" selected: name + rating + category + website badge + phone
      + socials + minimap all visible without scrolling; `› Scheduled (10)`
      disclosure sits collapsed at the bottom (`panelOpen:"false"` by default;
      count badge `"10"` in JetBrains Mono). Screenshot `_0036-collapsed.png`.
- [x] **Bounded internal scroll at 10 items.** Expanded list box measured
      `clientHeight 168` (== `--scheduled-list-max-h`) vs `scrollHeight 490` →
      `scrolls: true`; rail height stable. Screenshot `_0036-expanded.png`.
- [x] **Behaviors intact in the bounded/collapsed region.** 10 Cancel + 10
      Reschedule buttons present in `ScheduledSection`; `SchedulerStatus`
      (Pause/Resume, heartbeat "2s ago", counts, cancel-all) renders inside the
      same disclosure — handlers unchanged (same props passed through).
- [x] **Reduced motion respected.** Under `reducedMotion: 'reduce'`,
      `getComputedStyle('.disclosure-panel').transitionDuration === '0s'` (handled
      by the existing Disclosure CSS, `globals.css:556-558`).
- [x] **`npx tsc --noEmit` clean (client).** Exit 0 after each phase.

## Completion record

- Commit SHAs: (this commit)
- What changed:
  - `client/src/components/Outreach/BusinessContext.tsx` — lead-state column
    reordered so lead identity renders first; `SchedulerStatus` + `ScheduledSection`
    relocated to the bottom inside the existing `Disclosure` primitive
    (`label="Scheduled"`, `count`, `defaultOpen={false}`). `ScheduledSection`'s
    item list wrapped in a `max-height` + `overflowY:auto` + `minHeight:0` scroll
    region (count-badge header stays fixed). Empty-state column unchanged.
  - `client/src/styles/globals.css` — new token `--scheduled-list-max-h: 168px`.
- Decision on the open question: **bound + collapse in place** (slice's own
  recommendation) — smallest change that fixes F5.
- Follow-ups / new parked items: a dedicated global scheduler surface (the queue
  is not lead-scoped) remains a parked option if it ever wants its own home.
- Reuse note: no new primitive — the slice-0016 `Disclosure` already animated and
  already respected `prefers-reduced-motion`, so steps 3 + 4 came for free.
