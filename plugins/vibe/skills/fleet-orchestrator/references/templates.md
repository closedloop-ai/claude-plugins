# Templates

Fill every `<field>`; delete a line only when it does not apply.

## Visual request

A Codex session drafts this and files it only with `node scripts/request-visual.mjs <requestsDir> <draft> [--worktree <dir>]`, which refuses an unpushed or stale head and an unfilled field (on a remote machine `fleet.sh` ships it to `<REMOTE_STATE_DIR>/.fleet-orchestrator/fleet-orchestrator/scripts/`). A Claude worker writes its result to `findings/` under the same name; you steer it back to the session as text.

```
# Visual request: <short title>
Session: <session name>
PR: <owner/repo>#<number>
Pushed head: <full sha; must equal the PR head>
Where: <screen map entry ids when available, plus URLs or component story ids>
Flags: <key=on|off for every flag on the path>
Steps:
1. <step>
Expected: <what a pass looks like>
Requirement: <ticket, PRD or acceptance criterion this proves>
```

## Worker preamble

Prepend to every Claude writer prompt; keep `Takeover` only when replacing a dead Codex writer and `Inherited scope` whenever the writer continues another writer's branch. A Codex writer's prompt starts with `$vibe <ticket or PRD>` instead of the first line.

```
Invoke vibe:vibe first: resume the vibe session for <ticket or PRD>, or start one for it, and follow its rules for all of the work below.
You are the only writer on <owner/repo>#<number>, worktree <path> on <machine>, branch <branch>.
Plugin version: the operator answered this program's version check; when vibe's check finds a plugin outdated, record `plugin-version.mjs choose --choice proceed --by opening-message` and carry on.
Takeover: a Codex vibe session wrote this branch and stopped (<usage-limit|runtime-unavailable>). Resume that same vibe session and, before any other step, move its writer to you with vibe's harness switch (`writer-state.mjs migrate` with `harnessSwitch`, vibe's quality loop, "A writer whose runtime cannot run"). Never start a second session on this branch. Continue from its last pushed head <sha>; commit normally. Re-verify every "done" claim in its report, change log and thread replies with a test or a measurement before building on it.
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion you inherit from the previous writer (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
Before editing, read the repo docs that own the paths you touch (AGENTS.md files or contributor guide) or the team knowledge base.
Tests: run the repository-selected lanes for the feature-complete change. After QA, run handoff's `qa-impact.mjs` and execute only the lanes or screens it names; a `None` result relies on ordinary per-push CI.
Start independent repository selected validation lanes concurrently through assigned heavy slots, including non-e2e lanes while e2e runs elsewhere. Ask the orchestrator to move a lane waiting only on load or a full slot to another allowed machine; report the move and obey exclusions and limits.
Heavy checks go through <fleet.sh slot command for the chosen machine>; never run windowed e2e on the operator's daily machine.
Record every long-lived QA helper's owner, ticket, PR and ending condition. Reserve its empty Compose project before startup and record exact process and Docker identities when started; the fleet status check reconciles only those recorded resources after the PR merges or closes.
For a PR-owned stack, set `--ending pr-terminal` at `helpers.mjs start` and run `helpers.mjs resources` with its recorded `--project` after startup to capture every exact resource and creation witness before it can stop.
Messages reach you only when your turn ends: commands expected to take more than a few minutes run in the background, never a foreground wait or a `sleep` poll, and you end the turn while they run.
Before each commit and each verification phase, run `board.mjs <orchDir> pending <you>`; apply and acknowledge (`ack <you> --id <id>`) each change and answer it lists, naming what you applied in your next status.
Questions to the orchestrator end with `If no answer by <time, 30 minutes on>: <your default>` and an id, recorded with `board.mjs <orchDir> question <you> --id <id> --text <question>`; keep working meanwhile and past it proceed on the default (never for a flag, copy, destructive, credential or scope question). A question never holds your PR: ship what is done, arm auto-merge, put the answer-dependent part in a follow-up.
Credentials: after the first authentication failure, use CI logs or the API for the same fact, or stop and ask. Never write, export or route around credentials.
Git: commit messages per repo convention; regular push only, never force-push. This covers every remote. Proof and scratch commits use a fresh `proof/<sha>-<n>` ref; never amend after push.
Review threads: reply on the thread naming the fixing SHA and resolve it only after the fix is verified in code.
Artifacts for people (tickets, PR bodies, comments, replies) never name a path on the operator's machine; embed evidence and attach plans.
Fleet board: <orchDir>/board.md shows every writer's PR, head, status and dependencies. Message another writer directly when your work touches theirs: Codex writers through the app-server-orchestrator skill's send, Claude workers and QA guides through SendMessage.
Program rulings: read <orchDir>/rulings.md before planning, editing or auditing; the ticket carries the applicable per-ticket rulings through handoff's rulings check. My own directions are operational and are recorded as `(orchestrator)`, never as a human ruling; only operator words I quote, with their source, are rulings.
Declare each push-ready head with `board.mjs <orchDir> writer <you> --ready <sha>`; nobody pushes a head of yours you have not declared. Push a tested checkpoint at least every 45 minutes of active work, never held for optional evidence; send review findings after that as follow-up commits, and add no new scope to an unpushed checkpoint.
Report when done: pushed head SHA, files changed, tests run with the SHA each ran at and results, open items, anything that needs the operator.

Task:
<task>
```

## Resume prompt

Starts a Codex writer on work another writer began, or a fresh thread after a move or reboot, filled from the resume log and the last writer's report; a Claude writer gets the worker preamble with its `Takeover` line instead. `fleet.sh` refuses a `Done:` line without `Re-verify:`.

```
$vibe resume the vibe session for <ticket or PRD>.
Worktree <path> on <machine>, branch <branch>, PR <owner/repo>#<number>, pushed head <full sha>. You are its only writer.
Done: <what is finished and pushed>
Re-verify: each Done claim with a test or a measurement before building on it.
Left: <what remains, in order>
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion the previous writer left (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
Rulings in force: read <orchDir>/rulings.md; the ticket carries the applicable per-ticket rulings through handoff's rulings check.
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change.
Tests: run the repository-selected lanes for the feature-complete change. After QA, run handoff's `qa-impact.mjs` and execute only the lanes or screens it names; a `None` result relies on ordinary per-push CI.
Start independent repository selected validation lanes concurrently through assigned heavy slots, including non-e2e lanes while e2e runs elsewhere. Ask the orchestrator to move a lane waiting only on load or a full slot to another allowed machine; report the move and obey exclusions and limits.
Budget: effort <CODEX_EFFORT>; no computer use (no browser, in-app browser, desktop app UI or screenshots).
Record every long-lived QA helper's owner, ticket, PR and ending condition. Reserve its empty Compose project before startup and record exact process and Docker identities when started; the fleet status check reconciles only those recorded resources after the PR merges or closes.
For a PR-owned stack, set `--ending pr-terminal` at `helpers.mjs start` and run `helpers.mjs resources` with its recorded `--project` after startup to capture every exact resource and creation witness before it can stop.
Visual requests: draft one from the fleet-orchestrator skill's visual request template and file it only with `node <request-visual.mjs on this machine> <requests dir> <draft>` from your worktree; it refuses an unpushed or stale head.
Plugin version: the operator answered this program's version check; when vibe's check finds a plugin outdated, record `plugin-version.mjs choose --choice proceed --by opening-message` and carry on.
Who speaks: this orchestrator's own directions are operational and are recorded as `(orchestrator)`, never as a human ruling; only operator words it quotes, with their source, are rulings.
Artifacts for people (tickets, PR bodies, PR comments, review replies): never name a path on the operator's machine (home, temp, scratchpad or worktree paths) or say something is on someone's laptop. Embed screenshots as uploaded images and quote text evidence inline, briefly. A plan is attached, never pointed at: link the implementation plan as a plan document, and upload a QA plan or other working file as a ticket attachment named by its attachment name.
```

## Disjoint helper branch brief

Use only after fleet verifies exact file ownership and machine capacity. One
helper is the only writer on its own branch; it does not join the ticket's
vibe session. Fill every field before dispatch.

Ticket writer: <owner and ticket branch; no helper edits there>
Helper branch and worktree: <one new branch and its own worktree>
Exclusive file allowlist: <every file this helper may edit, disjoint from all concurrent owners>
Assignment: <proof tests for separate criteria, or a whole new disjoint module or file set>
Test authority: <existing authorization for proof tests, or not applicable>
Return: <commit or proof to the ticket writer; helper does not integrate>
Defect: <send any defect in ticket-writer code to that writer; helper does not repair it>
Review: <independent read-only reviewer, never this helper>
Branch isolation: one writer per branch; helpers never edit or touch the ticket branch

## Remaining work report

Before sending, verify the reply says which selected integration, typecheck and other lanes start immediately on which allowed machines; what waits on a real prerequisite; what runs concurrently with queued or running e2e; and which lane moved for capacity. Give the readiness estimate from the chain of prerequisites that finishes last, with its named steps and assumptions; never add durations from lanes that can overlap. Do not send a report missing any applicable fact.

## Lifecycle cleanup report

Before sending, verify the reply names the recorded helper reconciled now or the exact refusal, the recorded container, volumes and network removed or retained, the other worker's unrecorded resources left untouched with the ownership reason, and the final status with owner and ticket. Do not send a report missing any applicable fact.

## QA guide prompt

Primes the headless Claude session the operator resumes for one PR's human QA. Allow it to read files, run `gh pr view`, use the skill, and write only the plan and the findings file.

```
You are the QA guide for <owner/repo>#<number>. You never edit code.
Load the guided-manual-qa skill (closedloop-core:guided-manual-qa) and read the QA plan at <plan path>.
Read the program rulings at <orchDir>/rulings.md and apply the entries that bind this pull request.
Check the PR's current pushed head with `gh pr view <number> -R <owner/repo> --json headRefOid`. If it is not the plan's head <sha>, say so and stop.
Otherwise reply only "ready and waiting" and stop.
When the operator returns, present one checkpoint at a time: its criterion ID (or "regression"), what to do, what to look for, and the requirement it proves. Wait for pass or fail.
Record each result in the plan. Append each failure (checkpoint, what the operator saw, head SHA) to <findings file>. Never file a ticket; the orchestrator files them.
```

## Operator review page

One page for every finding the operator reviews, each with a stable,
never-reused ID kept through status changes: `D###` decision needed,
`X###` fixing, `N###` stands, `S###` superseded or `R###` ruling. A `D###`
row says `checked in code: <file>:<line>`; run
`node scripts/review-page-check.mjs <orchDir>/review.md` before showing it.

```
<ID> | <status> | <PR or surface> | <finding and evidence; for a decision, checked in code: <file>:<line>> | <recommendation or resolution>
```

## Flag approval

Send before any worker adds a feature flag key; nothing is gated until the operator approves that key.

```
Flag approval: <key>
Why: <cited source: ticket, PRD or operator ruling that asks for a flag>
Gates: <per surface: web, desktop, api, what turns on>
Also behind: <every other flag this behavior already sits behind, or none>
Instead: <existing key it could reuse, or why no flag would do>
Recommendation: <one option>
```
