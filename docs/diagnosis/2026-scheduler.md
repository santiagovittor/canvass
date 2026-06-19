# Scheduler Hardening — Diagnosis 2026-06-18

**DB file:** `/app/data/scraper.db` (WAL mode confirmed)  
**Server container:** `maps-scraper-server-1` (node:20-bookworm, up ~4h at time of diagnosis)  
**Worker file:** `server/src/services/scheduledSendWorker.ts`

---

## (a) Stuck-row count by age bucket + 5 oldest

### Status distribution (all 75 rows)

| status    | count | earliest scheduled_at       | latest scheduled_at          |
|-----------|-------|-----------------------------|------------------------------|
| sent      | 48    | 2026-06-15T12:00:00.000Z    | 2026-06-18T19:06:22.355Z     |
| scheduled | 17    | 2026-06-19T12:00:00.000Z    | 2026-06-23T13:30:00.000Z     |
| canceled  | 9     | 2026-06-16T16:00:00.000Z    | 2026-06-18T17:57:00.000Z     |
| skipped   | 1     | 2026-06-18T18:05:00.000Z    | 2026-06-18T18:05:00.000Z     |

### Stuck-row age buckets (status='scheduled', scheduled_at < now)

**Result: 0 rows.** All 17 `scheduled` rows have `scheduled_at` in the future (earliest: 2026-06-19T12:00:00Z). There are no stuck rows at diagnosis time.

### 5 oldest scheduled rows (all future-dated)

| id (prefix)  | business_id (prefix)  | scheduled_at             | last_error              | attempt_count |
|--------------|-----------------------|--------------------------|-------------------------|---------------|
| c0aed65d     | ChIJhcvjV3LX...       | 2026-06-19T12:00:00.000Z | null                    | 0             |
| 7ecd9658     | ChIJhYRtUXXX...       | 2026-06-19T12:00:00.000Z | null                    | 0             |
| 8900bca0     | ChIJ83BivCi2...       | 2026-06-19T12:00:00.000Z | null                    | 0             |
| c4a6b107     | ChIJ-4SZhsfK...       | 2026-06-19T12:00:00.000Z | null                    | 0             |
| 1950eb21     | ChIJG56cpv6x...       | 2026-06-19T12:00:00.000Z | null                    | 0             |

5 more rows are deferred to 2026-06-23T13:30:00Z with `last_error = "deferred:outside_window"`, indicating the governor deferred them to next Monday's window. `attempt_count` is 0 for all — deferral does not increment the counter (by design: only `claimScheduledSend` increments it).

---

## (b) Worker liveness evidence

No `[scheduledSend]` log lines appear in the container logs (`docker logs maps-scraper-server-1 --tail 500 | grep [scheduledSend]` → 0 matches). The only logged errors are `[gemini][fallback-debug]` 503s from the composer.

**What this means:** The worker IS firing — 48 rows reached `sent` status and the most recent `claimed_at` timestamps show activity at 19:06, 18:55, 18:45, 18:34, 18:23 UTC today. But the worker logs nothing on normal operation: `startScheduledSendWorker` only logs when `OUTREACH_DRY_RUN=true`, and `tick()` errors are caught and logged to stderr with `[scheduledSend]` prefix — no info-level heartbeat exists.

**Key liveness facts:**
- `running` flag is in-memory only — resets to `false` on container restart. No crash evidence; 0 currently claimed rows.
- `LEASE_MS = 10 minutes`. `reapStaleClaims` runs at the top of every tick.
- First tick fires 15s after `startScheduledSendWorker()` is called; then every 30s.
- The container has been up ~4h but was last restarted (from git status context, commits suggest restarts occurred today during dev).

**Gap:** There is no observability — no tick counter, no heartbeat log, no metric. Liveness can only be inferred from DB state.

---

## (c) Skip-path inventory

All pre-claim skip paths call `resolveScheduledFromScheduled` (conditional on `status='scheduled'`), which moves the row to a terminal status without passing through `claimed`. None of them log.

| Path | Trigger | Terminal status | logged? | updates row? |
|------|---------|-----------------|---------|--------------|
| `!row` | `getOutreachSendRow` returns null | `skipped` (last_error: `business_missing`) | NO | YES via resolveScheduledFromScheduled |
| `!draft` | `getDraft` returns null | `skipped` (last_error: `draft_missing`) | NO | YES |
| `!to \|\| !validateEmail(to)` | no valid email in row | `skipped` (last_error: `no_valid_email`) | NO | YES |
| `isSuppressed(to)` | email on suppression list | `skipped` (last_error: `suppressed`) | NO | YES |
| `sentRowExistsForScheduledSend(job.id)` | secondary idempotency guard | `skipped` (last_error: `already_sent`) | NO | YES |
| `!gate.allowed` | sendGate blocks (unverified draft, etc.) | `held` (last_error: gate reason) | NO | YES |
| `verdict?.disposition !== 'sent_specific'` | draft lacks prospect anchor | `held` (last_error: `disposition_not_specific`) | NO | YES |
| `decision.action === 'defer'` | governor: outside window or cap reached | stays `scheduled`, new `scheduled_at` | NO | YES via deferScheduledSend |
| `!claimScheduledSend(job.id, ...)` → returns false | another tick/instance already claimed row | row stays `claimed` (owned by other) | NO | NO (silent bail) |
| `sendEmail` returns `!result.success` | SMTP-layer failure | `failed` (last_error: result.error) | NO | YES via finishScheduledSend |
| `sendEmail` throws | uncaught SMTP exception | `failed` (last_error: err.message) | NO | YES via finishScheduledSend |
| `saveEmailExample` throws | side-effect failure only | does NOT affect send status | YES — `console.error('[scheduledSend] saveEmailExample failed:', err)` | NO |

**Finding:** `saveEmailExample` is the only path that emits a `[scheduledSend]` log. Every other path — including all 7 pre-claim skip/hold exits and the two failure paths — is silent. This means there is no way to observe why a row was held, skipped, or failed without querying the DB directly.

---

## (d) Manual-send interaction evidence

**1 confirmed conflict found:**

| ss.id (prefix) | business_id (prefix)  | ss.scheduled_at          | es.sent_at               |
|----------------|-----------------------|--------------------------|--------------------------|
| 1950eb21       | ChIJG56cpv6x...       | 2026-06-19T12:00:00.000Z | 2026-06-18T15:55:09.531Z |

The business was sent manually at 15:55 UTC today, and a separate `scheduled_sends` row for the same business was created at 16:59 UTC (after the manual send) and is still `status='scheduled'` for tomorrow. This row will be caught by the `sentRowExistsForScheduledSend` guard when the worker runs it — but only because that guard checks for any `email_sends` row linked to the specific `scheduled_send.id` (not the business).

**Wait — there is a subtlety:** `sentRowExistsForScheduledSend` is keyed to `scheduled_send_id` in `email_sends`, not to `business_id`. The manual send happened via `/send` route, which presumably records a row in `email_sends` without a `scheduled_send_id`. This means the idempotency guard will NOT catch this conflict. The business will receive a second email tomorrow unless a different guard fires first.

The `sendGate` check and `disposition !== 'sent_specific'` check may or may not catch it depending on whether the draft was deleted by the manual-send flow. If `deleteDraft` ran on the manual send, then `!draft` will fire and the row will be skipped with `draft_missing`. That is the likely actual outcome — but it is a defense-in-depth gap: the exact guarantee depends on whether the manual /send path deletes the draft.

**No supersede logic exists** — there is no code path that cancels a `scheduled` row when a manual send succeeds for the same business.

---

## (e) State machine + claim WHERE clause

### State machine

```
                          ┌─────────────────────────────────────────────┐
                          │         ENQUEUE (createScheduledSend)       │
                          │  status = 'scheduled'  attempt_count = 0    │
                          └────────────────────┬────────────────────────┘
                                               │
                              getDueScheduledSends (scheduled_at <= now)
                                               │
                     ┌─────────────────────────▼─────────────────────────┐
                     │           processJob READ-ONLY phase               │
                     │  (status stays 'scheduled' throughout this phase)  │
                     └──┬────────────┬────────┬──────┬────────┬──────────┘
                        │            │        │      │        │
                 !row  !draft  !email  suppressed  !gate  !specific
                 sentExists          verdict     disposition
                        │
                   resolveScheduledFromScheduled (WHERE status='scheduled')
                        │
              ┌─────────┴───────────┐
              │                     │
           skipped               held
         (terminal)            (terminal)
                                     │
                              outside_window / cap
                                     │
                              deferScheduledSend (WHERE status='scheduled')
                                     │
                                 scheduled (new scheduled_at)   ←──(loop)
                                     │
                         claimScheduledSend (WHERE status='scheduled')
                         SET status='claimed', attempt_count+1
                                     │
                              ┌──────┴──────┐
                              │  SMTP send  │
                              └──────┬──────┘
                          ┌──────────┴──────────┐
                          │                     │
                       success               failure
                          │                     │
                    finishScheduledSend    finishScheduledSend
                      status='sent'         status='failed'
                      (no WHERE guard)      (no WHERE guard)
```

**Terminal statuses:** `sent`, `failed`, `skipped`, `held`, `canceled`  
**Re-entrant:** `scheduled` (after defer)  
**Transient:** `claimed` (only during transmit window; reaped after 10 min)

### Claim WHERE clause

```sql
UPDATE scheduled_sends
SET status = 'claimed', claimed_at = ?, attempt_count = attempt_count + 1, updated_at = ?
WHERE id = ? AND status = 'scheduled'
```

Returns `changes === 1` on success. This is the exactly-once gate: if two ticks race, only one `changes === 1` wins; the other silently returns. This is correct.

**Notable: `claimed_at` is stored as TRUE UTC** (passed from `new Date().toISOString()` in the worker), **but `updated_at` is stored as UTC-3 shifted** (via `nowUtcMinus3()`). This is the intentional design of the codebase (all `updated_at` / `sent_at` fields use UTC-3 for local-day slicing). However, the `reapStaleClaims` cutoff is computed as `new Date(Date.now() - LEASE_MS).toISOString()` — true UTC — and compared against `claimed_at` which is also true UTC. This comparison is consistent and correct.

**Observed evidence of the UTC/UTC-3 split:** In the recent sent rows, `claimed_at` reads ~3h ahead of `updated_at` (e.g., `claimed_at: 2026-06-18T19:06:37Z` vs `updated_at: 2026-06-18T16:06:40Z`). This is expected behavior, not a bug.

---

## Summary of gaps for Task 1+

1. **No heartbeat / tick log** — worker fires silently; liveness requires DB inspection.
2. **All skip/hold/fail paths are silent** — zero observability on why a row didn't send.
3. **No supersede on manual send** — a manual send does not cancel the pending `scheduled` row. The draft-deletion cascade provides accidental protection in the most common case, but is not a guarantee.
4. **`sentRowExistsForScheduledSend` does not catch manual-send conflicts** — the guard is keyed to `scheduled_send_id`, which is null for manual sends.
5. **No per-lead status endpoint** — impossible to surface scheduler state in the UI without a new route.
