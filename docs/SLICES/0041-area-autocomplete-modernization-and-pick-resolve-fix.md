# Slice 0041: Area autocomplete — modernization + pick-resolve fix

> Operator-reported (2026-06-26): the GeoNames area autocomplete "shows nothing
> while typing" and, when a suggestion *is* picked, **Preview resolves the wrong
> place or 400s**. Diagnosis below proves the autocomplete + backend are correct;
> the load-bearing bug is that picking a GeoNames suggestion throws away the exact
> coordinates it already holds and re-resolves the *name string* through Nominatim.
> This slice fixes that and modernizes the picker (highlight, loading/empty states,
> country flags + home-country ranking, recent searches + ghost completion).

## Intent

Make the Whole-city area picker (slice `0038`) trustworthy and modern. **Correctness
first:** when the operator picks a gazetteer suggestion, build the scrape bbox from
the coordinates the pick already carries — biased Nominatim for a real boundary,
falling back to a population-scaled box around the exact point — so Preview/dispatch
can never silently scrape a homonym hundreds of km away. **Feel second:** the dropdown
should visibly respond while typing (loading state), highlight the matched text, show
a country flag and rank the operator's home country first, and offer recent picks +
inline ghost completion. Traces to the `0038` premium-city-UX line on ROADMAP — this
is its correctness + polish follow-up.

## Out of scope

- The map-draw scrape mode (`scraperMode === 'map'`) — untouched.
- Instant keyword mode (`panelMode === 'instant'`) — untouched.
- Re-importing or expanding the GeoNames gazetteer (`geo_places` already holds
  170,050 rows; verified live).
- The coverage registry / `scraped_areas` read model — untouched (the displayName it
  stores improves as a side effect, but no schema or logic change here).
- Multi-country "home" configuration UI — home country is a single server constant
  (`AR`) this slice; a Settings-driven home is a parked follow-up.
- Persisting recent searches server-side — recents live in `localStorage` only.

## Constraints (`docs/SPEC.md` / `rules/*`)

- **Service layering** (`rules/architecture.md`): the new pick-aware resolver lives in
  `services/geocoder.ts`; any new query in `db/geo.ts`; routes only parse + delegate;
  client HTTP only through `lib/api.ts` + the existing hook.
- **Zero-cell guard stays** — the new bbox still flows through `cellCount`; if it
  computes 0 cells, refuse the job (existing guard at `scrape.ts:100`). Never dispatch
  nothing.
- **Nominatim 1 req/s** — the biased lookup reuses the existing `rateLimited` gate in
  `geocoder.ts`; the centroid fallback makes **no** external call, so a rate-limit
  stall can never block a pick.
- **lat/lon precision** — `geo_places.lat/lon` are gazetteer centroids (REAL, existing
  schema); used only to compute a city-scale bbox, not stored as place coordinates, so
  the "lat/lng as strings" place-storage invariant is unaffected.
- **booleanPointInPolygon `(point, polygon)` GeoJSON `[lon,lat]`** — unchanged; the grid
  path downstream of the bbox is untouched.
- **SSE-only realtime** — no new realtime; the picker is request/response.
- **rules/ui.md** — dropdown is a raised glass surface (`--bg-elevated`, hairline,
  `--shadow-md`, no double depth+outline); JetBrains Mono for population/coords; no
  tiny <12px labels; loading uses shimmer (never the literal "Loading…"); honest empty
  state (no fake rows); amber only for the active option + matched-text highlight;
  respect `prefers-reduced-motion` (existing `kpAcIn` keyframe already does).

## Diagnose-first checklist

Completed 2026-06-26 BEFORE writing this plan. Live evidence captured.

- [x] Files read: `client/src/components/ui/AreaAutocomplete.tsx`,
      `client/src/hooks/useAreaAutocomplete.ts`, `client/src/lib/api.ts:60-87`
      (`GeoPlace`, `geoAutocomplete`), `client/src/components/Scraper/KeywordPanel.tsx`
      (pick + `handlePreviewCity`), `server/src/routes/geo.ts`,
      `server/src/services/geocoder.ts` (`searchAreas`, `resolveAreaToBbox`),
      `server/src/db/geo.ts` (`searchAreas` SQL), `server/src/routes/scrape.ts:60-114`
      (`/city/resolve` + `/city`, both call `resolveAreaToBbox`),
      `server/src/db/index.ts:194-205` (`geo_places` schema + index),
      `client/src/styles/globals.css:776-794` (`kp-ac*` styling).
- [x] Symbols catalogued: `geo_places`, `searchAreas`, `resolveAreaToBbox`, `GeoPlace`
      (`name, admin1, country, population, lat, lon`), `placeLabel`, `onPick`/`onChange`,
      `cityResolveSchema`, `citySchema`, `cellCount`, `polygonFromBbox`, `rateLimited`,
      `CITY_CELL_KM_DEFAULT`.
- [x] Evidence (live, server in container, `/app/data/scraper.db`):
  - `geo_places` = **170,050 rows**. Backend works:
    `GET /api/geo/autocomplete?q=Mar` → 8 ranked hits incl. *Mar del Plata*.
  - **Pick-resolve bug reproduced** via `POST /api/scrape/city/resolve`:
    - `"Belgrano, Buenos Aires F.D., AR"` (the exact label a pick sends) → **400**,
      "Could not resolve … Try adding a country or state."
    - `"Belgrano, AR"` → resolves to **"Estación de Trenes Manuel Belgrano", Santa Fe**
      (~400 km away), bbox = a single building, `cellCount: 1`.
    - `"Belgrano, Argentina"` → same wrong train station.
  - The pick **already holds the right point**: GeoNames `Belgrano | Buenos Aires F.D.
    | AR | lat -34.5627 lon -58.45829 | pop 138942`. `onPick` receives it but uses only
    `population`; `placeLabel` rebuilds a string the resolver can't parse.
  - Root cause of "F.D." 400: `admin1` from GeoNames is `"Buenos Aires F.D."` (Federal
    District); the comma-joined `name, admin1, country-CODE` label is a poor Nominatim
    query → no hit or wrong homonym.
- [x] "Dropdown shows nothing": not reproducible from the backend (suggestions return
      correctly) and the operator later *did* receive a Belgrano suggestion → treat as a
      stale-first-load (project memory: Windows bind-mount swallows Vite HMR). Slice
      rebuilds the component; verification is a live browser check after a client restart.
- [x] Research (combobox/autocomplete UX, 2026): WAI-ARIA combobox pattern (role,
      aria-activedescendant, aria-expanded — partly present); highlight matched
      substring; explicit loading + empty states; geographic disambiguation via
      flag/region + home-bias ranking; recent-search affordance on empty focus; inline
      ghost-text completion with Tab-to-accept. All map onto the chosen feature set.
- [x] Open question for operator — **bbox-on-pick strategy** → **answered: "Both"**
      (biased Nominatim → validate → fall back to centroid+population box). Feature set →
      **answered: all four** (highlight, loading/empty, flags+ranking, recent+ghost).

## Implementation plan

_Operator approves before edits. Each step verifies before the next._

### Phase 1 — Correctness: pick-aware bbox resolve (the load-bearing fix)

- **1a — `resolvePickedArea` in `services/geocoder.ts`.** New function taking
  `{ name, country, lat, lon, population }`:
  1. **Biased Nominatim:** query `q = name, <country-name>` with a `viewbox` around
     `(lat, lon)` (± a population-scaled span) so it can't wander to a homonym. Reuse the
     existing `rateLimited` gate + User-Agent.
  2. **Validate the hit:** accept only if the returned bbox's centroid is within
     ~`50 km` of the picked point **and** the bbox spans more than ~`1 km` (reject
     building-/amenity-sized boxes — the Santa-Fe-train-station failure mode). Distance
     via a cheap equirectangular approximation.
  3. **Fallback:** else build a box from the exact picked point + a **population→radius
     band** (the calibration knob):
     `<20k→3km · <100k→5km · <500k→10km · <2M→15km · else→25km` half-extent;
     `dLat = km/111`, `dLon = km/(111·cos(lat))`.
     `// ponytail: static bands tuned for AR cities; widen/narrow per-pick only if coverage complaints appear`
  Returns the same `ResolvedArea` shape (`bbox`, `displayName`, `kind`) so callers are
  unchanged. *(Verify: a unit-style `__main__`/assert check or a one-off tsx script —
  Belgrano `(-34.5627,-58.45829, pop 138942)` yields a bbox centered on the real barrio,
  `kind` either a city boundary or `centroid-box`, never the Santa Fe building.)*

- **1b — Thread the picked coords through both routes.** Extend `cityResolveSchema`
  (and thus `citySchema`) with an optional `picked: { lat:number, lon:number,
  country:string|null, population:number }`. In `/city/resolve` **and** `/city`: if
  `picked` present → `resolvePickedArea`; else → existing `resolveAreaToBbox(area)`
  (free-typed, no suggestion chosen). Both routes must use the same branch — Preview and
  dispatch cannot diverge. *(Verify: `curl POST /api/scrape/city/resolve` with the
  Belgrano `picked` payload → bbox over the real barrio; without `picked`, a free-typed
  `"Rosario, Argentina"` still resolves as today.)*

- **1c — Client carries the pick.** `KeywordPanel` stores the full picked `GeoPlace`
  (not just population) in state; clears it on any manual edit (`onChange`). `lib/api.ts`
  `resolveCityArea` / `startCityScrape` send `picked` when set. *(Verify: live in
  browser — pick Belgrano, Preview shows the barrio + a sane cell count; edit the text by
  hand and Preview falls back to name resolve.)*

### Phase 2 — Modernization (on top of the now-correct base)

- **2a — Highlight matched text.** Prefix search means the match is the leading
  substring; render the matched head in `--accent`, the rest in `--text-primary`.
  *(Verify: typing "Mar" bolds "Mar" in "Mar del Plata".)*
- **2b — Loading + empty states.** `useAreaAutocomplete` returns `{ results, loading }`
  (`loading` true between debounce-fire and response). Component: shimmer rows while
  loading-with-no-results; honest "Sin resultados" when settled-empty; a subtle "Seguí
  escribiendo…" when `< 2` chars and focused. No literal "Loading…", no fake rows.
  *(Verify: throttle network in devtools — shimmer appears; a gibberish query shows the
  empty state, not a blank box.)*
- **2c — Country flag + home-country ranking.** ISO-2 `country` → regional-indicator
  emoji flag (pure fn, no assets) shown per row. `db/geo.ts` search adds
  `ORDER BY (country = ?) DESC, population DESC` with a server `HOME_COUNTRY = 'AR'`
  constant. *(Verify: `GET /api/geo/autocomplete?q=Buenos` → `Buenos Aires AR` ranks
  first; rows render a 🇦🇷 / 🇻🇪 etc. flag.)*
- **2d — Recent searches + ghost completion.** Recents: last ~5 picked places in
  `localStorage`, shown on empty focus (pick = same handler). Ghost: when the field value
  is a case-insensitive prefix of `results[0].name`, render the remainder as ghost text;
  `Tab` accepts (fills + picks). *(Verify: pick two areas, refocus empty field → recents
  list; type "Mar" → ghost "…del Plata", Tab fills it.)*
  `// ponytail: ghost text is the most fragile piece visually — if it fights the input layout, ship recents only and park ghost`

- **Both phases — tsc.** *(Verify: `npx tsc --noEmit` clean — server in container, client.)*

## Verification gate

_Filled DURING execution with live evidence — not assertions._

- [x] Pick-resolve: `POST /api/scrape/city/resolve` with the Belgrano `picked` payload →
      `bbox {minLat -34.5750, maxLat -34.5316, minLon -58.4734, maxLon -58.4254}`,
      `displayName "Belgrano, Buenos Aires, Comuna 13, Ciudad Autónoma de Buenos Aires, Argentina"`,
      `kind "suburb"`, `cellCount 9`. The real barrio. The old `"Belgrano, …, AR"` string path
      is gone on pick. **First-cut bug found+fixed during exec:** `limit=1` initially grabbed a
      same-name *railway station* ~9 km away (1.1 km box) sitting in the viewbox — fixed by
      fetching `limit=10` and taking the first **area-typed** (`AREA_TYPES` whitelist) + near +
      `>1 km` hit, so a POI homonym can't shadow the real area.
- [x] Dispatch parity: `POST /api/scrape/city` with the same `picked` → job stored
      `bboxJson {minLat -34.5750, maxLat -34.5316, minLon -58.4734, maxLon -58.4254}` and
      `geometryJson` Polygon over the barrio (lat -34.5x, lon -58.4x), `cellCount 9` —
      **not Santa Fe**. (Job created then DELETE-cancelled to avoid a real scrape.)
- [x] Free-typed fallback intact: `POST /city/resolve {"area":"Rosario, Argentina"}` (no
      `picked`) → `kind "city"`, `displayName "Municipio de Rosario, …, Santa Fe, Argentina"`,
      `cellCount 90` — unchanged from today's behavior.
- [x] Home-country ranking (2c): `GET /api/geo/autocomplete?q=Buenos` → `AR | Buenos Aires |
      Buenos Aires F.D. | pop 2891082` first, ahead of CR/MX/PE/CO homonyms.
- [x] **Browser visual — VERIFIED live (Claude-in-Chrome, `localhost:5173`, Whole-city).**
      Typing "Mar" → results dropdown; matched head "Mar" rendered in `--accent`, name in
      `--text-primary`, region (", Buenos Aires, AR") muted; population in JetBrains Mono
      right-aligned; AR rows ranked first. Ghost tail "del Plata" shown in the field; **Tab
      accepted** it → field "Mar del Plata, Buenos Aires, AR", pick registered (Population
      593.337, lead estimate). **Preview → "Mar del Plata, Partido de General Pueyrredón,
      Buenos Aires, Argentina", `city`, 91 cells** — the real city via the pick path. Clearing
      the field + focus → "RECIENTES" with the persisted Mar del Plata. Empty/hint/shimmer
      states present.
      Caveat: country flags render as the ISO-2 letters (e.g. "AR") on Windows Chrome — the OS
      has no regional-indicator emoji glyphs; still conveys the country. No code change; the
      `flagEmoji` pair renders as 🇦🇷 on platforms with flag glyphs.
- [x] `npx tsc --noEmit` clean — server (in container) `SERVER_EXIT=0`; client `No errors found`.

## Completion record

- Commit SHAs: `649e08e`
- What changed:
  - **Phase 1 (correctness, load-bearing):** `resolvePickedArea` in `services/geocoder.ts` —
    biased Nominatim (`viewbox` + `countrycodes` + `bounded=1`, `limit=10`), accept the first
    area-typed (`AREA_TYPES`) hit within 50 km spanning >1 km, else a population-scaled
    centroid box (`popToRadiusKm` bands; no external call). `picked` threaded through both
    `/city/resolve` and `/city` (shared branch → Preview/dispatch parity). Client carries the
    full picked `GeoPlace` (`cityPick`), cleared on manual edit, sent as `picked`.
  - **Phase 2 (modernization) — all four shipped:** matched-text highlight; loading shimmer +
    honest "Sin resultados" + "Seguí escribiendo…" hint (`useAreaAutocomplete` now returns
    `{results, loading}`); country flags (`flagEmoji`) + home-country ranking (`db/geo.ts`
    `ORDER BY (country = ?) DESC`, `HOME_COUNTRY='AR'`); recents in `localStorage` + ghost
    completion (Tab to accept).
- Follow-ups / new parked items:
  - Settings-driven home country (still the `HOME_COUNTRY='AR'` server constant).
  - Real-boundary-only mode (reject the centroid-box fallback) if an operator wants it.
  - Server-persisted recents (currently `localStorage` only).
  - Ghost completion shipped (not cut) — revisit only if it fights the input layout on some
    fonts/zoom.
  - Country flags show as ISO-2 letters on Windows (no emoji flag glyphs) — cosmetic, OS-level.
