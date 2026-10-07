---
name: handoff
description: Finish a vibe session in symphony-alpha and hand it to design, then engineering. Shows the person a task list, then (through workers) checks the work stays within its scope, makes sure every new or changed component has Storybook stories, runs lint, typecheck, and tests (the whole suite for a full-scope session), runs the code reviews (an adversarial review, or two workflow-code-review passes for full scope) and fixes what they confirm, checks the session's live ClosedLoop ticket is complete, pushes the last changes to the andy/<slug> branch and its Vercel environment, and assigns the ticket to Nenad Antic for design review with the status left In Progress. Both scopes end at the branch; no pull request is opened. Use when someone says "handoff", "hand this off", "send this to engineering", or "I'm done with this". Pairs with the vibe skill.
---

# Handoff

The person ran `vibe` and built something they are happy with. You
orchestrate making it safe and complete for the next people, without asking
them to understand any of the engineering. The session's live ClosedLoop
ticket was created when the session started and the workers kept it current;
handoff checks it is complete rather than writing it. Then Nenad Antic
(design) reviews the components in the branch's Vercel Storybook, comments on
the ticket when he signs off, and reassigns it to Daniel Ochoa, who finishes
the work through analysis, a pull request, and merge. The ticket stays In
Progress throughout, and no pull request is opened here, in either scope.

## Your role: orchestrate, never do the work

The same rule as the `vibe` skill, without exception: you never read source
files, search the codebase, edit files, read diffs or tickets in full, or run
builds, tests, linters, reviews, git, or `gh` yourself. You show and update
the task list, talk to the person, run this skill's inventory script and the
vibe session script (short JSON), and dispatch workers. Each worker returns a
short status (`DONE`, `NEEDS_PERSON`, `BLOCKED`); relay `NEEDS_PERSON`
verbatim in plain words and dispatch a fresh worker with the answer. Every
worker brief says to use closedloop-graph first
(`../vibe/references/closedloop-graph.md`), and every worker that edits the
live ticket follows `../vibe/references/ticket-template.md`.

Harness notes match the `vibe` skill: in Codex invoke as `$handoff` and spawn
plugin agents from `../../agents/<name>.md` with the file's body as the
subagent's instructions; in Claude Code use `/code:handoff` and the
`code:<name>` agents. Repo agents live in `<repo>/.claude/agents/`. Paths like
`scripts/...` and `../vibe/...` are relative to this skill's own folder, not
the repository. Resolve the plugin root (two levels above this file, as the
`vibe` skill describes) to an absolute path and start every worker brief with
the same plugin-root line: worker paths starting with `../` are relative to
`<root>/agents`, never to the worktree the worker runs in.

## Workers

| Step | Worker |
|---|---|
| Summary | `vibe-handoff-summarizer` |
| Guardrail and review fixes | `vibe-change-worker` (fix mode: give it the findings); backend findings in full scope to `vibe-backend-worker` (fix mode) |
| Judgment guardrails | `vibe-guardrails-reviewer` |
| Storybook | `vibe-storybook-decomposer` |
| Code checks, whole test suite, Storybook footprint | `vibe-verify-worker` |
| Draft: adversarial review | repo `review-soul` and `vibe-adversarial-reviewer`, in parallel |
| Full: two review passes | the `workflow-code-review` skill (itself orchestrator-only) |
| Draft: requirements file | `vibe-api-requirements-writer` |
| Last push and Vercel check | `vibe-environment-worker` (redeploy mode) |
| Ticket check and assignment | `vibe-ticket-worker` (handoff mode, then assign mode) |

## 0. Pick the session

Run `node ../vibe/scripts/vibe-sessions.mjs list` (it uses the checkout the
vibe preflight remembered). Use the session whose worktree you are in. If you
are not in one and more than one session is `active`, list them in plain
words and ask which one to hand off. Read its `scope`, `liveTicket`, and
`localFixes`.

If the session has no `liveTicket` (it started before live tickets existed),
dispatch `vibe-ticket-worker` in create mode first; it records the slug on
the session. If it is `handed-off`, tell the person it already went
to design and stop.

Then run `node ../vibe/scripts/vibe-sessions.mjs codex-sessions --worktree "<wt>"`
so this conversation is recorded on the session too.

## 1. Show the task list first

Before anything else, show the list for the session's scope and keep it
updated as each item finishes (mark it done, or say plainly what blocked it).

Draft scope:

```
Here's what I'll do to hand this off:
[ ] Summarize what changed and confirm it with you
[ ] Check nothing outside the screens and components changed
[ ] Make sure every new or changed component has Storybook stories, and
    measure what the work adds to the Storybook sidebar
[ ] Run the code checks (lint, types, tests)
[ ] Run a tough code review and fix what it finds
[ ] Write up what engineering needs to build behind the scenes
[ ] Upload the last changes and check the app and Storybook show them
[ ] Check the ticket has everything design and engineering need
[ ] Hand the ticket to Nenad Antic for design review
```

Full scope:

```
Here's what I'll do to hand this off:
[ ] Summarize what changed and confirm it with you
[ ] Check the change stays within what we can hand off
[ ] Make sure every new or changed component has Storybook stories, and
    measure what the work adds to the Storybook sidebar
[ ] Run every test in the repo
[ ] Run two tough code reviews and fix what they find
[ ] Upload the last changes and check the app and Storybook show them
[ ] Check the ticket has everything design and engineering need
[ ] Hand the ticket to Nenad Antic for design review
```

## 2. Summarize and confirm

Run `node scripts/handoff-inventory.mjs --worktree "<wt>"` (the JSON stays out
of the chat). It covers the session's redeploy commits and anything not
committed yet. Dispatch `vibe-handoff-summarizer` with the worktree and the
inventory path.

The inventory's `localFixes` are files the setup worker changed on this Mac to
work around a symphony-alpha bug (each with the ticket that reports it). They
are not the person's work: the inventory already leaves them out of
`changedFiles` and its guardrail checks, and every worker brief from here on
(summarizer, guardrails reviewer, change and backend workers, decomposer,
verify worker, reviewers, environment worker, ticket worker) lists their paths
as out of scope, not to be described, reviewed, edited, or committed. Show the
person the plain summary and ask them to confirm or correct it. Their
corrections go to the ticket worker in step 9.

## 3. Guardrail check

If the inventory's `blocking` checks fail, or `outsideAllowed` is non-empty,
dispatch `vibe-change-worker` in fix mode with those findings. In draft scope
a forbidden backend or database change is never handed off: the worker turns
it into a stub plus a requirement, or returns `NEEDS_PERSON` explaining what
removing it would take away. Then dispatch `vibe-guardrails-reviewer`, and
pass any findings to `vibe-change-worker`. Re-run the inventory until every
blocking check passes.

## 4. Storybook

Dispatch `vibe-storybook-decomposer` with the inventory's
`componentsWithoutStories` and the changed `packages/design-system`
components. Then dispatch `vibe-verify-worker` in footprint mode: it runs
`pnpm vibe storybook-diff`, sends every governance `problem` back through the
decomposer, and confirms every new component appears in the sidebar. Keep its
footprint summary for the ticket.

## 5. Checks

Draft: dispatch `vibe-verify-worker` in checks mode. It runs Biome, source
gates, affected typecheck and tests, fixes failures in the session's own
changes, never weakens a test, and returns a short pass/fail summary plus any
pre-existing failures it left alone.

Full: dispatch `vibe-verify-worker` in full-suite mode instead. It runs every
lane, fixes failures in the session's own changes, and never weakens a test.

## 6. Reviews

Draft: dispatch the repo agent `review-soul` (`.claude/agents/review-soul.md`)
and `vibe-adversarial-reviewer` in parallel on the worktree. Pass their
findings to `vibe-change-worker` in fix mode; it verifies each finding against
the code before fixing and reports fixed and rejected (with one line why).
Then run step 5 again.

Full: run the `workflow-code-review` skill (`$workflow-code-review` in Codex,
`/code:workflow-code-review` in Claude Code) on the worktree's changes against
the session's base. It dispatches its own reviewer workers; you only receive
its consolidated findings. Send frontend findings to `vibe-change-worker` and
backend findings to `vibe-backend-worker`, both in fix mode, then run the full
suite again (step 5). Then run `workflow-code-review` a second time on the
result and repeat the fix and suite steps for anything it confirms. Keep both
passes' fixed and rejected lists for the ticket.

## 7. Requirements (draft scope)

Dispatch `vibe-api-requirements-writer` with the inventory's `stubs`. It
writes `api-requirements.md` to the session's private git directory, never
into the repo. The ticket worker reconciles the ticket's API requirements
section with it and attaches it in step 9. Full scope skips this; its Backend
built and Backend still missing sections are reconciled in step 9.

## 8. Upload the last changes

Run `node ../vibe/scripts/vibe-sessions.mjs codex-sessions --worktree "<wt>"`
again, then dispatch `vibe-environment-worker` in redeploy mode with the
worktree, the live ticket slug, the confirmed summary, and the inventory's
`localFixes` paths. It commits everything the checks and reviews changed as
one more commit (nothing is squashed or amended), pushes through the repo's
pre-push checks, requests the environment again so that commit is deployed,
and updates the ticket. If
nothing changed since the last redeploy, it confirms the branch and the
environment are current instead. A push refused by the repo's checks goes back
to step 5's fixing, then this step again.

## 9. Check the ticket

Dispatch `vibe-ticket-worker` in handoff mode with: the worktree, the live
ticket slug, the scope, the inventory path, the confirmed summary and the
person's corrections, the footprint, check, and review summaries, the
requirements file path (draft) or the decision tables in
`.closedloop-ai/decision-tables/` (full). It refreshes the record sections,
fills the Handoff section, reconciles API requirements or the backend
sections, attaches the files, and runs `scripts/live-ticket-check.mjs`. It
returns `DONE` when the ticket is complete, or `NEEDS_PERSON` with what only
the person can supply (for example acceptance criteria they never stated).
Repeat until it returns `DONE`.

## 10. Hand it to design

Dispatch `vibe-ticket-worker` in assign mode with the worktree and the live
ticket slug. It confirms the ticket is still assigned to the session's
operator, the person who ran it (if engineering or design already took it, it
returns `BLOCKED` and you stop: that branch is theirs now), assigns it to
Nenad Antic, and leaves the status In Progress.

Then mark the session handed off:
`node ../vibe/scripts/vibe-sessions.mjs touch --worktree "<wt>" --status handed-off`,
and dispatch `vibe-setup-worker` to stop local Storybook or Desktop if either
runs.

Tell them, in a few lines: the ticket link, the app and Storybook links, the
branch name, and what happens next: Nenad Antic reviews the components in
Storybook and comments on the ticket when he signs off, then hands it to
Daniel Ochoa to finish. For a draft, add one line per piece of backend work
engineering will build.
