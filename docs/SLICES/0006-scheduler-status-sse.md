# Slice 0006: Scheduler status over SSE (remove polling)

## Intent

Replace the 15-second `setInterval` polling in the scheduler-status components
with the existing SSE channel. Diagnosed in
[0002](0002-text-query-ui-clarity-audit.md) (finding F6): `ScrapeSchedulerStatus`
polls every 15s (`ScrapeSchedulerStatus.tsx:18`) and the outreach
`SchedulerStatus` does the same — both violate the SSE-only rule and are the
"costful" repeated-fetch pattern the operator explicitly wants avoided. This is
a rule-compliance cleanup, not an operator-visible feature.

**Project vocabulary:** broadcast scrape-scheduler tick/health over `broadcast()`
and consume via `useSSE`; delete the `setInterval(refresh, …)` loops.

## Out of scope

- No change to scheduler behavior, tick cadence, or pause/resume semantics.
- No visual redesign of the status component — same data, push instead of poll.
- Keyword live-status (0003) is separate; this slice only de-polls the existing
  scheduler widgets.

## Constraints

- **SSE only** (`.claude/rules/ui.md`): the fix must use `broadcast()`
  (`server/src/sse.ts:64`) + `useSSE`, not a different cadence of polling.
- **Reuse the scheduler health source** — `getScrapeSchedulerHealth()`
  (`scrapeSchedulerWorker.ts:37-51`) already computes everything; emit it on
  tick rather than serving it on demand.
- **No business logic in components** — the component renders pushed state.
- **Surgical** — swap the data source; keep the markup.

## Diagnose-first checklist

Diagnosis complete in 0002 (F6). Confirm before editing:

- [ ] Files to read: `client/src/components/Scraper/ScrapeSchedulerStatus.tsx`
      (poll at :16-20), `client/src/components/Outreach/SchedulerStatus.tsx`
      (same pattern), `server/src/services/scrapeSchedulerWorker.ts`
      (`tick` 64-149, `getScrapeSchedulerHealth` 37-51),
      `server/src/services/scheduledSendWorker.ts` (outreach scheduler health),
      `server/src/sse.ts`, `client/src/hooks/useSSE.ts`,
      `client/src/lib/scrapeSchedulesApi.ts`.
- [ ] Symbols to catalog: `getScrapeSchedulerHealth`, `getSchedulerHealth`
      (outreach), `getScrapeSchedulerStatus` (current poll endpoint),
      existing SSE event names (avoid collisions).
- [ ] Decide event names: e.g. `scrape-scheduler:tick`,
      `send-scheduler:tick`. Emit at the end of each `tick` (and on
      pause/resume) carrying the health payload + recent runs.
- [ ] Note: recent-runs list is also fetched — decide whether to push it in the
      tick event or keep a one-time fetch on mount (one fetch on mount is fine;
      the ban is on *polling loops*, not initial loads).
- [ ] Open questions: none.

## Implementation plan

_Proposed; operator approves before edits._

- Step 1 — Emit `scrape-scheduler:tick` (health + recent runs) at the end of
  `tick()` and on `setScrapeSchedulerPaused`. Do the same for the outreach
  scheduler (`scheduledSendWorker`). *(Verify by: `curl -N /events` prints a
  tick event every ~60s and immediately on pause/resume.)*
- Step 2 — In both status components, fetch once on mount for the initial
  snapshot, then subscribe via `useSSE`; delete the `setInterval` refresh.
  *(Verify by: grep shows no `setInterval` in the components; status still
  updates live on tick/pause.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-22)._

- [x] `curl -N http://localhost:3001/events` → emits both events. Capture A
      (35s, 5504 bytes): `1 event: snapshot`, `1 event: send-scheduler:tick`.
      Capture B (pause+resume triggered): `2 event: scrape-scheduler:tick`,
      `1 event: snapshot`. Sample scrape payload:
      `data: {"health":{"lastTickAt":"2026-06-22T23:44:27.312Z","ticksTotal":17,
      "lastTickCounts":{…},"intervalMs":60000,…}` — full health + recentRuns.
- [x] grep: no `setInterval(` in `ScrapeSchedulerStatus.tsx`, outreach
      `SchedulerStatus.tsx`, or `pages/Outreach.tsx` (poll lived in the page,
      not the widget). "No matches found".
- [x] Pause pushes immediately: `POST /api/scrape-schedules/pause` then
      `/resume` (both 200) produced 2 immediate `scrape-scheduler:tick`
      broadcasts in the live capture — no 15s delay. `setScrapeSchedulerPaused`
      / `setPaused` broadcast at the choke point, covering route + any caller.
- [x] `tsc --noEmit` clean: server (in container) exit 0; client "No errors
      found".

## Completion record

- Commit SHAs: uncommitted (working tree) — pending operator.
- What changed:
  - Server: `scrapeSchedulerWorker.ts` + `scheduledSendWorker.ts` broadcast
    `scrape-scheduler:tick` / `send-scheduler:tick` (full status payload) at the
    end of each `tick()` and inside the pause setters. Added exported builders
    `getScrapeSchedulerStatusPayload()` / `buildScheduledQueueStatus()`; the
    `/status` routes (`scrapeSchedules.ts`, `schedulerStatus.ts`) now reuse them
    (no shape duplication, route→service→db layering intact).
  - Client: `ScrapeSchedulerStatus.tsx` and `pages/Outreach.tsx` fetch once on
    mount, then subscribe via `useSSE`; deleted both 15s `setInterval` loops.
    Outreach tick handler also refreshes the active lead's schedule row.
- Follow-ups / new parked items: per-lead `getLeadScheduleStatus` is now
  tick-driven (≤30s) instead of 15s polled — folded in, no separate loop left.
