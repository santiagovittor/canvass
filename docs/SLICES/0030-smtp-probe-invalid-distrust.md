# Slice 0030: SMTP-probe `invalid` distrust — stop condemning leads on a single RCPT 5xx

> Direct follow-up to [`0024`](0024-validity-gate-microsoft-rejectall-fix.md).
> 0024 added the catch-all symmetry test and assumed the `real 5xx + random 2xx`
> quadrant "does not occur on a normal discriminating server… verified by code
> inspection, not a live address." Live evidence (2026-06-25) disproves that for
> Microsoft 365: its mail edge (`*.mail.protection.outlook.com`) returns
> **inconsistent** RCPT codes *within a single probe session* under rate/reputation
> throttling, manufacturing exactly that quadrant → a false `invalid` cached 30 days.

## Intent

**Plain English.** We're still throwing out real leads because of an unreliable
SMTP test. When we open port 25 to a company's mail server and ask "does this
mailbox exist?", Microsoft-hosted servers (very common for the law firms / clinics
we target) don't answer honestly from a stranger's IP — they throttle and give
different answers to the same question seconds apart. The current logic, if it sees
the real address rejected (550) but a made-up address accepted (250) in one
session, declares the real address dead. That comparison is not trustworthy on a
probe-hostile provider. The fix: an SMTP rejection alone can no longer condemn an
address. We keep the *positive* signal (a server that cleanly discriminates —
accepts real, rejects random — confirms `valid`), and we keep the two
*authoritative* dead signals: **a non-existent domain (no MX)** and **a real
bounce (DSN)**. Everything ambiguous → `unknown` and the lead proceeds. Then clear
the stale false-`invalid` rows so those leads re-enter the queue.

**Project vocabulary.** In `emailVerifier.probe`'s post-RCPT branch, remove the
`real5xx && randOk → invalid` quadrant — collapse it into `unknown`. After this,
the *only* `invalid` verdicts are: `validateEmail`/`isPlaceholderEmail` rejects
(no network), MX non-existence (`ENOTFOUND`/`ENODATA`/`NXDOMAIN`/empty MX,
`mx_ok=false`), and bounce ingestion (`source='bounce'`). The SMTP probe becomes a
`valid`-only confirmer. Then a documented one-off cache clear of the now-stale
probe-`invalid`/`mx_ok=1` rows (the 0024 manual-clear pattern, narrowed).

## Out of scope

- Removing/weakening the gate, the MX check, or bounce ingestion — SPEC: off the
  table. This narrows *one* probe verdict, nothing else.
- The `valid` positive path (`realOk && rand5xx`) — unchanged; still a trusted
  confirm.
- MX-death `invalid` (e.g. `ctxabogados.com.ar` → `ENOTFOUND` live; correct) —
  untouched. Those rows stay `invalid` and re-probe to `invalid` anyway.
- A paid verification API, retry-for-stability probing, per-provider MX allowlists
  — considered and rejected below; do not build.
- Multi-address selection (`0025`) and the Prepare-lane eligibility work (`0029`) —
  unrelated; this only changes the *signal*, which they consume unchanged.

## Constraints (`docs/SPEC.md`)

- **Reuse** `emailVerifier` (`verifyEmailDeliverable` / `probe` / `smtpProbe`) and
  the `email_validity` cache — no new module, no paid API. One-spot edit in the
  existing verdict branch.
- **Fail-open discipline** stays: timeout/refused/greylist/ambiguous → `unknown`,
  never throw into the pipeline. This change makes the gate *more* fail-open, in line
  with 0024's stated direction.
- **Bounce ingestion** (`replyChecker` DSN pass, slice 0013) remains the
  authoritative permanent-dead signal — this slice leans on it harder, so confirm it
  is still wired (`source='bounce'` rows present in `email_validity`).
- **Additive only**; no schema change (`email_validity` already stores
  `result`/`mx_ok`/`source`). The cache clear is a documented one-off, **not** a
  migration (mirror 0024 step 3).
- **Reviewer subagent on the send path.** `emailVerifier` feeds the batch gate +
  `selectBestEmail` (send-adjacent). Per SPEC convention, a code-review subagent
  pass is available before merge — operator may request; default no-spawn.

## Diagnose-first checklist

**Diagnosis done in the originating session (2026-06-25) — live evidence recorded
below. Operator approves the implementation plan before edits.**

- [x] Files read:
  - `server/src/services/emailVerifier.ts` (whole) — `probe()` verdict branch
    `:131-138`, `verifyEmailDeliverable()` `:141-161`, `selectBestEmail()` `:172-185`.
  - `server/src/services/batchOrchestrator.ts:91-106` — the pre-compose gate; only
    `validity === 'invalid'` is skipped (`skipped_bad_email`).
  - `server/src/db/index.ts` — `email_validity` table `:66-72`, `validateEmail` /
    `isPlaceholderEmail` `:495-515`, `getEmailValidity`/`upsertEmailValidity`
    `:521-537`, `resolveValidity` `:554`, `getEmailValidityMany` `:540`.
  - `server/src/env.ts:70` — `EMAIL_VERIFY_SMTP_PROBE` default `true` (probe is on).
  - `docs/SLICES/0024-…md` — the symmetry test + its (now-falsified) assumption.
- [x] Symbols cataloged:
  - **The branch to change** (`emailVerifier.ts:131-138`):
    ```
    realOk && rand5xx → valid          (keep — trusted confirm)
    real5xx && randOk → invalid        (REMOVE → unknown; this slice)
    else (both-same / 4xx / etc.)→ unknown
    ```
  - **Consumers of the verdict** (all benefit, none break): batch gate
    (`batchOrchestrator.ts:98` skips only `invalid`), `selectBestEmail` ranking
    (`valid>unknown>invalid`), and the Outreach/queue `email_validity` UI badge via
    `resolveValidity` (db). The `valid` path is unchanged; fewer false `invalid`.
  - **Invalid sources after the fix:** `placeholder`/`malformed` (no network),
    MX-death (`mx_ok=false`), `bounce` (DSN). No probe-`invalid`.
- [x] Live evidence captured (dev container, port 25 open):
  - Own-domain (non-freemail) `invalid` rows = **13**: `probe`+`mx_ok=1` ×7 (the
    false negatives), `bounce` ×3 (real, kept), `probe`+`mx_ok=0` ×2 (MX-dead, kept),
    `placeholder` ×1 (kept).
  - The 7 `probe`+`mx_ok=1` are **all** `*.mail.protection.outlook.com` (M365).
    Live re-probe of four returned `{code:550, randomCode:550}` for **every** one —
    i.e. today they classify `unknown` (proceed). Their cached `invalid` came from a
    transient `randomCode` 2xx in the original session. → false negatives, ~7 leads.
  - `estudio@ctxabogados.com.ar` (the operator's example): `invalid`, `mx_ok=0`;
    live DNS `resolveMx('ctxabogados.com.ar') → ENOTFOUND`. Genuinely dead domain —
    correct, NOT a lost lead. (Same: `favilabogados.com`.)
- [x] Open questions — **resolved by operator:** operator approved the recommended
  fix (drop the probe-`invalid` quadrant) and wants the 7 stale M365 rows
  re-validated so they re-enter the queue.

## Why not the alternatives (recorded — do not re-litigate)

- **Re-probe N times for stability before condemning.** More code, still fragile —
  M365's throttling is reputation/time-based, so a "stable" window can flip later;
  and it spends extra port-25 sessions per lead. A signal this unreliable shouldn't
  produce a permanent verdict at all.
- **Per-provider MX allowlist (treat outlook/google edges specially).** A brittle
  hardcoded list that rots; the symptom (probe-hostile shared edge) is not unique to
  Microsoft. Distrusting *all* probe-derived rejection is simpler and provider-blind.
- **Keep it, surface as `unknown` in UI only.** The batch gate keys on `invalid`;
  the leak is at the data layer, not the display. Must fix the verdict.

## Implementation plan

_Proposed — operator approves before edits._

- **Step 1 — Collapse the probe-`invalid` quadrant.** In `emailVerifier.probe`
  (`:131-138`), keep `realOk && rand5xx → valid`; change `real5xx && randOk` to fall
  through to the final `return { result: 'unknown', mxOk: true }`. Update the
  block comment so the next reader knows the SMTP probe is a `valid`-only confirmer
  and why (cite this slice + the M365 inconsistency). MX-death `invalid`
  (`:114-119`) and the `validateEmail` rejects (`:143-145`) are untouched.
  *(verify by: live re-probe — the four M365 addresses → `unknown`; a real Gmail
  (`realOk && rand5xx`) → still `valid`; `ctxabogados.com.ar` → still `invalid` via
  the MX branch, not the probe.)*

- **Step 2 — Re-validate stale probe-`invalid` rows.** Documented one-off cache
  clear (run once in the container; **not** a migration — mirror 0024 step 3),
  narrowed to the SMTP false-negatives so genuinely-dead MX rows and bounces are
  preserved:
  ```sql
  DELETE FROM email_validity WHERE source='probe' AND result='invalid' AND mx_ok=1;
  ```
  The next batch re-probes those addresses under the new logic → `unknown` →
  proceed. (`mx_ok=0` probe rows and `source='bounce'`/`placeholder`/`malformed`
  rows are left intact.)
  *(verify by: after the clear, the 7 M365 leads are absent from
  `email_validity` as `invalid`; a batch over them no longer logs
  `reason=bad_email`; they reach analyze/compose.)*

## Verification gate

_Filled DURING execution with live evidence — not assertions._

- [x] Live two-code probe in the container (throwaway `server/_probe0030.mjs`,
  deleted after — not committed). Output 2026-06-25:
  ```
  estudio@tflvpc.com.ar      code=550 randomCode=550 → unknown
  estudio@auadgraf.com.ar    code=550 randomCode=550 → unknown
  central@valtecsa.com       code=550 randomCode=550 → unknown
  contact@bhsmile.com        code=550 randomCode=550 → unknown
  svittordev@gmail.com       code=250 randomCode=550 → valid
  estudio@ctxabogados.com.ar MX-err=ENOTFOUND        → invalid (MX-death)
  ```
  Four M365 → `unknown` (proceed); real Gmail `realOk && rand5xx` → `valid`
  (positive path intact); `ctxabogados.com.ar` → `invalid` via MX, not the probe.
  (Today the four M365 happen to answer both-550; under the OLD logic the only way
  they reached `invalid` was a transient `randomCode` 2xx — exactly the quadrant
  now removed. The removed quadrant can no longer fire regardless of throttle state.)
- [x] SQL before/after the clear (throwaway `server/_clear0030.mjs`, deleted after).
  `SELECT source, mx_ok, COUNT(*) FROM email_validity WHERE result='invalid' GROUP BY source, mx_ok`:
  ```
  BEFORE: bounce/0→3  placeholder/0→1  probe/0→2  probe/1→7
  DELETED rows: 7
  AFTER:  bounce/0→3  placeholder/0→1  probe/0→2
  ```
  The `probe/1` bucket (7) dropped to 0; `bounce`, `probe/0`, `placeholder` unchanged.
- [x] Batch gate (by construction, not a live batch run): gate skips only
  `validity === 'invalid'` (`batchOrchestrator.ts:99`). The 7 M365 rows are now
  absent from `email_validity` → `verifyEmailDeliverable` re-probes → returns
  `unknown` (proven above) → `validity !== 'invalid'` → no `reason=bad_email` skip;
  item advances to analyze/compose. No expensive full-batch run needed to establish
  this — the gate condition + cleared cache + proven verdict close it.
- [x] Recorded tradeoff (carry 0024's): a genuinely-dead mailbox on a probe-hostile
  provider now → `unknown`, proceeds, and bounces; bounce ingestion flips it to
  `invalid` on the real DSN. Deliberate — operator priority is not losing real leads.
- [x] `npx tsc --noEmit` clean — server in the container, exit 0.
- [x] Self-review (send-path-adjacent): change is fail-open (the removed quadrant
  becomes `unknown`), no new throw path, no schema/cache-shape change, probe still
  QUITs + socket-close guard unchanged. Two now-unused locals (`real5xx`, `randOk`)
  removed; file-top summary comment updated to match. Reviewer subagent not spawned
  (default no-spawn; operator did not request).

## Completion record

- Commit SHAs: _(this commit)_
- What changed: `emailVerifier.ts` — removed the `real5xx && randOk → invalid`
  probe quadrant; the SMTP probe is now a `valid`-only confirmer. Everything that
  isn't a clean accept-real/reject-random discrimination → `unknown` and proceeds.
  Removed the two locals that branch used; updated the file-top + branch comments.
  One-off cache clear (`DELETE … source='probe' AND result='invalid' AND mx_ok=1`)
  ran in the dev container, removing 7 stale false-`invalid` M365 rows. No schema
  change, no new module, no dep.
- Follow-ups / new parked items: none. Authoritative dead signals (MX non-existence,
  bounce DSN) unchanged; if a probe-hostile dead mailbox slips through it is caught
  by bounce ingestion on the real DSN, as designed.
