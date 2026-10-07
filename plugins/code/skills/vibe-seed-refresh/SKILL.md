---
name: vibe-seed-refresh
description: Keep symphony-alpha's vibe seed (the throwaway, fully seeded data behind `just vibe-up` and the vibe skill's seeded Vercel environments) in step with main. Checks fresh main for seed drift (models marked todo, models with no coverage file, a failing seed, a red Vibe Seed Walk run on main); when drift exists it creates a ClosedLoop ticket and marks it IN_PROGRESS, has workers fix the seed in a fresh worktree and open a PR, monitors it with gh-monitor-pr until green, enables auto-merge into the merge queue, keeps monitoring until it merges, then marks the ticket DONE. Built for Codex Desktop. Use when asked to "refresh the vibe seed", "check the seed", "update the seeded db", or on a schedule.
---

# Vibe seed refresh

The vibe seed fills a throwaway database and Desktop profile from code in
symphony-alpha: locally for `just vibe-up`, and in each seeded vibe session's
Vercel environment. Every Prisma model has a coverage file saying whether the
seed fills it (`seeded`), deliberately leaves it empty (`skipped`, with a
reason), or still owes it data (`todo`). Engineers add `todo` when they add a
model; this skill pays that debt and repairs anything else that drifted.

Run in Codex Desktop (`$vibe-seed-refresh`). It relies on the
`gh-monitor-pr` skill, which wakes this thread when the PR needs attention, so
each wake-up resumes from the state file instead of polling.

## Your role: orchestrate, never do the work

This thread can live for days across monitor wake-ups, so its context is for
state and decisions only. Under all circumstances you never read source,
search the codebase, edit files, read logs or diffs, or run seeds, builds,
tests, git, or `gh` yourself. You read and write the state file, call the
ClosedLoop MCP for the ticket and loop, start and stop `gh-monitor-pr`, and
dispatch workers with short briefs. Workers return a short status (`DONE`,
`BLOCKED`, or `DRIFT` / `CLEAN` from the check worker).

Workers are this plugin's agents (`../../agents/<name>.md`; in Codex spawn a
subagent with the file's body as its instructions, in Claude Code use
`code:<name>`). Every worker uses closedloop-graph first, per
`../vibe/references/closedloop-graph.md`; say so in each brief.

| Worker | Job |
|---|---|
| `vibe-seed-check-worker` | refresh the check worktree to fresh main and report drift |
| `vibe-seed-fix-worker` | fix the seed in the fix worktree until the checks pass; also fixes CI failures and review comments later |
| `vibe-seed-pr-worker` | commit, push, open the PR from the template; later merge main, re-enqueue, report PR state |

## State

Keep state in `~/.codex/vibe-seed-refresh/state.json`:
`{ "phase", "ticket", "loopId", "branch", "worktree", "pr", "lastCheck", "drift" }`.
Read it first on every run and every wake-up. Phases, in order:
`checking`, `fixing`, `pr-open`, `queued`, `merged`, `done`. A missing file
means `checking`.

## 1. Check

Dispatch `vibe-seed-check-worker` with the symphony-alpha checkout path: the
`repo` from `node ../vibe/scripts/vibe-sessions.mjs repo`, the checkout the
vibe preflight remembered (if none is remembered, run
`../vibe/scripts/vibe-preflight.sh` once; it finds and remembers it). Quote
the path in every brief; it can contain spaces. It
returns `CLEAN` with the main SHA, or `DRIFT` with the drift list. On `CLEAN`,
record `lastCheck`, report "Seed is current with main (<sha>)", and stop.

## 2. Ticket

On `DRIFT`:
1. ClosedLoop: `get-me` for the assignee and `list-projects` for the current
   week's project (the date-range name covering today). Use `search` for an
   open ticket titled "Vibe seed refresh" in that project and reuse it if one
   is open.
2. Otherwise `create-document` (`type: ISSUE`, `status: IN_PROGRESS`, assigned
   to you, title "Vibe seed refresh: <short drift summary>", body listing every
   drift item), then `create-loop` on it.
3. Save state with phase `fixing` and the drift list.

## 3. Fix

Dispatch `vibe-seed-fix-worker` with the checkout path, the ticket slug, and
the drift list. It creates the fix worktree from fresh main
(`fix/<iss-slug>-vibe-seed`), fixes the seed, and runs every check until they
pass. Save its worktree and branch in state and post a loop event with its
summary. On `BLOCKED`, post the reason as a loop event, tell Daniel, and stop.

## 4. Pull request

Dispatch `vibe-seed-pr-worker` in open mode with the worktree and ticket. It
returns the PR URL. Link it (ClosedLoop `create_branch_artifact` with the ticket's project UUID as
`projectId`, the branch as `branchName`, and the ticket's UUID as
`sourceArtifactId`; then a loop event),
start the monitor per the `gh-monitor-pr` skill with the PR URL and
`--stall-after 1800`, save phase `pr-open`, and end the turn.

## 5. On each wake-up

Read state. Dispatch `vibe-seed-pr-worker` in status mode for a one-line PR
state, then act on it:

- Failing check or new human review comment: dispatch `vibe-seed-fix-worker`
  in follow-up mode with the PR URL. It fixes, pushes, replies on review
  threads with the fixing commit, and resolves them. A failure unrelated to
  the diff gets one re-run; a second failure gets a loop event and a note to
  Daniel instead of more re-runs.
- Merge conflict: `vibe-seed-pr-worker` in sync mode (merge main, re-run the
  fix worker's checks through it, push).
- Green and approved or not requiring review: `vibe-seed-pr-worker` in enqueue
  mode (`gh pr merge --squash --auto`); save phase `queued`.
- Removed from the queue: `vibe-seed-fix-worker` in follow-up mode to
  diagnose per `docs/runbooks/merge-queue-operations.md`, then enqueue again.
- Merged: save phase `merged` and continue to section 6.

End every wake-up turn after acting; the monitor wakes the thread again.

## 6. Done

1. ClosedLoop: `complete-loop` with the PR URL and branch, then
   `update-document` to `DONE`.
2. Stop the PR monitor per `gh-monitor-pr`.
3. Dispatch `vibe-seed-pr-worker` in cleanup mode (remove the fix worktree
   without forcing, delete the local branch).
4. Save phase `done`, then reset the state file to `checking` for the next run.
