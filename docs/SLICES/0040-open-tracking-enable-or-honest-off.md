# Slice 0040: Open-tracking — enable honestly, or honest-off

> **Implementation order: 7 of 8.** Derived from diagnosis
> [`0033`](0033-yield-outreach-analytics-audit.md) finding **F6**. The whole stack
> is already built and dormant — this slice is a **decision + a small wiring**, with
> an explicit deliverability tradeoff. **Operator decides the branch before code.**

## Intent

**Plain English.** The honest answer to "are we adding the pixel?" is no — the code
exists end to end (tracking image, open recorder, opens table, an open-rate stat)
but it only switches on when one setting, the server's public internet address, is
filled in, and it's blank. So no email carries a pixel and the open rate is always
zero. Two honest choices: (1) turn it on — set that address and the existing code
starts recording opens, accepting that in 2026 open tracking is noisy and a mild
spam risk; or (2) leave it off and make the UI stop pretending it measures opens,
and instead check "am I landing in spam" a more reliable way. Either way the app
should stop implying a precise open rate it doesn't have.

**Project vocabulary.** The pixel pipeline is complete: `routes/track.ts` (1×1 GIF
→ `recordOpen`), `openTracker.ts` (`email_opens` insert + `email:opened` SSE),
`db/analytics.ts getOpenStats`, `services/analytics.ts openRatePct`,
`emailSender.ts:76-83,95-99` (pixel injected **iff** `env.PUBLIC_URL` set). It is
dormant because `PUBLIC_URL` is absent from `.env` — proven: 257 sends, **0**
`tracking_token`, **0** `email_opens`. This slice either (A) sets a reachable
`PUBLIC_URL` and validates the live loop, or (B) makes the open-rate UI honest and
adds a real inbox-placement check.

## Out of scope

- Click tracking (a separate, more reliable signal — could be a later parked item).
- Reply visibility (slice `0014`).
- Analytics insight rework (slice `0039`) — only the open-rate *honesty* overlaps;
  coordinate the label.
- A full deliverability suite (Postmaster automation) — at most a one-off posture
  check here.

## Constraints (`docs/SPEC.md` / `rules/*`)

- **Env validated by zod at boot** — `PUBLIC_URL` is already
  `z.string().url().optional()` (`env.ts:33`); if branch A, document that it must be
  **internet-reachable** (not `localhost`) for Gmail/Apple proxies to fetch the
  pixel. No silent default.
- **SSE-only realtime** — `email:opened` already broadcasts (`openTracker.ts:9`);
  any UI open-indicator consumes it, no polling.
- **Pixel route stays above auth** — `index.ts:53` mounts `track` before
  `authMiddleware` (recipients' mail clients are unauthenticated); do not move it.
- **No schema change needed for branch A** — `tracking_token` + `email_opens`
  already exist; additive-only if anything.
- **rules/ui.md** — any open-state UI uses honest language (no fake "sin abrir"
  default — see the parked `0015 open-tracking-honesty` intent), JetBrains Mono for
  any rate, on-system.
- **Deliverability tradeoff is load-bearing and must be surfaced, not hidden**
  (operator's "no hidden regressions"): a tracking pixel is a minor spam signal;
  Apple Mail Privacy Protection pre-fetches images (false opens), Gmail's proxy
  caches the pixel (repeat opens vanish). Clicks + reply rate are more trustworthy.

## Diagnose-first checklist

Done in `0033` F6 — confirm before editing.

- [x] Files to read: `server/src/services/emailSender.ts:76-99` (pixel injection
      gate), `server/src/routes/track.ts`, `server/src/services/openTracker.ts`,
      `server/src/db/analytics.ts:36-46` (`getOpenStats`),
      `server/src/services/analytics.ts:209` (`openRatePct`), `server/src/env.ts:33`
      (`PUBLIC_URL`), `server/src/index.ts:53` (route mount order), the parked
      `docs/SLICES/0015-open-tracking-honesty.md` intent.
- [x] Symbols to catalog: `PUBLIC_URL`, `trackingToken`, `recordOpen`,
      `insertEmailOpen`, `findSendByToken`, `email_sends.tracking_token`,
      `email_opens`, `email:opened` SSE, `getOpenStats`, `openRatePct`.
- [x] Evidence (live): `PUBLIC_URL` not in `.env`; 257 sends / 0 tokens / 0 opens.
- [x] Research (`0033` F6): 2026 open-tracking is ~75-84% structurally unreliable
      (Apple MPP false opens, Gmail proxy caching); cold-outbound consensus = lean on
      reply rate; clicks unaffected by proxies.
- [x] **Open question for operator — THE decision: branch A or B.** → **B (honest-off)**
      chosen 2026-06-26. Operator's goal was diagnosing opens-vs-content; explained
      the pixel is low-risk on a trusted domain but the 2026 data is noisy (Apple MPP
      false opens, Gmail proxy caching) and would still need an internet-reachable host
      routing to this Express server. Operator chose to stay honest-off and lean on
      reply rate + placement check.

## Implementation plan

_Operator approves the branch AND the tradeoff before edits._

### Branch A — Enable (operator wants first-open confirmation, accepts the tradeoff)

- **A1 — Reachable `PUBLIC_URL`.** Set `PUBLIC_URL` to an internet-reachable base
  (tunnel/host) so Gmail/Apple proxies can fetch `/t/<token>.gif`. Validate at boot.
  *(Verify: from outside the network, `GET <PUBLIC_URL>/t/test.gif` returns the GIF
  with no-store headers.)*
- **A2 — Live loop test.** Send a real (or dry-run-then-real) email to a seed inbox,
  open it, confirm `email_opens` gets a row and `email:opened` fires.
  *(Verify: SQL `SELECT * FROM email_opens` shows the open; a tracked send has a
  `tracking_token`; the SSE event is observed.)*
- **A3 — Honest UI.** Show open state as "at least one open (approx)", never a
  precise rate; note proxy/MPP caveats inline. Coordinate label with `0039`.
  *(Verify: UI reads honestly; open-rate not presented as truth.)*
- **A4 — Seed/placement sanity.** One-off: send to Gmail/Outlook seed addresses,
  confirm inbox vs spam — the real answer to "am I going to spam."
  *(Verify: documented placement result.)*

### Branch B — Honest-off (rely on reply rate; pixel is a spam risk not worth it)

- **B1 — Make the UI honest.** Remove any implied open rate / default "sin abrir";
  state opens aren't tracked (parked `0015` intent). Keep the dormant code in place
  (no deletion) so A is a one-line flip later.
  *(Verify: no UI element implies a measured open rate.)*
- **B2 — Inbox-placement check (the real "am I in spam").** A one-off seed-inbox
  test (Gmail/Outlook) + a posture check (SPF/DKIM/DMARC on the signature link
  domain `santiagovittor.store`); document results.
  *(Verify: placement + auth posture captured; any failing record flagged.)*

- **Both branches — tsc.** *(Verify: `npx tsc --noEmit` clean, server in container.)*

## Verification gate

_Filled DURING execution with live evidence (2026-06-26)._

- [—] (A) Not taken — branch B chosen.
- [x] (B) **UI no longer implies a measured open rate.** Live DB
      (`/app/data/scraper.db`, better-sqlite3): `email_sends WHERE status='sent'` =
      **218**, `tracking_token IS NOT NULL` = **0**, `email_opens` = **0** — so
      `openRatePct = pct(0,0) = 0` was a constant, not a measurement. Live API
      `GET /api/analytics` after server restart returns `kpis.trackedSends: 0`, so the
      KpiStrip "Open rate" tile now renders `—` + sub "tracking off" instead of the
      fake "0%". When a token ever exists (branch A flip) the same tile shows
      `{openRatePct}%` + sub "(opens can't be confirmed)" — honest in both states. The
      LeadQueue badge was already honest (slice 0015 tri-state). Render is pure
      derivation off `trackedSends` (tsc-checked) → data evidence ≡ screenshot.
- [x] (B) **Auth posture documented.** Mail is sent **From `@gmail.com`** (both senders:
      `svittordev@gmail.com`, `santiagovittordev@gmail.com`) via Gmail SMTP → SPF / DKIM /
      DMARC are **Google's and pass/align** — the actual sending identity is sound. The
      signature *link* domain `santiagovittor.store` (A `190.55.60.130`) has **no SPF,
      no DMARC, no MX** (it does not send mail, so this does not affect deliverability
      auth, but the domain is spoofable). Cheap hardening parked: add DMARC `p=reject`
      + null MX. Live **seed-inbox placement** test (send to Gmail/Outlook seeds or
      mail-tester.com, eyeball inbox-vs-spam) is **operator-run** — not executed here
      because it requires transmitting real mail from the operator's account; method
      documented, deferred to operator.
- [x] Tradeoff documented in the completion record below (not hidden).
- [x] `npx tsc --noEmit` clean — server (in container) **and** client both report no errors.

## Open questions for the operator

1. **Branch decision:** enable the pixel (A) for first-open confirmation knowing
   it's noisy + a mild spam signal, or honest-off (B) and trust reply rate + a
   placement check? *Recommend B unless you specifically want first-open
   confirmation; clicks/replies are the trustworthy signals in 2026.*
2. **If A:** what's the internet-reachable host for `PUBLIC_URL` (the prod URL, a
   tunnel)? It must not be `localhost`.
3. **Placement check scope:** just a manual seed test now, or stand up Google
   Postmaster Tools for the link domain? *Recommend manual seed test first.*

## Completion record

- **Branch chosen: B (honest-off)** — operator decision 2026-06-26.
- Commit SHAs: _(see git log for this slice's commit)_
- What changed:
  - `server/src/services/analytics.ts` — `AnalyticsPayload.kpis` gains
    `trackedSends: number`; `getAnalytics` sets it from `openStats.trackedSends`. This
    lets the UI distinguish "0% of N tracked sends" from "no tracking configured at
    all" (the actual state: `PUBLIC_URL` unset → 0 pixels → `openRatePct` is a
    meaningless constant).
  - `client/src/lib/analyticsApi.ts` — `kpis.trackedSends: number` on the type.
  - `client/src/components/Analytics/KpiStrip.tsx` — the "Open rate" tile is now
    data-driven: `trackedSends === 0` → value `—`, sub "tracking off"; otherwise
    `{openRatePct}%`, sub "(opens can't be confirmed)" (MPP/proxy honesty). The fake
    "Open rate 0%" is gone.
  - **No deletion** of the pixel pipeline (`routes/track.ts`, `openTracker.ts`,
    `getOpenStats`, `openRatePct`, the `emailSender.ts` gate). All dormant code stays
    → branch A remains a one-line flip (`PUBLIC_URL=…`) later.
- **Deliverability tradeoff (explicit, not hidden):** enabling the pixel was rejected
  not because it is dangerous (a 1×1 pixel on a trusted domain is a weak spam signal)
  but because the *data is unreliable* in 2026 — Apple Mail Privacy Protection
  pre-fetches the image (false opens), Gmail's proxy caches it (repeat opens vanish) —
  and it would require an internet-reachable host routing to this Express server.
  Reply rate (already shown) is the trustworthy content signal; the operator's
  "opens vs content" question is better answered by a placement check + reply rate.
  Cost of branch B: no first-open confirmation at all (accepted).
- Follow-ups / new parked items:
  - **Click tracking** — a more reliable signal unaffected by image proxies (parked).
  - **DMARC `p=reject` + null MX on `santiagovittor.store`** — cheap anti-spoof
    hardening for the signature link domain (no SPF/DMARC/MX today); not a deliverability
    blocker since mail is sent from gmail.com.
  - **Live seed-inbox placement test** (mail-tester.com or Gmail/Outlook seeds) —
    operator-run; requires transmitting real mail.
  - **Branch A** stays available behind `PUBLIC_URL` (Postmaster automation if ever
    pursued).
