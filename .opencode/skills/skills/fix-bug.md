# fix-bug

Workflow for bug fixes. Follow in order. Do not skip steps.

## Before Touching Anything

1. Read `CLAUDE.md`. Project conventions live there. Do this first, every time.
2. If the fix will touch more than one file, run `/plan` before writing code.

## Diagnose Before Fixing

1. Find the root cause. State it explicitly before writing any code:
   > Root cause: [one or two sentences explaining why the bug happens, not what it looks like]

   Do not fix symptoms. If you cannot articulate the root cause, keep investigating.

2. **SSE bugs:** check all three layers in order before concluding where the break is:
   server emit → stream flush → frontend handler.
   Most "frontend" SSE bugs are one of the other two.

## Scope Discipline

1. Touch only files directly involved in the stated bug.
2. Do not clean up unrelated code, reformat, or "improve" things noticed in passing. Note them for the final report instead.
3. Never revert a fix from a previous session without flagging it explicitly and explaining why the previous fix was wrong.

## Commit

One commit only. Message format: `fix: [short description]`

## Verify Before Reporting Done

Run both lint checks from repo root. Both must pass:

```bash
npm -w client run lint && npm -w server run lint
```

Do not report the bug fixed if either fails.

## Report

End with:

- **Root cause:** ...
- **Files changed:** ...
- **Lines changed:** +X / -Y
- **Verified by:** ...
- **Noticed but not touched:** ... (or none)