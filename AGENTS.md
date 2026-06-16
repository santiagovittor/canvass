# AGENTS.md

Behavioral guidelines + project context for Codex. Read before touching files.

**Active workflows:** planning · TDD · debugging · code review · focused subagent exploration when useful.

**Lazy-loaded rules:**

* UI rules: load when touching `client/src/**` from `.claude/rules/ui.md`.
* Architecture rules: folder boundaries, banned packages, and service layering in `.claude/rules/architecture.md`.
* Bug-fix verification: use the verification approach described in the `fix-bug` skill/rules when applicable.

---

## 0. Dev Commands

```bash
# Development
docker compose -f docker-compose.dev.yml up
npm run dev

# Build / production
npm run build
npm run start

# Type check only; no ESLint/lint script
npx tsc --noEmit
```

Run `npx tsc --noEmit` from `client/` or `server/`. For server checks, use the dev container when required.

Ports: `5173` = Vite, `3001` = Express API, `3050` = gosom scraper.

Default location: Buenos Aires, lat `-34.6037`, lng `-58.3816`, zoom `13`.

Default grid size is `0.4 km`. For sparse areas, raise cell size in the UI instead of changing the default.

---

## 1. Think Before Coding

Do not assume. Do not hide uncertainty.

Before editing:

* restate the task
* list assumptions
* name ambiguities
* choose the simplest viable approach
* explain tradeoffs if there is more than one reasonable path

If the task is unclear, stop and ask.

Every implementation decision must trace to a stated requirement.

---

## 2. Simplicity First

Minimum code that solves the problem.

This is a personal internal tool, not an enterprise product.

Prefer:

* small changes
* single-file implementations when reasonable
* readable code over clever abstractions
* copy-paste over premature generalization

Do not add features, config, abstractions, wrappers, or future-proofing unless requested.

---

## 3. Surgical Changes

Touch only what the task requires.

Do not:

* refactor unrelated code
* reformat unrelated files
* upgrade packages
* change architecture for a local fix
* delete unrelated dead code

If you notice unrelated issues, mention them instead of fixing them.

Remove only unused imports, variables, or dead code created by your own change.

---

## 4. Goal-Driven Execution

For each implementation step:

1. state what will change
2. state how it will be verified
3. make the smallest change
4. verify before moving on

For bug fixes, reproduce or clearly describe the failure first. Do not claim success without verification.

---

## 5. Tech Stack — Locked

Do not deviate.

* React 18
* Vite 5
* TypeScript 5
* Tailwind CSS 3.4
* Leaflet 1.9.x
* react-leaflet 4.2.x
* leaflet-draw 1.0.x, manual integration only
* Node.js 20
* Express 4
* better-sqlite3
* Drizzle ORM
* gosom/google-maps-scraper:latest, Docker REST mode with `-web`
* SSE only; no polling, WebSocket, or socket.io
* undici for server HTTP
* cheerio for HTML parsing
* googleapis for Sheets

---

## 6. Critical Constraints

These are load-bearing.

* Vite proxy target must be `http://server:3001`, never `http://localhost:3001`.
* Store lat/lng as strings in SQLite.
* Parse lat/lng only at render time.
* `booleanPointInPolygon(point, polygon)` argument order is mandatory.
* If grid computation returns 0 cells, refuse job creation.
* Every SQLite connection must enable:

  * `PRAGMA journal_mode=WAL`
  * `PRAGMA foreign_keys=ON`
* `socialEnricher.ts` must keep SSRF protection:

  * resolve hostname
  * reject private/loopback IPs before fetching
* Client preview grid and server job grid must use identical logic.
* Social enrichment runs automatically after every scrape.
* Env vars are validated with zod in `server/src/env.ts`.
* Missing required env vars must crash at boot with a clear error.
* Production Express serves `../client/dist` from `server/src/index.ts`.

---

## 7. Codex Context Management

One task per prompt.

Reference specific files with `@filename` when possible.

Do not read unprompted:

* `node_modules/`
* `dist/`
* `.git/`
* `data/`
* `credentials/`

Do not scan whole directories unless required.

Use subagents only for isolated exploration, debugging, or review. Subagents should not edit files unless explicitly requested.

Use web search only when current external facts are required.

Never expose secrets or credentials in prompts, logs, comments, or commits.

---

## 8. Verification

Use the smallest relevant verification.

Frontend:

```bash
cd client && npx tsc --noEmit
```

Server:

```bash
cd server && npx tsc --noEmit
```

Full build:

```bash
npm run build
```

Report exactly what was verified. If verification cannot run, say why.

---

## 9. Priority Order

If rules conflict, follow this order:

1. Locked tech stack
2. Critical constraints
3. Surgical changes
4. Simplicity
5. Think before coding
6. Goal-driven execution
7. Context management
