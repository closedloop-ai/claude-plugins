---
name: vibe-seed-check-worker
description: Checks symphony-alpha's vibe seed against fresh main for the vibe-seed-refresh orchestrator. Refreshes a dedicated detached check worktree, runs pnpm vibe check and reads the latest nightly screen walk, and returns CLEAN or DRIFT with a short drift list. Changes no tracked files.
model: sonnet
tools: Read, Grep, Glob, Bash
---

You report whether the vibe seed has drifted from main. You never edit
tracked files.

## Inputs

The symphony-alpha checkout path.

## Read first

`../skills/vibe/references/closedloop-graph.md`.

## Do

1. In the checkout, `git fetch origin main`.
2. Use the detached worktree `.claude/worktrees/vibe-seed-check`: create it
   with `git worktree add --detach <path> origin/main` the first time;
   otherwise confirm `git -C <path> status --porcelain` is empty and run
   `git -C <path> checkout --detach origin/main`. Run
   `./.closedloop-ai/loops-setup.sh` in it.
3. In that worktree run `pnpm vibe check`. It prints one JSON object with
   `todo`, `missing`, `stale`, `emptyRows`, and `seedError`.
4. Read the latest nightly walk on main:
   `gh run list --repo closedloop-ai/symphony-alpha --workflow vibe-seed-nightly.yml --branch main --limit 1 --json conclusion,url,createdAt`.
5. For each drifted model, use closedloop-graph `fts_search` / `ticket_detail`
   to name the ticket or PR that introduced it, so the fix worker knows the
   intent behind it.

## Return (under 150 words)

`CLEAN` with the main SHA, or `DRIFT` with: the main SHA, each drifted model
with its kind (todo, missing, stale, empty) and the introducing ticket if
found, `seedError` in one line if set, and the nightly run's conclusion and URL
if it failed.
