# new-feature

Workflow for implementing a new feature. Follow in order. No steps are optional.

## 1. Read Context First

Read `CLAUDE.md` before doing anything else. If it contradicts anything below,
flag it and stop.

## 2. Plan

Invoke `/plan`. Always. Features never skip planning regardless of perceived size.

## 3. Propose, Then Wait

Write the implementation approach as a proposal. Include:

- Files you will touch and why
- Data flow changes
- Explicit callout if the SSE pipeline is involved — this is the most fragile
  part of the system. Name which streams, which events, and what could break.
- Any new npm dependency, with justification for why the existing stack cannot
  do the job. Check `package.json` in both workspaces first. Default answer: no.

**Stop. Wait for explicit approval. Do not write code on implied consent.**

## 4. Simpler-Path Check

This is a personal internal tool. Before proposing the full implementation, ask:
is there a version that covers ~90% of the use case in ~20% of the code?
If yes, propose that first. Gold-plating is waste.

## 5. Implement Within Scope

Touch only files required for the feature. No drive-by refactors, no formatting
changes in unrelated files, no "while I was here" fixes. Note them for the
final report instead.

## 6. Commit Discipline

One commit per logical unit. Message format: `feat: [short description]`

No batching unrelated changes. No `wip` or `misc` messages.

## 7. Verify Before Reporting

Run both from repo root. Both must pass:

```bash
npm -w client run lint && npm -w server run lint
```

Do not report done on a red tree.

## 8. Final Report

- **Built:** what now works, with the entry point to try it
- **Excluded:** what was deliberately left out and why
- **Noticed:** follow-on issues or bugs spotted but not touched

Keep it short. Facts, not narrative.