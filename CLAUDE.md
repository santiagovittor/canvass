# CLAUDE.md

Behavioral guidelines + project context for Claude Code. Read this before touching any file.

**Active plugins:** superpowers (TDD, planning, debugging, subagent workflows) · feature-dev (7-phase feature workflow with architect/explorer/reviewer agents) · code-review (confidence-scored pre-merge review via `/code-review`)

**Lazy-loaded rules:**
- UI rules auto-load when touching `client/src/**` via `.claude/rules/ui.md`.
- Architecture rules (folder boundaries, banned packages, service layering) in `.claude/rules/architecture.md`.
- Verification steps for bug fixes live in the `fix-bug` skill.

---

## 0. Dev Commands

```bash
# Development (run in separate terminals after docker compose up)
docker compose -f docker-compose.dev.yml up          # gosom container on :3050 + SQLite volume
npm run dev                                           # vite (:5173) + express (:3001) concurrently

# Build & production
npm run build                                         # builds client/dist + compiles server
npm run start                                         # express serves client/dist as static files

# Type check (no ESLint, no `lint` script — tsc only)
npx tsc --noEmit                                      # run from client/ or server/ (in the dev container for server)
```

Port map: `5173` = Vite dev, `3001` = Express API, `3050` = gosom scraper container.

Default location (Buenos Aires): lat `-34.6037`, lng `-58.3816`, zoom `13`.

Grid default 0.4 km is tuned for dense urban areas: smaller cells = more gosom jobs but better coverage; overlap dupes are absorbed by place_id dedup + upsert. For sparse areas raise cell size in the UI rather than changing the default.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State assumptions explicitly. If uncertain, ask before writing a single line.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so before implementing the complex one.
- If something is genuinely unclear, **stop and name what's confusing**.
- Every implementation decision must trace back to a stated requirement.

---

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what the spec asks.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.

This is a personal internal tool, not an enterprise product. Prefer single-file implementations, copy-paste over generalization, readable over clever.

**Test:** Would a senior engineer call this overcomplicated? If yes, simplify.

---

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- When your changes create orphans (unused imports, dead vars): remove those. Only those.

**Test:** Every changed line should trace directly to the stated task.

---

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

For every implementation step, state:
1. What you will implement
2. How you will verify it works before moving on

Don't proceed to the next step until the current one verifies.

---

## 5. Tech Stack — LOCKED. Do NOT deviate.

- **React 18** + **Vite 5** + **TypeScript 5** + **Tailwind CSS 3.4**
- **Leaflet 1.9.x** + **react-leaflet 4.2.x** — DO NOT upgrade. v5 is ESM-only and breaks.
- **leaflet-draw 1.0.x** — integrate manually, NOT via a wrapper package.
- **Node.js 20** + **Express 4** + **better-sqlite3** + **Drizzle ORM**
- **gosom/google-maps-scraper:latest** — Docker, REST mode, `-web` flag.
- **SSE only** for realtime. No polling, no WebSocket, no socket.io.
- **undici** for server-side HTTP. **cheerio** for HTML parsing. **googleapis** for Sheets.

---

## 6. Critical Constraints

These are load-bearing. Breaking any of them breaks the app:

- Vite proxy: target must be `http://server:3001` (Docker Compose service name). Never `http://localhost:3001` — inside a container, localhost resolves to itself, not Express.
- **Lat/lng as strings** in the DB (SQLite REAL loses precision at zoom ≥ 17). Parse only at render.
- **booleanPointInPolygon argument order:** `(point, polygon)` — turf reverses this vs. most libs. Easy to swap.
- **Zero-cell guard:** if grid computation returns 0 cells, refuse to create the job. Don't silently succeed.
- **SQLite boot pragmas:** `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`. Both, on every connection.
- **SSRF protection in `socialEnricher.ts` is mandatory** — resolve the hostname and reject private/loopback IPs before fetching.
- **Grid computation runs on both client (preview) and server (job creation)** with identical logic. Keep them in sync.
- **Social enrichment runs automatically after every scrape**, not manually triggered.
- **Env vars validated via zod in `server/src/env.ts` at boot.** Missing required var → crash with a clear message. No silent defaults.
- In production, `server/src/index.ts` serves `../client/dist` as static files.

---

## 7. Token Management

- One task per message. Don't batch unrelated work.
- Reference specific files with `@filename`. Don't read whole directories.
- If context approaches 60%, `/compact focus on [current phase], drop any prior phase output`.
- Never read unprompted: `node_modules/`, `dist/`, `.git/`, `data/`, `credentials/`.

---

**If these guidelines conflict with each other, prioritize in order: 5 > 6 > 3 > 2 > 1 > 4.**