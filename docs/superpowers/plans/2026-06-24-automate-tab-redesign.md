# Automate Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the Automate tab into a full-width ingest → prepare → send pipeline
console: pick leads, run the batch, review/edit drafts, schedule or send.

**Architecture:** Full-width `AutomatePage` with three stacked lanes
(`IngestLane`, `PrepareLane`, `SendLane`), each a resting panel with a numbered
`LaneHeader`. Lanes reuse existing components/hooks and drive existing endpoints;
new custom UI primitives (`Checkbox`, `SelectableTable`, `LaneHeader`,
`InlineDraftEditor`) carry the new interactions. SSE-only realtime.

**Tech Stack:** React 18 + TS + Vite, custom primitives in
`client/src/components/ui/`, tokens in `globals.css`, HTTP via `lib/*Api.ts`,
realtime via `useSSE`.

## Global Constraints

- No new UI library (architecture.md §Packages / ui.md HARD BANS). Custom primitives only.
- No `fetch(` in `.tsx`; all HTTP through `lib/*Api.ts` + a hook in `hooks/`.
- SSE only (`/events`); no polling, no `setInterval` data fetch (local UI tick to animate is allowed).
- No raw hex in components; no sub-12px type. Add missing tokens to `globals.css` first.
- Numeric/data values in `var(--font-mono)`.
- Per-task gate: `npx tsc --noEmit -p client/tsconfig.json` clean; server tsc in dev container when server touched. Verify visually via live render where UI changes.
- Reuse-only backend; additive at most. Default: zero server change.

---

### Task 1: Outreach filter-overflow fix (standalone quick win)

**Files:**
- Modify: `client/src/components/Outreach/LeadQueue.tsx:228` (mode-pill row) and audit sibling filter rows in the same 300px column.

- [ ] **Step 1:** Add `flexWrap: 'wrap'` + `rowGap` to the mode-pill row container (`LeadQueue.tsx:228`). Check the `mode==='followup'` row (`:264`) and any other non-wrapping `display:flex` row in that column; add `flexWrap` where pills/controls can exceed 300px.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Live render Outreach at the 300px column; confirm all mode pills are visible/reachable, no clipping.
- [ ] **Step 4:** Commit `fix(outreach): wrap lead-queue filter pills so they don't clip the column`.

---

### Task 2: Visual tokens for lanes

**Files:**
- Modify: `client/src/styles/globals.css`

- [ ] **Step 1:** Add tokens used by the redesign if missing: `--space-lane: 20px` (lane padding), `--gap-lane: 16px` (between lanes), `--automate-max: 1200px`, a numbered-badge size token, and a subtle row-hover token if not already present. Reuse existing `--bg-panel/--bg-elevated/--border/--radius-pane/--shadow-*/--text-*` rather than inventing.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean (CSS-only, just confirm nothing else broke).
- [ ] **Step 3:** Commit `style(automate): add layout tokens for redesigned lanes`.

---

### Task 3: `Checkbox` primitive

**Files:**
- Create: `client/src/components/ui/Checkbox.tsx`

**Interfaces:**
- Produces: `export function Checkbox(props: { checked: boolean; indeterminate?: boolean; onChange: (next: boolean) => void; 'aria-label'?: string; disabled?: boolean }): JSX.Element`

- [ ] **Step 1:** Implement a token-styled checkbox: a `<button role="checkbox" aria-checked={indeterminate ? 'mixed' : checked}>` with a custom box (border `--border-strong`, checked fill `--accent`, check glyph in `--accent-ink`), 18px, keyboard space/enter toggles, `disabled` 40% opacity. `indeterminate` shows a dash. No raw hex.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(ui): Checkbox primitive`.

---

### Task 4: `LaneHeader` primitive

**Files:**
- Create: `client/src/components/Automate/LaneHeader.tsx`

**Interfaces:**
- Produces: `export function LaneHeader(props: { step: number; title: string; status?: React.ReactNode }): JSX.Element`

- [ ] **Step 1:** Implement a header row: a circular numbered badge (`step`, `--font-mono`, `--accent` ring), the lane `title` (`--text-section`, `--font-ui`), and a right-aligned `status` slot. Comfortable spacing, bottom hairline seam.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(automate): LaneHeader primitive`.

---

### Task 5: `SelectableTable` primitive

**Files:**
- Create: `client/src/components/ui/SelectableTable.tsx`

**Interfaces:**
- Consumes: `Checkbox` (Task 3).
- Produces:
  ```ts
  export interface Column<T> { key: string; header: string; render: (row: T) => React.ReactNode; mono?: boolean; width?: number }
  export function SelectableTable<T>(props: {
    rows: T[];
    rowId: (row: T) => string;
    columns: Column<T>[];
    selected: Set<string>;
    onToggle: (id: string) => void;
    onToggleAll: (ids: string[]) => void;   // toggles all CURRENT rows
    emptyLabel?: string;
  }): JSX.Element
  ```

- [ ] **Step 1:** Implement: header row with a select-all `Checkbox` (checked when all current rows selected, indeterminate when some) + column headers; body of compact rows (42–48px), each leading with a `Checkbox`, selected rows get a subtle `--accent-dim` tint, hover token. Mono columns use `--font-mono`. Empty state shows `emptyLabel` (no literal "Loading...").
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(ui): SelectableTable primitive`.

---

### Task 6: `useLeadStaging` hook

**Files:**
- Create: `client/src/hooks/useLeadStaging.ts`

**Interfaces:**
- Consumes: `getOutreachLeads(page, { validEmail, search })` (`lib/outreachApi.ts`).
- Produces:
  ```ts
  export interface StagingLead { id: string; name: string; category: string | null; locCountry: string | null }
  export function useLeadStaging(): {
    leads: StagingLead[]; total: number; loading: boolean;
    search: string; setSearch: (s: string) => void;
    selected: Set<string>; toggle: (id: string) => void; toggleAll: (ids: string[]) => void;
    selectFirst: (n: number) => void; clear: () => void;
  }
  ```

- [ ] **Step 1:** Implement: fetch page-1 deliverable leads (`validEmail:true`) + on `search` change (debounced ~250ms via local timer, not a poll). Own selection `Set`. `selectFirst(n)` pages `getOutreachLeads` until `n` ids collected (mirror `AutomatePage.collectLeadIds`), sets selection to those. Map rows → `StagingLead`.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(automate): useLeadStaging hook`.

---

### Task 7: `PrepareLane` (staging + run + live console)

**Files:**
- Create: `client/src/components/Automate/PrepareLane.tsx`
- Modify: `client/src/components/Automate/BatchConsole.tsx` (extract the ACTIVE-run render — progress/ETA/cost/counts/StageTracker/OutcomeList — into an exported `BatchRunView` the lane embeds; drop the standalone 720px idle card).

**Interfaces:**
- Consumes: `useBatchRun` (existing), `useLeadStaging` (Task 6), `SelectableTable` (Task 5), `LaneHeader` (Task 4).
- Produces: `export function PrepareLane(): JSX.Element`

- [ ] **Step 1:** Extract `export function BatchRunView({ progress, currentLead, accumulatedCost, items, onPause, onResume, onCancel })` from `BatchConsole.tsx` (the active branch, restyled as metric cards inside a lane — no fixed `maxWidth`, fills lane width).
- [ ] **Step 2:** Implement `PrepareLane`: `LaneHeader step=2 title="Preparar"`. When idle/no active run: staging `SelectableTable` (columns name / category / país), a search input, quick-select pills ("Primeros 15/30/60" → `selectFirst`), dry-run toggle, primary `Preparar {selected.size} seleccionados` (disabled when 0) → `start([...selected], dryRun)`. When a run is active: render `BatchRunView`.
- [ ] **Step 3:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 4:** Commit `feat(automate): Prepare lane with lead staging + run-on-selection`.

---

### Task 8: `useScheduledSends` hook

**Files:**
- Create: `client/src/hooks/useScheduledSends.ts`

**Interfaces:**
- Consumes: `listScheduled()`, `getScheduledQueueStatus()`, `pauseScheduler/resumeScheduler`, `cancelScheduled`, `rescheduleScheduled`, `cancelAllPending` (`lib/outreachApi.ts`); `useSSE`.
- Produces:
  ```ts
  export function useScheduledSends(): {
    rows: ScheduledSend[]; status: ScheduledQueueStatus | null; loading: boolean;
    refresh: () => void;
    cancel: (id: string) => Promise<void>;
    reschedule: (id: string, localDateTime: string) => Promise<void>; // uses baLocalToUtcIso
    cancelAll: () => Promise<void>;
    pause: (reason?: string) => Promise<void>; resume: () => Promise<void>;
  }
  ```

- [ ] **Step 1:** Implement: one-shot `listScheduled` + `getScheduledQueueStatus` on mount; re-`refresh()` on `send-scheduler:tick` SSE (subscribe via `useSSE`); mutation passthroughs that call the API then `refresh()`.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(automate): useScheduledSends hook`.

---

### Task 9: `InlineDraftEditor`

**Files:**
- Create: `client/src/components/Automate/InlineDraftEditor.tsx`

**Interfaces:**
- Consumes: `loadDraft(businessId)`, `saveDraft(businessId, subject, body, isAiDraft)` (`lib/outreachApi.ts`).
- Produces: `export function InlineDraftEditor(props: { businessId: string; onClose: () => void; onSaved?: () => void }): JSX.Element`

- [ ] **Step 1:** Implement: on mount `loadDraft`; show subject input + body textarea (token-styled, mono not required for prose), `Guardar` (`saveDraft`, then `onSaved?.()` + `onClose`) and `Cancelar`. Skeleton/shimmer while loading (no "Loading...").
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(automate): InlineDraftEditor`.

---

### Task 10: `SendLane` (queue + review/edit + send/schedule/cancel)

**Files:**
- Create: `client/src/components/Automate/SendLane.tsx`

**Interfaces:**
- Consumes: `useScheduledSends` (Task 8), `InlineDraftEditor` (Task 9), `LaneHeader` (Task 4), `sendOutreachEmail`, `formatScheduledAt`, `defaultScheduleLocal` (`lib/outreachApi.ts`).
- Produces: `export function SendLane(): JSX.Element`

- [ ] **Step 1:** Implement: `LaneHeader step=3 title="Enviar"` with scheduler status + pause/resume in the status slot. Queue list (each row: business name, scheduled-at via `formatScheduledAt`, window label, origin). Per-row actions: `Editar` (toggles `InlineDraftEditor` inline), `Enviar ahora` (`sendOutreachEmail`), `Reprogramar` (datetime input → `reschedule`), `Cancelar` (`cancel`). Footer: `Cancelar todo` (`cancelAll`, guarded by inline confirm state — no native `confirm()`). Empty state when queue empty.
- [ ] **Step 2:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 3:** Commit `feat(automate): Send lane — review/edit drafts, send now, reschedule, cancel`.

---

### Task 11: `useScrapeSchedules` hook + `IngestLane`

**Files:**
- Create: `client/src/hooks/useScrapeSchedules.ts`, `client/src/components/Automate/IngestLane.tsx`
- Reuse: `ScrapeSchedulerStatus`, `SchedulesList` (`components/Scraper/`).

**Interfaces:**
- Consumes: `listScrapeSchedules`, `getScrapeSchedulerStatus`, `pauseScrapeScheduler`, `resumeScrapeScheduler`, `runScrapeScheduleNow`, `deleteScrapeSchedule` (`lib/scrapeSchedulesApi.ts`); `useSSE`.
- Produces: `useScrapeSchedules()` returning `{ schedules, status, loading, refresh, pause, resume, runNow, remove }`; `export function IngestLane(): JSX.Element`.

- [ ] **Step 1:** `useScrapeSchedules`: one-shot list + status on mount; refresh on `scrape-scheduler:tick` SSE; mutation passthroughs. (If `ScrapeSchedulerStatus`/`SchedulesList` already self-fetch, IngestLane may reuse them directly and the hook only supplies the management list — keep whichever is less duplicative; do not double-fetch.)
- [ ] **Step 2:** `IngestLane`: `LaneHeader step=1 title="Ingesta"` with scheduler health in the status slot; render schedules with next/last run + run-now/pause/resume/delete; a one-line link "Crear desde el mapa en Scraper →" (switches to Scraper tab — accept an `onGoToScraper` prop wired from `AutomatePage`/`App`, or render plain text if wiring nav is out of reach this pass).
- [ ] **Step 3:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 4:** Commit `feat(automate): Ingest lane — scrape scheduler status + management`.

---

### Task 12: `AutomatePage` full-width lane composition

**Files:**
- Modify: `client/src/components/Automate/AutomatePage.tsx` (rewrite as the lane container).

**Interfaces:**
- Consumes: `IngestLane`, `PrepareLane`, `SendLane`.

- [ ] **Step 1:** Rewrite `AutomatePage` as a full-width scroll container; inner wrapper `max-width: var(--automate-max)`, centered (`margin: 0 auto`), padding `var(--space-lane)`, vertical `gap: var(--gap-lane)`. Stack `<IngestLane/> <PrepareLane/> <SendLane/>`. Remove the old single-`BatchConsole` body and the dead idle-card import path.
- [ ] **Step 2:** Delete now-unused `BatchConsole` idle code if fully orphaned after extraction (per CLAUDE.md §3, only if provably unused).
- [ ] **Step 3:** `npx tsc --noEmit -p client/tsconfig.json` → clean.
- [ ] **Step 4:** Commit `feat(automate): compose full-width Ingest/Prepare/Send lanes`.

---

### Task 13: Live verification + evidence

**Files:**
- Modify: this plan / a short evidence note (and the spec's verification section).

- [ ] **Step 1:** `npx tsc --noEmit -p client/tsconfig.json` clean; server tsc in dev container clean (if server touched — expected untouched).
- [ ] **Step 2:** Drive the live SPA via the dev playwright browser; screenshot each lane: Ingest (scheduler + schedules), Prepare (staging checklist + a running batch), Send (queue + an open inline editor). Confirm full-width layout, no left-floating box, Outreach pills no longer clip.
- [ ] **Step 3:** Confirm SSE-only (no `setInterval` data fetch, no WebSocket), no new dep in `package.json`.
- [ ] **Step 4:** Commit any evidence note.

## Self-Review

- **Spec coverage:** Ingest (T11), Prepare staging+run+console (T6,T7), Send review/edit/send/schedule/cancel (T8,T9,T10), primitives (T3,T4,T5), tokens (T2), bug fixes (T1 filter, T12 width), full-width layout (T12), verification (T13). All spec sections mapped.
- **Placeholder scan:** interfaces give concrete signatures; verification is tsc + render (no test runner exists). No TBD.
- **Type consistency:** `selectFirst(n)`, `toggleAll(ids)`, `Set<string> selected`, `reschedule(id, localDateTime)`, `BatchRunView` props consistent across T5/T6/T7/T8/T10.
