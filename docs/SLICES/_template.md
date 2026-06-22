# Slice NNNN: <name>

## Intent

One paragraph: what this slice delivers and why. Trace it to a ROADMAP entry.

## Out of scope

What this slice explicitly does NOT touch. Prevents scope creep.

## Constraints

Which `docs/SPEC.md` invariants apply here. Link them, don't restate. Example:
"additive schema only", "reuse `composeVerifiedEmail` — do not reimplement",
"dry-run records a `dryrun` row".

## Diagnose-first checklist

Done BEFORE any edit. The operator approves the implementation plan before edits
begin.

- [ ] Files to read: …
- [ ] Symbols to catalog (functions, columns, env vars, routes): …
- [ ] Online topics to research: …
- [ ] Open questions for the operator: …

## Implementation plan

_Filled in by Claude Code AFTER diagnosis. Operator approves before edits._

- Step 1 — … (verify by: …)
- Step 2 — … (verify by: …)

## Verification gate

_Filled in DURING execution with live evidence — not after, not assertions._

- [ ] SQL: `…` → rows: …
- [ ] curl: `…` → response: …
- [ ] Log line: `…`
- [ ] Screenshot: …
- [ ] `npx tsc --noEmit` clean (server in container)

## Completion record

- Commit SHAs: …
- What changed: …
- Follow-ups / new parked items: …
