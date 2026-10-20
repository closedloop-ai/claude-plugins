# Templates

Fill every `<field>`; delete a line only when it does not apply.

## Visual request

A Codex session writes this to the requests dir as `<session>-<yyyymmdd-hhmm>-<slug>.md`. A Claude worker does the work and writes its result to `findings/` under the same name; you steer the result back to the session as text.

```
# Visual request: <short title>
Session: <session name>
PR: <owner/repo>#<number>
Pushed head: <full sha; must equal the PR head>
Where: <URLs or Storybook story ids>
Flags: <key=on|off for every flag on the path>
Steps:
1. <step>
Expected: <what a pass looks like>
Requirement: <ticket, PRD or acceptance criterion this proves>
```

## Worker preamble

Prepend to every Claude worker prompt; keep the `Takeover` line only when replacing a dead Codex writer.

```
You are the only writer on <owner/repo>#<number>, worktree <path> on <machine>, branch <branch>.
Takeover: a Codex session wrote this branch and stopped (<limit|crash>). Continue in the same worktree from its last pushed head <sha>. Do not edit vibe session records; commit normally.
Before editing, read every AGENTS.md that owns the paths you touch and query the workflow repo memory for this repo.
Tests: run only the tests covering what you changed (ask the repo's test graph or lane tool which). Heavy checks go through <slot-lock command or remote host>. Never run native e2e on <operator laptop>.
Git: plain commit messages; regular push only, never force or amend after push.
Review threads: reply on the thread naming the fixing SHA and resolve it only after the fix is verified in code.
Report when done: pushed head SHA, files changed, tests run and results, open items, anything that needs the operator.

Task:
<task>
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
