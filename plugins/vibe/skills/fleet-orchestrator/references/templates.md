# Templates

Fill every `<field>`; delete a line only when it does not apply.

## Visual request

A Codex session drafts this and files it only with `node scripts/request-visual.mjs <requestsDir> <draft> [--worktree <dir>]`, which names it `<session>-<yyyymmdd-hhmm>-<slug>.md`. The script refuses, naming both SHAs, unless `Pushed head` equals the PR's current head (read with `gh`) and the worktree's HEAD, and refuses when `gh` cannot answer or a field is unfilled. On a remote machine `fleet.sh` ships it to `<REMOTE_STATE_DIR>/.fleet-orchestrator/fleet-orchestrator/scripts/`. A Claude worker does the work and writes its result to `findings/` under the same name; you steer the result back to the session as text.

```
# Visual request: <short title>
Session: <session name>
PR: <owner/repo>#<number>
Pushed head: <full sha; must equal the PR head>
Where: <URLs or component story ids>
Flags: <key=on|off for every flag on the path>
Steps:
1. <step>
Expected: <what a pass looks like>
Requirement: <ticket, PRD or acceptance criterion this proves>
```

## Worker preamble

Prepend to every Claude writer prompt; keep the `Takeover` line only when replacing a dead Codex writer. A Codex writer's prompt starts with `$vibe <ticket or PRD>` instead of the first line.

```
Invoke vibe:vibe first: resume the vibe session for <ticket or PRD>, or start one for it, and follow its rules for all of the work below.
You are the only writer on <owner/repo>#<number>, worktree <path> on <machine>, branch <branch>.
Takeover: a Codex vibe session wrote this branch and stopped (<usage-limit|runtime-unavailable>). Resume that same vibe session and, before any other step, move its writer to you with vibe's harness switch (`writer-state.mjs migrate` with `harnessSwitch`, vibe's quality loop, "A writer whose runtime cannot run"). Never start a second session on this branch. Continue from its last pushed head <sha>; commit normally.
Before editing, read the repo docs that own the paths you touch (AGENTS.md files or contributor guide) or the team knowledge base.
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change.
Tests: after any change, fix or merge (a conflict resolution included), run exactly the tests code_tests_for maps to the files it touched, nothing broader by default; files that map to no tests (changelog, README, version text) run none and CI confirms.
Heavy checks go through <fleet.sh slot command for the chosen machine>. Never run e2e that opens windows on the operator's daily machine.
Git: commit messages per the repo's conventions; regular push only, never force or amend after push.
Review threads: reply on the thread naming the fixing SHA and resolve it only after the fix is verified in code.
Artifacts for people (tickets, PR bodies, PR comments, review replies): never name a path on the operator's machine (home, temp, scratchpad or worktree paths) or say something is on someone's laptop. Embed screenshots as uploaded images and quote text evidence inline, briefly. A plan is attached, never pointed at: link the implementation plan as a plan document, and upload a QA plan or other working file as a ticket attachment named by its attachment name.
Report when done: pushed head SHA, files changed, tests run and results, open items, anything that needs the operator.

Task:
<task>
```

## Resume prompt

Starts a Codex writer on work another writer began, or a fresh thread after a move or reboot. Fill it from the resume log and the last writer's report; for a Claude writer use the worker preamble with its `Takeover` line instead.

```
$vibe resume the vibe session for <ticket or PRD>.
Worktree <path> on <machine>, branch <branch>, PR <owner/repo>#<number>, pushed head <full sha>. You are its only writer.
Done: <what is finished and pushed>
Left: <what remains, in order>
Rulings in force: <operator rulings and merge order that bind this work>
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change.
Tests: after any change, fix or merge (a conflict resolution included), run exactly the tests code_tests_for maps to the files it touched, nothing broader by default; files that map to no tests (changelog, README, version text) run none and CI confirms.
Budget: effort <CODEX_EFFORT>; no computer use (no browser, in-app browser, desktop app UI or screenshots).
Visual requests: draft one from the fleet-orchestrator skill's visual request template and file it only with `node <request-visual.mjs on this machine> <requests dir> <draft>` from your worktree; it refuses an unpushed or stale head.
If asked about a plugin version update, keep the current version.
Artifacts for people (tickets, PR bodies, PR comments, review replies): never name a path on the operator's machine (home, temp, scratchpad or worktree paths) or say something is on someone's laptop. Embed screenshots as uploaded images and quote text evidence inline, briefly. A plan is attached, never pointed at: link the implementation plan as a plan document, and upload a QA plan or other working file as a ticket attachment named by its attachment name.
```

## QA guide prompt

Primes a headless Claude session the operator resumes for one PR's human QA. Allow it to read files, run `gh pr view`, use the skill, and write only the plan and the findings file.

```
You are the QA guide for <owner/repo>#<number>. You never edit code.
Load the guided-manual-qa skill (closedloop-core:guided-manual-qa) and read the QA plan at <plan path>.
Check the PR's current pushed head with `gh pr view <number> -R <owner/repo> --json headRefOid`. If it is not the plan's head <sha>, say so and stop.
Otherwise reply only "ready and waiting" and stop.
When the operator returns, present one checkpoint at a time: its criterion ID (or "regression"), what to do, what to look for, and the requirement it proves. Wait for pass or fail.
Record each result in the plan. Append each failure (checkpoint, what the operator saw, head SHA) to <findings file>.
```

## Flag approval

Send to the operator before any worker adds a feature flag key; nothing is gated until they approve that key.

```
Flag approval: <key>
Why: <cited source: ticket, PRD or operator ruling that asks for a flag>
Gates: <per surface: web, desktop, api, what turns on>
Also behind: <every other flag this behavior already sits behind, or none>
Instead: <existing key it could reuse, or why no flag would do>
Recommendation: <one option>
```
