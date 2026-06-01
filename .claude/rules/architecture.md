# Architecture Rules

Project: maps-scraper — personal B2B lead generation tool.
Stack: React 18 + Vite + TS + Node.js + Express + better-sqlite3 + Drizzle + gosom (Docker, REST).

---

## Folder Rules

Strict service layer. No exceptions.

- `server/src/routes/**` — routes call services only. No business logic, no DB access, no HTTP clients. Parse request, invoke service, shape response.
- `server/src/services/**` — services contain business logic and call `server/src/db/**` only. No raw SQL, no direct Drizzle calls outside db/.
- `server/src/db/**` — the only place Drizzle queries exist. Services import repository functions from here.
- `client/src/lib/**` — pure functions. No React imports, no hooks, no side effects. `lib/api.ts` is the sole HTTP client.
- `client/src/hooks/**` — React hooks only. No direct fetch. All HTTP goes through `lib/api.ts`. No business logic that belongs server-side.
- `client/src/components/ui/**` — custom primitives. Do not import third-party UI kits here.

---

## Packages — Do Not Add

Each of these has been considered and rejected. Do not propose them again.

- **socket.io / ws** — SSE already handles all realtime. No bidirectional need.
- **axios** — undici is configured server-side. fetch on the client.
- **React Query / SWR / TanStack Query** — custom hooks in `client/src/hooks/` cover this app's scope.
- **shadcn/ui, Radix, Mantine, Chakra, MUI** — primitives live in `client/src/components/ui/`. Keep the bundle small.
- **react-hook-form / Formik** — plain controlled inputs. Forms in this app are small.
- **zod on the client** — server validates every request boundary. Client trusts server responses.
- **moment / date-fns / dayjs** — `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` are sufficient.
- **lodash / underscore / ramda** — native JS only (`Array.prototype.*`, `Object.entries`, `structuredClone`).
- **Leaflet wrappers other than react-leaflet@4.2.x** — version is pinned. No substitutes.

---

## Architectural Decisions — Settled

Do not revisit without a written reason.

- 26 hardcoded B2B categories. One gosom job per category per grid cell.
- Jobs run sequentially. No parallelism, no worker pools.
- Deduplication is by `place_id`. Nothing else is authoritative.
- Grid cells are filtered by `booleanPointInPolygon` before dispatch. If zero cells pass, throw a user-facing error. Never silently dispatch nothing.
- Social enrichment runs automatically after every scrape completes. It is not opt-in.
- gosom is driven via its REST API only. No CLI invocation, no file-based input.
- better-sqlite3 runs in WAL mode. Every connection executes `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` at startup. Both, every time.
- SSRF protection in `server/src/services/socialEnricher.ts` is mandatory. Resolve hostname, reject private ranges before fetching. No bypass flag.
- Env vars validated by zod in `server/src/env.ts` at boot. Missing var → crash with clear message. No silent defaults.
- In production, `server/src/index.ts` serves `../client/dist` as static files.

---

## gosom Integration Gotchas

Hard-won. Do not re-learn these.

- **lat/lon arrive as strings** from the gosom REST response. Always `parseFloat` before arithmetic, comparisons, or passing to turf.
- **max_time is seconds**, not nanoseconds. The field name is deceptive if you're coming from Go's `time.Duration`.
- **Vite proxy target must be `http://server:3001`** — the Docker Compose service name. `localhost:3001` inside the Vite container resolves to the Vite container itself, not Express.
- **booleanPointInPolygon expects `[longitude, latitude]`** — GeoJSON order. Leaflet uses `[lat, lng]`. Verify axis order at every boundary between the two.
- **Poll loop must see "working" before exiting on "ok".** gosom reports "ok" as an initial idle state before the job starts. Require the `working → ok` transition before treating "ok" as completion.