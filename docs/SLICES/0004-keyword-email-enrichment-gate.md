# Slice 0004: Keyword email-enrichment gate

## Intent

Make keyword-scraped leads actually get emails. Today they never do: the
keyword path writes no `scrape_jobs` row, so the email-extraction flag the
enricher reads is NULL and email scraping is skipped — even though social
enrichment runs (diagnosed in [0002](0002-text-query-ui-clarity-audit.md),
finding F2). This slice carries an `extractEmails=1` signal from the keyword
path to the enricher so website-bearing keyword leads get their emails, exactly
like polygon leads do.

**Project vocabulary:** insert a minimal `scrape_jobs` row in
`runKeywordJobSync` with `extractEmails=1`, so the `enrichmentQueue` left-join
resolves and `enrichSocial(biz, true)` extracts emails.

## Out of scope

- No gosom-side email extraction (settled: gosom email jobs stall the worker
  pool — `jobRunner.ts:307-312`).
- No-website leads are still email-less — that is inherent (emails come from the
  website HTML) and accepted by the operator; the contact lane for them is the
  separate slice [0007](0007-no-website-lead-outreach.md).
- No UI changes (live status is 0003; provenance copy is 0005).
- No change to the polygon path's email behavior.

## Constraints

- **Additive schema only** (`SPEC.md`). A `scrape_jobs` insert uses existing
  columns; if any keyword-specific column is needed, add, never alter
  destructively.
- **Reuse `runKeywordJobSync`** (`SPEC.md` registry) and the existing
  `enrichmentQueue` gate — do not reimplement enrichment.
- **lat/lng as strings**, **dedup by place_id**, **SQLite WAL pragmas** —
  unchanged invariants the insert must respect.
- **No false absence claims** — verify the left-join in
  `enrichmentQueue.ts:39-44` resolves against the new row before claiming the
  fix works.

## Diagnose-first checklist

Diagnosis complete in 0002 (F2). Confirm before editing:

- [ ] Files to read: `server/src/services/jobRunner.ts` (`runKeywordJobSync`
      113-155; compare `startJob` 45-76 and `runJobSync` 80-104 for the row
      shape), `server/src/services/enrichmentQueue.ts` (39-51, 69-79),
      `server/src/services/socialEnricher.ts` (116-160), `server/src/db/schema.ts`
      (`scrapeJobs` columns), `server/src/sse.ts:27-58` (the `snapshot` query).
- [ ] Symbols to catalog: `scrapeJobs` required columns (id, searchTerm,
      language, bboxJson, gridCellKm, cellCount, status, geometryJson,
      extractEmails, createdAt), `businesses.jobId`, `extractEmails`.
- [ ] Key risk: the `snapshot` query (`sse.ts:27-58`) selects
      `running`/`error` jobs ordered by `createdAt`. A keyword `scrape_jobs`
      row must NOT masquerade as an active polygon job. Decide the row's
      `status` (e.g. set to `done` on completion; consider a `kind`/keyword
      marker or geometry=null so polygon-oriented views ignore it).
- [ ] Symbols to catalog: any job-listing route/UI that reads `scrape_jobs`
      and might now show keyword rows (grep `from(scrapeJobs)` /
      `FROM scrape_jobs`).
- [ ] Open questions: should the keyword `extractEmails` be always-on (1) or a
      checkbox like the polygon Search panel? Recommendation: always-on —
      operator wants "as many emails as possible" (O3). Confirm.

## Implementation plan

_Proposed; operator approves before edits._

- Step 1 — In `runKeywordJobSync`, insert a `scrape_jobs` row for the run's
  `jobId` with `extractEmails: 1`, a benign `status` that polygon views ignore
  (e.g. start `done` after scraping, or a keyword marker), and null/empty
  geometry. *(Verify by: `SELECT id, extract_emails, status FROM scrape_jobs
  WHERE id = '<jobId>'` → row exists, extract_emails=1.)*
- Step 2 — Confirm the enrichment left-join now resolves: after a run,
  `enrichSocial` is called with `wantEmails=true` for that job's businesses.
  *(Verify by: server log in enrichment loop; `emails_json` populated for
  website-bearing leads from the run.)*
- Step 3 — Verify the `snapshot` query and any job-listing views do not now
  surface keyword rows as active scrapes. *(Verify by: open a fresh SSE
  connection mid-keyword-run → snapshot is not hijacked; the scraper Sidebar
  doesn't show a phantom polygon job.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-22)._

Live run: `POST /api/keyword-scrape/instant` `{query:"abogado recoleta", lang:"es",
depth:1, geoBias:{lat:-34.5889, lon:-58.3974, radius:3000}}` → `{added:17, deduped:3}`.
Job id `izMGEnvx8PwfP3JSQCGBeA`. (Note: server runs under tsx watch in Docker; the
edit only took effect after `docker compose restart server` — first run on stale
code wrote no job row, confirming the diagnosis from the other side.)

- [x] SQL: `scrape_jobs` row →
      `{id:"izMGEnvx8PwfP3JSQCGBeA", extract_emails:1, status:"done",
      geometry_json:null, grid_cell_km:0, cell_count:0, bbox_json:"[]"}`. One row,
      extract_emails=1.
- [x] SQL: businesses for the job → total=17, website-bearing=13, social_enriched=13,
      `emails_json IS NOT NULL` count = **5** (> 0). All 17 are fresh place_ids
      (job_id is written on INSERT only), so the emails come solely from this run's
      Node-side enrichment with `wantEmails=true` — not pre-existing rows.
      Samples: `DMO Abogados → [dolmedo@dmohg.com.ar, hguaita@dmohg.com.ar]`,
      `Estudio Jurídico Pereyra Pallisé → [contacto@pereyrapallise.com]`,
      `Estudio Haissiner → [5 addresses]`.
- [x] Gate proven end-to-end: the enrichmentQueue left-join now resolves
      `extractEmails=1`, so `enrichSocial(biz, true)` extracts emails. Contrast:
      pre-fix keyword businesses are orphans — `businesses LEFT JOIN scrape_jobs ...
      WHERE scrape_jobs.id IS NULL` returns prior keyword job_ids (e.g. 56, 39, 38
      rows) that never had a job row and thus never got the email gate.
- [x] `curl -N /events` → `snapshot` was an unrelated **errored polygon** job
      (`id 84AP9AcRgZSOjrRfOh28rA, status error, cellCount 38`), NOT the keyword
      `done` row. The keyword row never hijacks the active-job snapshot (the query
      selects only `running`/`error`).
- [x] `npx tsc --noEmit` clean — exit 0 (server in `maps-scraper-server-1`).

## Completion record

- Commit SHAs: _(uncommitted — pending operator)_
- What changed: `server/src/services/jobRunner.ts` — `runKeywordJobSync` now inserts
  a minimal `scrape_jobs` row for the run's `jobId` (`extractEmails:1`,
  `status:'done'`, `geometryJson:null`, `bboxJson:'[]'`, `gridCellKm:0`,
  `cellCount:0`) before the gosom call, so the enrichmentQueue left-join resolves
  and website-bearing keyword leads get emails like polygon leads. Single-file,
  additive — no schema change, no UI change. `extractEmails` is always-on (1) per
  the O3 recommendation.
- Follow-ups / new parked items: none. No-website keyword leads remain email-less
  by design (slice [0007](0007-no-website-lead-outreach.md)).
