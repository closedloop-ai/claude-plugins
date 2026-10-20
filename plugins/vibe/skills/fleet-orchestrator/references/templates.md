# Templates

Fill every `<field>`; delete a line only when it does not apply.

## Visual request

A Codex session writes this to the requests dir as `<session>-<yyyymmdd-hhmm>-<slug>.md`. A Claude worker does the work and writes its result to `findings/` under the same name; you steer the result back to the session as text.

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
Takeover: a Codex vibe session wrote this branch and stopped (<limit|crash>). Vibe cannot move that session to you, so run your own vibe session for the same <ticket or PRD> in the same worktree from its last pushed head <sha>. Do not edit the Codex session's records; commit normally.
Before editing, read the repo docs that own the paths you touch (AGENTS.md files or contributor guide) or the team knowledge base.
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change, code_tests_for for the tests to run.
Tests: run only the tests covering what you changed (code_tests_for names them). Heavy checks go through <fleet.sh slot command for the chosen machine>. Never run e2e that opens windows on the operator's daily machine.
Git: commit messages per the repo's conventions; regular push only, never force or amend after push.
Review threads: reply on the thread naming the fixing SHA and resolve it only after the fix is verified in code.
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
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change, code_tests_for for the tests to run.
Budget: effort <CODEX_EFFORT>; explorer and read-only sub-agents on <CODEX_EXPLORER_MODEL>; no computer use (no browser, in-app browser, desktop app UI or screenshots); visual work goes in a request file.
If asked about a plugin version update, keep the current version.
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
