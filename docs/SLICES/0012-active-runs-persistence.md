# Slice 0012: Server-authoritative active-runs, SSE-rehydrated

> Derived from diagnosis [`0011`](0011-ux-clarity-and-outreach-audit.md)
> findings **(a)/(b)/(c)** — the #1 trust-breaker. Addresses BRIEF symptoms 1 and
> the "handle multiple things simultaneously" wish.

## Intent

**Plain English:** When a process is running (keyword scrape, batch outreach,
premium analysis) and you switch tabs or come back later, the run must still be
on screen — picked up from the server, which is the real source of truth — and
you must be able to see several runs at once. Today only the polygon map-scrape
survives a tab switch; everything else disappears because its progress lived only
in the screen you left.

**Project vocabulary:** Make the server the source of truth for *all* active
runs and rehydrate the client on mount via the existing connect-time SSE
`snapshot` mechanism, exactly as the polygon scrape already does
(`sse.ts:27-61` → `App.tsx:40-104`). Add a single active-runs read-model and a
thin always-mounted "active runs" strip so runs persist across unmount and render
concurrently. No polling — pure SSE + one GET on mount.

## Out of scope

- Cancel/pause semantics changes — reuse existing batch/scrape controls.
- New run *types*. Only surfacing what already runs (scrape, keyword, batch,
  premium).
- Reworking the polygon-scrape path — it already works; it's the template.
- Any redesign of the run components' internals beyond hydration.

## Constraints (`docs/SPEC.md`)

- **SSE only.** No polling loop, no `setInterval` fetch, no WebSocket. The
  rehydration extends `sse.ts register()`'s snapshot emission; the GET is a
  one-shot on mount, not a poll.
- **Client hooks call `lib/api.ts` only** (`rules/architecture.md`). The
  active-runs read goes through `lib/api.ts`, consumed by a hook — no `fetch(` in
  `.tsx`.
- **Additive schema only.** Batch runs already persist (`batch_runs`,
  `listRunsByStatus`); keyword runs are currently *synchronous and unpersisted*
  (`runKeywordJobSync`) — if keyword runs need to survive, add an additive
  `keyword_runs` row or reuse `scrape_jobs`. Decide in diagnosis below; prefer
  reuse.
- **Reuse the run registry** — `batchOrchestrator.activeRuns` /
  `listRunsByStatus` and `scrape_jobs`. Do not build a parallel tracker.

## Diagnose-first checklist

- [ ] Files to read: `server/src/sse.ts` (snapshot pattern), `client/src/App.tsx`
      (snapshot consumer + tab unmount), `client/src/hooks/useKeywordRun.ts`,
      `client/src/hooks/useStageProgress.ts`, `client/src/pages/Outreach.tsx`
      (batch state), `server/src/services/batchOrchestrator.ts` (activeRuns +
      listRunsByStatus), `server/src/db/batch.ts`, `server/src/routes/batch.ts`,
      `server/src/services/jobRunner.ts` (runKeywordJobSync — is a keyword run
      durable?).
- [ ] Symbols to catalog: `register()`, `broadcast()`, `snapshot` event shape;
      `batch_runs` columns + `listRunsByStatus`, `getBatchRun`; `scrape_jobs`
      status set; the keyword run lifecycle (does anything persist mid-run?);
      every `*:progress` / `*:stage` SSE event already emitted.
- [ ] Key question: **does a keyword run persist anywhere server-side?** If
      `runKeywordJobSync` is fully synchronous with no row, it cannot be
      rehydrated without an additive row OR moving its progress onto a
      `scrape_jobs`-style record. Establish file:line before choosing.
- [ ] Online topics: SSE `Last-Event-ID` replay vs. connect-time snapshot
      (snapshot is simpler and already proven here); durable-store-for-progress
      pattern. (Sources already cited in `0011`.)
- [ ] Open questions for the operator: should the active-runs strip be global
      (always-visible across all tabs) or per-relevant-tab? Recommend global,
      compact, top-of-app.

## Implementation plan

_Draft — operator approves before edits._

- Step 1 — Server read-model `getActiveRuns()` returning a typed union of active
  runs from durable sources: `scrape_jobs` (running/error), `batch_runs`
  (running/paused via `listRunsByStatus`), premium-analysis queue, and keyword
  runs (per the diagnosis decision). *Verify:* unit-call returns the live batch +
  scrape rows that SQL shows as active.
- Step 2 — `GET /api/runs/active` in a route → service → db (layering).
  *Verify:* `curl` returns the active set while a batch + scrape run.
- Step 3 — Extend `sse.ts register()` to also emit a connect-time
  `runs:snapshot` event with the same `getActiveRuns()` payload (alongside the
  existing scrape `snapshot`). *Verify:* open a second browser/tab mid-run → it
  receives the snapshot immediately.
- Step 4 — Client `useActiveRuns()` hook (via `lib/api.ts`): hydrate from
  `runs:snapshot` on mount + GET fallback, then keep current via the existing
  `batch:progress` / `keyword:*` / `premium:progress` / `job:*` events. *Verify:*
  start a batch, switch tabs, return → run still shown.
- Step 5 — Always-mounted compact "Active runs" strip (top of `App`, like the
  tab strip) listing each run with type, stage label, live count, and a link to
  its tab. *Verify:* two concurrent runs (scrape + batch) both visible at once;
  survives tab switches and a full page reload.
- Step 6 — Point the existing per-tab components (`useKeywordRun`,
  `Outreach.batchProgress`) at the hydrated store so a returned-to tab shows the
  in-flight run, not idle/empty. *Verify:* return to Scraper mid-keyword-run →
  stage tracker resumes, not `idle`.

## Verification gate

_Filled DURING execution with live evidence (2026-06-23)._

- [x] `curl /api/runs/active` → JSON listing the live runs. With a paused batch +
      premium queue + a mid-flight keyword run present, returned:
      ```json
      {"type":"batch","runId":"90879592-…","status":"paused","total":25,"processed":17,"queuedForSend":15,"failed":2,"pauseReason":"user_paused"}
      {"type":"premium","running":1,"pending":6}
      {"type":"keyword","jobId":"sduQF23-…","runId":"verify-0012-runid","stage":"scraping","query":"test cafe palermo verify0012","startedAt":"2026-06-23T14:58:48.289Z"}
      ```
- [x] Log line on a fresh SSE connection (`curl /events`): server logged
      `[sse] register() emitting runs:snapshot — 2 active run(s)`, and the stream
      carried both the unchanged polygon `snapshot` event AND the new
      `runs:snapshot` event with the batch + premium payload.
- [x] SQL — `batch_runs` active row matches the strip:
      `[{"id":"90879592-…","status":"paused"}]` (the read-model includes
      `paused` as an active/held run). Keyword durability across its lifecycle:
      mid-flight `scrape_jobs` row = `{status:running, run_kind:keyword,
      keyword_stage:scraping, keyword_run_id:verify-0012-runid}`; on completion
      `{status:done, keyword_stage:done}` and it left `/api/runs/active`
      (`types: ["batch","premium"]`, keyword absent). Keyword scrape itself worked
      end-to-end: `{"added":11,"deduped":1}`.
- [x] `npx tsc --noEmit` clean — server (in dev container) **and** client
      (`TypeScript: No errors found`), after every phase.
- [ ] Browser screenshot of two concurrent runs in the strip + tab-switch/reload
      persistence: **data layer fully verified above**; the strip is a thin
      renderer over `/api/runs/active` (one-shot GET on mount) + `runs:snapshot`,
      so reload-rehydration is structural. Visual confirmation in the running dev
      client (`:5173`) is the one remaining manual check.

### Diagnosis-driven fixes captured during execution
- **Graveyard guard:** first live `curl` returned 40+ historical `status='error'`
  polygon `scrape_jobs` rows. Tightened `listActiveScrapeJobs` to `status='running'`
  only — the strip tracks live runs; the Scraper tab's own `snapshot` event still
  surfaces the latest error.
- **Restart safety:** keyword rows left `running` by a restart are marked `error`
  in `resumeOrphanedJobs` (synchronous runs can't resume); both that loop and the
  polygon snapshot exclude `run_kind='keyword'`.

## Completion record

- Commit SHAs: _uncommitted (working tree)._
- What changed:
  - **Server — keyword durability (producer):** additive nullable `scrape_jobs`
    columns `run_kind` / `keyword_stage` / `keyword_run_id` (`db/schema.ts`,
    idempotent ALTERs in `db/migrate.ts`). `runKeywordJobSync` now inserts the row
    as `status='running', run_kind='keyword'`, persists each stage alongside the
    existing `keyword:*` broadcasts, and flips to `done`/`error` terminally
    (`services/jobRunner.ts`). `resumeOrphanedJobs` excludes + error-marks keyword
    rows; `sse.ts` polygon snapshot excludes `run_kind='keyword'`.
  - **Server — read-model:** `db/activeRuns.ts` (running scrapes + running keyword
    runs), `db/premium.ts` `countRunningAnalyses()`, `services/activeRuns.ts`
    `getActiveRuns()` typed union (scrape / keyword / batch / premium-aggregate),
    `GET /api/runs/active` (`routes/runs.ts` + mounted in `index.ts`), and
    connect-time `runs:snapshot` SSE emission in `sse.ts`.
  - **Client — strip + store:** `lib/activeRunsApi.ts` (`ActiveRun` mirror + GET),
    `hooks/useActiveRuns.ts` (GET-on-mount + `runs:snapshot` + live-event patching,
    no polling), `components/ActiveRuns/ActiveRunsStrip.tsx` always-mounted in
    `App.tsx`, styles in `globals.css`.
  - **Client — per-tab resume:** `useKeywordRun.adopt(...)` + `KeywordPanel`
    adopt-on-mount; `Outreach` seeds `batchProgress`/`batchRunIdRef` from
    `getActiveRuns()` on mount.
- Follow-ups / new parked items:
  - Browser screenshot of the strip (two concurrent runs + reload) — data layer
    verified; visual confirmation outstanding.
  - Test artifact: a `scrape_jobs` keyword row + 11 real businesses from query
    `"test cafe palermo verify0012"` remain in the dev DB (valid leads; left in
    place — harmless, dedup-safe).
  - Premium aggregate row refreshes via boundary refetch on `premium:progress`;
    fine for this app's volume. Revisit only if event chatter becomes an issue.
