# Slice 0011: UX clarity & outreach-truth audit (DIAGNOSIS ONLY)

> **This is a diagnosis slice. Its only deliverable is this report. No code is
> changed here.** Every fix is deferred to a ranked follow-up slice the operator
> picks from at the end of this document.

## Intent

**Plain English:** The app *works*, but it does not feel trustworthy or
comfortable. Runs vanish from the screen when you switch tabs, the type is small
and feels unserious, the Outreach tab is crowded, the "respondieron" (replies)
list is missing a real reply, a lot of emails bounce as *Address not found*, and
every email is stamped *sin abrir* ("unopened") whether or not it was opened.
This slice traces each complaint to its exact cause in the code and data, ranks
them by how much they hurt, and proposes a surgical direction for each — without
fixing anything yet and without a rewrite.

**Project vocabulary:** Audit the client run-state lifecycle (SSE
subscribe/unsubscribe on mount/unmount vs. server-as-source-of-truth snapshot
rehydration), the outreach correctness path (open-pixel injection, IMAP reply
classification, email-validity gating), and the Outreach UI surface
(filters/disclosure, type scale). Produce findings with file:line / SQL
evidence and ranked remediation slices. **Renumbered `0008` → `0011`** to clear
the ROADMAP collision; the five derived fix slices are **`0012`–`0016`** (see
[Recommended next slices](#recommended-next-slices-ranked--operator-picks)).

## Symptoms (operator's words, from `docs/BRIEF.md`)

1. "sometimes when i run a process like the keyword query or the batch run and
   then click on another tab. if i go back to the process' tab it is gone from
   the ui and I only can rely on the runtime console to see if something is
   running"
2. "I do not like the font we are using… too small and non serious… i need the
   app to have more breathing room"
3. "design.md and rules/ui.md can be too limiting and the reason my app looks
   like shit right now, so for this one you will have more freedom to play
   around"
4. "Some tabs have a lot of information bloated like outreach specially… the
   filters look like sht"
5. "The 'respondieron' feature im not sure is working, recently i received a
   response from 'joyeriayvino@gmail.com' that does not appear there"
6. "A lot of the emails are returning as Address not found… we are wasting
   resources in creating emails for sites that dont have an email. im not sure
   if we are making them up or what"
7. "in the Outreach tab we have the 'sin abrir' tag… visible in all of them. is
   it working? are we adding a pixel… are we being blacklisted and sent to
   spam?"

Desire: "processes to persist flawlessly even if i close the tab… this is a
local app, it should be able to handle multiple things simultaneously." Not
wanted: "A big rewrite. Surgical findings + surgical fixes." and "Quality
regressions hidden."

## Out of scope

- **No fixes in this slice.** Findings + directions only.
- **No big rewrite.** Every proposed direction must be surgical and land in a
  later, separately-approved slice.
- **No hidden quality regressions.** Any later simplification that would hide or
  change a working behavior (e.g. removing `sin abrir`, collapsing filters) must
  be tagged as a tradeoff in its slice, never slipped in.
- **Not loosening `DESIGN.md` / `rules/ui.md` here.** The operator's request for
  more design freedom (symptom 3) is recorded below as a *constraint tension* to
  resolve deliberately in a future slice — it is not a license to restyle in
  this diagnosis.

## Constraints

These `docs/SPEC.md` invariants and rules bound every proposed direction:

- **SSE only for realtime** (`SPEC.md` Stack snapshot; `rules/ui.md` "Realtime").
  No polling loop, no `setInterval` fetch, no WebSocket may be proposed as a
  fix. The process-persistence fix must extend the existing **server
  snapshot-on-connect** mechanism (`server/src/sse.ts:27-61`), not add polling.
- **Client hooks call `lib/api.ts` only**; no `fetch(` in `.tsx`
  (`rules/architecture.md` Folder Rules).
- **lat/lng as strings**, additive schema only, reuse-only registry
  (`SPEC.md` Invariants) — any new run-state surface must use additive columns.
- **Reuse the send path** (`composeVerifiedEmail`, `sendGate`, `governor`) — an
  email-validity gate must slot into the existing pipeline, not duplicate it.
- **Constraint tension (record, do not resolve here):** `rules/ui.md` BANNED
  DEFAULTS pins `Outfit` (UI) + `JetBrains Mono` (numbers) and forbids font
  swaps; `DESIGN.md §3` caps body text at 14px and bans display headings (the
  "No-Display-Heading Rule"). The operator explicitly wants larger, more
  "serious" type and more breathing room. These directly conflict. The fix slice
  for typography must **first amend `DESIGN.md` / `rules/ui.md`** with a written
  rationale, then implement — the rules are the source of truth and cannot be
  silently overridden.

---

## Diagnose-first checklist — findings

### (a) Process-persistence data flow

**What happens when you leave a tab:** App tabs are *conditionally rendered*, not
hidden. `client/src/App.tsx:191-253` switches on `view === 'scraper' ? … :
view === 'outreach' ? <Outreach/> : …`. Switching tab **unmounts the entire
previous page**. Run state for every process except the polygon scrape lives in
component `useState`, so unmount destroys it:

- Keyword run: `useKeywordRun.ts:34-38` holds `stage/elapsed/added/deduped` in
  `useState`; lives inside `KeywordPanel`, which unmounts when you leave the
  Scraper tab *or* toggle Scraper→Keywords mode (`App.tsx:225-233`). On remount
  it `reset()`s to `'idle'` (`useKeywordRun.ts:95-103`).
- Batch outreach run: `Outreach.tsx:58-59` holds `batchProgress` /
  `batchRunIdRef` in component state; unmounts with the Outreach page.
- Premium analysis: `useStageProgress.ts:45` starts from `EMPTY` each mount.

**Why it can't recover:** SSE events are fire-and-forget broadcasts
(`server/src/sse.ts:64-68`) with **no event IDs and no replay buffer**. The
browser's built-in `Last-Event-ID` reconnect replay (an SSE feature) is unused.
The *only* rehydration is `register()` in `sse.ts:27-61`, which on every new
connection queries `scrape_jobs` for a `running`/`error` row and emits a
`snapshot` event — consumed by `App.tsx:41-52`. Because `App` is always mounted
(top-level), the **polygon scrape is the one process that survives a tab
switch**. Nothing equivalent exists for keyword/batch/premium runs.

**Dynamic data that EXISTS server-side but is never re-rendered after remount:**
- Active batch runs: `batchOrchestrator.ts:53` keeps an in-memory
  `activeRuns: Set<string>`, **and** runs are durably persisted —
  `listRunsByStatus(['running'])` (`batchOrchestrator.ts:247`) reads them back
  from `batch_runs` on boot to resume. The client never asks for this list on
  mount; `Outreach.tsx:154-168` loads stats/signature/schedule but **never**
  "what batch is running right now."
- Scrape-scheduler / send-scheduler health is pushed via `send-scheduler:tick`
  and consumed live (`Outreach.tsx:391-398`) — but only while mounted.

SSE events the backend emits across a run's life (none replayed on reconnect):
`keyword:started|stage|done|error` (`useKeywordRun.ts:58-83`),
`outreach:stage` w/ phases start/retry/end/done (`useStageProgress.ts:56-83`),
`batch:progress` (`Outreach.tsx:406-411`), `premium:progress`
(`Outreach.tsx:412-424`), `email:opened|replied`, `send-scheduler:tick`,
`job:started|progress|scraped|done|error`, `enrich:progress`,
`businesses_updated`, and the connect-time `snapshot` (`App.tsx:40-104`).

**Severity: HIGH (clarity).** **Direction:** mirror the proven polygon pattern —
extend `sse.ts register()` to also emit a connect-time snapshot of active
keyword/batch/premium runs from their durable tables, and have the
keyword/batch hooks hydrate from it on mount (same shape they already handle).
Pure SSE, no polling.

### (b) Concurrency reality

There is **no single cross-tab source of truth the UI reads**. Server-side, batch
runs are tracked durably (`batch_runs` via `listRunsByStatus`,
`batchOrchestrator.ts:247`; in-memory mirror at `:53`), scrape jobs in
`scrape_jobs`, scheduled sends in `scheduled_sends`. But each *client* surface is
its own island: `App.tsx` tracks one scrape job (`jobId`), `Outreach.tsx` tracks
one batch run it personally started (`batchRunIdRef`, and it filters
`batch:progress` to *that* runId at `Outreach.tsx:409`). A batch started in one
session/tab is invisible to a freshly-mounted Outreach page — the filter drops
events whose `runId` it never learned. The app *can run* several processes at
once (scrape + batch + scheduler ticks are independent), but it cannot *show*
more than the one each mounted component happens to own.

**Severity: HIGH (clarity).** **Direction:** a single read-model — one
`GET /api/runs/active` (server-authoritative, union of scrape/keyword/batch/
premium durable rows) plus a connect-time SSE snapshot — feeding one "active
runs" strip. Surgical: the data already exists in the tables; this is a read +
render, not new orchestration.

### (c) UI render gap — status

A returned-to tab "shows nothing" because the component re-mounts at its empty
initial state and **the data is gone client-side, with no server fetch to refill
it.** Concretely: `KeywordPanel`/`useKeywordRun` remounts at `stage:'idle'`
(`useKeywordRun.ts:34`), so the live stage tracker renders idle; `Outreach`
remounts with `batchProgress = null` (`Outreach.tsx:58`) and only repopulates if
a *new* `batch:progress` event for an already-known `runId` arrives — which it
won't, because `batchRunIdRef` reset to `null` on remount. So it is **data
missing (client-side), present-but-unfetched (server-side)** — not a render
branch bug. The decision point is the absence of any mount-time hydration call in
`Outreach.tsx:154-168` and `useKeywordRun.start/reset`.

**Severity: HIGH (clarity).** **Direction:** same as (a)/(b) — hydrate on mount
from the server snapshot.

### (d) 'Respondieron' trace — **REFUTED as broken; CONFIRMED as hidden**

The reply *was* detected and ingested. SQL on the live DB
(`/app/data/scraper.db`):

```
businesses WHERE emails_json LIKE '%joyeria%':
  Aurora Estudio  outreach_status='replied'  reply_type='auto'
  emails_json = ["joyeriayvino@gmail.com","holaauroraestudio@gmail.com","tuemail@email.com"]
```

So `joyeriayvino@gmail.com` is the **first email of the lead "Aurora Estudio"**;
the IMAP checker matched the sender against
`getReplyCheckTargets()` (`db/index.ts:1458-1478`, lowercased address map in
`replyChecker.ts:59-104`), flipped status to `replied`, and recorded
`replied_at`. **The bug is the classification + the filter.** `classifyReply`
(`replyChecker.ts:27-47`) marked it `'auto'` (auto-submitted header, an
auto-reply subject, or the 0–3 min velocity rule at `:41`). And the Respuestas
tab query **hard-excludes auto**:

```sql
-- getRepliedLeads, db/index.ts:1357-1360
WHERE b.outreach_status = 'replied'
  AND (b.reply_type IS NULL OR b.reply_type != 'auto')
```

Reply-type breakdown (live DB): **`auto` = 5, `real` = 3** of 8 replies — so
**5 of 8 detected replies never appear in "Respondieron."** A real human reply
misclassified as `auto` becomes invisible with no operator recourse to
reclassify.

**Severity: HIGH (correctness).** **Direction:** stop hard-hiding `auto` —
surface auto-classified replies in a muted/secondary row with a one-tap
"this is a real reply" reclassify; and soften the velocity heuristic
(`replyChecker.ts:41`) which is the most likely false-positive source for a fast
human reply. (Tradeoff to tag: showing autos adds noise — mitigate with muting,
not hiding.)

### (e) Email-validity / 'Address not found' trace — **we do NOT fabricate; we DON'T verify**

**Where emails come from:** the scraper does **not** produce emails. Enrichment
does — `socialEnricher.ts:94-110` `extractEmails()` pulls `mailto:` hrefs and
regex-matched (`EMAIL_RE`, `:77`) addresses out of the business's own website
HTML, filters obvious junk (`isJunkEmail`, `:86-92`), keeps ≤5. They are **real
strings found on the page**, not invented. (Refutes "are we making them up.")

**Why bounces happen anyway:** two gaps.
1. **No existence check.** The only gate before send is `validateEmail()`
   (`db/index.ts:463-471`) — *format + a 2-domain blocklist only*. No MX lookup,
   no SMTP probe. A template placeholder like **`tuemail@email.com`** (literally
   "your-email@email.com", scraped from Aurora Estudio's site and sitting first
   in another row's `emails_json`) passes this gate and would be composed +
   sent. Stale or typo'd published addresses pass too.
2. **No bounce ingestion.** `sendEmail()` (`emailSender.ts:86-95`) records
   `status:'sent'` the moment **Gmail accepts** the message. "Address not found"
   is an *asynchronous* bounce that lands back in the inbox minutes later and is
   **never read** — the IMAP scanner only looks for replies, not DSNs. SQL
   confirms: `email_sends` = **155 sent, 36 dryrun, 1 failed**, and the single
   "failed" is `"GMAIL_FROM and GMAIL_APP_PASSWORD not configured"` — a config
   error, **not a single bounce recorded.** So "sent" ≠ "delivered," and spend
   on compose+send for dead addresses is invisible.

**Severity: HIGH (correctness + cost).** **Direction:** add an MX (and optional
SMTP-RCPT) validity gate *before* compose in the pipeline — cheapest possible
filter ahead of the expensive Gemini step — and ingest DSN/bounce messages in
the existing IMAP pass to mark `email_sends.status='bounced'`, surfacing it in
the lead row. Reuse the send path; do not duplicate it.

### (f) Open-tracking truth — **'sin abrir' is a guaranteed default, not a signal**

The pixel is injected **only when `PUBLIC_URL` is set** and internet-reachable
(`emailSender.ts:73-79`): `trackingToken = publicBase ? randomUUID() : null`.
`PUBLIC_URL` is **absent from `.env`** (verified — only `DATABASE_URL`,
`GMAIL_FROM`, `GMAIL_APP_PASSWORD` are set), and this is a localhost app, so the
`/t/:token.gif` endpoint (`routes/track.ts`) can never be reached by a remote
mail client regardless. SQL proves it end-to-end:

```
email_sends WHERE tracking_token IS NOT NULL  →  0
email_opens (all rows)                        →  0
```

**Zero pixels ever embedded; zero opens ever recorded.** The UI then renders
`fu.open_count > 0 ? 'abierto' : 'sin abrir'` (`LeadQueue.tsx:496`), and since
`open_count` is always 0, **every email shows `sin abrir` — it is a hardcoded
"unknown," not a measurement.** Even if `PUBLIC_URL` were set and public,
open-tracking is *fundamentally unreliable in 2026*: Apple Mail Privacy
Protection preloads every image through Apple's proxy at delivery, firing the
pixel whether or not the human opened it (false ~100% opens), and corporate
security scanners / client prefetch do the same (see Sources). Honest products
now say "we can't confirm opens" rather than showing a binary.

On spam/blacklist exposure (symptom 7): nothing in code blacklists you, but the
bounce blindness in (e) is the real reputation risk — Gmail's 2026 sender
guidance treats >3% bounce as a spam-filtering trigger, and we currently can't
measure our bounce rate at all.

**Severity: MED (correctness/honesty).** **Direction:** stop showing a binary
`abierto/sin abrir`. Either (i) drop the open indicator entirely (it has never
carried information), or (ii) replace with an honest "open tracking off" /
"opens can't be confirmed" state, and only show a real signal if `PUBLIC_URL`
ever gets configured. **Tradeoff to tag:** option (i) removes a visible
"feature" — but it is a feature that has only ever shown a constant, so removal
loses no information.

### (g) Outreach bloat audit

The Outreach page is a 3-column grid (`Outreach.tsx:531-616`): LeadQueue (left),
EmailComposer/WhatsAppComposer (center), BusinessContext (right). Crowding is
concentrated in **LeadQueue's filter stack** (`LeadQueue.tsx:204-347`), which in
`new` mode stacks **four rows of controls**: queue-mode pills (Nuevos /
Follow-up / Respondieron / Sin sitio, `:215-228`), search + category select
(`:277-318`), an email pills row (Has email / All leads, `:321-334`), and a
country+website pills row (Todos/AR/US | Todos/Sin sitio/Con sitio, `:337-345`).
That's ~12 controls before the first lead. All are **wired and working** (each
sets state that feeds the fetch at `:107-133`), so this is clutter, not dead
code — a progressive-disclosure candidate, not a deletion. The right rail
(`BusinessContext`) additionally carries the scheduled-queue list + scheduler
pause/resume/cancel-all controls (`Outreach.tsx:603-615`), adding density.

**Severity: MED (clarity).** **Direction:** collapse the secondary filter rows
(email/country/website) behind a single "Filtros" disclosure with an active-count
badge — the count is already computed (`LeadQueue.tsx:160-165`) — keeping
mode-pills + search always visible. No behavior removed. (Tradeoff: a filter one
click further away; mitigated by the active-count badge keeping it discoverable.)

### (h) Typography & spacing audit

Tokens: `--font-ui: 'Outfit'`, `--font-mono: 'JetBrains Mono'`
(`globals.css:41-42`). `DESIGN.md §3` defines the scale: Title 16–18px, **Body
400/14px**, Label 13px, Caption 11px, and a hard **"No-Display-Heading Rule"**
(`DESIGN.md:139`) — nothing above 18px except 28px mono stat numbers. In
practice the rendered Outreach surfaces sit *below even that*: LeadQueue renders
lead names at 13px (`LeadQueue.tsx:397`), emails/metadata at **10px**
(`:415,:425,:477,:496,:536`), pills at 11px (`PILL_BASE`, `:34`), with tight
padding (pills `2px 8px`, filter bar `8px 10px`, rows `10px 14px`). Against 2026
guidance — comfortable body **16px+** (18–20px desktop), line-height **1.5–1.75**,
type scales like Perfect Fourth (1.333) or Major Second (1.125) for dense UIs,
and "active breathing room" — the current surface is objectively small and
cramped, matching the operator's read. The font *choice* (Outfit, a geometric
humanist sans) is defensible, but the operator perceives it as "non serious";
2026 "serious tool" recommendations lean to IBM Plex Sans / Atkinson Hyperlegible
for technical/enterprise tools (see Sources). Note: `DESIGN.md` itself argues
Outfit reads "warm but precise" — so this is a *taste + rules conflict*, the
tension recorded under Constraints.

**Severity: MED (clarity).** **Direction:** a deliberate type-scale + spacing
bump (body → 15–16px, metadata → 12–13px, line-height → 1.5, looser padding)
landed *as an amendment to `DESIGN.md`/`rules/ui.md` first*, optionally trialing
a "serious" font. This is the slice where the design-freedom tension is resolved.

### (i) UX heuristic pass — concrete clarity failures

- **Lost run on tab switch** (a/c): server keeps working, UI shows idle/empty —
  violates "system status visibility" and the operator's mental model of a local
  app that "handles multiple things."
- **No concurrency view** (b): cannot see two runs at once even though the
  backend runs them.
- **No provenance/validity hint** (e): the queue shows an email with a green dot
  (`LeadQueue.tsx:570-576`) with no signal that it's unverified/may bounce, and
  no hint that emails come from a *later enrichment step*, not the scrape.
- **Misleading `sin abrir`** (f): a constant masquerading as a measurement.
- **Bloated filters** (g) and **cramped/small type** (h).

### (j) "Why it feels broken" — top 3 by operator impact

1. **Runs disappear on tab switch (a/b/c).** Highest impact: it breaks trust in
   the whole tool and forces the operator to the runtime console. Evidence:
   `App.tsx:191-253` unmounts pages; run state is component `useState`
   (`useKeywordRun.ts:34`, `Outreach.tsx:58`); only the scrape job rehydrates
   (`sse.ts:27-61`). Server has the data; the UI never asks.
2. **Wasted spend on dead emails, invisibly (e).** High impact on cost + sender
   reputation: no MX gate (`validateEmail` is format-only, `db/index.ts:463`),
   no bounce ingestion (0 bounces recorded vs. 155 sends), placeholders like
   `tuemail@email.com` pass.
3. **Two honesty bugs that make the tool feel fake (d + f).** Real replies
   hidden (`getRepliedLeads` excludes `auto`, 5/8 replies invisible) and a
   permanent `sin abrir` stamp (0 pixels, 0 opens ever). Both make the operator
   distrust numbers that are actually just defaults.

---

## Findings summary table

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| a/c | Non-scrape runs lost on tab unmount; no mount-time rehydration | `App.tsx:191-253`; `useKeywordRun.ts:34`; `Outreach.tsx:58,154-168`; `sse.ts:27-61` (scrape-only snapshot) | HIGH clarity |
| b | No cross-tab active-runs source of truth in UI (data exists in tables) | `batchOrchestrator.ts:53,247`; `Outreach.tsx:409` runId filter | HIGH clarity |
| d | Replies detected but `auto` ones hard-hidden; 5/8 invisible; joyeriayvino = Aurora Estudio, classified auto | `getRepliedLeads` `db/index.ts:1357-1360`; `classifyReply` `replyChecker.ts:27-47`; SQL `reply_type auto=5 real=3` | HIGH correctness |
| e | Emails scraped (not fabricated) but no MX/SMTP gate + no bounce ingestion; placeholders pass | `socialEnricher.ts:94-110`; `validateEmail db/index.ts:463-471`; `emailSender.ts:86-95`; SQL `sent=155 failed=1(config) bounced=0` | HIGH correctness/cost |
| f | Pixel only with `PUBLIC_URL` (unset); `sin abrir` is a constant; opens unreliable in 2026 anyway | `emailSender.ts:73-79`; `track.ts`; `LeadQueue.tsx:496`; SQL `tracking_token≠null=0, email_opens=0` | MED honesty |
| g | LeadQueue stacks ~12 working filter controls before first lead | `LeadQueue.tsx:204-347` | MED clarity |
| h | Body capped 14px, metadata rendered 10px, tight padding; Outfit locked | `DESIGN.md §3`/`:139`; `globals.css:41-42`; `LeadQueue.tsx:397,415,425` | MED clarity |

---

## Recommended next slices (ranked — operator picks)

> Each addresses at least one required area. Areas covered: (1) cross-tab/
> concurrent persistence → S1; (2) Address-not-found emails → S2; (3)
> 'respondieron' → S3; (4) 'sin abrir' honesty → S4; (5) typography + outreach
> declutter → S5.

**S1 → slice `0012` — Server-authoritative active-runs, SSE-rehydrated** *(addresses a, b, c)*
- *Intent:* one durable, server-owned list of active runs (scrape/keyword/batch/
  premium) that any tab rehydrates on mount via the existing connect-time SSE
  snapshot, plus a thin "active runs" strip so runs survive tab switches and show
  concurrently.
- *Impact:* removes the #1 trust-breaker; runs never vanish; multiple runs
  visible at once.
- *Effort:* M (extend `sse.ts register()` + one `/api/runs/active` read + hook
  hydration; tables already exist). *Prereqs:* none — pattern proven by the
  scrape snapshot. SSE-only, no polling.

**S2 → slice `0013` — Email-validity gate + bounce ingestion** *(addresses e)*
- *Intent:* MX (optionally SMTP-RCPT) check before compose so dead/placeholder
  addresses never reach Gemini or send; ingest DSN bounces in the IMAP pass and
  mark `email_sends.status='bounced'`, surfaced on the lead.
- *Impact:* stops wasted compose/send spend; protects sender reputation
  (Gmail >3% bounce = spam trigger); "sent" finally means delivered.
- *Effort:* M (new pre-compose gate in the pipeline + DSN parse alongside
  `replyChecker`). *Prereqs:* none. Reuse the send path; additive `bounced`
  status + column.

**S3 → slice `0014` — Reply visibility & reclassification** *(addresses d)*
- *Intent:* show `auto`-classified replies in "Respondieron" (muted) with a
  one-tap "real reply" reclassify; soften the 0–3 min velocity auto-rule.
- *Impact:* the 5/8 currently-hidden replies become visible; no real reply lost
  to a misclassification with no recourse.
- *Effort:* S (relax `getRepliedLeads` filter + a `setReplyType` route + UI
  control + tune `replyChecker.ts:41`). *Prereqs:* none. *Tradeoff:* adds some
  auto-reply noise — mitigate by muting, not a separate full tab.

**S4 → slice `0015` — Open-tracking honesty (+ optional real tracking)** *(addresses f)*
- *Intent:* replace the always-on `sin abrir` binary with an honest state — drop
  the indicator, or show "opens not tracked / can't be confirmed," driven by
  whether a pixel was actually embedded.
- *Impact:* the UI stops asserting a measurement it never made.
- *Effort:* S (UI + a "was a token issued" check). *Prereqs:* none. *Tradeoff:*
  removes a visible tag — but it has only ever shown a constant, so no signal is
  lost; flag this explicitly in the slice.

**S5 → slice `0016` — Typography/breathing-room + Outreach declutter (resolve the
design-freedom tension)** *(addresses g, h, and symptom 3)*
- *Intent:* first **amend `DESIGN.md`/`rules/ui.md`** with a written rationale to
  raise the type scale (body 15–16px, metadata 12–13px, line-height ~1.5), loosen
  spacing, and optionally trial a "serious" font; then apply it and collapse the
  secondary LeadQueue filters behind a "Filtros" disclosure with an active-count
  badge.
- *Impact:* directly answers "too small / non serious / cramped / filters look
  like sht."
- *Effort:* M (rules amendment + token/scale change + one disclosure component).
  *Prereqs:* operator sign-off on the rules amendment (the tension above).
  *Tradeoff:* hides filters one click deeper (badge mitigates); changes the
  locked aesthetic deliberately, not silently.

Suggested order: **S1 → S2 → S3 → S4 → S5** (trust first, then money, then
honesty, then polish). S2/S3/S4 are independent and parallelizable.

## Open questions for the operator

**All three resolved by the operator (2026-06-23) — recorded here, applied in the
derived slices:**

1. **Numbering collision — RESOLVED.** This diagnosis renumbered `0008` → `0011`;
   fix slices are `0012`–`0016`. Existing ROADMAP ids `0008`/`0009`/`0010`
   (digest / auto-compose / meta-ad-library) are untouched.
2. **Open-tracking — RESOLVED: enable, but only spam-safe.** Operator wants real
   tracking *only if there is no danger of being flagged as spam.* Slice `0015`
   therefore: (a) removes the misleading always-on `sin abrir` binary first; (b)
   makes real tracking *opt-in*, hosting the pixel on the operator's **own
   established domain `santiagovittor.store`** (already trusted — it's the
   signature link target), which keeps spam risk low; (c) documents the real
   deliverability lever as **bounce rate (slice `0013`)**, not the pixel. Default
   stays honest-off until `PUBLIC_URL` is deliberately configured.
3. **Email-validity — RESOLVED: strongest practical.** Operator: "whatever you
   can do to make sure we get real emails." Slice `0013` does MX **+** best-effort
   SMTP-RCPT probe (with catch-all handling), an expanded placeholder/junk
   blocklist (e.g. `tuemail@…`), and bounce-DSN ingestion — before compose spend.

## Sources (Phase 1 research)

Open-tracking unreliability / Apple MPP:
- [Postmark — Open Tracking and Apple Mail (MPP)](https://postmarkapp.com/support/article/1257-open-tracking-and-apple-mail)
- [Twilio SendGrid — Apple MPP and Open Events](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/understanding-apple-mail-privacy-protection-and-open-events)
- [beehiiv — Impact of Apple MPP on Open Rates](https://www.beehiiv.com/blog/apple-mpp-open-rate)
- [gblock — Email Tracking Pixels 2026 / Gmail proxy](https://www.gblock.app/articles/email-tracking-pixels-2026-gmail-proxy)

Email validity / MX / bounce:
- [Hunter — Email Verifier (MX/SMTP checks)](https://hunter.io/email-verifier)
- [NeverBounce — Email Verification](https://www.neverbounce.com/email-verification)
- [Mailwarm — Cold Email Bounce Rate (Gmail 2026 >3% trigger)](https://www.mailwarm.com/blog/cold-email-bounce-rate-acceptable-reduction)

Background-job persistence / SSE source-of-truth / concurrency UI:
- [SSE Developer's Guide 2026 (Last-Event-ID replay)](https://dev.to/napster_rj/what-are-server-sent-events-sse-a-developers-guide-for-2026-4jb6)
- [LogRocket — UI patterns for async workflows & background jobs](https://blog.logrocket.com/ux-design/ui-patterns-for-async-workflows-background-jobs-and-data-pipelines/)
- [AppMaster — Background tasks with progress: UI patterns (durable storage)](https://appmaster.io/blog/background-tasks-progress-ui)

Typography & density:
- [b13 — UI Font Size Guidelines](https://b13.com/blog/designing-with-type-a-guide-to-ui-font-size-guidelines)
- [adoc-studio — Typography Best Practices: 2026 Guide (type scales)](https://www.adoc-studio.app/blog/typography-guide)
- [uiuxdesigning — Best Font for Readability 2026 (IBM Plex, Atkinson)](https://uiuxdesigning.com/best-font-for-readability/)

Progressive disclosure / decluttering:
- [IxDF — Progressive Disclosure (2026)](https://ixdf.org/literature/topics/progressive-disclosure)
- [UXPin — Progressive Disclosure: best practices 2026](https://www.uxpin.com/studio/blog/what-is-progressive-disclosure/)

---

*Diagnosis only. No implementation plan, no verification gate, no completion
record — those belong to the fix slices the operator selects above.*
