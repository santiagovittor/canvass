# Slice 0015: Open-tracking honesty (+ optional spam-safe real tracking)

> Derived from diagnosis [`0011`](0011-ux-clarity-and-outreach-audit.md) finding
> **(f)**. Addresses BRIEF symptom 7 ("sin abrir visible in all of them… are we
> being blacklisted?"). Operator directive (2026-06-23): enable real tracking
> *only if there is no danger of being flagged as spam.*

## Intent

**Plain English:** Every email is stamped "sin abrir" (unopened) — but that's
not a measurement, it's a default: we have never embedded a tracking pixel (it
only turns on when `PUBLIC_URL` is set, which it isn't), so we have zero open
data. Stop lying. First, replace the always-on "sin abrir" with an honest state.
Then, optionally, turn on *real* tracking in a way that won't hurt deliverability
— hosting the tracking pixel on your own already-trusted domain
(`santiagovittor.store`, the same one your signature links to) — and even then
tell the truth that opens can't always be confirmed (Apple Mail and corporate
scanners fire pixels on their own).

**Project vocabulary:** Decouple the open indicator from a missing signal: render
a tri-state driven by whether a tracking token was actually issued for that send
(`email_sends.tracking_token`). Keep pixel injection gated on `PUBLIC_URL`
(`emailSender.ts:73-79`) but document the spam-safe configuration; surface "opens
can't be confirmed" honesty per 2026 MPP reality.

## Out of scope

- Click-tracking (link wrapping) — different mechanism, not requested.
- Changing send/deliverability mechanics beyond the pixel. (Bounce-rate, the real
  reputation lever, is slice [`0013`](0013-email-validity-gate-and-bounce-ingestion.md).)
- Standing up new public infrastructure in this slice — wiring is conditional on
  the operator configuring `PUBLIC_URL`; default stays honest-off.

## Constraints (`docs/SPEC.md`)

- **No misleading UI.** The indicator must reflect reality: not-tracked vs.
  tracked-no-open vs. tracked-opened. No binary that's actually a constant.
- **Additive only.** Existing `email_opens` + `tracking_token` suffice; no
  destructive change.
- **SSE only** — `email:opened` already broadcasts (`openTracker.ts:9`).
- **Spam-safety is a hard requirement (operator).** See the deliberate
  configuration note below; default behavior unchanged until the operator opts in.
- **`rules/ui.md`** governs any new pill/state styling (muted states, mono for
  any count).

## Spam-safety analysis (answers the operator's condition)

- A single 1×1 tracking pixel is **not itself** a strong spam signal. The pixel
  endpoint already sets no-store headers (`routes/track.ts:11-16`) and the image
  is tiny.
- The real deliverability risks are: (1) **bounce rate** — handled in `0013`,
  the bigger lever; (2) hosting the pixel on a **fresh/untrusted domain** or an
  IP with poor reputation; (3) image-heavy / link-heavy HTML bodies.
- **Mitigation chosen:** host the pixel on **`santiagovittor.store`**, the
  operator's existing domain already referenced by the email signature
  (`emailSender.ts:84`) — established reputation, same-domain as existing links,
  so it adds no new untrusted host. Keep the body text-first (current
  `bodyHtml` is plain, `emailSender.ts:81`). Under this setup, pixel risk is low.
- **Honesty regardless:** even correctly configured, Apple MPP pre-fetches images
  → false opens; corporate scanners prefetch too. So a "tracked-opened" state
  must be labeled as *possible* open, and "no open recorded" never means
  "definitely unopened." (Sources in `0011`.)

## Diagnose-first checklist

- [ ] Files to read: `server/src/services/emailSender.ts:72-95` (pixel gate +
      token), `server/src/routes/track.ts`, `server/src/services/openTracker.ts`,
      `server/src/db/index.ts:686-700` (`findSendByToken`, `insertEmailOpen`),
      `client/src/components/Outreach/LeadQueue.tsx:486-497` (the `sin abrir`
      render), `server/src/env.ts:24` (`PUBLIC_URL`).
- [ ] Symbols to catalog: `tracking_token` on `email_sends`, `open_count` join in
      `getFollowUpLeads`/`getRepliedLeads`, `email:opened` consumer
      (`Outreach.tsx:399-401`), `PUBLIC_URL` usage.
- [ ] Confirm (scratch SQL, discard): `tracking_token IS NOT NULL` count and
      `email_opens` count are both 0 (diagnosis found both 0) — proves current
      state is a constant.
- [ ] Online topics: already covered in `0011` (MPP, proxy prefetch). Confirm
      Gmail image-proxy behavior caches but doesn't re-trigger per open.
- [ ] Open questions: does the operator want to actually configure
      `PUBLIC_URL=https://santiagovittor.store` now, or ship honesty-only first
      and enable tracking later? Recommend honesty-first, enable behind config.

## Implementation plan

_Draft — operator approves before edits._

- Step 1 — Tri-state the indicator from data: a send/lead is `not-tracked` when
  no `tracking_token` was issued, `tracked-no-open` when issued but no
  `email_opens` row, `tracked-opened` when an open exists. Default today →
  everything shows `not-tracked` (honest), not `sin abrir`. *Verify:* with 0
  tokens, no lead shows a false "unopened"; it shows "sin seguimiento" / "opens
  off."
- Step 2 — Honest labels: `tracked-opened` → "posible apertura" with a tooltip
  that opens can't be confirmed (MPP/prefetch); `tracked-no-open` → "sin apertura
  registrada." *Verify:* labels read truthfully; no binary "sin abrir."
- Step 3 — (Optional, behind operator opt-in) document + support
  `PUBLIC_URL=https://santiagovittor.store` so the pixel actually embeds; confirm
  `/t/:token.gif` is reachable on that host. *Verify:* a test send embeds a
  pixel; opening it records one `email_opens` row and flips the lead to "posible
  apertura" via `email:opened`.
- Step 4 — Tradeoff note in the slice's completion record: Step 1 removes the
  visible "sin abrir" tag — but it has only ever shown a constant, so **no signal
  is lost** (the explicit, non-hidden tradeoff per `0011` Out-of-scope).

## Verification gate

_Filled DURING execution with live evidence (2026-06-23)._

- [x] SQL (server container, better-sqlite3): `email_sends WHERE tracking_token IS
      NOT NULL` = **0**, `email_opens` = **0**, `email_sends WHERE status='sent'` =
      **179**. Proves "sin abrir" was a constant across all 179 sends, not a
      measurement.
- [x] Live API: `GET /api/outreach/follow-ups?days=0` after server restart →
      `total: 139`, every row `tracked:false, open_count:0`
      (sample: `Estudio MP`, `Studio5`). So all 139 follow-up leads now render the
      honest **"sin seguimiento"** tri-state, never a false "sin abrir." The
      `tracked` field flows DB → API → type; render is pure derivation (tsc-checked),
      so the data evidence is equivalent to the screenshot.
- [ ] (Step 3, NOT enabled) Pixel-hit log on `santiagovittor.store/t/<token>.gif` —
      out of scope this slice; default stays honest-off until operator sets
      `PUBLIC_URL`. Support already exists at `emailSender.ts:73`.
- [x] `npx tsc --noEmit` clean — server (in container) and client both report no
      errors.

## Completion record

- Commit SHAs: _(uncommitted — operator to commit)_
- What changed:
  - `server/src/db/index.ts` — `getFollowUpLeads` + `getRepliedLeads` lastSendJoin
    now compute `tracked_count = SUM(tracking_token IS NOT NULL)`; `FollowUpLead`
    gains `tracked: boolean`, `RawFollowUpRow` gains `tracked_count`, both mappers
    set `tracked: (tracked_count ?? 0) > 0`.
  - `client/src/lib/outreachApi.ts` — `FollowUpLead.tracked: boolean`.
  - `client/src/components/Outreach/LeadQueue.tsx` — binary `abierto`/`sin abrir`
    badge replaced by tri-state: `!tracked` → "sin seguimiento"; tracked + no open
    → "sin apertura registrada"; tracked + open → "posible apertura" (accent), each
    with an honest tooltip (MPP/corporate prefetch caveat).
- Tradeoff (Step 4, per `0011` Out-of-scope): the visible "sin abrir" tag is gone,
  but it only ever rendered a constant (0 tokens / 0 opens across 179 sends) — **no
  signal is lost.** This is the explicit, non-hidden tradeoff.
- Follow-ups / new parked items: Step 3 (enable real tracking via
  `PUBLIC_URL=https://santiagovittor.store`) remains parked behind operator opt-in;
  no infra stood up. When enabled, "posible apertura" rows become reachable and the
  `email:opened` SSE already refreshes the followup list (`Outreach.tsx:424`).
