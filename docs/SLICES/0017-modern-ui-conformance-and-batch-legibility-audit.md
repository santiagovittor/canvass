# Slice 0017: Modern-UI conformance, batch legibility & failure-visibility audit (DIAGNOSIS ONLY)

> **This is a diagnosis slice. Its only deliverable is this report. No code is
> changed here.** Every fix is deferred to a ranked follow-up slice the operator
> picks from at the end of this document.

> **Numbering note (read first).** The operator's brief asked to create this as
> `0011`. `0011` was already taken — `docs/SLICES/0011-ux-clarity-and-outreach-audit.md`
> is a *prior, different* diagnosis (cross-tab persistence, replies, email
> validity, open-tracking, type) whose fixes shipped as slices `0012`–`0016`.
> Overwriting it would destroy the basis for shipped work, so this fresh
> diagnosis is filed as **`0017`**. Its brief (`docs/BRIEF.md`) is genuinely new
> ground: bringing the *rendered* app into conformance with the just-amended
> design rules, **relocating + making the batch runner legible**, **surfacing
> Gemini credit exhaustion**, and a **height/responsiveness bug**. None of that
> was covered by `0011`–`0016`.

## Intent

**Plain English:** The app works, but it doesn't yet *look* like the modern,
roomy, calm console the updated design rules describe, and the single most
important feature — "run batch" to prepare leads — is hidden in a tiny strip,
gives no sense of how long it will take or what it's doing, and quietly fails
without saying why. On top of that, when a run is going the "running" banner
appears at the top and pushes the bottom buttons off the screen so they can't be
reached. This slice traces each complaint to its exact cause in the code, ranks
them by how much they hurt, and proposes a surgical direction for each — without
changing any code yet.

**Project vocabulary:** Audit (a) the rendered client surfaces against the
amended `DESIGN.md`/`.claude/rules/ui.md` (type scale, tokens, banned tiny-type,
hardcoded hex, inline-style sprawl); (b) the Outreach information density and
disclosure model; (c) the batch-prepare control surface (`BatchRunner` +
`batchOrchestrator` state machine) and its failure isolation; (d) the gap
between the SSE signal already emitted (`batch:progress`, `outreach:stage` from
`stageTracker`) and what the batch UI renders; (e) how Gemini quota/spend
exhaustion (`GeminiRpdExhausted` vs. provider `429 RESOURCE_EXHAUSTED`)
propagates to — or is swallowed before — the UI; (f) the Outreach viewport-height
layout regression introduced by the always-mounted `ActiveRunsStrip`. Produce
findings with `file:line` evidence and ranked remediation slices.

## Symptoms (operator's words, from `docs/BRIEF.md`, verbatim)

1. "both design.md and rules/ui.md have been updated so the looks in our app
   should be updated as well to match it … i want the app to look more modern
   and easier to understand"
2. "Some tabs have a lot of information bloated like outreach specially. there
   is a lot going on there. the filters look like sht"
3. "the 'run batch' feature for the leads preparation is one of the most
   important features of the app and it is currently occupying a small part of
   the Outreach at the top. Sometimes it works, sometimes it doesn't, i never
   know how much it is going to take or what is happening under the hood. this
   needs to be solved asap and it needs to be moved into another part where it
   can be easier and more inviting to be used, and also show as much information
   as possible to help me understand what is going on"
4. "if possible i want to know when i ran out of gemini credits because that is
   the moment where some things start failing. investigate this"
5. "sometimes i cant see the buttoms on the lower part (for example when the
   'running' banner appears at the top). there is clearly an issue with the
   responsiveness or with the height"

Desire: "look modern, to have breathing space, transitions, animations and to be
extremely clear with the user as for what is going on at each step. the user
does not need to be technical to use it." Not wanted: "Quality regressions
hidden." and "Lazy behaviour."

## Out of scope

- **No fixes in this slice.** Findings + directions only.
- **No big rewrite.** Every proposed direction must be surgical and land in a
  later, separately-approved slice.
- **No hidden quality regressions, no lazy behaviour.** Any later simplification
  that hides or changes working behaviour (e.g. relocating the batch runner,
  collapsing more controls) must be tagged as a tradeoff in its slice.
- **Not re-doing `0011`–`0016`.** The reply/open-tracking/email-validity/
  cross-tab work is shipped; this slice does not revisit it except where a
  conformance violation happens to live in the same file.

## Constraints

These `docs/SPEC.md` invariants and `DESIGN.md` / `.claude/rules/ui.md` rules
bound every proposed direction:

- **SSE only for realtime** (`SPEC.md` Stack snapshot; `ui.md` "Realtime"). The
  batch-legibility and credit-exhaustion fixes must extend the existing
  `broadcast()` channels (`server/src/sse.ts:77`) and the connect-time snapshot
  (`sse.ts:18-75`). No polling, no `setInterval` fetch, no WebSocket.
- **Client hooks call `lib/api.ts` only**; no `fetch(` in `.tsx`
  (`.claude/rules/architecture.md` Folder Rules). Inline-style removal must move
  to tokens/classes in `globals.css`, not new inline literals.
- **Design tokens are the source of truth** (`DESIGN.md §2-4`,
  `globals.css:5-62`). New shades/sizes/animation timings go into `globals.css`
  *first*; components reference variables. No hardcoded hex, no sub-12px UI text
  as a layout fix (`DESIGN.md` "No-Tiny-UI Rule").
- **Approved fonts only** — IBM Plex Sans (UI), JetBrains Mono (numbers).
  No font swap is needed or proposed.
- **Map untouched** — CartoDB Dark Matter, `react-leaflet@4.2.x` pinned. This
  slice does not touch the map layer.
- **Reuse the batch + Gemini pipeline** (`batchOrchestrator`, `stageTracker`,
  `geminiRateLimiter`) — a legibility/credit surface reads existing state and
  broadcasts; it must not re-implement orchestration or rate limiting.
- **Additive schema only** if any run/credit state is persisted.

---

## Diagnose-first checklist — findings

### (a) Design conformance: rendered UI vs. amended `DESIGN.md` / `ui.md`

Slice `0016` raised the *tokens* (`globals.css:46-62`: `--text-body:15px`,
`--text-caption:12px`, `--leading-body:1.5`, spacing scale) and promoted IBM
Plex Sans (`globals.css:41-43`). **But the rendered surfaces never adopted
them.** The Outreach/Scraper components still hardcode sub-12px sizes and raw
hex inline, directly violating the "No-Tiny-UI Rule" and the "tokens before
component use" rule (`DESIGN.md §3`, `§9.2`; `ui.md` COMPONENT RULES).

Measured (grep over `client/src`):

- **102 occurrences of inline `fontSize: 9|10|11`** across 9 files —
  `EmailComposer.tsx` (33), `LeadQueue.tsx` (18), `BusinessContext.tsx` (12),
  `SchedulesList.tsx` (9), `BatchRunner.tsx` (6), `ScrapeSchedulerStatus.tsx`
  (6), `StageTracker.tsx` (5), `SchedulerStatus.tsx` (10),
  `WhatsAppComposer.tsx` (3). Concrete: lead emails/metadata render at **10px**
  (`LeadQueue.tsx:437,449,459,500,505,517,528`), the queue header at 11px
  (`LeadQueue.tsx:201`), batch labels/pills/meta at 11px
  (`BatchRunner.tsx:25,31,68,75`).
- **~18 sub-12px rules in `globals.css`** that predate the 0016 scale:
  `.active-runs-label` 10px (`:145`), `.active-run-meta`/`.bento-label` 11px
  (`:191,:490`), `.pill--keyword` 10px (`:421`), `.an-kpi-sub` 10px (`:707`),
  `.an-cal-month` 9px (`:900`).
- **23 hardcoded color literals** in Outreach components (raw `rgba(255,255,255,…)`,
  `rgba(255,77,109,0.12)`, `rgba(74,222,128,0.12)`): `LeadQueue.tsx:251,460,532,592`,
  `EmailComposer.tsx` (9), `WhatsAppComposer.tsx` (2), `SchedulerStatus.tsx` (4) —
  none reference the `--error`/`--success`/`--accent-dim` tokens that exist.
- **Inline-style sprawl.** `Outreach.tsx`, `LeadQueue.tsx`, `BatchRunner.tsx`,
  `StageTracker.tsx` build nearly every element with `style={{…}}` literals
  rather than tokens/classes — against `ui.md` "No inline `style={}` except
  genuinely dynamic values." `BatchRunner.tsx:38-45` even re-defines
  primary/ghost button styles inline instead of using `.btn-primary` /
  `.btn-secondary` (`globals.css:277,309`).

**Severity: MED (clarity / brand conformance).** **Direction:** a conformance
pass that (i) replaces inline sub-12px sizes with the `--text-*` tokens (metadata
→ `--text-caption` 12px, body → `--text-body` 15px), (ii) swaps raw hex for the
existing semantic tokens, (iii) extracts the repeated inline styles into
`globals.css` classes, and (iv) sweeps the residual sub-12px rules in
`globals.css`. No new font, no new palette — the tokens already exist; the work
is adoption. (Tradeoff: large surface-area edit; mitigate by scoping per panel.)

### (b) Outreach information-density audit (first priority)

The Outreach page is a fixed 3-column grid (`Outreach.tsx:557-563`:
`gridTemplateColumns: '300px 1fr 320px'`) — LeadQueue (left), EmailComposer /
WhatsAppComposer (center), BusinessContext (right). Slice `0016` already moved
the secondary filters behind a `Filtros` disclosure with an active-count badge
(`LeadQueue.tsx:311-363`, `Disclosure` primitive) and the queue header shows an
active-filter count (`LeadQueue.tsx:210`) — that part of the brief is **already
addressed**. Remaining density problems:

- **The left column stacks four things in `new` mode** before the first lead:
  `BatchRunner` (`Outreach.tsx:565-574`), the 4-pill queue-mode row
  (`LeadQueue.tsx:228-241`), search (`:290-308`), and the `Filtros` disclosure
  (`:311`). The batch runner sitting *on top of* the queue is the core of the
  brief's "run batch occupies a small part at the top" — it competes with the
  lead list for the narrowest column.
- **The right rail doubles as a scheduler console.** `BusinessContext`
  (`Outreach.tsx:629-641`) carries lead context **and** the scheduled-send queue
  + pause/resume/cancel-all controls — two unrelated jobs in one 320px column.
- **No responsive collapse.** The grid is hardcoded px; unlike `.app-grid`
  (`globals.css:202-205` has a `@media (max-width:1279px)` single-column
  fallback), the Outreach grid has none, so on a smaller window the three
  columns crush rather than reflow.

**Severity: MED (clarity).** **Direction:** relocate `BatchRunner` out of the
queue column (ties into (c)), and treat the scheduler console in the right rail
as a separable surface. Add a responsive fallback for the 3-col grid. No filter
behavior removed (already disclosed in 0016).

### (c) "Run batch" feature trace

**Where it lives now:** `BatchRunner.tsx`, rendered only in `new` mode at the
top of the left LeadQueue column (`Outreach.tsx:565-574`). It is a ~120px strip:
preset size pills `[15,30,60]` + custom N, a dry-run checkbox, and a "Prepare N
leads" button (`BatchRunner.tsx:92-128`).

**How it's triggered:** `onStart` → `handleStartBatch` (`Outreach.tsx:127-142`)
takes the first N queue lead IDs → `startBatch(ids, dryRun)` (`lib/batchApi.ts`)
→ POST → `batchOrchestrator.startBatch` (`batchOrchestrator.ts:230-236`) →
`driveRun` → per-item `processItem` (`:79-180`).

**What it does under the hood, per lead** (`processItem`, the prepare state
machine): email-validity gate (`:94-104`, slice 0013) → TTL-gated premium
analyze: Playwright **render → signatures → PSI → vision** (`:106-132`) →
`rankAnchors` (`:141`) → **compose → verify → gate** via `composeVerifiedEmail`
(`:154`) → on `sent_specific`, persist draft + `enqueueForSend` (`:169-178`).
Concurrency is a semaphore of `BATCH_PREPARE_CONCURRENCY` (default 3, `:189`).

**Why it intermittently "works sometimes, not others":**
1. **Per-lead failure isolation swallows the reason.** Any throw inside
   `processItem` is caught at `batchOrchestrator.ts:206-211` and the lead is
   marked `failed` (dead-letter) while the batch continues. The UI surfaces only
   an aggregate `failed N` number (`BatchRunner.tsx:72`) — no per-lead reason.
   Flaky upstreams that land here: Playwright render exceeding
   `BATCH_ANALYZE_TIMEOUT_MS` (120s, `:118`), `premium_analysis_failed`
   (`:128-130`), a Gemini timeout/5xx after the bounded retries are exhausted.
2. **Provider quota 429 also lands in this generic `failed` bucket** (see (e)) —
   so "ran out of credits" looks identical to "one site was slow."
3. The one failure that *is* surfaced cleanly is the app's own daily Gemini
   budget: `GeminiRpdExhausted` pauses the run with `pauseReason =
   'gemini_rpd_exhausted'` (`:199-204`), shown at `BatchRunner.tsx:74-78`.

**Backend signal that exists but isn't surfaced:** `broadcastProgress` already
emits `processed / total / skippedNoEvidence / heldGeneric / queuedForSend /
failed / pauseReason` on every transition (`batchOrchestrator.ts:57-71`). What
it does **not** emit and the UI cannot show: which lead is in flight, which
pipeline stage it's on, elapsed time, throughput, an ETA, or per-lead failure
reasons — even though all of that is computable from state already in the DB
(`batch_items`) and the per-lead `outreach:stage` stream (see (d)).

**Severity: HIGH (reliability + clarity — operator's #1 feature).**
**Direction:** relocate the batch runner to a dedicated, inviting surface (its
own panel or a full-width strip, not buried in the queue column) and enrich it
with the signal that already flows — current lead, live stage, counts with
per-disposition meaning, elapsed + ETA, and an expandable per-lead failure list
(reasons already persisted in `batch_items.lastError`,
`batchOrchestrator.ts:208`). Read + render + broadcast; no new orchestration.

### (d) Long-job legibility gap (available signal vs. rendered signal)

**Emitted during a batch:**
- `batch:progress` — aggregate counts (`batchOrchestrator.ts:57-71`).
- `outreach:stage` — **rich per-lead, per-stage** events from `stageTracker`:
  `phase:'start'|'end'|'retry'|'done'`, `stage` name (render/signatures/psi/
  vision/compose/verify/gate), `durationMs`, `costUsd`, retry `attempt` +
  `retryDelayMs` (`stageTracker.ts:92,97,112,120,66`). These fire for **every
  lead the batch processes**, because `processItem` runs the same
  `withAnalysis`/`stage`-wrapped pipeline as the single-lead path.
- `premium:progress` — premium analysis lifecycle.

**Rendered by the batch UI:** only the aggregate counts + a `processed/total`
bar (`BatchRunner.tsx:54-85`). The component that *does* render the rich
per-stage view — `StageTracker.tsx` (weighted bar, witty per-stage captions,
per-stage timer, retry/cost line, and it already carries `EXPECTED_MS` per stage
at `:17` from which an ETA is trivially derivable) — is wired **only** to the
single-lead composer via `useStageProgress(lead.id)` (`StageTracker.tsx:70`,
keyed to `activeLead`). So during a batch the per-lead pipeline narrates itself
over SSE while the batch surface shows a silent number.

**The gap, concretely:** the data for "what's happening under the hood" and "how
long will it take" already exists and is already rendered elsewhere — it is just
not connected to the batch surface. ETA = `EXPECTED_MS` sum per remaining lead ×
remaining leads, or observed `processed`-rate × remaining; both derivable from
state already present (`StageTracker.tsx:17`; `batch:progress` processed/total).

**Severity: HIGH (clarity).** **Direction:** feed the batch surface the
`outreach:stage` stream (filtered to the in-flight lead) and a computed ETA, so
the relocated runner from (c) shows the live stage, elapsed, ETA, and cost — the
same honest signal the single-lead tracker already shows, scaled to the run.

### (e) Gemini credit / quota exhaustion propagation

There are **two distinct exhaustion conditions**, handled very differently:

1. **App-internal daily budget** (`GEMINI_RPD`, default 1000). `reserveGeminiRpd`
   fails → `withGeminiRate` throws the typed `GeminiRpdExhausted`
   (`geminiRateLimiter.ts:216-217`). The batch catches it specifically, pauses
   the run, sets `pauseReason='gemini_rpd_exhausted'`
   (`batchOrchestrator.ts:199-204`), and the UI shows "Gemini daily budget hit"
   (`BatchRunner.tsx:74-78`) + the strip chip (`ActiveRunsStrip.tsx:51`). This
   path is **clean and surfaced.**
2. **Provider-side quota / billing exhaustion** — the operator's actual "ran out
   of gemini credits." Google returns **HTTP 429 with `RESOURCE_EXHAUSTED`** and
   a `QuotaFailure` detail. `isRetryable` classes 429 as transient
   (`geminiRateLimiter.ts:83-87`) → it is retried up to the bounded budget →
   then thrown as a generic error (`AbortError`, `:234,:247`). In a batch that
   generic error hits the catch-all and marks the lead `failed`
   (`batchOrchestrator.ts:206-211`); in the single-lead path it surfaces as raw
   `err.message` text in the composer (`Outreach.tsx:209`). **No pause, no
   distinct "out of credits" state, no banner.**

**The swallowed signal:** `describeGeminiError` (`geminiRateLimiter.ts:103-134`)
*already parses* `status`, `reason` (e.g. `RESOURCE_EXHAUSTED`), `quotaMetric`,
`quotaLimitValue`, and `retryDelayMs` from the structured `errorDetails`. But it
is consumed only by `logGeminiFailure` → **`console.error`**
(`:135-143`) — it is never broadcast over SSE or persisted. So the system *knows*
it ran out of provider quota; it just tells the server log, not the operator.
Failure point: the rich `GeminiErrorDesc` is dropped at `:234`/`:247` (re-thrown
as a bare `AbortError`) and again at `batchOrchestrator.ts:207` (reason
flattened into `lastError`).

**Severity: HIGH (reliability / clarity).** **Direction:** detect a provider
quota 429 (reason `RESOURCE_EXHAUSTED` and *not* the app's own RPD) distinctly
from a transient 429 — when retries are exhausted on it, broadcast an
`outreach:provider-exhausted` SSE (data already in `GeminiErrorDesc`) and pause
the batch with a `provider_quota_exhausted` reason, mirroring the existing RPD
pause. Surface a calm, non-technical banner ("Gemini quota reached — new emails
paused; resumes when quota resets"). Parse + classification already exist; the
missing piece is broadcast + a UI state. (Tradeoff: distinguishing a hard
billing cap from a soft per-minute 429 needs the `reason`/`quotaMetric` fields —
which `describeGeminiError` already extracts — so no new probing.)

### (f) Responsiveness / height bug (lower buttons unreachable under the banner)

**Reproduced by reading the layout chain.** The app shell is a flex column:
`.app-root { display:flex; flex-direction:column }` (`globals.css:80-85`)
containing `.tab-strip` (fixed **40px**, `globals.css:103-112`), then the
**always-mounted** `<ActiveRunsStrip>` (`App.tsx:192`), then the view container.
`ActiveRunsStrip` renders **nothing when idle but a ~40px bar when any run is
active** (`ActiveRunsStrip.tsx:72` early-return; `.active-runs-strip` padding
6px + chip ≈ 40px, `globals.css:133-142`). That bar **is** the operator's
"running banner."

The other views absorb the bar correctly because their containers flex:
`.app-grid` and `.view-fill` are `flex:1; min-height:0` (`globals.css:87-100`),
so they shrink when the strip appears. **Outreach does not.** Its root grid
hardcodes an absolute viewport calc:

```tsx
// Outreach.tsx:557-563
<div style={{ display:'grid', gridTemplateColumns:'300px 1fr 320px',
              height: 'calc(100vh - 44px)', overflow:'hidden' }}>
```

Two defects compound:
1. The `44px` constant is **already wrong** — the tab strip is 40px
   (`globals.css:108`), not 44px.
2. It accounts for **none** of the `ActiveRunsStrip`. When a run is active the
   real available height is `100vh − 40px − ~40px`, but Outreach forces its grid
   to `100vh − 44px` — roughly **36px taller than its parent**. Because the
   parent `.view-fill` is `overflow:hidden` (`globals.css:96-100`), the excess
   is **clipped, not scrollable** — so the bottom of the center column (the
   EmailComposer send/skip/schedule buttons) and the right rail (scheduler
   pause/cancel controls) drop below the viewport and cannot be reached. Exactly
   the symptom.

This is **app-injected chrome**, not mobile browser chrome, so the real fix is
flex sizing, not `dvh` (the 2026 viewport-unit guidance applies to browser
chrome). The other views already prove the flex approach works.

**Severity: HIGH (usability — blocks primary actions).** **Direction:** make the
Outreach root fill its flex parent (`height:100%`, `min-height:0`) like
`.app-grid`/`.view-fill` already do, instead of a hardcoded `calc(100vh − 44px)`;
let the always-mounted strip change the column height for free. Add the
responsive grid fallback from (b) in the same pass.

### (g) "Where is the confusion" — top 3 clarity / usability sinks by operator impact

1. **The batch runner is illegible and unreliable-looking ((c)+(d)).** Highest
   impact: it's the operator's named #1 feature, it's buried in a tiny strip,
   shows only a bare `processed/total` + counts, no ETA, no live stage, and
   collapses every failure into a reason-less `failed N`. Evidence:
   `BatchRunner.tsx:54-85` renders counts only; the rich `outreach:stage`
   stream (`stageTracker.ts:92-123`) and `EXPECTED_MS` ETA basis
   (`StageTracker.tsx:17`) are never wired to it.
2. **Out-of-credits is invisible ((e)).** High impact: provider quota 429 is
   retried then dumped into the generic `failed` bucket
   (`batchOrchestrator.ts:206-211`) while the parsed reason
   (`geminiRateLimiter.ts:103-143`) goes only to `console.error`. The operator's
   "the moment things start failing" has no UI signal.
3. **Primary actions get clipped off-screen ((f)).** High impact: the
   `calc(100vh − 44px)` Outreach root (`Outreach.tsx:560`) ignores the
   always-mounted `ActiveRunsStrip` (`App.tsx:192`), so the send/schedule
   buttons drop below an `overflow:hidden` parent whenever a run is active.

Secondary but pervasive: the rendered surfaces still hardcode 10–11px text and
raw hex despite the 0016 token scale ((a)), which is why the app still "doesn't
look like the new design."

---

## Findings summary table

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| a | 0016 raised tokens but rendered surfaces still hardcode sub-12px + raw hex + inline styles | 102× `fontSize:9-11` across 9 files (`LeadQueue.tsx:437,449`; `BatchRunner.tsx:25,31`); 23 hex literals; `globals.css` sub-12px at `:145,421,707,900`; inline-style sprawl `Outreach/LeadQueue/BatchRunner` | MED clarity |
| b | Outreach left column stacks batch+mode+search+filters; right rail doubles as scheduler; no responsive collapse | `Outreach.tsx:557-574,629-641`; no `@media` vs `.app-grid` `globals.css:202` | MED clarity |
| c | Batch runner buried in a strip; per-lead failures collapse to a reason-less `failed N`; rich signal unused | `Outreach.tsx:565-574`; `BatchRunner.tsx:54-85`; `batchOrchestrator.ts:57-71,206-211` | HIGH reliability/clarity |
| d | `outreach:stage` rich per-lead stream + ETA basis exist but batch UI shows only aggregate counts | `stageTracker.ts:92-123`; `StageTracker.tsx:17,70`; `BatchRunner.tsx:54-85` | HIGH clarity |
| e | App RPD exhaustion surfaced; provider 429 `RESOURCE_EXHAUSTED` parsed then logged to console only, never broadcast → silent `failed` | `geminiRateLimiter.ts:83-87,103-143,234`; `batchOrchestrator.ts:199-211`; `Outreach.tsx:209` | HIGH reliability |
| f | Outreach root `calc(100vh-44px)` ignores always-mounted `ActiveRunsStrip` → bottom buttons clipped under `overflow:hidden` | `Outreach.tsx:557-563`; `App.tsx:192`; `globals.css:96-100,108,133-142`; `ActiveRunsStrip.tsx:72` | HIGH usability |

---

## Recommended next slices (ranked — operator picks)

**S1 → slice `0018` — Fix the Outreach height clip (banner pushes buttons off-screen)** *(addresses f)*
- *Intent:* replace the hardcoded `calc(100vh − 44px)` Outreach root with flex
  sizing (`height:100%; min-height:0`) so the always-mounted `ActiveRunsStrip`
  changes the column height for free, like every other view already does; add a
  responsive single-column fallback to the 3-col grid.
- *Impact:* primary send/schedule/scheduler buttons are always reachable while a
  run is active — removes a hard usability block. Smallest, highest-certainty
  fix.
- *Effort:* **S** (one container's sizing + one `@media`). *Prereqs:* none.

**S2 → slice `0019` — Relocate + enrich the batch runner (legible long-job surface)** *(addresses c, d, b)*
- *Intent:* move `BatchRunner` out of the queue column into a dedicated, inviting
  surface; wire it to the existing `outreach:stage` stream (current lead + live
  stage), a computed ETA (from `EXPECTED_MS` / observed rate), elapsed, cost, and
  an expandable per-lead failure list (reasons already in `batch_items.lastError`).
- *Impact:* directly answers "most important feature, never know how long or
  what's happening, move it" — the #1 brief item. Turns a silent number into a
  narrated run.
- *Effort:* **M** (one new panel/primitive + a hook subscribing to
  `outreach:stage`; reuses `StageTracker` rendering). *Prereqs:* S1 (so the new,
  taller surface isn't itself clipped). SSE-only; reads existing state.

**S3 → slice `0020` — Surface Gemini provider-quota exhaustion** *(addresses e)*
- *Intent:* classify a provider `429 RESOURCE_EXHAUSTED` (vs. the app's own RPD
  and vs. a soft per-minute 429); when retries are exhausted on it, broadcast a
  new SSE event from the already-parsed `GeminiErrorDesc` and pause the batch
  with a `provider_quota_exhausted` reason; show a calm non-technical banner.
- *Impact:* the operator finally sees "out of credits" the moment it happens,
  instead of leads silently failing. Closes brief item 4.
- *Effort:* **M** (classification + one broadcast + a banner; parser already
  exists). *Prereqs:* ideally after S2 (shares the batch surface for the banner),
  but independent. Reuse `geminiRateLimiter`/`batchOrchestrator`; additive
  pause-reason.

**S4 → slice `0021` — Design-conformance adoption pass (tokens, type, hex, inline styles)** *(addresses a, b)*
- *Intent:* replace inline sub-12px sizes with `--text-*` tokens, raw hex with
  semantic tokens, and extract repeated inline styles into `globals.css` classes;
  sweep the residual sub-12px rules in `globals.css`. Per-panel scope to keep
  diffs reviewable.
- *Impact:* the rendered app finally matches the amended design rules — "look
  modern, breathing room." Closes brief items 1–2 visually.
- *Effort:* **M–L** (large surface area, low risk per edit). *Prereqs:* none, but
  best **after** S1–S3 so the batch surface is styled in its final shape.

Suggested order: **S1 → S2 → S3 → S4** (unblock the buttons, then make the #1
feature legible, then surface failures, then polish the whole surface to the new
design). S1 and S3 are independent of each other; S2 is the centerpiece.

## Open questions for the operator

1. **Where should the relocated batch runner live?** Options: (a) a dedicated
   full-width strip above the Outreach 3-column grid; (b) its own panel/tab; (c)
   a prominent card in the center column above the composer when in `new` mode.
   The brief says "another part where it can be easier and more inviting" — pick
   the placement in S2's plan.
2. **Provider-quota pause behaviour:** when Gemini provider quota is exhausted,
   should the batch *pause and auto-resume* (like the RPD pause does after the
   Pacific-midnight reset) or *stop and wait for a manual resume*? Billing caps
   don't reset on a known schedule the way RPD does, so auto-resume timing is
   unclear — operator's call in S3.

## Sources (Phase 1 research, 2026)

Long-running job legibility / progress / ETA:
- [LogRocket — UI patterns for async workflows, background jobs & data pipelines](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)
- [UXPin — Progress Tracker Design: UX Best Practices (2026)](https://www.uxpin.com/studio/blog/design-progress-trackers/)
- [Smart Interface Design Patterns — Designing Better Loading & Progress UX](https://smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/)

Surfacing API/external failure to non-technical users:
- [Postman — Best Practices for API Error Handling](https://blog.postman.com/best-practices-for-api-error-handling/)
- [UX Collective — Designing API error codes and responses](https://uxdesign.cc/documenting-api-error-codes-and-responses-135313b10af9)
- [Bootcamp — Error handling UX design patterns](https://medium.com/design-bootcamp/error-handling-ux-design-patterns-c2a5bbae5f8d)

Modern dark operations-console UX (breathing room, motion, legibility):
- [Tech-RZ — Dark Mode Design Best Practices in 2026](https://www.tech-rz.com/blog/dark-mode-design-best-practices-in-2026/)
- [UXPin — Dashboard Design Principles (2026)](https://www.uxpin.com/studio/blog/dashboard-design-principles/)
- [Aufait UX — Dashboard Design Guide 2026](https://www.aufaitux.com/blog/dashboard-design-examples-inspiration-best-practices/)

Responsive / viewport-height layout:
- [Modern CSS — dvh, svh, lvh: viewport height fix](https://modern-css.com/mobile-viewport-height-without-100vh-hack/)
- [Savvy — CSS dvh (Dynamic Viewport Height) explained](https://savvy.co.il/en/blog/css/css-dynamic-viewport-height-dvh/)

---

*Diagnosis only. No implementation plan, no verification gate, no completion
record — those belong to the fix slices the operator selects above.*
