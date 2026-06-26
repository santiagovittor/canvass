# Slice 0039: Analytics — dynamic, opportunity-oriented insights

> **Implementation order: 6 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F7**. The data is
> already live SQL — the fix is *what* it computes, not *whether* it refreshes.

## Intent

**Plain English.** The "Where to aim next" and "Category × zone yield" boxes look
frozen, but they're actually recomputed every load — they just summarize **all-time**
totals, and the database is dominated by the original Buenos Aires scrape, so the
same answer wins every time and nothing visibly moves. They also skip the things
that would actually change and help: which categories and zones get **replies** and
**emails**, and where the weak spots are. Fix: window the insights to a recent
period (and show change vs before), rank by response rate and email-found rate, call
out genuine weak spots and opportunities, refresh live, and strip the em dash from
the insight text.

**Project vocabulary.** Rework `services/analytics.ts` `buildInsights` (`:83-180`)
and add `db/analytics.ts` queries so insights are time-windowed (last 30/90 days +
delta vs prior window) and opportunity-oriented (response rate + email-found rate by
category × zone, weak-spot flags). Keep the existing live `getAnalytics()` request
path and add SSE-refresh on send/open events. Remove the em dash at `analytics.ts:101`.

## Out of scope

- The KPI strip, calendar, funnel, geo-hex map — leave unless trivially affected;
  this slice is the insight + matrix value, not the whole dashboard.
- Open-rate insights that depend on tracking — open rate is structurally 0 until
  slice `0040` decides the pixel; gate any open-based insight behind tracking being
  live.
- The em-dash **send-path** sanitizer (slice `0034`) — here only the analytics
  string is fixed.
- New data sources — everything needed is already in `businesses` + `email_sends`.

## Constraints (`docs/SPEC.md` / `rules/*`)

- **SSE-only realtime** — refresh insights on the existing `email:opened` (dormant)
  / send-scheduler / `businesses_updated` events + a connect-time snapshot; no
  polling loop in the hook (`client/src/hooks/useAnalytics.ts`).
- **db/ is the only place Drizzle/SQL lives** — new aggregates go in
  `db/analytics.ts`, services call them; no raw SQL in `services/`.
- **Reply counting honesty** — keep the existing `real`-only reply filter
  (`db/analytics.ts:10-12`); don't inflate response rate by counting auto/unknown.
- **rules/ui.md** — JetBrains Mono for all rates/counts/deltas; comfortable spacing;
  no tiny type; insight cards stay on-system; **no em dash** in any insight string.
- **No false precision** — a rate over a tiny denominator (e.g. 2 sends) must be
  labeled low-confidence or suppressed, not shown as a headline %.

## Diagnose-first checklist

Done in `0033` F7 — confirm before editing.

- [x] Files to read: `server/src/services/analytics.ts` (`buildInsights:83`,
      `getAnalytics:182`, `pct:79`), `server/src/db/analytics.ts` (all aggregate
      queries; note `getCategoryZoneMatrix`, `getCategoryYields`, `getBandYields`,
      `getRepliedSendDays`, `getOpenStats`), `client/src/hooks/useAnalytics.ts`
      (refresh model), `client/src/components/Analytics/InsightCards.tsx` +
      `CategoryMatrix.tsx` (render).
- [x] Symbols to catalog: `MatrixRow`, `CategoryYieldRow`, `BandYieldRow`,
      `AnalyticsPayload.insights`, the `ZONE`/`HAS_EMAIL`/`CONTACTED`/`REPLIED` SQL
      fragments (`db/analytics.ts:6-13`).
- [x] Research: open tracking is unreliable in 2026 (`0033` F6) — prefer reply rate
      as the headline signal; only show open rate if `0040` enables the pixel.
- [x] Open question for operator (below). Resolved: 30d headline + 90d context
      (all-time kept); reply-rate-first, open gated to 0040; weak-spot ≥15 sends/0 replies.

## Implementation plan

_Operator approves before edits._

- **Step 1 — Time-windowed aggregates.** Add `db/analytics.ts` queries that compute
  category × zone yield, **email-found rate**, and **response rate** over a window
  (last 30 and 90 days, by `email_sends.sent_at` / `businesses.scraped_at`) plus the
  prior window for a delta. Keep all-time available for context.
  *(Verify: SQL returns windowed rows; a recent scrape visibly shifts the 30-day
  numbers where all-time wouldn't move.)*

- **Step 2 — Opportunity-oriented `buildInsights`.** Rewrite to surface: best
  **response-rate** category×zone (not just email yield), worst weak spots ("X in Y:
  0 replies on 18 sends — reconsider angle or pause"), highest email-found-rate
  combos to scrape more of, and under-covered high-yield zones. Confidence-gate small
  denominators. Strip the em dash (`:101`) and any other in insight strings.
  *(Verify: insights name response/email-found rates with real numbers; weak-spot
  insight appears for a genuinely zero-reply combo; no `—` in any string.)*

- **Step 3 — Live refresh.** Make `useAnalytics` re-pull (or patch) on the relevant
  SSE events (`email:opened` once `0040` is live, send-scheduler tick,
  `businesses_updated`) with a connect-time snapshot — no polling.
  *(Verify: sending/scheduling an email updates the insights without a manual
  reload; no `setInterval` in the hook.)*

- **Step 4 — Matrix presentation.** `CategoryMatrix` shows the windowed yield +
  response rate (the operator's "Category × zone yield" box becomes a live
  opportunity grid), JetBrains Mono numerics, low-confidence cells muted.
  *(Verify: the matrix changes after new data; rates legible, on-system.)*

- **Step 5 — tsc.**
  *(Verify: `npx tsc --noEmit` clean — server in container, and client.)*

## Verification gate

_Filled DURING execution with live evidence._

- [x] SQL: windowed aggregates differ from all-time. Live DB (2026-06-26):
      `getCategoryZoneMatrix` all-time = **2000** rows; `getEmailFoundMatrix(30d)`
      = **1571** rows; prior-30d = **395** rows. The 30-day window is a strict,
      moving subset where all-time never moves — a fresh scrape lands in the 30d
      window and shifts it. `MatrixRow` now carries `replied`.
- [x] Insights surface response-rate + email-found-rate + a real weak-spot, with
      confidence-gating on small denominators.
      - **email-found (30d + delta)** fires on live data: `[Recent email yield]
        Hotel in La Plata: 64.7% have email (11/17, last 30 days)...`
      - **response-rate / weak-spot** are *correctly suppressed* on live data: the
        outreach is fragmented (165 combos / 197 sends / 3 replies, max **6**
        sends per combo), so no combo clears the ≥10-send (best) or ≥15-send
        (weak-spot) gate. That is the no-false-precision constraint working, not a
        miss. Response counting is correct (`Abogado/La Plata`: 4 sends / 1 real
        reply). The branch logic + message strings + gates were proven on
        synthetic rows that DO qualify (assert self-check, exit 0):
        `Restaurante in Palermo: 22.2% reply rate (4/18 sent, last 90 days)...`
        and `Gimnasio in Belgrano: 0 replies on 17 sent (last 90 days)...`; the
        3-send combo is excluded from both.
- [x] No `—` in any analytics insight string. `getAnalytics().insights` →
      `EM DASH: false`; `grep "—" server/src/services/analytics.ts` → no match
      (both insight strings and comments cleaned).
- [x] Insights update over SSE: `useAnalytics` subscribes via `useSSE` to
      `send-scheduler:tick`, `email:replied`, `businesses_updated`, `email:opened`
      → debounced silent re-pull. No `setInterval`; debounce uses `setTimeout`, no
      polling loop. Connect-time snapshot = the initial `reload()`.
- [x] `npx tsc --noEmit` clean — server (in container) exit 0, client (in
      container) exit 0.

## Open questions for the operator

1. **Window:** default insight window — 30 days, 90 days, or both with a toggle?
   *Recommend 30-day headline + 90-day context, all-time available.*
2. **Open rate:** include an open-rate insight only if slice `0040` turns the pixel
   on, or leave open-rate out entirely (reply rate as the trust signal)? *Recommend
   reply-rate-first; open-rate only if/when tracking is live and labeled noisy.*
3. **Weak-spot threshold:** what counts as a weak spot worth flagging — e.g. ≥15
   sends with 0 replies? *Recommend ≥12-15 sends, 0 real replies.*

## Completion record

- Commit SHAs: `78de92f`
- What changed:
  - `db/analytics.ts`: `getCategoryZoneMatrix` now returns `replied`;
    added `getEmailFoundMatrix(since, until?)` (windowed by `scraped_at`) and
    `getResponseMatrix(since, until?)` (windowed by `sent_at`, distinct contacted
    vs real-replied). One `YYYY-MM-DD` cutoff serves both date bases.
  - `services/analytics.ts`: `buildInsights` rewritten opportunity-first — best
    response combo (90d, ≥10 sends), weak spot (90d, ≥15 sends / 0 replies),
    recent email-found combo (30d + delta vs prior 30d), under-scraped zone,
    ready-to-contact. Every rate confidence-gated. Both em dashes removed. Dropped
    the all-time best-combo / yield-band / day-of-week insights and the now-dead
    `weekdayOf`/`WEEKDAY_NAMES`/`getRepliedSendDays` plumbing.
  - `hooks/useAnalytics.ts`: live SSE refresh (debounced silent re-pull) on
    send/reply/scrape events; no polling.
  - `components/Analytics/CategoryMatrix.tsx` + `lib/analyticsApi.ts` +
    `styles/globals.css`: new all-time **Reply** column, JetBrains Mono, muted
    when contacted < 8 (low-confidence).
- Follow-ups / new parked items:
  - `db/analytics.ts` `getCategoryYields`, `getBandYields`, `getRepliedSendDays`
    are now unused exports (orphaned by the `buildInsights` rewrite). Left in
    place; remove in a cleanup pass if nothing else picks them up.
  - Response-rate insights stay dormant until outreach concentrates enough sends
    per category×zone to clear the ≥10/≥15 gates. Re-confirm once volume grows.
  - Open-rate insight intentionally absent; wire it in slice `0040` when the pixel
    is live (the `email:opened` SSE refresh is already subscribed).
