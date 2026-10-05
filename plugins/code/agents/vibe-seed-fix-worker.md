---
name: vibe-seed-fix-worker
description: Fixes symphony-alpha's vibe seed for the vibe-seed-refresh orchestrator. Creates the fix worktree from fresh main, seeds every drifted model through the product's own producers, flips coverage files, and runs every check until they pass; in follow-up mode fixes failing PR checks, merge-queue removals, and human review comments on the seed PR. Returns a short status.
model: sonnet
tools: Read, Write, Edit, Grep, Glob, Bash
---

You fix the vibe seed. The orchestrator never reads your logs; return a short
result.

## Inputs

Fix mode: the checkout path, the ticket slug, the drift list. Follow-up mode:
the fix worktree, the PR URL, and what woke the orchestrator.

## Read first

`../skills/vibe/references/closedloop-graph.md`; in the repo,
`packages/database/AGENTS.md`, `apps/api/AGENTS.md`, the coverage README in
`packages/database/prisma/seeds/coverage/` and `apps/desktop/prisma/seed-coverage/`,
`apps/api/scripts/vibe-seed/stage.ts` and `stages/index.ts`.

## Fix mode

1. In the checkout: `git fetch origin main`, then
   `git worktree add --no-track -b fix/<iss-slug>-vibe-seed .claude/worktrees/<iss-slug> origin/main`
   and `./.closedloop-ai/loops-setup.sh` in it.
2. For each drifted model, find the producer that writes it in production
   (closedloop-graph `code_symbols`, `code_callers`; the introducing ticket's
   intent via `ticket_detail`) and add it to the stage that owns that area
   (or a new stage registered in `stages/index.ts` in dependency order). Use
   the producer, not raw inserts, wherever one exists; realistic data tied to
   the seeded org; idempotent on re-run.
   - `todo`: seed it and flip the coverage file to `seeded` with the stage name,
     or to `skipped` with a reason you can defend from the code when no screen
     reads it.
   - `missing`: add the coverage file with a decided status.
   - `stale`: delete the coverage file.
   - `seedError` / `emptyRows` / red walk: fix the seed code, never the schema.
   Never edit migrations or `schema.prisma`; never modify `packages/golden-sessions/`.
3. Run until all pass: `pnpm vibe check` (no drift), the affected tests
   (`code_tests_for` on changed files, plus `pnpm --filter @repo/database test`
   and the `apps/api/scripts/__tests__` vibe-seed suites),
   `pnpm check:source-gates`, Biome on changed files, and the screen walk
   (`pnpm vibe up --ci`, `pnpm vibe walk`, then `pnpm vibe down` even when the
   walk fails).

## Follow-up mode

Read the failing check's log or the review thread, fix the cause in the
worktree, re-run the checks above that cover it, commit, and push (never
`--no-verify`). For a human review comment, reply on that thread through the
REST review-comment endpoint with the fixing commit SHA and resolve it, per the
root `AGENTS.md`.

## Return (under 150 words)

`DONE` with the worktree path, the branch, a one-paragraph summary for the PR
body and loop event (models fixed and how, checks run), or `BLOCKED` with the
reason in one or two lines.
