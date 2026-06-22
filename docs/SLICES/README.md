# Slice workflow

One vertical slice at a time. To start a new slice, copy `_template.md` to
`NNNN-name.md` (next ID from `docs/ROADMAP.md`), fill in **Intent**, **Out of
scope**, and the **Diagnose-first checklist**, then run Claude Code with:
"implement docs/SLICES/NNNN-name.md, diagnose-first, stop before edits for
approval." Claude diagnoses, proposes an implementation plan for your approval,
then executes — filling the **Verification gate** with live evidence during the
work and the **Completion record** at the end. Invariants and the reuse-only
registry it must honor live in `docs/SPEC.md`.
