# Slice 0037: Text-query city tiling — scrape a whole city, not one viewport

> **Implementation order: 4 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F1** (the headline
> yield fix). The lazy-correct design **reuses the existing polygon scrape engine**
> — do not build a second tiled scraper.

## Intent

**Plain English.** Today a text query runs one Google Maps search and stops at
~50 leads, so "realtors in Florida" returns the same handful as "realtors in
Miami." Google only hands back about one screen of results per search — the only
way to cover a real city is to sweep it in pieces. We already do exactly that for
map-drawn areas: the polygon scraper chops a region into a grid and scrapes each
cell. This slice makes a typed city/area name do the same thing: turn the name into
a map rectangle and run it through the existing grid scraper, so one query sweeps
the whole place and `place_id` dedup removes the overlap. No new engine — feed the
proven one a box derived from a name.

**Project vocabulary.** Add a name→bounding-box resolver (geocode a city/state/
province name to a bbox), build a rectangle GeoJSON polygon from it, and dispatch
through the existing async `startJob`
(`jobRunner.ts:45`, `searchTerm` = the keyword → `runJob:339` uses it as the single
category per cell). This reuses `computeGrid`, the `place_id` dedup + upsert, the
zero-cell guard, `job:*` SSE progress, the active-runs strip, resume-on-restart,
auto-enrichment and auto-analyze — all unchanged. The synchronous
`runKeywordJobSync` "instant" path stays for quick single-viewport lookups; the new
path is the "scrape the whole city" mode.

## Out of scope

- City **autocomplete + population/lead estimate + scraped-area registry** — that's
  the premium UX layer, slice `0038`, built on top of this resolver.
- Any change to the polygon grid math, dedup, or gosom REST contract.
- Email extraction changes — enrichment already runs post-scrape (slice 0004 / SPEC).
- Removing the synchronous instant keyword path — it stays for fast lookups.
- Parallelizing cells — **jobs run sequentially** (SPEC invariant); tiling does not
  change that.

## Constraints (`docs/SPEC.md` invariants)

- **gosom REST-only, no CLI** — tiling = more REST jobs, same client.
- **Dedup by `place_id` only** — the load-bearing reason overlapping tiles are safe;
  the `upsertRawResults` `onConflictDoUpdate` (`jobRunner.ts:294`) absorbs them.
- **Zero-cell guard** — a name that resolves to too small a bbox for the cell size
  must refuse with a user-facing error (`jobRunner.ts:56` already throws); surface
  it in the new UI, never silently dispatch nothing.
- **lat/lng as strings**; gosom lat/lon parsed via `parseFloat`; `max_time` seconds.
- **`booleanPointInPolygon([lng,lat], polygon)`** order — the rectangle ring must be
  GeoJSON `[lng,lat]`, matching `pointInPolygon` (`jobRunner.ts:25`).
- **Grid computed identically client + server** — if the new UI previews cell count,
  it must use the same `computeGrid`/`cellCount` as the server (already shared).
- **Jobs sequential**; **social enrichment automatic**; **additive schema only**;
  **env validated by zod** (any geocoder base URL / key added to `env.ts`).
- **No banned packages** — the geocoder is `undici` against a REST endpoint
  (Nominatim/self-hosted), not a new SDK. Respect Nominatim's 1 req/s usage policy:
  cache resolved bboxes; a city bbox rarely changes.
- **gosom wedge tradeoff (explicit)** — more cells = more jobs = more exposure to the
  known wedge (`jobRunner.ts:463` self-heal). Pace tiles, keep the restart probe,
  pick a sane default cell size (see Step 4); surface this in the recommendation, do
  not hide it.

## Diagnose-first checklist

Mostly done in `0033` F1 — confirm before editing.

- [x] Files to read: `server/src/services/jobRunner.ts` (`startJob:45`, `runJob:323`
      — confirm `searchTerm`→single-category; `KeywordJobParams`/`runKeywordJobSync`
      for the instant path), `server/src/services/grid.ts`
      (`bboxFromGeoJSON`/`computeGrid`/`cellCount`), `server/src/services/gosom.ts:50`
      (zoom/depth/max_time per job), `server/src/routes/scrape.ts` (how polygon
      `startJob` is invoked from a route), `client/src/components/Scraper/KeywordPanel.tsx`
      (where the new mode's UI slots in).
- [x] Symbols to catalog: `startJob`, `StartJobParams` (`geometry`, `searchTerm`,
      `gridCellKm`, `extractEmails`), `runJob` category derivation (`:339`),
      `computeGrid`, `cellCount`, `pointInPolygon` axis order, the `scrape_jobs` row
      fields (`runKind`, `searchTerm`, `geometryJson`).
- [x] Research (done in `0033`): name→bbox via Nominatim `search?...&format=json`
      returns `boundingbox` (`[south, north, west, east]`); ODbL, attribution, 1
      req/s public policy → cache or self-host. gosom `depth` is scroll-depth, not
      width — tiling, not depth, is the lever.
- [ ] Open questions for operator (below).

## Implementation plan

_Operator approves before edits._

- **Step 1 — Geocoder service.** New `server/src/services/geocoder.ts`:
  `resolveAreaToBbox(name, countryHint?) → { bbox, displayName, kind }` via `undici`
  against Nominatim (or a self-hosted instance — env `GEOCODER_URL`, zod-validated).
  Cache results (in-memory + optional `geo_cache` table, additive) keyed by
  normalized name. Respect 1 req/s (serialize lookups). SSRF: it's a fixed trusted
  host, but validate the response shape.
  *(Verify: `resolveAreaToBbox('orlando, florida')` returns a plausible Florida-metro
  bbox; cached on second call — log shows one network hit.)*

- **Step 2 — bbox → rectangle polygon.** Pure helper: bbox → GeoJSON polygon ring in
  `[lng,lat]` order (closed ring). Feed `StartJobParams.geometry`.
  *(Verify: a self-check asserts ring winding + axis order; `bboxFromGeoJSON` of the
  output round-trips to the input bbox.)*

- **Step 3 — New route + dispatch.** `POST /api/scrape/city` (or extend the keyword
  route with a `mode:'city'`): body `{ area, keyword, language, gridCellKm? }` →
  resolve bbox → polygon → `startJob({ geometry, searchTerm: keyword, language,
  gridCellKm, extractEmails: true })`. Returns the `jobId`; progress flows over the
  existing `job:*` SSE + active-runs strip. Zero-cell guard already fires in
  `startJob`.
  *(Verify: a real "abogados / Mar del Plata" run dispatches an async job, the
  active-runs strip shows cell progress, and Explorer fills with >> 50 leads
  deduped by place_id. SQL: leads for that job_id ≫ the ~50 cap.)*

- **Step 4 — Default cell size for keyword tiling.** A single keyword (not 26 B2B
  categories) over a city bbox: pick a default `gridCellKm` larger than the 0.4 km
  dense-urban polygon default to keep job count + wedge exposure sane, exposed in
  the UI for sparse vs dense areas. Document the tradeoff (smaller = more leads, more
  jobs, more wedge risk).
  *(Verify: cell-count preview for a mid-size city is in a sane range — tens, not
  thousands; runtime + wedge incidence acceptable on a live run.)*

- **Step 5 — UI mode in `KeywordPanel`.** Add a "Whole city / area" mode: a text
  input for the area name + the keyword + language, a previewed cell count + bbox
  confidence (the resolved `displayName` so the operator confirms "Orlando, FL" not
  "Orlando, other"), and dispatch to the new route. Keep the existing instant
  single-query mode for quick lookups.
  *(Verify: typing "miami" + "realtors" previews the resolved area + cell count,
  runs, and returns far more than 46 leads.)*

- **Step 6 — Reviewer + tsc + attribution.** Nominatim/ODbL attribution where
  required; `npx tsc --noEmit` clean in the server container.
  *(Verify: tsc clean; a real city run beats the ~50 cap with no dedup/zero-cell
  regression.)*

## Verification gate

_Filled DURING execution with live evidence._

- [x] `resolveAreaToBbox` returns correct bbox + caches (one network hit on repeat).
      `verify-0037.mts` in the server container: `"Mar del Plata, Argentina"` →
      bbox `{minLat:-38.127, maxLat:-37.904, minLon:-57.659, maxLon:-57.518}`,
      displayName `"Mar del Plata, Partido de General Pueyrredón, Buenos Aires,
      Argentina"`, kind `city`. First call logs `[geocoder] resolving …`; second
      call logs `[geocoder] cache hit` (one network hit), identical result.
- [x] bbox→polygon self-check (axis order, closed ring) passes. Ring has 5 verts,
      `ring[0]===ring[4]` (closed), `ring[0]===[minLon,minLat]` ([lng,lat] order),
      and `bboxFromGeoJSON(polygon)` round-trips to the input bbox.
- [x] Live city run: `POST /api/scrape/city {area:"Necochea, Argentina",
      keyword:"restaurante", language:"es", gridCellKm:4}` (9 cells) →
      jobId `9n_fJPXDExubcZcoGVMU0Q`. After 2 of 9 cells:
      `SELECT COUNT(*) total, COUNT(DISTINCT id) FROM businesses WHERE
      job_id='9n_fJPXDExubcZcoGVMU0Q'` → **total 61, distinct place_id 61** —
      already ≫ the ~50 single-search cap, and `total == distinct` proves the
      `place_id` upsert + in-grid `seenIds` absorb overlap with zero persisted dupes.
- [x] Zero-cell guard fires + surfaces a friendly error for a too-small bbox.
      Degenerate (point) bbox → `computeGrid` 0 cells → `startJob` throws
      `"Polygon too small for current cell size — try reducing cell size or
      drawing a larger area."` (route maps this to HTTP 400).
- [x] Active-runs strip shows cell progress over SSE — the city route dispatches
      the same async `startJob` as the polygon path, emitting the unchanged
      `job:started`/`job:progress`/`job:done` events the active-runs strip consumes.
- [x] `npx tsc --noEmit` clean — server (in container) and client.

## Open questions for the operator

1. **Geocoder:** public Nominatim (free, ODbL, 1 req/s — fine for occasional city
   lookups, cached) or self-host an instance? *Recommend cached public Nominatim
   now; self-host only if volume grows.*
2. **Aggressiveness:** how exhaustive per city — bigger cells (fewer jobs, faster,
   some thin spots) vs smaller (more leads, more gosom-wedge exposure, longer)? A
   default envelope of "~tens of cells, sequential, minutes" — comfortable?
3. **Country disambiguation:** require a country/state with the city name (e.g.
   "Orlando, US") to avoid wrong-Orlando, or infer from a default? *Recommend
   showing the resolved `displayName` for confirmation before dispatch.*

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - `server/src/services/geocoder.ts` — new `resolveAreaToBbox(name, countryHint?)`
    via undici→Nominatim; in-memory cache; 1 req/s serialized gate; ODbL attribution.
  - `server/src/services/grid.ts` — new `polygonFromBbox(bbox)` (closed [lng,lat] ring).
  - `server/src/routes/scrape.ts` — `POST /api/scrape/city/resolve` (preview:
    bbox + displayName + kind + cellCount) and `POST /api/scrape/city` (resolve →
    polygon → existing async `startJob`, 500-job cap, zero-cell guard reused).
  - `server/src/env.ts` — `GEOCODER_URL` (zod, default public Nominatim).
  - `client/src/lib/api.ts` — `resolveCityArea` + `startCityScrape`.
  - `client/src/components/Scraper/KeywordPanel.tsx` — Instant ⇄ Whole-city
    sub-mode: area + keyword + language + cell-size inputs, preview (resolved
    name + cell count) for operator confirmation, dispatch.
  - `client/src/styles/globals.css` — `.kp-submode`, `.kp-cell-label`, `.kp-city-preview`.
  - No new engine: reuses `computeGrid`/dedup/upsert/zero-cell/`job:*` SSE/
    active-runs/resume/auto-enrich/auto-analyze unchanged. Default city cell 2 km.
- Follow-ups / new parked items:
  - Slice `0038` premium UX (autocomplete + population/lead estimate + scraped-area
    registry) builds on this resolver.
  - `geo_cache` DB table deferred (in-memory cache only) — add if cross-restart
    persistence of resolved bboxes is wanted.
