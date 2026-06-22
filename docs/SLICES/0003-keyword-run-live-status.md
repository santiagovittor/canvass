# Slice 0003: Keyword-run live status (SSE stage tracker)

## Intent

Make a **Run Now** keyword scrape feel alive. Today the panel shows a disabled
"Running…" button, then a final Added/Deduped number — nothing in between
(diagnosed in [0002](0002-text-query-ui-clarity-audit.md), finding F1). This
slice emits a small set of stage events from the keyword path over the existing
SSE channel and renders a compact stage tracker in `KeywordPanel`:
submitting → scraping → saving → enriching → done, plus an elapsed timer and the
final count. Directly addresses the operator's #1 complaint ("no live status,
no real dynamic data") without polling and without a new backend system.

**Project vocabulary:** broadcast `keyword:*` stage events from
`runKeywordJobSync`; subscribe in a new `useKeywordRun` hook (or extend
`useSSE`) and render a stage tracker component in the keyword view.

## Out of scope

- No precise mid-scrape business counter. gosom does not stream partial counts
  during a single keyword job (the count is only known after `downloadResults`
  — `jobRunner.ts:131`). Show stage + elapsed + final count, never a fake
  ticking counter.
- No change to the email gate — that is slice [0004](0004-keyword-email-enrichment-gate.md).
- No change to the polygon/Map flow or its `JobProgress`.
- No new realtime transport. SSE only.
- Not fixing the scheduler-status polling — that is slice 0006.

## Constraints

- **SSE only** (`.claude/rules/ui.md`, `SPEC.md`). Reuse `broadcast()`
  (`server/src/sse.ts:64`) and the client `useSSE` consumer (`App.tsx:40-104`).
  No `setInterval`, no polling, no WebSocket.
- **Reuse `runKeywordJobSync`** (`SPEC.md` registry) — extend it with emits, do
  not fork it.
- **No business logic in components** (`.claude/rules/architecture.md`) — the
  stage state lives in a hook; the component renders it.
- **Numbers in `JetBrains Mono`**, no native `<progress>`, dark surfaces, accent
  glow on the active stage (`ui.md` aesthetics). Match the existing
  `JobProgress` visual language (`Sidebar/JobProgress.tsx`) so the two scrape
  flows feel like one product.
- **One deliberate motion** (active-stage accent ramp), not `transition-all`.

## Diagnose-first checklist

Diagnosis is largely complete in 0002. Confirm before editing:

- [ ] Files to read: `server/src/services/jobRunner.ts` (`runKeywordJobSync`
      113-155, `pollUntilDone` 393-450), `server/src/sse.ts`,
      `client/src/components/Scraper/KeywordPanel.tsx`,
      `client/src/hooks/useSSE.ts`, `client/src/App.tsx` (SSE handlers),
      `client/src/components/Sidebar/JobProgress.tsx` (visual reference).
- [ ] Symbols to catalog: `broadcast`, `useSSE`, `instantKeywordScrape`,
      the keyword run's `jobId` (currently `randomBytes`, ephemeral —
      coordinate with 0004 which may persist it).
- [ ] Decide: does `KeywordPanel` need the run's `jobId` to scope events? If
      0004 lands first, a real `scrape_jobs` row gives a stable id; if 0003
      lands first, scope by a client-generated correlation id passed in the
      POST body and echoed in events.
- [ ] Online topics: none new — see 0002 sources [1][2][3][7][8].
- [ ] Open questions: none outstanding (O1 resolved: runs are from
      Scraper→Keywords).

## Implementation plan

_Proposed; operator approves before edits._

- Step 1 — Emit stage events from `runKeywordJobSync`: `keyword:started`
  (with a correlation id + query), `keyword:stage` (`scraping` after gosom job
  created, `saving` before upsert, `enriching` after `kickEnrichment`),
  `keyword:done` (with `added`/`deduped`), `keyword:error`. Carry a correlation
  id so multiple tabs don't cross-render. *(Verify by: server log shows each
  `broadcast('keyword:…')`; `curl -N /events` prints the events during a run.)*
- Step 2 — Thread the correlation id through `POST /api/keyword-scrape/instant`
  (`routes/keywordScrape.ts`) and `instantKeywordScrape`
  (`lib/keywordScrapeApi.ts`) so the client can match events to its run.
  *(Verify by: id in request body appears in every emitted event.)*
- Step 3 — Add a `useKeywordRun` hook subscribing to `keyword:*`, exposing
  `{ stage, elapsedMs, added, deduped, error }`. Local 1s clock for the elapsed
  timer (render-only, like `JobProgress.tsx:46-52`), no fetching.
  *(Verify by: hook state transitions match the SSE events.)*
- Step 4 — Render a compact stage tracker in `KeywordPanel` (3-5 labelled
  steps, active step accent-glow, elapsed in mono, "~90s typical" hint). Replace
  the bare "Running…" with the tracker; keep the final Added/Deduped.
  *(Verify by: screenshot of a live run showing stage advance + elapsed.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-22)._

- [x] Log line — server container logs during a real run:
      ```
      server-1 | [jobRunner] broadcast keyword:stage scraping run=verify-0003-abc
      server-1 | [jobRunner] broadcast keyword:stage saving run=verify-0003-abc
      server-1 | [jobRunner] broadcast keyword:stage enriching run=verify-0003-abc
      ```
- [x] `curl -sN http://localhost:3001/events` during a real Run Now
      (`runId=verify-0003-ok`, query "zapateria in palermo buenos aires"):
      ```
      event: keyword:started
      data: {"runId":"verify-0003-ok","query":"zapateria in palermo buenos aires"}
      event: keyword:stage
      data: {"runId":"verify-0003-ok","stage":"scraping"}
      event: keyword:stage
      data: {"runId":"verify-0003-ok","stage":"saving"}
      event: keyword:stage
      data: {"runId":"verify-0003-ok","stage":"enriching"}
      event: keyword:done
      data: {"runId":"verify-0003-ok","added":16,"deduped":0}
      ```
      Run returned `{"added":16,"deduped":0}`, HTTP 200.
- [~] Screenshot: keyword panel mid-run (active stage + elapsed timer). NOT
      captured in this CLI session — no browser driver run. UI render is
      tsc-clean and driven entirely by the verified event flow above; the
      tracker advances on each `keyword:stage`, elapsed ticks via the render-only
      clock. Recommend a manual browser pass (or `/run`) to attach the image.
- [~] Screenshot: final state (Added/Deduped + "done" stage). Same as above —
      `keyword:done` carries `added=16`, which the panel renders in the existing
      `.kp-result` block + final "Done" stage.
- [x] No `setInterval`/polling added — `git diff` grep for
      `setInterval|setTimeout.*fetch|polling|WebSocket` returns none. The sole
      `setInterval` is the render-only elapsed clock in the new
      `useKeywordRun.ts` (untracked), mirroring `JobProgress.tsx:46-52`. No fetch
      loop, no new transport.
- [x] `npx tsc --noEmit` clean — client (`No errors found`) and server in
      container (exit 0), re-run after each phase.

## Completion record

- Commit SHAs: _pending — not committed (operator did not request commit)._
- What changed:
  - `server/src/services/jobRunner.ts` — `KeywordJobParams.runId?` added;
    `runKeywordJobSync` emits `keyword:started` / `keyword:stage`
    (scraping/saving/enriching) / `keyword:done`, wrapped in try/catch emitting
    `keyword:error` (rethrows to preserve the route 500 path). Fallback `runId`
    when caller omits it (scheduler).
  - `server/src/routes/keywordScrape.ts` — `runId` in `instantSchema`, threaded
    into `runKeywordJobSync`.
  - `client/src/lib/keywordScrapeApi.ts` — `runId?` on `InstantScrapeParams`
    (already forwarded via JSON body).
  - `client/src/hooks/useKeywordRun.ts` (new) — subscribes to `keyword:*` via
    `useSSE`, filters by `runId`, exposes `{ stage, elapsedMs, added, deduped,
    error, start, reset }` with a render-only elapsed clock. No fetching.
  - `client/src/components/Scraper/KeywordPanel.tsx` — mints
    `crypto.randomUUID()` per Run Now, calls `run.start`, passes `runId`,
    renders a 4-step stage tracker (active-stage accent glow, elapsed in mono,
    "~90s typical" hint); resets tracker on request-level failure.
  - `client/src/styles/globals.css` — `.kp-stages*` / `.kp-elapsed` /
    `kpStageGlow` keyframe, matching `JobProgress` visual language.
- Follow-ups / new parked items:
  - Visual screenshots still owed (CLI run had no browser driver).
  - When slice 0004 lands a persistent `scrape_jobs` row id, consider whether
    the keyword path should scope events by that stable id instead of the
    client `runId` (slice 0003 diagnose-first note).
