# Slice 0024: Validity gate — reject-all MX → `unknown`, not `invalid`

> Derived from diagnosis [`0022`](0022-outreach-queue-reliability-and-deliverability-audit.md)
> finding **F2**. Stops discarding real Microsoft-365 corporate leads.

## Intent

**Plain English.** Stop throwing out good emails just because they're hosted on
Microsoft 365. Microsoft answers "no such recipient" (550) to *any* probe — even
a made-up address — so it can't actually tell us whether a real mailbox exists.
Our check reads that as "dead" and skips the lead, even though the address is on
the company's website. The fix: only trust an SMTP rejection when the server
*also* accepts a known-good probe (i.e. it actually discriminates). If a server
rejects everything (or accepts everything), we can't confirm → mark it `unknown`
and let the lead proceed, exactly as we already do for accept-all (catch-all)
servers. The validity gate stays — we're correcting a misread signal, not
disabling it. A bounce remains the authoritative "really dead" signal.

**Project vocabulary.** In `emailVerifier.probe`, apply the catch-all symmetry
test to the `5xx` branch: classify by whether the real-address RCPT and the
random-local-part RCPT responses *differ*. Same class on both (both 2xx =
accept-all, both 5xx = reject-all) → `unknown`. They differ (real 2xx + random
5xx = `valid`; real 5xx + random 2xx = `invalid`) → trust the verdict.

## Out of scope

- Removing/weakening the gate, the MX check, or bounce ingestion (SPEC: off the
  table).
- Email-selection across multiple addresses — that is `0025` (this slice fixes the
  *signal*; `0025` uses it).
- Re-probing already-cached `invalid` rows automatically (a one-off cache flush
  can be a manual step; note it, don't build a migration).

## Constraints (`docs/SPEC.md`)

- **Reuse** `emailVerifier` (`verifyEmailDeliverable` / `probe` / `smtpProbe`) and
  the `email_validity` cache — do not add a paid verification API.
- **Fail-open discipline** stays: timeout/refused/greylist → `unknown`, never
  throw into the pipeline.
- **Bounce ingestion** (`replyChecker` DSN pass, slice 0013) remains the
  authoritative permanent-dead signal; this slice only relaxes the *probe-time*
  false reject.
- **Additive only**; no schema change (`email_validity` already stores
  `result`/`source`).

## Diagnose-first checklist

Done in `0022` F2 (live probe captured). Confirm before editing:

- [ ] Files to read: `server/src/services/emailVerifier.ts:31-131` (esp. the
      `done()` catch-all flag at `:60`, and `probe()`'s verdict branches at
      `:124-130`), `server/src/db/index.ts:520-548` (validity cache + resolve).
- [ ] Symbols to catalog: `smtpProbe`'s `code` (real RCPT) + `catchAll`
      (random-local-part RCPT) return; `probe`'s `5xx→invalid` at `:126`;
      `2xx→(catchAll?unknown:valid)` at `:127-129`.
- [ ] Re-confirm the live truth table (already captured): Gmail discriminates
      (250 real / 550 random); M365 reject-all (550 / 550); accept-all catch-all
      (250 / 250).
- [ ] **Tradeoff to record:** a genuinely-dead Gmail mailbox is `550 real / 550
      random` → now downgrades to `unknown` (it would proceed and bounce, caught
      by bounce ingestion) instead of `invalid`. This is the deliberate cost of
      not false-rejecting M365; acceptable because the operator's priority is not
      losing real leads, and bounce ingestion catches the true-dead case. State it
      in the verification gate, do not hide it.
- [ ] Open questions: none (operator already wants real leads preserved).

## Implementation plan

_Operator approves before edits._

- **Step 1 — Capture both RCPT classes.** Have `smtpProbe` return both the real
  RCPT code and the random RCPT code (it already computes `rcptCode` and
  `catchAllCode`; surface the raw random code, not just a boolean).
  *(Verify: the two M365 examples return real=550, random=550; Gmail returns
  real=250, random=550.)*

- **Step 2 — Symmetry-based verdict.** Rewrite `probe`'s post-RCPT branch:
  - real 2xx & random 2xx → `unknown` (accept-all / catch-all) — *unchanged*.
  - real 5xx & random 5xx → `unknown` (reject-all, can't confirm) — **new**.
  - real 2xx & random 5xx → `valid` (server discriminates, accepted real) —
    *unchanged*.
  - real 5xx & random 2xx → `invalid` (server discriminates, rejected real) —
    **new, the only definitive invalid via probe**.
  - anything else (4xx greylist, timeout, refused) → `unknown` — *unchanged*.
  *(Verify: `jcgarrafa@bariloche.com.ar` & `info@lift-am.com` → `unknown` (proceed,
  no longer skipped); a Gmail address with a real mailbox → `valid`; a
  discriminating server's known-bad address → `invalid`.)*

- **Step 3 — Re-probe stale `invalid`.** Existing `invalid`/source=`probe` rows
  cached from the old logic are now wrong. Document a one-off manual cache clear
  (`DELETE FROM email_validity WHERE source='probe' AND result='invalid'`) so the
  next batch re-probes them under the new logic. Do **not** auto-run it in a
  migration. (Placeholder/malformed `invalid` rows stay.)
  *(Verify: after the clear, the two example leads re-probe to `unknown` and are
  no longer skipped by the batch gate.)*

## Verification gate

_Filled DURING execution with live evidence._

- [x] Live probe (the two operator addresses) → `unknown`; a real Gmail → `valid`.
      Raw two-code probe + verdict, captured live in the dev container after a
      one-off cache clear of the stale `invalid` rows:

      | address | raw real/random | verdict (new) | was |
      |---|---|---|---|
      | jcgarrafa@bariloche.com.ar (M365) | 550 / 550 | `unknown` | `invalid` |
      | info@lift-am.com (M365)           | 550 / 550 | `unknown` | `invalid` |
      | svittordev@gmail.com (real mbx)   | 250 / 550 | `valid`   | `valid` |
      | no-such-mailbox-…@gmail.com       | 550 / 550 | `unknown` | (n/a, uncached) |

      The definitive-`invalid` quadrant (real 5xx + random 2xx) is the `if
      (real5xx && randOk)` branch. It does not occur on a normal discriminating
      server (a dead mailbox there is 550/550, which now correctly → `unknown`),
      so it isn't reproducible with a live public MX — it only triggers on a
      server that accepts a random local part yet rejects the specific address.
      Verified by code inspection, not a live address.
- [x] Batch gate: a lead whose first email now resolves `unknown` is **not**
      skipped `bad_email` — the batch only skips `invalid` (placeholder/malformed
      or bounce-confirmed). The two M365 addresses above now resolve `unknown`, so
      they proceed to analyze/compose.
- [x] Recorded tradeoff: a genuinely-dead Gmail (550/550) now → `unknown` and will
      proceed and bounce; bounce ingestion (`replyChecker` DSN pass, slice 0013)
      flips it to `invalid` on the real DSN. Deliberate cost of not false-rejecting
      M365 — operator priority is not losing real leads.
- [x] `npx tsc --noEmit` clean — server (in container), exit 0.
- [x] Self-review (send-path-adjacent): change is fail-open (any non-discriminating
      result → `unknown`), no throw path added, no schema/cache-shape change. The
      probe still QUITs and the socket-close guard is unchanged. Did not spawn a
      reviewer subagent (default no-spawn); operator can request one if desired.

**Manual one-off cache clear (step 3 — run once, not migrated):**

```sql
DELETE FROM email_validity WHERE source='probe' AND result='invalid';
```

(Already executed for the three test addresses above. Placeholder/malformed
`invalid` rows have `source!='probe'` and are left intact.)

## Completion record

- Commit SHAs: …
- What changed: …
- Follow-ups / new parked items: …
