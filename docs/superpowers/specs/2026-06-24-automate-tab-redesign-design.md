# Automate tab redesign — design spec

_Date: 2026-06-24. Supersedes the minimal slice 0019 Automate page. Driven by
`docs/FEEDBACK.md`._

## Problem

The first Automate cut (slice 0019) shipped three real defects and a thin scope:

1. **Looks unfinished / left-floating.** `AutomatePage` renders a `maxWidth: 720`
   card left-aligned inside a full-width area, so it reads as a small box stuck
   to the left, not a page.
2. **Outreach filters overflow.** `LeadQueue`'s mode-pill row
   (`Nuevos / Follow-up / Respondieron / Sin sitio`, `LeadQueue.tsx:228`) has no
   `flexWrap`; in the 300px left column the last pill is clipped.
3. **No actual automation story.** It is just the batch runner moved to a tab.
   There is no lead selection, no draft review/edit, no send control, and the
   scrape scheduler lives elsewhere (Scraper sidebar).

The operator wants the Automate tab to tell one story —
**ingest → prepare → send** — and to look engaging, not rudimentary.

## Goal

A full-width Automate page that reads top-to-bottom as the lead pipeline, lets
the operator pick exactly which leads to prepare, review/edit the resulting
drafts, and schedule or send them — reusing the existing backend end to end. No
new orchestration; presentation + selection + thin SSE/reads + existing
mutations.

## Decisions (locked with operator 2026-06-24)

- **Layout:** vertical narrative lanes (not kanban, not wizard).
- **Prep flow:** stage (checklist) → run → review drafts → schedule/send. Inline
  draft edit happens **after** compose (mid-batch the email doesn't exist yet).
- **No new UI library.** `architecture.md` / `ui.md` UI-kit ban stays. Build with
  the existing token system + new custom primitives.
- **Build all at once** (single delivery), but internally verified per lane.

## Layout

`AutomatePage` = full-width scroll container; inner content centered at
`max-width: 1200px` with comfortable padding (24–32px). Three numbered lanes
stacked top→bottom, each a resting panel (`--bg-panel`, `--border`,
`--radius-pane`) with a `LaneHeader` (number badge + title + lane status).

```
AUTOMATE  (full width, centered max-1200)
  ① INGEST    scrape scheduler status + schedules
  ② PREPARE   lead staging checklist → run batch → live console + outcomes
  ③ SEND      scheduled-send queue: review/edit draft, send now, reschedule, cancel
```

## Lanes

### ① Ingest

- **Reuse** `ScrapeSchedulerStatus` + `SchedulesList` (today rendered in
  `Sidebar.tsx`). Show scheduler health (running/paused + next tick),
  pause/resume, and the schedule list with next/last run.
- **Tradeoff (explicit):** creating a schedule needs map geometry, so Automate
  hosts **status + management** (pause/resume, run-now, delete) only; the
  "create from current map polygon" entry point stays in the Scraper tab. Lane
  shows a one-line cross-link to Scraper for creation.
- API: `scrapeSchedulesApi` (`listScrapeSchedules`, `getScrapeSchedulerStatus`,
  `pauseScrapeScheduler`, `resumeScrapeScheduler`, `runScrapeScheduleNow`,
  `deleteScrapeSchedule`). Live via existing `scrape-scheduler:tick` SSE.

### ② Prepare

- **Lead staging table** (new primitive `SelectableTable`): deliverable new-mode
  leads (`getOutreachLeads(page, { validEmail: true })`). Columns: checkbox,
  name, category, country. Header checkbox = select-all (current page). Quick
  helpers: "select first 15 / 30 / 60". Search box (reuses the leads `search`
  filter). Selection count + "Preparar N seleccionados" primary action.
- **Run on selection:** `useBatchRun.start(selectedIds, dryRun)` (the hook
  already accepts explicit ids). Dry-run toggle retained.
- **Live console (redesigned, engaging):** progress bar, ETA, elapsed,
  accumulated cost, per-disposition counts, current lead name + live
  `StageTracker`, expandable per-lead `OutcomeList` with reasons. This is the
  existing `BatchConsole` content, restyled to sit inside the lane (no more
  standalone 720px card) and visually richer (metric cards, clearer state).
- Honest `pauseReason` seam preserved for slice 0020.

### ③ Send / Review

- **Scheduled-send queue** (`listScheduled()` → `ScheduledSend[]`, plus
  `getScheduledQueueStatus()` for counts/health). After a batch enqueues,
  prepared leads appear here.
- **Per-row actions (all existing endpoints):**
  - Edit draft inline (`InlineDraftEditor`): `loadDraft(businessId)` →
    `saveDraft(businessId, subject, body, isAiDraft)`.
  - Send now: `sendOutreachEmail(...)`.
  - Reschedule: `rescheduleScheduled(id, sendAtUtc)` (uses `baLocalToUtcIso`).
  - Cancel: `cancelScheduled(id)` / `cancelScheduledById(id)`.
- **Bulk:** cancel-all (`cancelAllPending`), and a guarded "send all now".
- Scheduler pause/resume already available (`pauseScheduler`/`resumeScheduler`);
  surface its status here too so Send has its own health line.
- Live via existing `send-scheduler:tick` SSE.

## New custom primitives (`client/src/components/ui/`)

- `Checkbox` — token-styled, accessible (`role`/`aria-checked`, keyboard).
- `SelectableTable` / `SelectableRow` — generic dense selectable table; used by
  the staging list (and reusable later).
- `LaneHeader` — numbered step badge + title + right-aligned status slot.
- `InlineDraftEditor` — subject + body editor with save/cancel, opens in-row.

Reuse: `StageTracker`, `Disclosure`, existing pill styles,
`.btn-primary`/`.btn-secondary`, all `globals.css` tokens. Any missing token
(spacing/size/animation) is added to `globals.css` first — no raw hex, no
sub-12px.

## Hooks / lib (no `fetch(` in `.tsx`)

- `useLeadStaging` — fetch staging leads + own selection state (Set of ids,
  toggle, select-all, select-first-N, search). No HTTP beyond `outreachApi`.
- `useScheduledSends` — one-shot `listScheduled` + `getScheduledQueueStatus`,
  refreshed on `send-scheduler:tick` SSE (event-driven, not a poll); exposes
  edit/send/reschedule/cancel passthroughs.
- `useScrapeSchedules` — one-shot `listScrapeSchedules` + status, refreshed on
  `scrape-scheduler:tick` SSE.
- `useBatchRun` — reused as-is.

## Backend

Reuse-only. No new routes expected; every action maps to an existing endpoint
(`outreachQueue.ts` send/draft/schedule/scheduled, `scrapeSchedules` routes,
`batch` routes). If the Prepare→Send handoff needs the draft preview alongside a
scheduled row and no existing read provides it, add **one additive** field to an
existing read — not a new orchestration path. Default expectation: zero server
change beyond what slice 0019 already landed.

## Bug fixes folded in

- `LeadQueue.tsx:228` mode-pill row → `flexWrap: 'wrap'` (and audit the other
  filter rows in that column for the same clipping).
- Automate width → resolved by the new full-width layout.

## Out of scope

- Moving scrape-schedule **creation** out of the Scraper tab (needs map
  geometry).
- Removing the Outreach right-rail scheduled-send console (operator may keep it;
  the Automate Send lane is additive, not a forced migration). Revisit later.
- The provider-quota banner (slice 0020) — keep the `pauseReason` seam honest.
- Full design-token sweep (slice 0021) — build clean, don't do the global pass.

## Verification (nothing hidden)

Per lane, ending with `npx tsc --noEmit` clean (client + server in container):

- Outreach filters: no clipping at the 300px column; all pills reachable.
- Automate: full-width, lanes render, no left-floating box.
- Prepare: select/deselect + select-all + first-N work; run uses exactly the
  selected ids; live console advances; outcomes list shows reasons.
- Send: queue lists scheduled rows; edit persists (`saveDraft` round-trip);
  send-now sends; reschedule/cancel work; SSE updates the list without polling.
- Ingest: scheduler status + schedules render; pause/resume reflected live.
- Final: drive the live SPA (playwright over the dev browser) and screenshot
  each lane; write evidence back. No `setInterval` data poll, no WebSocket, no
  new UI-kit dep, SSE only.

## File plan (anticipated)

- Edit: `client/src/components/Automate/AutomatePage.tsx` (rewrite as lanes),
  `client/src/components/Automate/BatchConsole.tsx` (restyle into Prepare lane),
  `client/src/components/Outreach/LeadQueue.tsx` (flexWrap fix),
  `client/src/components/Sidebar/Sidebar.tsx` (share scheduler components).
- New: `client/src/components/Automate/IngestLane.tsx`,
  `PrepareLane.tsx`, `SendLane.tsx`, `LaneHeader.tsx`;
  `client/src/components/ui/{Checkbox,SelectableTable}.tsx`,
  `client/src/components/Automate/InlineDraftEditor.tsx`;
  `client/src/hooks/{useLeadStaging,useScheduledSends,useScrapeSchedules}.ts`.
- Reuse: `useBatchRun`, `StageTracker`, `Disclosure`, `outreachApi`,
  `scrapeSchedulesApi`, `batchApi`, `activeRunsApi`.
