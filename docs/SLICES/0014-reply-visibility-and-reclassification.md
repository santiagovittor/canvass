# Slice 0014: Reply visibility & reclassification

> Derived from diagnosis [`0011`](0011-ux-clarity-and-outreach-audit.md) finding
> **(d)**. Addresses BRIEF symptom 5 (joyeriayvino@gmail.com reply missing from
> "respondieron").

## Intent

**Plain English:** A real reply can go missing from the "Respondieron" list. It
isn't a detection failure — the reply *is* recorded — but if the auto-classifier
guesses "auto-reply," the replies tab hides it completely with no way to say
"no, this was a real person." We saw exactly this: the reply from
joyeriayvino@gmail.com (lead "Aurora Estudio") was detected, marked `auto`, and
hidden. Make auto-classified replies visible (muted) and let the operator
reclassify with one tap; and make the auto-guess less trigger-happy.

**Project vocabulary:** Stop `getRepliedLeads` from hard-excluding
`reply_type='auto'` (`db/index.ts:1357-1360`); render autos as a muted secondary
state with a one-tap `setReplyType('real')` action; soften the velocity
auto-rule in `classifyReply` (`replyChecker.ts:41`) that most likely
false-positives a fast human reply.

## Out of scope

- Reply *threading* / showing message bodies (parked item — not here).
- Changing how replies are detected/matched (`replyChecker` IMAP match by sender
  address stays).
- Auto-reply *suppression* of follow-ups — already handled
  (`getFollowUpLeads` intentionally keeps auto-replied leads owing a follow-up,
  `db/index.ts:1285-1288`); don't disturb it.

## Constraints (`docs/SPEC.md`)

- **Additive only.** No schema change strictly required; if a "manually
  reclassified" provenance is wanted, add an additive column — don't repurpose
  `reply_type`'s existing values destructively.
- **Reuse** `setReplyType` (`db/index.ts:1489-1496`) — it already updates
  `reply_type`; expose it via a route rather than writing new SQL.
- **SSE only** for any live update (`email:replied` already exists,
  `replyChecker.ts:104`).
- **Auto-reply must still be excluded from the response *rate*** (SPEC pipeline:
  "auto-replies excluded from response rate") — visibility ≠ counting it as
  engagement. Keep the rate honest.

## Diagnose-first checklist

- [ ] Files to read: `server/src/db/index.ts:1348-1400` (`getRepliedLeads`),
      `:1480-1496` (`markReplied`, `setReplyType`),
      `server/src/services/replyChecker.ts:27-47` (`classifyReply`),
      `client/src/components/Outreach/LeadQueue.tsx:531-554` (replied render),
      `:222-224` (Respondieron pill), `server/src/routes/outreachQueue.ts`
      (where a reclassify route would live), `client/src/lib/outreachApi.ts`.
- [ ] Symbols to catalog: `reply_type` value set (`'auto'|'real'|'unknown'`),
      `RepliedLead` shape, the `email:replied` SSE consumer
      (`Outreach.tsx:402-405`), response-rate computation (confirm it filters
      auto so visibility change doesn't inflate it).
- [ ] Measure (scratch SQL, discard): confirm current split (diagnosis found
      `auto=5, real=3`); list the auto-classified names so the operator can spot
      any other real reply currently hidden.
- [ ] Online topics: none new — heuristic tuning is internal. (Auto-reply
      detection background already in `0011`.)
- [ ] Open questions: should reclassify be `auto → real` only, or also let the
      operator mark a `real` as `auto` (dismiss noise)? Recommend both
      directions, one control.

## Implementation plan

_Draft — operator approves before edits._

- Step 1 — Relax `getRepliedLeads` to include `auto`, returning `reply_type` so
  the client can style it. Keep the **response-rate** query excluding auto.
  *Verify:* "Aurora Estudio" appears in Respondieron.
- Step 2 — Render auto rows muted with a clear "auto-reply" tag and a one-tap
  "Es respuesta real" action; keep real replies visually primary.
  *Verify:* the 5 auto replies show muted; the 3 real show primary.
- Step 3 — `POST /api/outreach/reply-type` (route → db `setReplyType`) for
  operator reclassification; broadcast `email:replied` to refresh live.
  *Verify:* one tap flips Aurora Estudio to "respuesta real" and it restyles
  without reload.
- Step 4 — Soften `classifyReply` velocity rule (`replyChecker.ts:41`): narrow or
  remove the 3–8 min "unknown" / <3 min "auto" window that can catch a fast human
  (keep the header/subject auto-detection, which is reliable). *Verify:* a
  hand-constructed fast human reply (no auto headers) is no longer auto-marked.

## Verification gate

_Filled DURING execution with live evidence (2026-06-23)._

- [x] SQL before: `reply_type` split `auto=5, real=3`. Autos: Estudio I Propiedades,
      FMG Salud - Abogados, ATI Physical Therapy - Scottsdale, Nectar Estudio,
      Aurora Estudio. After Step 1, `GET /api/outreach/replied` returns `total: 8`
      — all 5 autos now listed (Aurora Estudio `[auto]` present).
- [x] Render verified by code + `tsc` (no browser screenshot captured): auto/unknown/null
      rows render muted with an `auto-reply` / `sin clasificar` tag; real rows keep the
      primary green `respuesta real` tag. One reclassify control per row
      (`Es respuesta real` ↔ `Marcar como auto`).
- [x] Network: `POST /api/outreach/reply-type` flips the row live —
      Aurora `auto → real` returned `{"ok":true}`, `GET /replied` then showed
      `reply_type: real`; route `broadcast('email:replied', …)` fires (the
      `Outreach.tsx` consumer already calls `setLeadRefreshTrigger`).
      Validation: bad `replyType` → 400, missing id → 400, unknown id → 404.
- [x] Response-rate honest: `responseRatePct` was **1.2%** with all 5 autos already
      visible (visibility alone did NOT inflate it). `auto → real` raised it to **1.6%**
      (operator-confirmed engagement counts, as intended); revert `real → auto`
      returned it to **1.2%**. State restored to original after testing.
- [x] `npx tsc --noEmit` clean: server (in container) + client (`No errors found`).

## Completion record

- Commit SHAs: _pending (not yet committed)_
- What changed:
  - `server/src/db/index.ts` — `getRepliedLeads` WHERE relaxed to include autos;
    new `reclassifyReply()` (overwrites reply_type in either direction; `setReplyType`
    left intact for the retro-only path).
  - `server/src/routes/outreachQueue.ts` — `POST /reply-type` (validates auto|real,
    404 on missing lead, broadcasts `email:replied`).
  - `client/src/lib/outreachApi.ts` — `setReplyType(businessId, 'auto'|'real')`.
  - `client/src/components/Outreach/LeadQueue.tsx` — muted auto rows + one-tap
    reclassify control (`onReclassify` prop).
  - `client/src/pages/Outreach.tsx` — `handleReclassify` wired to `LeadQueue`.
  - `server/src/services/replyChecker.ts` — dropped the reply-velocity window
    (`<3min→auto`, `3–8min→unknown`); header/subject auto-detection kept. Orphaned
    `lastSentAt` param + `UTC_MINUS_3_OFFSET_MS` import removed.
- Deviation from plan: slice said "reuse `setReplyType`" — its `reply_type IS NULL`
  guard blocks overwriting, so a sibling `reclassifyReply` was added instead (same
  route→db-fn shape, no SQL in routes).
- No schema change (additive provenance column judged unnecessary — rate honesty is
  handled by the existing `analytics.replied()` filter).
- Follow-ups / new parked items: none. Reply threading / message bodies remains parked
  (out of scope, per slice).
