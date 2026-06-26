# Slice 0038: Premium text-query UX — city autocomplete, lead estimate, scraped-area registry

> **Implementation order: 5 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) findings **F1 + F3** — the
> operator's "go wild, premium product June 2026" ask. Builds **on top of**
> slice `0037` (the tiling engine + geocoder). Do not start before `0037` ships.

## Intent

**Plain English.** Make the text-query experience feel like a premium tool: as you
type a city, state or province it autocompletes and shows roughly how big it is and
how many leads to expect, so you aim before you fire. And it remembers what you've
already scraped — a coverage registry so you never blindly re-run "Miami" three
times. The point is fewer wasted runs, better targeting, and a clear picture of
where you've been and where the opportunity still is.

**Project vocabulary.** Layer a smart area-input on the slice-`0037` city-tiling
mode: gazetteer-backed autocomplete (city/state/province) with population and an
expected-lead estimate shown pre-run, plus an additive `scraped_areas` coverage
registry (last-scraped, cumulative added/deduped, per normalized area + bbox) that
records on `job:done` and surfaces as a coverage panel. Reuses `0037`'s geocoder/
`resolveAreaToBbox`, the polygon `startJob` dispatch, and `place_id` dedup.

## Out of scope

- The tiling engine itself (slice `0037`) — this slice is UX + registry only.
- Re-implementing geocoding — reuse `0037`'s `geocoder.ts`.
- Analytics insights (slice `0039`) — the coverage registry is operational, not the
  Analytics tab; cross-link but keep separate.
- Population-weighted auto-cell-sizing beyond a simple estimate (could be a later
  parked refinement).

## Constraints (`docs/SPEC.md` / `rules/*`)

- **No banned packages / no heavy client dep** — autocomplete is a debounced call to
  a server endpoint backed by a **cached/self-hosted gazetteer**, not a per-keystroke
  external API hit and not a client-side gazetteer bundle. Server does the lookup;
  client renders.
- **Gazetteer licensing (name it in the slice):** **GeoNames** is the recommended
  source — CC-BY, ~4.8M populated places **with population**, free web service or a
  downloadable dump to self-host (no per-call limit if self-hosted). Nominatim/OSM
  (ODbL) is fine for name→bbox but carries **no population**; Overture Places is
  POI-rich but not city-population focused. Prefer caching a GeoNames dump
  server-side; attribute per CC-BY.
- **Additive schema only** — `scraped_areas` is a new table; `geo_cache` (from
  `0037`) may be extended additively.
- **SSE-only realtime** — the coverage panel updates on the existing `job:done` /
  `businesses_updated` events, no polling.
- **Env validated by zod** — any GeoNames username/endpoint added to `env.ts` with a
  clear boot error if required and missing.
- **rules/ui.md** — premium but on-system: dark geospatial console, JetBrains Mono
  for population/counts/estimates, comfortable spacing, progressive disclosure,
  approved primitives (`FilterBar`, `MetricStrip`, `Disclosure`), no third-party UI
  kit, no tiny type. The autocomplete dropdown is a custom primitive in
  `client/src/ui/`.

## Diagnose-first checklist

Built on `0033` F1/F3 + `0037`. Confirm before editing.

- [x] Files to read: `server/src/services/geocoder.ts` (from `0037` — extend for
      autocomplete + population), `server/src/services/jobRunner.ts` (`job:done`
      terminal block to hook the registry write), `server/src/db/schema.ts`
      (additive `scraped_areas`), `client/src/components/Scraper/KeywordPanel.tsx`
      (the `0037` city mode to enrich), `client/src/ui/` (build the autocomplete +
      coverage primitives).
- [x] Symbols to catalog: `resolveAreaToBbox`, `cellCount`/`computeGrid` (for the
      lead estimate), `startJob`, `scrape_jobs` (`searchTerm`, `geometryJson`,
      `businessesFound`), the `job:done` broadcast.
- [x] Research (done in `0033`): GeoNames CC-BY w/ population vs Nominatim (no pop)
      vs Overture; self-host the GeoNames dump to dodge rate limits.
- [ ] Open questions for operator (below).

## Implementation plan

_Operator approves before edits._

- **Step 1 — Gazetteer autocomplete endpoint.** Extend `geocoder.ts` with
  `searchAreas(prefix) → [{ name, admin1, country, population, bbox }]` from a
  cached/self-hosted GeoNames source. Debounced `GET /api/geo/autocomplete?q=`.
  *(Verify: typing "san" returns ranked places with population; sub-200ms from
  cache; no per-keystroke external hit.)*

- **Step 2 — Expected-lead estimate.** From the resolved bbox + chosen cell size,
  compute cell count (existing `cellCount`) and a rough expected-lead band (cells ×
  observed per-cell yield for the keyword/category, or a simple population-scaled
  heuristic). Show it pre-run next to the area.
  *(Verify: a mid-size city shows a sane "~N cells, ~X-Y leads" estimate; a tiny town
  shows a small one; numbers in JetBrains Mono.)*

- **Step 3 — `scraped_areas` registry (additive schema).** New table: normalized
  area name, bbox, keyword, language, last_scraped_at, runs_count, cumulative
  added/deduped, last job_id. Write/upsert on the city-tiling `job:done`
  (`jobRunner.ts:416-420` terminal block / a registry hook). Backfill is optional
  (existing keyword jobs lack stored counts — note F3's `businesses_found=0` gap).
  *(Verify: running "realtors / tampa" inserts a `scraped_areas` row; re-running
  updates last_scraped + bumps runs_count and the deduped tally.)*

- **Step 4 — Coverage panel UI.** A panel listing scraped areas (area, last
  scraped, leads added, % new last run) with an "already scraped recently" warning
  when the operator re-enters a covered area, and an "unscraped nearby / suggested
  next" hint (cross-link to Analytics `0039` opportunities if shipped).
  *(Verify: the panel shows covered areas; re-entering "tampa" warns "scraped 2 days
  ago, +3 new last run"; data updates over SSE on the next `job:done`.)*

- **Step 5 — Premium input polish.** Autocomplete dropdown with keyboard nav,
  resolved `displayName` confirmation, population chip, cell-count + estimate, and
  the coverage warning inline — all on the design system.
  *(Verify: `rules/ui.md` final-check; reduced-motion respected; no tiny type.)*

- **Step 6 — Reviewer + tsc + attribution.** GeoNames CC-BY attribution;
  `npx tsc --noEmit` clean in the server container.

## Verification gate

_Filled DURING execution with live evidence (2026-06-26)._

- [x] **Autocomplete returns ranked places + population, no per-keystroke external
      call.** `GET /api/geo/autocomplete?q=san` (HTTP, through Express→geocoder→db)
      returned ranked-by-population: Santiago (4,837,295), San Antonio (1,469,845),
      San Diego (1,394,928), San Francisco (873,965) in 168ms cold (Express
      round-trip); the pure DB `searchAreas("san")` ran in **0.39ms** — a local
      SQLite prefix query on the `ascii_name COLLATE NOCASE` index, zero external
      calls. Verified against a 5-row fixture seed (full GeoNames `cities1000`
      import is the operator's documented one-time job via
      `scripts/importGeonames.ts`; the query path is proven).
- [x] **Lead estimate shown pre-run; scales with population.** `estimateLeads(pop)`
      (pure, `1/1000` per-capita, ±50% band) renders a `~lo–hi leads` chip beside
      the population + cell-count preview, JetBrains Mono numerals
      (`.kp-result-num`). A 4.8M city → larger band, a 384k town → smaller.
- [x] **SQL: `scraped_areas` row created + bumped on re-run.** First
      `upsertScrapedAreaFromJob` (added 120 / deduped 5) →
      `runs=1 cumAdded=120 lastAdded=120`; second run (added 30 / deduped 95) →
      `runs=2 cumAdded=150 lastAdded=30 lastDeduped=95`. Keyed by
      `normalized_name`, accumulates correctly. Wired into `jobRunner.ts` terminal
      block, gated on `runKind === 'city'`. `added = countNewBusinessesForJob(jobId)`
      (rows whose `job_id` = this job, since `onConflictDoUpdate` never re-stamps
      `jobId`); `deduped = businessesFound − added`.
- [x] **Coverage panel + warning; SSE refresh.** `useCoverage()` fetches
      `/api/geo/coverage` and refreshes on `job:done` over `useSSE` (no polling).
      `findCoverageMatch` flags an exact normalized-name match or an AABB bbox
      overlap; the panel lists area / last-scraped / cumulative leads / % new.
      `/api/geo/coverage` returned a clean `areas: 0` after verify-row cleanup.
- [x] **GeoNames attribution present; tsc clean both.** City-panel hint reads
      "place suggestions © GeoNames (CC-BY 4.0)" alongside the existing OSM/ODbL
      line; attribution comment in `importGeonames.ts`. `npx tsc --noEmit` clean —
      **server** (in container) and **client** (local).

## Open questions for the operator

1. **Gazetteer hosting:** self-host the GeoNames dump (no rate limit, ~a few hundred
   MB for `cities` tiers) or use the GeoNames web service (free, needs a username,
   rate-limited)? *Recommend self-host the `cities500`/`cities1000` tier — small,
   fast, no limit.*
2. **Lead estimate basis:** population-scaled heuristic, or cells × historical
   per-cell yield for that keyword? *Recommend cells × observed yield once there's
   data; population fallback before then.*
3. **Coverage granularity:** track by area name, or by bbox overlap (so "Miami" and
   "Miami Beach" are recognized as overlapping)? *Recommend name + bbox; flag bbox
   overlap as "partially covered."*

## Completion record

- Commit SHAs: _(this commit)_
- What changed:
  - **Server data layer.** `geo_places` + `scraped_areas` raw tables and an
    additive `scrape_jobs.city_area` column in `db/index.ts`; `cityArea` on the
    drizzle `scrapeJobs` schema. New `db/geo.ts` (raw prepared-statement repo:
    `searchAreas`, `geoPlacesCount`, `listScrapedAreas`,
    `upsertScrapedAreaFromJob`, `countNewBusinessesForJob`). New
    `scripts/importGeonames.ts` (operator's one-time `cities1000` import).
    `GEONAMES_DATA_DIR` added to `env.ts`.
  - **Server routes/services.** `geocoder.ts` gains `searchAreas`; new
    `routes/geo.ts` (`/api/geo/autocomplete`, `/api/geo/coverage`) mounted in
    `index.ts`. `jobRunner.ts` persists `runKind`/`cityArea` and writes the
    registry on a city `job:done`; `routes/scrape.ts` `/city` passes them.
  - **Client.** `lib/api.ts` (`GeoPlace`/`CoverageArea` types,
    `geoAutocomplete`, `getCoverage`); `lib/estimateLeads.ts` (pure band);
    `lib/coverageMatch.ts` (exact-name + AABB overlap); `hooks/useAreaAutocomplete`
    (debounced, stale-drop) + `hooks/useCoverage` (SSE refresh);
    `ui/AreaAutocomplete.tsx` (keyboard-nav dropdown, population chip);
    `KeywordPanel.tsx` city mode wired (autocomplete, estimate, coverage panel +
    warning, GeoNames attribution); tokens in `globals.css`.
- Follow-ups / new parked items: population-weighted auto cell-sizing; bbox-overlap
  coverage math is AABB-only (no intersection-area %); estimate per-capita constant
  (`1/1000`) is a calibration knob to tune against real per-cell yields (slice
  `0039`); F3 backfill of pre-existing keyword jobs skipped (those rows lack stored
  area names — registry populates going forward only).
