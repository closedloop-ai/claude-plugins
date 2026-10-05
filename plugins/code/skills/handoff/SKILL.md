---
name: handoff
description: Finish a vibe session in symphony-alpha and hand it to engineering. Shows the person a task list, then (through workers) verifies the work stays frontend-only, makes sure every new or changed component has Storybook stories, runs lint, typecheck, and tests, runs an adversarial code review and fixes what it confirms, writes api-requirements.md from the session's stubs, creates the ClosedLoop handoff ticket (IN_PROGRESS, assigned to Andrew Eye) with that file attached, makes the single commit on the andy/<slug> branch, pushes, and posts the stable Vercel preview link. Use when someone says "handoff", "hand this off", "send this to engineering", or "I'm done with this". Pairs with the vibe skill.
---

# Handoff

The person ran `vibe` and built something they are happy with. You
orchestrate making it safe and complete for engineering to take over, without
asking them to understand any of the engineering. Engineering branches off the
pushed `andy/<slug>` branch, wires the real backend, and runs their own
reviews; they do not "review" this work, so the ticket stays IN_PROGRESS.

## Your role: orchestrate, never do the work

The same rule as the `vibe` skill, without exception: you never read source
files, search the codebase, edit files, read diffs, or run builds, tests,
linters, reviews, git, or `gh` yourself. You show and update the task list,
talk to the person, run this skill's inventory script and the vibe session
script (short JSON), and dispatch workers. Each worker returns a short status
(`DONE`, `NEEDS_PERSON`, `BLOCKED`); relay `NEEDS_PERSON` verbatim in plain
words and dispatch a fresh worker with the answer. Every worker brief says to
use closedloop-graph first (`../vibe/references/closedloop-graph.md`).

Harness notes match the `vibe` skill: in Codex invoke as `$handoff` and spawn
plugin agents from `../../agents/<name>.md` with the file's body as the
subagent's instructions; in Claude Code use `/code:handoff` and the
`code:<name>` agents. Repo agents live in `<repo>/.claude/agents/`. Paths like
`scripts/...`, `references/...`, and `../vibe/...` are relative to this skill's
own folder, not the repository.

## Workers

| Step | Worker |
|---|---|
| Summary | `vibe-handoff-summarizer` |
| Guardrail and review fixes | `vibe-change-worker` (fix mode: give it the findings) |
| Judgment guardrails | `vibe-guardrails-reviewer` |
| Storybook | `vibe-storybook-decomposer` |
| Code checks, Storybook footprint | `vibe-verify-worker` |
| Adversarial review | repo `review-soul` and `vibe-adversarial-reviewer`, in parallel |
| Requirements | `vibe-api-requirements-writer` |
| Ticket, commit, push, preview | `vibe-publish-worker` |

## 0. Pick the session

Run `node ../vibe/scripts/vibe-sessions.mjs list --repo <repo>`. Use the
session whose worktree you are in. If you are not in one and more than one
session is `active`, list them in plain words and ask which one to hand off.

## 1. Show the task list first

Before anything else, show this list and keep it updated as each item
finishes (mark it done, or say plainly what blocked it):

```
Here's what I'll do to hand this off:
[ ] Summarize what changed and confirm it with you
[ ] Check nothing outside the screens and components changed
[ ] Make sure every new or changed component has Storybook stories, and
    measure what the work adds to the Storybook sidebar
[ ] Run the code checks (lint, types, tests)
[ ] Run a tough code review and fix what it finds
[ ] Write up what engineering needs to build behind the scenes
[ ] Create the ClosedLoop ticket for engineering (assigned to you for now)
[ ] Attach the write-up to the ticket
[ ] Save your work as one change on its own branch and upload it
[ ] Get the shareable preview link and add it to the ticket
```

If this session already has a `handoffTicket` (they kept working after an
earlier handoff), say the existing ticket will be updated instead, and have the
publish worker confirm it is still assigned to Andrew Eye. If engineering has
reassigned it, stop: that branch is engineering's now, and new changes need a
new vibe session.

## 2. Summarize and confirm

Run `node scripts/handoff-inventory.mjs --worktree <wt>` (the JSON stays out
of the chat). Dispatch `vibe-handoff-summarizer` with the worktree and the
inventory path. Show the person its plain summary and ask them to confirm or
correct it. Their corrections go to the publish worker for the ticket.

## 3. Guardrail check

If the inventory's `blocking` checks fail, or `outsideAllowed` is non-empty,
dispatch `vibe-change-worker` in fix mode with those findings. A forbidden
backend or database change is never handed off: the worker turns it into a stub
plus a requirement, or returns `NEEDS_PERSON` explaining what removing it
would take away. Then dispatch `vibe-guardrails-reviewer`, and pass any
findings to `vibe-change-worker`. Re-run the inventory until every blocking
check passes.

## 4. Storybook

Dispatch `vibe-storybook-decomposer` with the inventory's
`componentsWithoutStories` and the changed `packages/design-system`
components. Then dispatch `vibe-verify-worker` in footprint mode: it runs
`pnpm vibe storybook-diff`, sends every governance `problem` back through the
decomposer, and confirms every new component appears in the sidebar. Keep its
footprint summary for the ticket.

## 5. Code checks

Dispatch `vibe-verify-worker` in checks mode. It runs Biome, source gates,
affected typecheck and tests, fixes failures in the session's own changes,
never weakens a test, and returns a short pass/fail summary plus any
pre-existing failures it left alone.

## 6. Adversarial review

Dispatch the repo agent `review-soul` (`.claude/agents/review-soul.md`) and
`vibe-adversarial-reviewer` in parallel on the worktree. Pass their findings to
`vibe-change-worker` in fix mode; it verifies each finding against the code
before fixing and reports fixed and rejected (with one line why). Then run step
5 again.

## 7. Write the requirements

Dispatch `vibe-api-requirements-writer` with the inventory's `stubs`. It
writes `api-requirements.md` to the session's private git directory, never
into the repo.

## 8 to 10. Ticket, commit, push, preview

Dispatch `vibe-publish-worker` with: the worktree, the inventory path, the
confirmed summary and the person's corrections, the footprint, check, and
review summaries, the requirements file path, and the existing `handoffTicket`
if any. It creates or updates the ticket (`references/ticket-template.md`),
attaches the requirements, makes the one commit, pushes, links the branch,
waits for the preview, and adds the link. When it returns, record the ticket:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree <wt> --handoff-ticket <ISS-slug>`.

## 11. Report

Mark the session handed off:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree <wt> --status handed-off`.
Then `just vibe-down` in the worktree unless they want to keep looking.

Tell them, in a few lines: the ticket link, the preview link, the branch name
engineering will use, and what engineering will build (one line per stub). The
preview runs against the stage API, not the seeded local data, and needs a
stage sign-in in a normal browser; stubbed screens still show their fixtures.
