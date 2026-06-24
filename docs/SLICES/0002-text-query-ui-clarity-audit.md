# Slice 0002: Text-query UI clarity audit (DIAGNOSIS)

> **Diagnosis slice. No code edits.** The only deliverable is this written
> report — Findings + Recommended next slices. Fixes happen in follow-up slices
> the operator picks from the ranked list at the bottom.

## Intent

**Plain English:** When you type a search like "lawyers in new york" and hit
**Run Now**, the screen tells you almost nothing — the button says "Running…",
then a final "Added / Deduped" number pops in. No live count, no stage, no
time estimate. The businesses that land have no emails. And there are two
controls next to the search box — **Bulk** and **+ Backlog** — that you don't
use because nothing tells you what they did. This slice diagnoses *why* each of
those feels broken, with file-and-line evidence, and proposes surgical
directions (not fixes) ranked for you to choose from.

**Project vocabulary (one line):** Audit the keyword/instant scrape path
(`KeywordPanel` → `POST /api/keyword-scrape/instant` → `runKeywordJobSync`)
for (a) absent SSE progress emission, (b) email enrichment gated off because
the path writes no `scrape_jobs` row, and (c) distrust-inducing schedule
controls; recommend SSE-render-only and email-gate slices.

## Symptoms (operator's words)

- "the only information shown by the UI is 'running' and the option to pause or
  cancel, but does not show live status, estimated time, amount of businesses
  scraped or real dynamic data."
- "all the businesses that were added into the database lack emails… intuitively
  I think that is because the email is not scraped by default by gosom and in my
  current polygon pipeline there is a step that runs later and enrichs it."
- "there are functions i dont use because i dont trust like the 'bulk' or the
  'schedule'. All of this because of bad UX UI."
- Wants: "Clear information about status and data flow in real time… dynamic,
  fluid and beautiful to watch without being really costful."

## Out of scope

- **NO fixes in this slice.** Diagnosis only.
- **NO big rewrite.** Every proposed direction must be surgical (markup +
  small, localized backend emit). Explicitly rejected: replacing the scheduler,
  re-architecting the scrape pipeline, swapping the realtime transport.
- Not touching the polygon/Map scrape path except to compare against it.
- Not fixing the pre-existing 15s `setInterval` polling in `ScrapeSchedulerStatus`
  / outreach `SchedulerStatus` (noted as a finding, but its fix is its own slice).
- Not adding gosom-side email extraction (settled decision: gosom email jobs
  stall the worker pool — `jobRunner.ts:307-312`).

## Constraints (SPEC invariants + rules that bind any future fix)

- **SSE only for realtime** — `.claude/rules/ui.md` ("Realtime: SSE only at
  `/events`. No polling, no `setInterval` fetches, no WebSocket"); `SPEC.md`
  Stack snapshot. The infra already exists (`server/src/sse.ts`,
  `App.tsx` `useSSE`). Any live-status fix reuses it; do not introduce polling.
- **Client hooks call `lib/api.ts` only** — `.claude/rules/architecture.md`
  (client/src/hooks). `KeywordPanel` currently calls `lib/keywordScrapeApi.ts`
  directly from the component, which is acceptable (it's an api module), but a
  live-status hook belongs in `hooks/` consuming SSE, not a `fetch` in the .tsx.
- **lat/lng as strings** — `SPEC.md` invariants; relevant if geoBias surfacing
  is touched.
- **Reuse-only registry** — `runKeywordJobSync` is the canonical keyword entry
  (`SPEC.md` registry); do not reimplement, extend.
- **Number rendering** — every count/timer/coordinate in `JetBrains Mono`
  (`ui.md`), no native `<progress>`, no `Loading...`, dark surfaces only.
- **No false absence claims** — every finding below cites file:line.

## Diagnose-first checklist — results

### (a) Run-status data flow: what the keyword run actually emits

**The keyword/instant path broadcasts ZERO SSE events.** Traced end to end:

- Entry: `KeywordPanel.handleRunNow` → `instantKeywordScrape`
  (`client/src/components/Scraper/KeywordPanel.tsx:34`,
  `client/src/lib/keywordScrapeApi.ts:28`) → `POST /api/keyword-scrape/instant`
  (`server/src/routes/keywordScrape.ts:19`) → `runKeywordJobSync`
  (`server/src/services/jobRunner.ts:113`).
- `runKeywordJobSync` (`jobRunner.ts:113-155`): create gosom job → `pollUntilDone`
  → `downloadResults` → `upsertRawResults` → `kickEnrichment()` → return
  `{ added, deduped, businessIds }`. **No `broadcast(...)` call anywhere in this
  function.**
- Contrast the polygon path `runJob` (`jobRunner.ts:259-366`) which broadcasts
  `job:started` (`:292`), `job:progress` (`:338`), `businesses_updated`
  (`:341`), `job:scraped` (`:350`), `job:done` (`:356`), `job:error` (`:362`).
  Those feed `App.tsx` `useSSE` (`App.tsx:40-104`) → `JobProgress`.

**Dynamic data that EXISTS server-side but is never rendered for keyword runs:**

- Final `added` / `deduped` — returned in the HTTP body, rendered only *after*
  completion (`KeywordPanel.tsx:208-217`). Not live.
- `enrich:progress` `{ jobId, done, total }` IS broadcast during enrichment
  (`enrichmentQueue.ts:78`) — but keyed to a `jobId` the keyword UI never
  learns/subscribes to, so the email/social fill-in is invisible here.
- gosom poll state (`working` / `pending` / row-count probes) exists inside
  `pollUntilDone` (`jobRunner.ts:393-450`) but is logged, never surfaced.

### (b) UI render gap: why the UI only shows "running"

**The data is missing at the source, AND the component never subscribes.** Both.

- `KeywordPanel` is a fully synchronous request/response component. While the
  request is in flight the only state change is `running=true`
  (`KeywordPanel.tsx:17,35`), which swaps the button label to "Running…"
  (`KeywordPanel.tsx:151`). There is **no SSE subscription, no `JobProgress`,
  no count, no timer, no stage** in this component.
- The decision point is the absence itself: `handleRunNow`
  (`KeywordPanel.tsx:28-46`) awaits one promise and sets a final result. There
  is no progress channel to render because (a) above emits none.
- The rich `JobProgress` component (`Sidebar/JobProgress.tsx`) — stage labels,
  cells bar, live "Xs ago", enrich bar, event log — is wired **only** to the
  polygon Sidebar (`Sidebar.tsx:104`, `App.tsx:191-235`). The keyword view
  (`App.tsx:231 KeywordPanel`) renders none of it.

### (c) Email-absence trace — hypothesis CONFIRMED, with a twist

Operator hypothesis: "email not scraped by gosom; enrichment only runs in the
polygon pipeline." **~60% correct.** Precise trace:

1. **gosom does not scrape email** — `runKeywordJobSync` calls gosom with
   `email: false` (`jobRunner.ts:127`). ✅ confirmed. (Polygon also uses
   `email:false` — `jobRunner.ts:313` — by the settled "no gosom email"
   decision.) So emails can only come from the Node-side enricher.
2. **Enrichment DOES run for keyword leads** — `runKeywordJobSync` calls
   `kickEnrichment()` (`jobRunner.ts:147`). ❌ the "only in polygon" half is
   wrong: social links *do* get enriched for keyword leads.
3. **But email extraction inside enrichment is gated OFF for keyword leads.**
   This is the real root cause:
   - `enrichmentQueue.loop` left-joins `scrape_jobs` on `businesses.jobId` to
     read `extractEmails`, then calls
     `enrichSocial(biz, social.extractEmails === 1)`
     (`enrichmentQueue.ts:39-47`).
   - `enrichSocial` extracts emails **only when that flag is true**:
     `const emails = wantEmails ? extractEmails(html, $) : []`
     (`socialEnricher.ts:143`).
   - **`runKeywordJobSync` never inserts a `scrape_jobs` row.** It mints a
     `jobId` from `randomBytes` (`jobRunner.ts:116`) and stamps it on
     `businesses.jobId`, but there is no `db.insert(scrapeJobs)` in the
     function — contrast `startJob` (`jobRunner.ts:58`, writes
     `extractEmails: …`) and `runJobSync` (`jobRunner.ts:89`).
   - So the left-join finds **no matching `scrape_jobs` row → `extractEmails`
     is NULL → `null === 1` is `false` → `wantEmails=false` → emails never
     extracted** for any keyword-scraped business. Social links still get set
     (they're not gated), which is why the rows look "enriched" but email-less.
4. **Second structural gate:** the enrichment queue only selects businesses
   with `isNotNull(businesses.website)` (`enrichmentQueue.ts:42`). A lead with
   no website is never enriched and can never get an email — emails are scraped
   from the website HTML (`socialEnricher.ts:94-111`). gosom supplies none.

**Polygon comparison:** `startJob` writes `extractEmails: params.extractEmails ? 1 : 0`
(`jobRunner.ts:67`) from the Search panel checkbox; the polygon *scheduler*
hardcodes `extractEmails: true` (`scrapeSchedulerWorker.ts:110`). That's why
polygon leads get emails and keyword leads don't — not because enrichment
skips keyword, but because the keyword path carries no `extractEmails=1` signal.

> **Branch line of the bug:** `socialEnricher.ts:143` (the gate) reading a flag
> that `jobRunner.ts:113-155` (the keyword path) never sets, because no
> `scrape_jobs` row is written there.

### (d) Realtime cost reality — it's a RENDER problem, mostly cheap

- The SSE channel already exists and is live: `broadcast()` + `/events`
  (`server/src/sse.ts:64`), consumed by `App.tsx` `useSSE`. Adding keyword
  progress = emit a handful of events from `runKeywordJobSync` + render them.
  **No new transport, no new backend system, no polling.**
- **Honest granularity caveat:** keyword/instant is a *single* gosom job, not a
  grid loop. gosom does not stream partial business counts mid-job — the count
  is only known after `downloadResults` (`jobRunner.ts:131`). So the achievable
  live signal is: **stage** (submitting → scraping → saving → enriching →
  done), an **elapsed timer**, then the **final count** + the already-existing
  **`enrich:progress`** fill-in. A precise *mid-scrape* business counter is not
  obtainable from gosom — do not promise it.
- ETA inputs that exist: a single keyword query typically finishes in ~90s
  (the polygon UI already states this — `JobProgress.tsx:84`); `pollUntilDone`
  knows elapsed time and gosom status (`jobRunner.ts:400-447`). Enough for a
  "~90s typical / elapsed Xs" hint, not a precise countdown.
- **Verdict:** "dynamic, fluid, not costful" is achievable and cheap as a
  render + small emit. It is NOT a costly new-backend problem.

### (e) Distrusted-feature audit — Bulk & Backlog ARE wired and DO work

- **Bulk** = the Single/Bulk mode toggle in `KeywordPanel` (`:8`, `:116-121`);
  `handleBulkEnqueue` (`:72-102`) splits the textarea by line and creates one
  `scrape_schedule` per line via `createScrapeSchedule`
  (`lib/scrapeSchedulesApi.ts`), `interval_minutes:0, enabled:1`.
- **+ Backlog / "schedule"** = `handleAddToBacklog` (`:48-70`) — a single
  `createScrapeSchedule`, also `interval_minutes:0`.
- **They are wired and functional.** The scrape scheduler tick (60s,
  `scrapeSchedulerWorker.ts:64`) pulls `getDueSchedules` (`enabled=1 AND
  next_run_at <= now` — `scrapeSchedules.ts:134`), runs the keyword branch
  (`scrapeSchedulerWorker.ts:89-99`), and `interval_minutes:0` correctly
  one-shots: `updateScheduleAfterRun` disables the row after the first run
  (`scrapeSchedules.ts:184-191`). First run lands ~15-75s later
  (`FIRST_TICK_DELAY_MS=15000` + tick — `scrapeSchedulerWorker.ts:11,155`).
- **Why they feel untrustworthy:** the only feedback is a transient
  "Added ✓" toast (`KeywordPanel.tsx:65-66,158`). The run then happens later in
  a background worker whose status lives **only** in `ScrapeSchedulerStatus`
  (`ScrapeSchedulerStatus.tsx:66` Pause, tick counts) — which is rendered in
  the **Sidebar** (`Sidebar.tsx:122`) that is **hidden in keyword mode**
  (`App.tsx:126`: `sidebarVisible = geometry !== null || jobActive`; an instant
  keyword run sets neither). So the operator enqueues, sees a checkmark, and
  never learns the run happened or what it found. Distrust is *earned by the
  UI*, not by broken logic.
- **Can they be hidden via progressive disclosure without breaking anything?**
  Yes — they are independent `createScrapeSchedule` calls with no coupling to
  Run Now. Collapsing the Bulk toggle + "+ Backlog" behind an "Advanced / Queue"
  disclosure is pure markup; no logic changes. (Tradeoff in §findings F5.)

### (f) UX heuristic pass vs 2026 best practices (real rendered component)

Evaluating the actual `KeywordPanel` Single-mode render (`KeywordPanel.tsx:124-218`):

| 2026 best practice | KeywordPanel today | Gap |
|---|---|---|
| Stage tracker, 3-6 labelled steps; never a bare spinner [1][2][7] | One disabled button "Running…" | No stages at all |
| Push progress over SSE, not polling [3][4][9] | No subscription; SSE infra unused here | Channel exists, unused |
| Show partial/loading + final state distinctly [2][5] | Only final Added/Deduped | No loading/partial state |
| Elapsed + rough ETA, kill the indefinite spinner [2][5][8] | None | "~90s" data exists, unshown |
| Surface data provenance so users trust the output [6][10] | No hint that emails arrive in a later enrichment step (and not at all today) | No provenance line |
| Progressive disclosure; never hide what's frequent, expose what's rare [11][12][13] | Bulk + Backlog sit co-equal with Run Now and confuse | Wrong altitude, no outcome feedback |

### (g) "Why it feels broken" — top 3 by operator impact

1. **No live status (clarity, HIGH).** The keyword path emits no SSE and the
   panel renders only a button label (§a, §b). This is the operator's loudest
   complaint and the cheapest to fix (render + small emit on existing SSE).
2. **Leads have no emails (correctness, HIGH).** The keyword path writes no
   `scrape_jobs` row, so the email-extraction flag is NULL and enrichment skips
   emails (§c). Silent data loss — the operator can't tell scraping "worked"
   but the leads are unusable for outreach.
3. **Bulk/Backlog distrust (clarity, MED-HIGH).** They work, but give a
   checkmark then run invisibly in a hidden sidebar (§e). The operator avoids
   features that *function correctly* purely because the UI never closes the
   loop.

## Findings (the deliverable)

**F1 — Keyword runs emit no SSE; UI shows only a button label.**
*Evidence:* `runKeywordJobSync` has no `broadcast()` (`jobRunner.ts:113-155`);
polygon `runJob` emits 6 event types (`jobRunner.ts:292,338,341,350,356,362`);
`KeywordPanel` has no SSE subscription, only `running` → "Running…"
(`KeywordPanel.tsx:17,151`). *Severity:* HIGH (clarity).
*Direction:* emit stage events (`keyword:stage` submitting→scraping→saving→
enriching→done + elapsed) from `runKeywordJobSync`; render a compact stage
tracker in `KeywordPanel` via an SSE hook. Reuse existing `/events` + `useSSE`.

**F2 — Keyword leads never get emails because the path writes no `scrape_jobs`
row, so the `extractEmails` enrichment gate is NULL.**
*Evidence:* gosom `email:false` (`jobRunner.ts:127`); `kickEnrichment()` runs
(`jobRunner.ts:147`); gate `enrichSocial(biz, extractEmails === 1)`
(`enrichmentQueue.ts:47`) reads a left-joined `scrape_jobs.extractEmails`
(`enrichmentQueue.ts:39-44`) that is NULL because `runKeywordJobSync` inserts no
`scrape_jobs` row (contrast `startJob` `jobRunner.ts:58-67`); `enrichSocial`
emails only `wantEmails ? … : []` (`socialEnricher.ts:143`). *Severity:* HIGH
(correctness — silent, makes leads un-actionable for outreach).
*Direction:* make the keyword path carry `extractEmails=1` to the enricher —
either insert a minimal `scrape_jobs` row in `runKeywordJobSync` (also unblocks
F1/F4 status persistence and the SSE `snapshot` recovery in `sse.ts:27-58`), or
pass an explicit `wantEmails` signal for keyword-origin businesses. Additive
schema only. Surgical.

**F3 — Leads without a website can never get an email (inherent, but unsurfaced).**
*Evidence:* enrichment queue filters `isNotNull(businesses.website)`
(`enrichmentQueue.ts:42`); emails are parsed from website HTML
(`socialEnricher.ts:94-111`); gosom provides none. *Severity:* MED (clarity —
this is correct behavior, but invisible, feeding the "no emails" confusion).
*Direction:* provenance microcopy in the lead/explorer view — "email is found
by visiting the business website; no-website leads can't have one." No logic
change.

**F4 — `enrich:progress` exists but is unreachable from the keyword UI.**
*Evidence:* broadcast at `enrichmentQueue.ts:78` keyed by `jobId`;
`KeywordPanel` neither knows the run's `jobId` for live use nor subscribes.
*Severity:* MED (clarity). *Direction:* once F2 gives the run a real `jobId`,
surface the same enrich bar `JobProgress` already renders (`JobProgress.tsx:144-161`).

**F5 — Bulk/Backlog work but close no loop; status is in a sidebar hidden in
keyword mode.**
*Evidence:* `createScrapeSchedule` one-shots correctly
(`scrapeSchedules.ts:184-191`; scheduler `scrapeSchedulerWorker.ts:87-99`); only
feedback is the "Added ✓" toast (`KeywordPanel.tsx:65,158`); status UI
`ScrapeSchedulerStatus` lives in `Sidebar.tsx:122`, sidebar hidden when
`sidebarVisible` is false in keyword mode (`App.tsx:126`). *Severity:* MED-HIGH
(clarity/trust). *Direction:* (a) progressive disclosure — demote Bulk/+Backlog
behind an "Advanced / Queue" reveal so Run Now is the clear primary; (b) show a
small "queued — runs in ~Xs, results will appear in Explorer" confirmation +
link to scheduler status from the keyword view. **Tradeoff:** hiding must not
orphan the only multi-query path; keep it one tap away, not deleted (Nielsen:
don't relocate complexity, and don't bury what's needed [11]).

**F6 — Pre-existing 15s polling in scheduler status violates the SSE-only rule.**
*Evidence:* `ScrapeSchedulerStatus.tsx:18` `setInterval(refresh, 15_000)`;
outreach `SchedulerStatus` similar. `ui.md` bans polling. *Severity:* LOW-MED
(correctness vs rule; also the "costful" pattern the operator wants avoided).
*Direction:* not in this audit's fix scope, but **any keyword live-status work
must be built on SSE, not by copying this poll.** Flag for a separate cleanup.

**F7 — Naming/mental-model mismatch: text query lives in Scraper→Keywords, not
the "Explorer" tab; the "pause/cancel" the operator recalls isn't on this screen.**
*Evidence:* text query = `App.tsx:219-233` (Scraper tab, Keywords mode);
Explorer tab = read-only `BusinessExplorer` (`App.tsx:237`), no run capability.
`KeywordPanel` shows no pause/cancel (`KeywordPanel.tsx:146-159`); Cancel lives
in polygon `JobProgress` (`JobProgress.tsx:62`), Pause in `ScrapeSchedulerStatus`
(`:66`) — both off-screen in keyword mode. *Severity:* LOW (clarity/labeling).
*Direction:* confirm with operator which screen they mean (open question O1);
likely the labeling itself ("Keywords" vs "Explorer") and the absent feedback
are why the recollection blurs.

## Recommended next slices (ranked)

1. **`0003-keyword-run-live-status` — live SSE stage tracker for keyword runs.**
   *Intent:* emit stage + elapsed events from `runKeywordJobSync` and render a
   compact stage tracker (submitting → scraping → saving → enriching → done) in
   `KeywordPanel`, on the existing `/events` SSE. *Impact:* directly fixes the
   #1 complaint (no live status); makes the run feel alive. *Effort:* S-M
   (small backend emit + one render component + one SSE hook). *Prereqs:* none
   strictly, but lands cleaner after slice #2 gives the run a real `jobId`.
   *Tradeoff to honor:* no precise mid-scrape count from gosom — show stage +
   elapsed + final count, not a fake live counter.

2. **`0004-keyword-email-enrichment-gate` — make keyword leads get emails.**
   *Intent:* carry `extractEmails=1` from the keyword path to the enricher (most
   likely: insert a minimal `scrape_jobs` row in `runKeywordJobSync`, which also
   unblocks status persistence + SSE snapshot recovery). *Impact:* fixes the
   silent correctness bug — keyword leads become outreach-usable. *Effort:* S
   (one insert + verify the join resolves; additive only). *Prereqs:* none.
   *Tradeoff:* writing a `scrape_jobs` row changes what the keyword path
   persists — verify it doesn't disturb the polygon-oriented `snapshot` query
   (`sse.ts:27-58`) or job-listing views.

3. **`0005-keyword-panel-disclosure-and-provenance` — declutter + explain.**
   *Intent:* progressive-disclose Bulk/+Backlog behind an "Advanced / Queue"
   reveal; add a "queued — appears in Explorer in ~Xs" confirmation; add
   provenance microcopy ("emails come from the business website, found in a
   later enrichment step; no-website leads have none"). *Impact:* removes the
   distrust (F5) and the "where are my emails" confusion (F3). *Effort:* S
   (markup + copy; no logic change). *Prereqs:* none; better after #1 so the
   primary flow already feels trustworthy. *Tradeoff:* keep the multi-query path
   one tap away — don't bury what the operator may still need.

4. **`0006-scheduler-status-sse` (optional cleanup) — replace 15s polling.**
   *Intent:* move `ScrapeSchedulerStatus` (and outreach `SchedulerStatus`) off
   `setInterval` polling onto SSE. *Impact:* compliance with the SSE-only rule;
   removes the "costful" pattern. *Effort:* M. *Prereqs:* none. *Lowest
   priority — correctness-of-rule, not operator-visible.*

## Open questions for the operator

- **O1 — Which screen?** You said "Explorer tab," but text queries run from
  **Scraper → Keywords**; the Explorer tab only browses saved leads. And the
  "pause/cancel" you recall isn't on the keyword screen (it's on the polygon/Map
  progress panel and the scheduler). Are you running keyword searches from
  Scraper→Keywords, or do you mean the Map (polygon) flow? This decides where
  the live-status work lands.
- **O2 — Backlog/Bulk:** keep them (demoted behind disclosure) or remove them
  entirely? They work, but you don't use them. Recommendation: keep, demote — I
  won't delete a working feature without your call.
- **O3 — Email expectation:** is it acceptable that no-website leads will never
  have an email (inherent — emails are scraped from the website)? If you expect
  emails for those, that's a different, larger sourcing problem.

---

### Sources (Phase 1 research)

- [1] [Progress Tracker Design: UX Best Practices (2026) — UXPin](https://www.uxpin.com/studio/blog/design-progress-trackers/)
- [2] [Designing Better Loading and Progress UX — Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/)
- [3] [SSE's Glorious Comeback: Why 2025 is the Year of Server-Sent Events — portalZINE](https://portalzine.de/sses-glorious-comeback-why-2025-is-the-year-of-server-sent-events/)
- [4] [Why Server-Sent Events are ideal for Real-Time Updates — talent500](https://talent500.com/blog/server-sent-events-real-time-updates/)
- [5] [UI patterns for async workflows, background jobs, and data pipelines — LogRocket](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)
- [6] [Data Provenance vs. Data Lineage — Snowflake](https://www.snowflake.com/en/fundamentals/data-lineage/lineage-vs-provenance/)
- [7] [Beyond the Progress Bar: The Art of Stepper UI Design — Lollypop (2026)](https://lollypop.design/blog/2026/february/beyond-the-progress-bar-the-art-of-stepper-ui-design/)
- [8] [CLI UX best practices: progress displays — Evil Martians](https://evilmartians.com/chronicles/cli-ux-best-practices-3-patterns-for-improving-progress-displays)
- [9] [Stop Polling Your APIs: Use Server-Sent Events Instead — Medium](https://medium.com/@buttraheel6/stop-polling-your-apis-use-server-sent-events-sse-instead-91d9d3a0bdab)
- [10] [WebSockets vs SSE vs Polling — DEV Community](https://dev.to/crit3cal/websockets-vs-server-sent-events-vs-polling-a-full-stack-developers-guide-to-real-time-3312)
- [11] [What is Progressive Disclosure? (updated 2026) — Interaction Design Foundation](https://ixdf.org/literature/topics/progressive-disclosure)
- [12] [What Is Progressive Disclosure in UX? (2026) — UXPin](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)
- [13] [The Art of Progressive Disclosure in UX/UI Design — Tim Graf](https://timgraf.com/ux-design/the-art-of-progressive-disclosure-in-ux-ui-design-balancing-complexity-and-clarity/)
