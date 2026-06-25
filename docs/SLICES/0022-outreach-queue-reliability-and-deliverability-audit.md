# Slice 0022: Outreach-queue reliability & deliverability audit (diagnosis)

> **Diagnosis slice. No code changes.** The deliverable is this written report:
> the Findings and Recommended-next-slices sections. Derived from the operator's
> raw brief at `docs/BRIEF.md` ("Outreach queue is broken"). Investigation run
> 2026-06-24 against the live dev stack (server container up since 14:29 UTC,
> `data/scraper.db`, real server logs, live SMTP probes).

## Intent

**Plain English.** The "Prepare a batch" button sometimes runs forever and never
finishes. Lots of good business emails get thrown out as "bad email" even though
the address is real and printed on the company's own website. We're not seeing
replies and the operator fears a blacklist. The operator added a second Gmail
address and wants to send from both to raise daily volume. Gemini keeps throwing
errors and the operator wants to know whether that's our fault or Google's. And
the page keeps losing its scrollbar so the bottom of long lists (e.g. the
Explorer leads) can't be reached. This slice **finds the cause of each** with
real evidence and proposes a direction — it does **not** fix anything.

**Project vocabulary.** Audit the prepare → analyze → compose → verify → enqueue
batch path (`batchOrchestrator`, `outreachComposePipeline`, `geminiRateLimiter`),
the pre-compose email-validity gate (`emailVerifier`), the single-sender send
path (`emailSender`, `outreachGovernor`), the reply/visibility data, and the
Explorer flex-sizing, and report root causes + ranked follow-up slices. Every
finding cites a `file:line`, a log line, a SQL count, or captured probe output.

## Symptoms (operator's words, verbatim)

- "Ran the Prepare a batch function in automation and it is stuck since 20
  minutes ago."
- "Most of the emails were flagged as 'bad_email' … they are present in their
  websites" — `email_invalid:jcgarrafa@bariloche.com.ar` (Estudio Jurídico
  Garrafa), `email_invalid:info@lift-am.com` (LIFT Asset Management).
- "That Estudio Juridico Garrafa had many emails apart from that one … sometimes
  we might be missing some leads['] emails because we are sending to the wrong
  on[e]."
- "We need to make sure we don't have a blacklist … it is weird that I'm not
  getting ANY response at all."
- "I created another email … santiagovittordev@gmail.com … some emails [from]
  svittordev and some from santiagovittordev … send more emails per day and avoid
  blacklists."
- "Gemini seems to be getting … timeouts or errors and I want to know if it is me
  or … the service."
- "Each time you add a function that takes some space I lose the chance of
  scrolling down … now … can't scroll to see all the leads scraped in explorer."
- Goal: "A 15 leads batch should take around 10 to 15 minutes TOPS … never end up
  in a weird stale state … like a factory … around 100 emails per day with the 2
  emails."

## Out of scope

This is diagnosis only. Explicitly **not** in this slice:

- No fix to the batch stall (no watchdog/timeout code, no concurrency change).
- No change to the validity gate, no catch-all/Microsoft handling code.
- No wiring of the second sender (no env vars, no DB columns, no rotation code) —
  only a written requirements spec for it.
- No model swap, no NVIDIA NIM / Ollama integration — only an evaluation.
- No Explorer layout fix.
- No re-scraping, no enrichment changes, no schema migration.
- **Off the table** (SPEC invariant): "fixing" `bad_email` by weakening or
  disabling the validity gate or bounce ingestion. We explain *why it
  false-positives*, not how to switch it off.

## Constraints (`docs/SPEC.md` invariants that apply)

- **Reuse-only registry** — any future fix reuses `composeVerifiedEmail`,
  `withGeminiRate`, `governSend`, `sendGate`, `scheduledSendWorker`; never
  reimplements them.
- **Email-validity gate + bounce ingestion stay** (slice 0013). The gate is
  load-bearing; the fix is making it classify Microsoft/Outlook reject-all MX as
  `unknown` (proceed) rather than `invalid` (skip) — not removing it.
- **SSE-only realtime** — any new health/state surface is an SSE event +
  connect-time snapshot, no polling (`gemini:health` precedent, slice 0020).
- **gosom self-heal** untouched (the wedge-restart probe in `jobRunner` is
  unrelated to the batch stall; do not conflate).
- **Additive schema only**; **env validated by zod at boot**; **no false absence
  claims** (every symbol below was grepped/confirmed in the current tree).
- **No quality regressions hidden** — a cheaper model or a looser gate that moves
  output/deliverability quality must surface the tradeoff in the recommendation.

## Diagnose-first checklist — results

Each item below was executed; full evidence is in **Findings**.

- [x] **(a) Batch stall** — traced trigger → state machine → wedge point. Root
      cause identified at `file:line` with the exact last log line before freeze.
- [x] **(b) bad_email false positives** — read the gate, ran the live SMTP probe
      against both operator examples, captured real reply codes + reason.
- [x] **(c) Multiple emails per lead** — SQL counts; send-target selection logic.
- [x] **(d) Blacklist / zero-reply** — DB reply/send counts; sender posture;
      confirmed replies are **not** zero.
- [x] **(e) Second-sender wiring** — audited the single-sender path; wrote the
      exact requirements (env, DB, cap, reply-scan).
- [x] **(f) Gemini reliability** — pulled real 503 log rate; classified us-vs-them;
      evaluated NVIDIA NIM / Ollama / alternatives with tradeoffs.
- [x] **(g) Scroll clipping** — found the missing `min-height:0` flex containers;
      cross-referenced slice 0018.

---

## Findings

### F1 — Batch stall: one wedged Gemini call freezes the whole prepare pipeline (HIGH / reliability)

**Plain English.** The batch didn't crash — it *froze*. One single Gemini request
got stuck and never came back or errored. Because every Gemini request in the
whole app waits in a single-file line behind that one stuck request, the entire
batch stopped dead: no error, no progress, forever, until the operator hit
cancel. This is exactly the "stuck 20+ minutes, no error, works-once-then-hangs"
the operator described.

**Evidence.**

- The stalled run in the DB: `batch_runs` id `b2b21677-…` — `status` was
  `running`, `total=15`, but only `processed=8`; `created_at 11:30:54`,
  `updated_at 12:17:26` (BA/UTC-3) ⇒ **~47 minutes** before the operator
  canceled (`pause_reason=user_canceled`).
- Its `batch_items`: **6 items frozen in state `composing`**, 1 still `pending`,
  the other 8 terminal. The 6 composing items' `updated_at` froze between
  11:30–11:37 and never moved again:
  ```
  ChIJDbwF8G97GpYRoezhtEbVOO8  composing  11:30:54
  ChIJB6QBt8x7GpYRYKb32gOPibI  composing  11:30:54
  ChIJN2hCfwQpQg0RjWEAvRQmGZE  composing  11:36:01
  ChIJOYYspzV7GpYRhiGd-5koeRg  composing  11:33:20
  ChIJ7xlsL3YpQg0RQItrEHV8OMo  composing  11:36:51
  ChIJ7Z7SxGopQg0R94RXUvRK3aM  composing  11:37:24
  ```
- Server log — **the last Gemini line ever emitted by this run**, then total
  silence (only scheduler ticks) until cancel ~40 min later:
  ```
  14:37:37.919  [gemini] compose call #120 @ … (rpd 59/1000)
  14:37:39.429  [gemini] compose attempt#3 FAILED status=503
  14:40:17      [scheduler] deferred … (no further [gemini] lines)
  ```
  Call #120 logged attempt#3 and never advanced to attempt#4/#5, never timed out,
  never completed. No server restart (`StartedAt 14:29:38`, single "Server
  running on :3001" at 14:30:17).
- **Mechanism (code).** All Gemini calls serialize through one Bottleneck limiter
  with `maxConcurrent: 1` (`geminiRateLimiter.ts:39-45`). A call that never
  settles holds that single slot, so every queued compose/verify across all
  in-flight leads waits behind it indefinitely. In `batchOrchestrator.processItem`
  the **analyze** stage is wrapped in `withTimeout(…, BATCH_ANALYZE_TIMEOUT_MS)`
  (`batchOrchestrator.ts:118`) but the **compose** stage is **not**:
  `composeVerifiedEmail(...)` at `batchOrchestrator.ts:154` has no per-item
  timeout. There is **no run-level watchdog** anywhere — `driveRun` does
  `Promise.all(items.map(...))` (`:192`) and only finalizes after every item
  settles (`:227`), so one never-settling item ⇒ the run never finalizes and
  stays `running` with no error.
- **Trigger.** A sustained upstream `gemini-2.5-flash` 503 storm (see F6): the
  wedge surfaced *during* a period when ~88% of calls were 503-ing, which is when
  the per-attempt retry/timeout machinery is exercised hardest.

**Severity.** HIGH (reliability). This is the operator's #1 symptom and directly
blocks the "factory" goal.

**Proposed direction (not a fix).** Two independent guards: (1) wrap the compose
stage in `processItem` with a `withTimeout` exactly like analyze already is, so a
stuck lead dead-letters to `failed` and the batch continues; (2) add a run-level
watchdog that fails/pauses a run whose `updated_at` hasn't advanced in N minutes.
Optionally make the per-attempt abort in `withGeminiRate` provably release the
Bottleneck slot even when the underlying fetch never settles. Pairs with F6
(reduce the 503 storm that triggers it).

### F2 — bad_email: Microsoft-365 mailboxes are reject-all on RCPT probes → false `invalid` (HIGH / deliverability)

**Plain English.** Both example addresses the operator flagged are hosted on
Microsoft 365 (Outlook for Business). Microsoft deliberately answers "no such
recipient" (550) to *anyone* probing whether a mailbox exists — including for a
made-up random address — to stop spammers harvesting addresses. Our validity
check reads that 550 as "dead mailbox" and throws the lead out. The mailbox is
almost certainly fine; Microsoft just refuses to confirm it over SMTP. Gmail, by
contrast, *does* answer truthfully, so Gmail-hosted leads verify correctly.

**Evidence (live SMTP probe, port 25 open in this dev env, 2026-06-24).**

```
jcgarrafa@bariloche.com.ar  → MX bariloche-com-ar.mail.protection.outlook.com  RCPT 550  catch-all-probe 550  ⇒ verdict INVALID
info@lift-am.com            → MX liftam-com01b.mail.protection.outlook.com     RCPT 550  catch-all-probe 550  ⇒ verdict INVALID
svittordev@gmail.com        → MX gmail-smtp-in.l.google.com                    RCPT 250  catch-all-probe 550  ⇒ verdict VALID
```

Both Microsoft hosts return **550 for the real address *and* for a random
non-existent local-part** — i.e. the server rejects *everything* at RCPT time;
it can't tell us anything. The current gate (`emailVerifier.ts:126`) returns
`invalid` on any `5xx` **before** it ever looks at the catch-all symmetry — and
the catch-all/"can't confirm → unknown" downgrade is only applied in the `2xx`
(accept-all) branch (`:127-129`). So a **reject-all** server is mis-scored
`invalid` instead of `unknown`.

- This matches the brief's exact rows: in the run logs,
  `[batch] skipped business=… reason=bad_email email=jcgarrafa@bariloche.com.ar`.
- DB `email_validity` invalid-via-probe sample is heavily M365/corporate:
  `estudio@auadgraf.com.ar`, `info@cosmetic-dentistry.com`, `contact@bhsmile.com`,
  `central@valtecsa.com`, `enquiries@abaccapital.com`, `info@lift-am.com`,
  `jcgarrafa@bariloche.com.ar`, … (14 `invalid`, 11 `unknown`, 10 `valid` cached).
- Cross-check with the memory note "prod likely blocks port 25 → unknown": in
  **prod** these would degrade to `unknown` and *proceed* (the gate fails open on
  a blocked probe). The false-`invalid` is specifically a **dev-env artifact**
  where port 25 is open and the probe *succeeds* at getting a misleading 550.
  External confirmation: Microsoft enforces SPF/DKIM/DMARC and recipient-probe
  rejection aggressively, and reject-all-on-RCPT is standard M365 anti-harvesting
  behavior.

**Severity.** HIGH (deliverability) — it silently discards a large slice of real,
reachable corporate leads, and the behavior differs between dev and prod.

**Proposed direction (not a fix).** Apply the catch-all symmetry test to the
`5xx` branch too: if the random-local-part probe *also* gets `5xx`, the server is
reject-all and can't confirm → downgrade to `unknown` (proceed), not `invalid`.
Equivalently, treat known Microsoft/Outlook protection MX as "probe-unreliable →
unknown". Keep a true `5xx` on a server that *accepted* the random probe (a real
"this specific mailbox is dead") as `invalid`. No weakening of the gate — only
correcting an unreliable-signal misclassification. Trust the bounce-ingestion
path (slice 0013) as the authoritative "really dead" signal.

### F3 — Multiple emails per lead: we always send to email[0]; ~11% of leads have alternates we never try (MED / deliverability)

**Plain English.** When a business lists several emails, we only ever use the
first one. If that first one is the unreachable/wrong one (e.g. a Microsoft
`info@` that we just mis-flagged), we skip the whole lead even though a second,
reachable address exists. About 1 in 9 emailed leads has more than one address.

**Evidence.**

- SQL over `businesses` with a non-empty `emails_json`: **681 leads with email;
  74 have >1 email** (52 with 2, 11 with 3, 5 with 4, 6 with 5). ≈ **10.9%**.
- Send target is hard-coded to the first parsed email: `getFirstEmailForBusiness`
  returns `parseEmails(emails_json)[0]` (`db/index.ts:552-558`); the batch gate
  and queue use only that (`batchOrchestrator.ts:95`,
  skill note `parseEmails(...)?.[0]`).
- Garrafa (operator's example) is exactly this case: email[0]
  `jcgarrafa@bariloche.com.ar` mis-flagged (F2), but the operator says it has
  other addresses we never attempt.

**Severity.** MED — meaningful recoverable leads, but smaller than F1/F2.

**Proposed direction (not a fix).** Pick the *best reachable* single address per
lead, not the first: prefer one whose validity probes `valid`/`unknown` over one
that probes `invalid`; prefer role/person heuristics where useful; dedup. **Do
NOT send to several addresses per company at once** — external best practice
(2026) is explicit that emailing multiple contacts at one company the same day
trips corporate firewalls into a domain-wide block. So the value here is *better
single-target selection / fallback*, not multi-send.

### F4 — Zero replies is (partly) a visibility problem, not a confirmed blacklist (MED / deliverability + UX)

**Plain English.** Replies are **not** actually zero — the database has 9 of
them. A 9-reply / 248-contacted rate (~3.6%) is normal-to-good for cold email.
The operator may not be *seeing* the replies (a known UI gap), and/or more mail
is landing in spam than we can measure. There's no evidence of a classic IP
blacklist, because the sender is a personal Gmail account whose outbound IPs
Google manages and rotates — the real risk is Gmail per-account reputation and
recipient spam-foldering, not an RBL listing.

**Evidence.**

- `email_sends` by status: **sent 200, bounced 4, failed 1, dryrun 36**.
- `businesses.outreach_status`: **contacted 248, replied 9, skip 26, null 3877**.
  So replies = **9, not 0** ⇒ 9/248 ≈ **3.6%** reply rate.
- Reply visibility is a known, already-ranked gap: ROADMAP `0014
  reply-visibility-and-reclassification` ("Stop hiding auto-classified replies").
  The brief's "ANY response at all" is consistent with replies existing but being
  hidden/auto-classified, plus spam-folder placement we can't observe.
- Sender posture: `emailSender.getTransport()` uses Gmail service with
  `auth.user = GMAIL_FROM` (`emailSender.ts:41-44`); from-address
  `env.GMAIL_FROM` (`:87`). Sending is via Gmail's shared, rotating outbound IPs
  (not a static IP we own), so DNSBL/RBL listing of "our IP" is not the failure
  mode — Gmail account reputation + content/link reputation (the
  `santiagovittor.store` link in the signature) and recipient spam filters are.
- External (2026): without inbox rotation, cold campaigns can sit below ~30%
  inbox placement; warmup + SPF/DKIM/DMARC + complaint-rate <0.3% are the levers.
  A free Gmail cold-emailing un-warmed is a primary spam-placement risk.

**Severity.** MED — reframes the operator's biggest fear (blacklist) toward two
addressable causes (reply visibility + spam placement / warmup).

**Proposed direction (not a fix).** (1) Ship reply visibility (slice 0014) so the
9+ replies are actually seen — the cheapest, highest-trust win. (2) Add a simple
deliverability posture check (Google Postmaster Tools enrollment for the link
domain; confirm the signature link domain has SPF/DKIM/DMARC and isn't on
Spamhaus DBL) as a one-off audit, not a feature. (3) Treat warmup + per-day caps
as the structural fix (ties into F5).

### F5 — Second sender: the send path is hard-wired to one Gmail; rotation needs env + per-sender state (MED / capacity)

**Plain English.** Right now the app can only send from one Gmail account, set in
one place. To send from two and split the daily volume, we need to teach the app
about a second account's credentials, choose which account each email goes from,
count the daily cap *per account* instead of globally, and scan *both* inboxes
for replies and bounces. Here's exactly what's needed.

**Evidence (current single-sender wiring).**

- Credentials are single: `env.GMAIL_FROM` + `env.GMAIL_APP_PASSWORD`
  (`env.ts:20-21`), surfaced in Settings as one secret
  (`settingsRegistry.ts:253`).
- One transport, one from-address: `emailSender.getTransport()`
  (`emailSender.ts:37-45`) and `from: env.GMAIL_FROM` (`:87`).
- Reply + bounce scanning reads exactly one mailbox: `replyChecker.ts:67,97,109`
  (`auth.user = GMAIL_FROM`, `ownAddress = GMAIL_FROM`).
- The daily cap is **global, not per-sender**: `capRemaining()` =
  `min(getDailyCapRolling(), GMAIL_HARD_CEILING) - rollingSentCount24h()`
  (`outreachGovernor.ts:57-59`); `OUTREACH_DAILY_CAP` default 15
  (`env.ts:34`). (Note a latent inconsistency: `emailSender.ts:35` hard-codes
  `DAILY_CAP = 30` only for the `remaining` number it returns — the real gate is
  the governor's rolling cap.)
- The validity probe's HELO/MAIL-FROM also assume the single `GMAIL_FROM`
  (`emailVerifier.ts:23,79,82`).

**Requirements to add `santiagovittordev@gmail.com` as a second rotating sender
(spec, not implementation).**

1. **Auth method.** A Gmail **App Password** for the new account (same mechanism
   as the current one) — App Passwords require 2-Step Verification enabled on
   that Google account. *(OAuth2 is the heavier alternative; App Password matches
   the existing pattern and is the lazy correct choice unless the operator wants
   OAuth.)* **→ Operator action: enable 2FA on santiagovittordev@gmail.com and
   generate a 16-char App Password.**
2. **Env / Settings.** A senders list rather than a single pair — e.g.
   `GMAIL_SENDERS` (JSON: `[{from,appPassword,dailyCap}]`) or a second
   `GMAIL_FROM_2` / `GMAIL_APP_PASSWORD_2` pair, validated by zod at boot.
3. **Sender selection.** A rotation policy per send (round-robin or
   least-recently-used / least-loaded-today). Persist which sender each
   `email_sends` / `scheduled_sends` row used (additive column `sender` /
   `from_address`).
4. **Per-sender cap.** Change the global cap to per-sender 24h rolling counts so
   each Gmail stays under its own safe ceiling. The "100/day across 2 accounts"
   goal is **only safe with warmup** — external 2026 guidance caps un-warmed cold
   Gmail at ~25–50/day/inbox; document the warmup ramp, don't just lift the cap.
5. **Reply + bounce scanning** must iterate **both** inboxes (`replyChecker`),
   and DSN/bounce matching must key off the per-row sender.
6. **Validity probe HELO/MAIL-FROM** should use a sender that matches (minor).

**Severity.** MED — clear capacity win, but bounded by warmup reality (don't sell
"100/day tomorrow").

**Proposed direction.** A dedicated slice; the hard parts are per-sender cap
accounting and dual-inbox reply/bounce scan, not the SMTP transport.

### F6 — Gemini: it's *them*, not us — ~88% 503 "high demand", zero quota errors (HIGH / reliability)

**Plain English.** Gemini's own servers were overloaded. Nearly 9 of every 10
requests came back "this model is experiencing high demand" (a Google-side 503),
and **zero** came back as "you're out of quota". So this is not our key, our
billing, or our rate limit — it's Google's capacity problem, which is widely
reported across 2026. A more reliable / cheaper model is a legitimate move.

**Evidence.**

- In the captured log buffer: **120 Gemini call attempts, 106 `FAILED
  status=503`, 0 `FAILED status=429`.** RPD usage was only ~60/1000 — nowhere near
  our own budget.
- The literal upstream message:
  `[503 Service Unavailable] This model is currently experiencing high demand.
  Spikes in demand are usually temporary. Please try again later.` on
  `gemini-2.5-flash:generateContent` (both compose and verify).
- Our classification is correct to *not* pause on these: 503 ≠ 429
  `RESOURCE_EXHAUSTED`, so `GeminiProviderExhausted` does not fire
  (`geminiRateLimiter.ts:296`) — but 503 *is* retryable (`:96-100`), so the
  storm burns the whole retry budget per call and, combined with single-slot
  serialization, is what set up the F1 wedge.
- External (2026): Gemini 503 "model overloaded / high demand" is a known
  structural issue, with reported peak error rates up to ~45%, recommended
  mitigation = exponential backoff or **switch to a steadier model** (gemini-2.5
  recovers fastest, but here even 2.5-flash was saturated).

**Candidate cheaper/free alternatives for *short multilingual cold-email JSON
generation* (this task only — vision stays Gemini).**

| Option | Free quota (2026) | Latency | Fit for `{subject, body}` JSON, ES/EN | Integration cost | Quality tradeoff |
|---|---|---|---|---|---|
| **NVIDIA NIM** (DeepSeek-V4-Flash, Kimi K2.5/K2.6, Nemotron-3) | 1000 credits on signup, free plan indefinite, ~40 RPM global | ~600–1500ms first token, 30–90 tok/s | Strong; OpenAI-compatible `/v1/chat/completions`, big-context models | **Low** — one base-URL + model-string change via OpenAI SDK | Frontier-class models; main risk is the shared 40 RPM ceiling under batch concurrency |
| **Ollama Cloud free** | Session limit / 5h + weekly GPU-time limits, 1 concurrent model, 6 free models | Varies by model/load | OK with JSON-schema structured outputs (Qwen2.5 multilingual, Hermes 2 Pro) | Low — OpenAI-compatible | Free tier quota is GPU-time-metered and small; fine as fallback, risky as primary |
| **opencode / Go-hosted models** | Varies | Varies | Untested for this task | Medium | Unverified — would need its own probe |
| **Stay on Gemini, add a reliable fallback chain** | n/a | n/a | n/a | Lowest | None — but doesn't escape Google capacity |

**Severity.** HIGH (reliability) — the provider instability is the upstream
trigger for F1 and the source of wasted compute.

**Proposed direction (not a fix).** Short-term: harden against the storm
(circuit-breaker / quarantine already exists for the composer at
`COMPOSE_503_QUARANTINE_MINUTES`; extend the same to the verifier, and bound the
retry storm). Medium-term: add **NVIDIA NIM as a provider option** for the
compose/verify text task behind the existing model-setting (`GEMINI_MODEL`
abstraction → a provider field), keeping Gemini for vision. **Tradeoff to surface
explicitly:** a model swap changes email *voice/quality* — must be A/B-read on
real Spanish (usted) + English drafts against the current `gemini-2.5-flash`
output before committing, and the verifier's fact-check strictness must be
re-validated on the new model so claim-grounding doesn't regress.

### F7 — Scroll clipping: Explorer right column / table wrapper miss `min-height:0` (MED / UX)

**Plain English.** Same family of bug as the one we fixed for the Outreach page
(slice 0018), but in a different container that 0018 never touched. When a tall
piece of chrome appears above the content (the active-runs banner, or just enough
filter chips), the Explorer's table can't shrink to fit, so its bottom — the
pagination and last rows — falls below the screen with no scrollbar to reach it.

**Evidence.**

- `BusinessExplorer.tsx:176` root is correct (`height:100%; overflow:hidden`),
  and `BusinessTable.tsx:136-137,330` is internally correct (flex column,
  `flex:1; overflowY:auto` scroll region, `flexShrink:0` footer).
- But the two flex containers between them omit `min-height:0`:
  `BusinessExplorer.tsx:196` (the right column, `flex:1; overflow:hidden;
  display:flex; flexDirection:column` — **no `minHeight:0`**) and `:262` (the
  table wrapper, `flex:1; overflow:hidden` — **no `minHeight:0`**). A flex item
  defaults to `min-height:auto` and refuses to shrink below its content, so the
  `flex:1` table is sized to its content height, overflows the viewport, and the
  ancestor `overflow:hidden` clips the bottom.
- Slice 0018 fixed this exact mechanism but **only in `Outreach.tsx`** (its "Out
  of scope" explicitly excluded other views). Outreach's columns *do* carry
  `minHeight:0` (`Outreach.tsx:514,524`); Explorer's do not — so this is a
  **sibling regression**, not a re-break of 0018.

**Severity.** MED (UX) — recurring operator pain, low-risk fix.

**Proposed direction (not a fix).** Add `minHeight:0` to `BusinessExplorer.tsx`
:196 and :262 (mirror the Outreach fix). Then audit every other top-level view's
flex chain once so "add a function → lose the scroll" stops recurring.

---

## Recommended next slices (ranked)

The operator picks which to ship. Effort is rough; prerequisites noted.

1. **`0023-batch-compose-timeout-and-watchdog`** — *Stop the prepare batch from
   freezing.* Wrap the compose stage in a per-item `withTimeout` (mirror analyze)
   + add a run-level stall watchdog that fails/pauses a run with no progress in N
   min. **Impact:** eliminates the #1 reliability symptom; makes batch time
   bounded ("factory"). **Effort:** S. **Prereq:** none. *Directly fixes F1.*

2. **`0024-validity-gate-microsoft-rejectall-fix`** — *Stop throwing out real
   corporate emails.* Apply catch-all symmetry to the `5xx` branch (reject-all MX
   → `unknown`, proceed) and/or treat Outlook-protection MX as probe-unreliable.
   **Impact:** recovers a large slice of M365 leads (Garrafa, LIFT, etc.) without
   weakening the gate. **Effort:** S. **Prereq:** none. *Fixes F2.*

3. **`0025-best-reachable-email-selection`** — *Send to the right address, not
   just the first.* Choose the best single send-target per lead from all
   available emails by validity rank; never multi-send to one company. **Impact:**
   recovers ~11% multi-email leads. **Effort:** S–M. **Prereq:** 0024 (validity
   signal must be trustworthy first). *Fixes F3.*

4. **`0014-reply-visibility-and-reclassification`** *(already on ROADMAP, promote)*
   — *See the replies that already exist.* Surface the 9 hidden replies + one-tap
   reclassify. **Impact:** directly answers "no replies" fear; highest trust per
   unit effort. **Effort:** M. **Prereq:** none. *Addresses F4.*

5. **`0026-gemini-503-resilience-and-nim-fallback`** — *Make generation survive
   Google's overload.* Extend 503 quarantine to the verifier; add NVIDIA NIM as a
   provider option for compose/verify (vision stays Gemini), behind an A/B
   quality read on real ES/EN drafts. **Impact:** removes the upstream trigger for
   F1 and the wasted compute. **Effort:** M. **Prereq:** 0023 (so a slow provider
   can't re-wedge). **Tradeoff:** voice/verifier-strictness must be validated —
   flagged, not hidden. *Addresses F6.*

6. **`0027-second-sender-rotation`** — *Send from both Gmail accounts.* Senders
   list + per-sender 24h cap + sender persisted per send + dual-inbox reply/bounce
   scan, with a documented warmup ramp. **Impact:** ~2× safe daily volume
   *after warmup*. **Effort:** M–L. **Prereq:** operator generates the App
   Password (see F5); best after 0014 so reply attribution per sender is visible.
   *Fixes F5.*

7. **`0028-explorer-scroll-clip-fix`** — *Reach the bottom of the Explorer list.*
   Add `minHeight:0` to the two Explorer flex containers; audit other views once.
   **Impact:** removes recurring UX pain. **Effort:** XS. **Prereq:** none.
   *Fixes F7.* (Could be folded into a routine UI pass.)

**Suggested order:** 0023 → 0024 → 0028 (the three smallest, highest-certainty
reliability/UX fixes) → 0014 → 0025 → 0026 → 0027.

## Open questions for the operator

1. **Second-sender auth (F5):** App Password (matches current setup, needs 2FA on
   the new account) — OK to go this route, or do you want OAuth2? *App Password is
   recommended.*
2. **Model swap (F6):** acceptable to A/B a free NVIDIA NIM model (e.g.
   DeepSeek-V4-Flash / Kimi K2.5) for compose+verify and adopt it **only if** the
   Spanish (usted) + English drafts read as well as today's Gemini output? Any
   model that reads worse stays off — confirm that bar.
3. **Daily volume (F5):** the "100/day across 2 accounts" target needs a warmup
   ramp (start ~5–10/day/inbox, scale over 2–4 weeks). OK to pace into it rather
   than switch it on at 100/day?

---

## Implementation plan

_N/A — diagnosis slice. No edits. The deliverable is the Findings + Recommended
next slices above._

## Verification gate

_Evidence captured DURING this diagnosis (2026-06-24, live dev stack):_

- [x] SQL: stalled run `b2b21677` `processed=8/15`, 6 items frozen `composing`
      ~47 min before `user_canceled`.
- [x] Log: last line `compose call #120 … attempt#3 FAILED status=503` @
      14:37:39, then 40 min of only scheduler ticks; no restart.
- [x] Log count: 120 Gemini attempts, **106× 503, 0× 429**.
- [x] Live SMTP probe: `jcgarrafa@bariloche.com.ar` & `info@lift-am.com` → M365
      MX, RCPT **550 real + 550 random** (reject-all) ⇒ false `invalid`;
      `svittordev@gmail.com` → 250 valid.
- [x] SQL: 681 emailed leads, **74 with >1 email**; sends 200 sent / 4 bounced;
      **9 replied** / 248 contacted.
- [x] Code: `batchOrchestrator.ts:154` compose has no `withTimeout` (analyze
      `:118` does); `geminiRateLimiter.ts:39` `maxConcurrent:1`;
      `emailVerifier.ts:126` 5xx→invalid before catch-all symmetry;
      `db/index.ts:552` `[0]`-only target; `emailSender.ts:37-45,87` single
      sender; `outreachGovernor.ts:57-59` global cap; `BusinessExplorer.tsx:196,262`
      missing `minHeight:0`.
- [x] No scratch files committed (probe ran inline in the server container and
      was discarded).

## Completion record

- Commit SHAs: _(diagnosis doc only — operator to review/commit)_
- What changed: added this diagnosis slice; no code touched.
- Follow-ups: 7 ranked slices above (`0023`–`0028` + promote `0014`); to be added
  to `docs/ROADMAP.md` when the operator picks the order.

## Sources

- Gmail warmup / caps / reputation: [MailReach](https://www.mailreach.co/blog/gmail-warmup),
  [Instantly](https://instantly.ai/blog/how-to-achieve-90-cold-email-deliverability-in-2025/),
  [UnifyGTM](https://www.unifygtm.com/explore/cold-email-2026-domain-setup-deliverability-sequences),
  [Amplemarket](https://www.amplemarket.com/blog/email-deliverability-guide-2026).
- SMTP 550 / Microsoft 365 reject behavior: [Microsoft Support](https://support.microsoft.com/en-us/office/i-receive-a-550-553-or-relay-prohibited-error-when-sending-email-messages-65b494a4-0a15-433e-829f-e73651e0245e),
  [Microsoft Learn (NDR 550)](https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/fix-error-code-550-5-1-0-in-exchange-online),
  [GlockApps](https://glockapps.com/blog/whats-causing-the-550-smtp-error-and-how-to-fix-it/).
- Inbox rotation / multi-sender / multi-contact risk: [DitLead](https://ditlead.com/blog/what-is-sender-rotation-and-why-you-need-it),
  [Mailshake](https://mailshake.com/blog/email-rotation/),
  [Clay (B2B deliverability)](https://www.clay.com/blog/b2b-cold-email-deliverability).
- Gemini 503 "high demand" 2026: [Google AI Dev Forum](https://discuss.ai.google.dev/t/503-this-model-is-currently-experiencing-high-demand-spikes-in-demand-are-usually-temporary-please-try-again-later/138664),
  [LaoZhang AI](https://blog.laozhang.ai/en/posts/fix-gemini-3-pro-image-503-overloaded).
- NVIDIA NIM free tier: [decodethefuture](https://decodethefuture.org/en/nvidia-nim-api-explained/),
  [freellm.net](https://freellm.net/providers/nvidia-nim).
- Ollama Cloud free tier: [DEV](https://dev.to/amareswer/ollama-cloud-free-vs-pro-usage-limits-pricing-what-you-actually-get-2026-3ieo),
  [freellm.net](https://freellm.net/providers/ollama-cloud).
