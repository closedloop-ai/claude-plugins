---
name: fleet-orchestrator
description: 'Use when you orchestrate several workers at once (Codex or vibe sessions and Claude subagents) delivering parallel pull requests, on one machine or across several, for a human operator who does QA and merges. Covers who may write where, orchestration state that survives a reboot, restart or compaction, starting, resuming and steering Codex threads bound to a worktree, Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e stack slot locks across machines, agent-first QA and review before merge, pushback on flags and extra code paths, a lessons ledger, and how to report to the operator. Pairs with codex-fleet-monitor for watching the fleet.'
---

# fleet-orchestrator

You run a program of several PRs at once: you plan, route, review, push back and report; workers write; the operator does QA, merges and makes product calls. Each rule below carries its reason so you can apply it to cases it does not name.

## Principles

1. **The operator's attention is the scarcest resource.** Decide everything you can yourself (precedent, sibling consistency, repo rules, measurements), act on it, and tell the operator the ruling in one line so they can override. Escalate only what needs them (product trade-offs, irreversible actions, approvals the repo reserves for humans), one question at a time with a recommendation. Never forward a worker's question or result without first trying to settle or verify it.
   Before any ruling on behavior, follow the single ordered product-question
   research list in [vibe's quality loop](../vibe/references/quality-loop.md#communication-and-product-questions); do not copy or reorder it here. Under fleet orchestration, a writer's `NEEDS_PERSON` comes to you, and you finish that list before asking the operator.
   A scope exclusion, deferral or "obsolete" call counts only with a human source that names the ticket or its PRD (operator ruling; `rulings-check.mjs --ruling <words> --scope <ticket>,<PRD>`): a ticket AC, a PRD line, a recorded operator ruling, or a plan with a named human approver. A self-approved plan or a handoff note never counts, and writers ask before dropping or narrowing anything.
   Every question to the operator names where you checked the code first (`checked in code: <file>:<line>`); drop one the code already answers. `scripts/review-page-check.mjs` refuses a decision row without it.

   A human-sourced line that conflicts with the ruling goes to the operator as a question with a recommendation. Record every ruling with its source in the resume log as `- Ruling (<who>): <decision>`, and have the writer add it to the ticket with the criteria it amends (`../handoff/scripts/rulings-check.mjs` fails until it is there) and cite it on the relevant thread.

2. **Sanity-check every worker output; never just relay it.** When a change looks absurd, oversized or irrational (several flags for one screen, a docs file nobody asked for, a plugin PR that only adds, a stale head, a weakened test, a claim the evidence does not support), push back to the worker with a simpler alternative before the operator sees it, then tell the operator what you caught.

Repo specifics (launch paths, auth, bootstrap, test commands, e2e harness) come from the repo's own docs (its `AGENTS.md` files or contributor guide) or the team knowledge base; look them up, never assume them. Machine specifics (hosts, paths, model names, slot counts) come from `<orchDir>/config.env`.

## Setup

Works on one machine with no remote config. More machines need ssh key auth between them, plus `codex`, `node`, `gh`, this plugin and the closedloop-graph MCP server on each. Prerequisites, the `config.env` keys with placeholders, and the setup checklist: [references/setup.md](./references/setup.md).

- First run: when `<orchDir>/config.env` is missing, or lacks a key this run needs, ask the operator once before launching anything, as one short structured question set (the harness's ask-question tool where available) with the [first-run questions](./references/setup.md#first-run-interview) and their defaults. Write `config.env` from the answers, run the checklist's verification, and report what passed.
- Later runs read `config.env` and do not ask again unless a verification fails.

## Roles

- Every writer is a vibe session, and no un-vibed writer ever edits a PR branch: Codex writers start or resume with a `$vibe` prompt naming the ticket or PRD (`fleet.sh` refuses a new session whose prompt does not start with `$vibe`), and Claude writers invoke `vibe:vibe` and follow its resume path. Vibe's scope, guardrails and ticket records only bind work done inside it.
- Reviews, handoff, ticket, environment and seed work go through vibe's own skills, workers and scripts (`vibe:handoff`, its reviewer and verify workers, `vibe:vibe-seed-refresh`), never ad hoc equivalents. One process keeps one set of records and gates.
- You never edit a product repo; every change goes through a worker in its own worktree. Keeps one owner per change and your context free for judgment.
- One writer per branch at a time, Codex or Claude. Two writers on one branch overwrite each other.
- Reviewers, verifiers, QA prep and visual reviewers are read-only Claude subagents. A reviewer that fixes cannot be the independent check.
- The operator gets QA, merges and enqueues, anything irreversible, and product decisions; everything else you settle (principle 1).
- Prefer the repo's or an installed plugin's specialist over a general-purpose agent whenever one exists. Repo-specific names below are examples.

| Role | Agent or skill | Plugin | Fallback when not installed |
|---|---|---|---|
| Ticket overlap, scope collisions, "did a human ask for this", drift tracing | `closedloop-core:closedloop-intel`, read-only, over the closedloop-graph MCP server | closedloop-core | closedloop-graph tools directly |
| QA plan per PR (plan-only) and the QA-guide session (one checkpoint at a time) | `closedloop-core:guided-manual-qa` in a Claude worker | closedloop-core | a written checklist from the criteria trace |
| Pre-merge local CI | the repo's local-CI skill (for example a `local-ci` skill wrapping dagger) | target repo | the repo's documented verify command |
| Design and visual review of a PR's UI, headless against the deployed preview | the repo's design-review and visual-qa skills and critic agents (for example `design-critic`, `visual-qa-critic`) | target repo | a Claude reviewer reading headless captures |
| Turning a repeated mistake into a guard | `closedloop-core:prevent-recurrence` | closedloop-core | the lessons loop below |
| Writers, reviews, handoff, ticket, environment | vibe's own workers (above) | vibe | none; vibe is required |
| Watchers, pollers, narrow log diagnosis | Sonnet subagents; `codex-fleet-monitor` for the fleet; the `app-server-orchestrator` skill to steer Codex threads | vibe, Codex skills | `fleet.sh session last` polling |

## Research with closedloop-graph

The closedloop-graph MCP server is required; decide from it, not from guesses. Tool guide: [vibe's closedloop-graph reference](../vibe/references/closedloop-graph.md).

- Before assigning work or ruling between PRs, check open-PR and ticket overlap with `query_collisions` and `blast_radius_tickets`; read a ticket's PRD lineage and children with `ticket_detail`.
- Before dispatching a ticket, and in every QA-prep brief, run vibe's newest-ruling search ([requirements worker](../../agents/vibe-requirements-worker.md), Newest ruling). On a hit, stop and ask the operator.
- In the same step, check every plan linked to the ticket (`list-artifact-links`, PRODUCES): save its `get-document` JSON and latest text and run `node ../handoff/scripts/rulings-check.mjs --plan <json> --plan-body <text>`. A plan with no human approver is not a ruling, so each exclusion it reports is scope the brief tells the writer to build or you escalate, never one to skip. A writer once skipped two tickets on an uncited Out-of-scope line of a plan vibe itself had marked approved.
- Before a shared change, read its callers and importers (`code_callers`, `code_importers`).
- Which tests to run, or rerun, after any change, fix or merge (a conflict resolution included) is decided by `code_tests_for`, the only route to tests, over the files that change touched: run exactly those and nothing broader by default. Files that map to no tests (changelog, README, version text) run none, and CI confirms.
- Trace a surprising difference in a before and after comparison to the commit and ticket that introduced it before blaming the PR.
- Attribute a file's origin or a first failure from local history only through `scripts/history-origin.mjs --repo <repo> --path <file>`, which refuses a shallow clone, where the oldest visible commit looks like the origin.
- Every worker prompt requires the same graph-first research (the preamble and resume templates carry it).

## State and persistence

- Keep all orchestration state in one persistent directory, never `/tmp` or a session scratchpad. A forced reboot wiped `/tmp` once and orphaned every Codex thread. Layout: [references/state.md](./references/state.md).
- Write every prompt to `prompts/` before sending it. A restarted orchestrator can then see what each worker was told; `fleet.sh` only accepts prompt files.
- Keep a dated resume log (rulings, merge order, who owns what, pending items) and read it first after any restart or compaction. Your memory of the program does not survive either.
- After your own restart, subagents are gone: re-arm the watcher, relaunch Claude workers from their saved prompts, and tell the operator what you restarted.
- If a remote machine reboots or loses its session state, its Codex threads cannot be reattached: start fresh threads in the same worktrees with [resume prompts](./references/templates.md#resume-prompt) built from `prompts/` and the resume log.

## Monitoring

Run [codex-fleet-monitor](../codex-fleet-monitor/SKILL.md) (`vibe:codex-fleet-monitor`) on the same `<orchDir>` in the background for the whole program and act on its lines as its table says, including usage bands, paid-credit spending and request files. It reads the session state files `fleet.sh` writes, listed as `local|remote <name>` in `sessions.txt`.

- The watcher resumes a session after a transient provider failure on its own; read its `recovery` lines when you wake. Run its supervisor on every machine that hosts Codex writers, so recovery also happens while you are not running. Set `AUTO_RESTART_DAEMON=1` in `config.env` only when the operator agrees that a stuck daemon may be restarted unattended.
- Re-arm the watcher in the same step you read each event. It only watches while running, and it costs nothing while waiting. Before ending any turn that handled an event, `node ../codex-fleet-monitor/scripts/watcher.mjs <orchDir>` must print `watcher ok`; on `MISSING` (`board.mjs status` prints `WATCHER-MISSING`), re-arm it. A lost re-arm once left writers' questions unread for seven hours overnight. Start it with the harness's background option (`run_in_background`), never with `&`, which left a stray copy twice; `watch.sh` refuses a second copy for the same work dir.
- The armed watcher is your heartbeat (`HEARTBEAT` every 30 quiet minutes); on every wake read every teammate message first. While the operator is away, also keep a recurring schedule (loop or cron, 20 to 30 minutes) that does the same and checks `watcher.mjs`. Recovery resumes an idle Codex writer on its default once its question's deadline passes.
- Answer a writer's question within 15 minutes: the watcher's `QUESTION-UNANSWERED` (Codex) and `board.mjs status`'s (questions Claude writers record with `board.mjs question`) mark the late ones; answer, or tell the writer to proceed on its default.
- On `STALE-PR` (a PR needing its writer with no push for 45 minutes), ask the owning writer for an ETA, unblock it, or reassign it, whatever the writer reports it is busy with; one PR sat six hours on five threads while its writer looked busy.
- Push for a writer only the head it declared push-ready (`board.mjs <orchDir> writer <name> --ready <sha>`): `board.mjs <orchDir> push-check <writer> --head <sha>` must print `READY` first. Otherwise ask the writer for its ready head and wait. A writer's committed head once went to auto-merge while the writer was still fixing two regressions in it.
- Before you or a reviewer inspect a head, check it equals the pushed PR head (`gh pr view <n> --json headRefOid`). Sessions sometimes report local, unpushed commits.

## Codex sessions

`scripts/fleet.sh` drives a session on this machine (`local`) or on `REMOTE_HOST` (`remote`, which copies the scripts and the prompt file there first) through the managed Codex App Server, using the monitor's client.

```sh
scripts/fleet.sh <orchDir> local|remote session turn  <name> --prompt-file <file> [--cwd <worktree>] [--model <m>] [--effort <e>] [--sandbox <mode>]
scripts/fleet.sh <orchDir> local|remote session steer <name> --prompt-file <file>
scripts/fleet.sh <orchDir> local|remote session last  <name> [--count <n>]
```

- `turn` starts a thread bound to `--cwd` the first time (refusing a different cwd later) and resumes it afterwards, then starts a turn.
  - `--model` and `--effort` default to `CODEX_MODEL` and `CODEX_EFFORT`.
  - A new session refuses to start without a model or an effort, or with a prompt that does not start with `$vibe`.
  - Start every Codex writer this way, never through a bare thread start without both: one came up on a model that ran about 17 tokens per second and another on the default effort. The watcher marks a thread on another model or effort `MODEL(...)`; restart it on the configured one.
  - Model, effort, sandbox and each prompt file sent persist in the session's state file.
- `steer` adds to the active turn and fails when none is running.
- `last` prints the monitor's status line and the last agent messages.

- Run Codex at the high effort level, not the maximum: the maximum burns the limit far faster for little gain on PR work. The thread runs on `CODEX_MODEL`; vibe's own worker-model policy picks each sub-agent's model, so never name one in a prompt.
- No computer use in Codex: no browser, in-app browser, desktop app UI or screenshots. It is the fastest drain. Code host work goes through its CLI.
- Visual work is a request file a Codex session writes only through `scripts/request-visual.mjs` ([template](./references/templates.md#visual-request)), which refuses a head that is not the PR's pushed head; a Claude worker does it and you steer the findings back as text.

## Claude workers

- Launch each Claude writer with the [worker preamble](./references/templates.md#worker-preamble) saved to `prompts/`. It starts with invoking vibe and carries the worktree, PR, reading, test, git, thread-reply and report rules so no writer improvises them.
- A message to a busy worker arrives only when it goes idle; if it idles without acting on one, resend it once, then interrupt after the second unanswered delivery instead of sending a third.
- A pane teammate sees your messages only when its current turn ends. For an urgent redirect, ask the operator to press Esc in the named pane, which ends the turn and delivers them; otherwise expect delivery at the next turn boundary. Keep long briefs in a file and send its path.
- A standing duty (main's post-merge health, a PR shepherd, the watcher) always has a live owner: `board.mjs <orchDir> duty <duty> --owner <writer or helper>`. Name the replacement in the same step you stop or move its owner; `helpers.mjs stopped` refuses an owner, and `board.mjs status` prints `UNOWNED-DUTY`. Main's health once went unwatched for an hour after its watcher was stopped to save budget.
- Stop a helper (reviewer, verifier, QA prep, poller) as soon as you accept its result; its brief and findings are on disk, so the next trigger launches a fresh one. Idle helper panes hide the active ones from the operator. Record each with `scripts/helpers.mjs <orchDir> start|accepted|stopped <name>`, and run `scripts/helpers.mjs <orchDir> status` with every monitor event: each `STOP` line is a helper to stop now, each `ORPHAN` line a stopped helper whose processes still run. A helper records every process it starts (dev servers, app stacks) with `helpers.mjs <orchDir> pid <name> <pid...>`, adding `--group` only for one it spawned detached; `stopped` ends them and refuses while any lives. Stopped QA agents once left dev servers running for 13 to 16 hours.

## Fleet board and direct messages

Writers that could not see each other's work collided, a QA guide never heard its checkpoint was ready, and a UX ruling reached one writer while another PR rendered the same behavior. `scripts/board.mjs` keeps `<orchDir>/board.md`, the page every writer reads:

- The status sweep, a standing `status-sweep` duty. At every writer assignment and every merge, and at every status report, gather each in-scope PRD's children (status, assigned writer, linked pull requests and their state, the latest body of each merged or DONE one, its plans, and the umbrella that absorbed it) into a snapshot and run `node scripts/status-audit.mjs --snapshot <file>`. It fails until each `MISMATCH`, `UNOWNED`, `UNREAD`, `UNCHECKED`, `PLAN-OPEN` and `ABSORBED-OPEN` child is fixed or listed under `outOfScope` with who ruled it out. Closing an umbrella ticket closes the children it absorbed in the same step, with its merge as evidence. A merge alone never makes a ticket DONE: its criteria are checked against the merged code first.
- When you launch a writer, add its row (`board.mjs <orchDir> writer <name> --runtime codex|claude --pr <n> --repo <owner/repo> --head <sha> --status <text> --deps <a,b>`) and give it the board path and the messaging recipe ([worker preamble](./references/templates.md#worker-preamble)). Update the row on every push report.
- Writers message each other directly: Codex writers through the `app-server-orchestrator` skill's send, Claude workers and QA guides through SendMessage.
- A settled UX ruling is saved once as a reference file with its screenshots in a shared evidence location. Find every renderer of the behavior with `code_grep` across each open PR's diff and main, then `board.mjs <orchDir> deliver <ruling> --kind ruling --reference <file> --to <every owning writer and QA guide>`. Every QA plan for that behavior cites the reference, and one shared component beats each PR building its own.
- When QA prep marks a human checkpoint ready, or rebinds results, `deliver <checkpoint> --kind checkpoint --head <sha> --to <guide>` and message the guide yourself with the checkpoint, its launch steps and the head.
- After each message, `board.mjs <orchDir> told <item> <recipient>`. Run `board.mjs <orchDir> status` with every monitor event: each `STALE` row is a writer whose pushed head the board does not show, each `UNTOLD` line someone still to tell, each `UNOWNED-DUTY` a duty to give an owner now. A `SLOW` row is a Codex writer 30 minutes without a push on a PR with unresolved human threads: have it push and hand the branch to a Claude writer (Codex to Claude, below), as for a dead writer.

## Moving work between runtimes and accounts

- When a machine's `codex-usage` band reaches `MOVE_AT_PERCENT`, or its trend says it will before the work is done, tell the operator at once with the band and `resets=<n>`: applying a limit reset is theirs. When they are away, move its busiest writers to Claude writers now instead of waiting for an answer. Move them on any `LIMIT` or `LIMIT-SPENDING-CREDITS` line too. Claude usage is the watcher's `claude-usage` line (from `claude -p "/usage"`, session and weekly bands on the same threshold): on a `HIGH` band tell the operator at once with its reset time, and when they are away move the busiest Claude writers to Codex writers; move one at once when it hits its limit.
- When the operator reports high Claude usage, stop idle and polling Claude workers first, ask active ones to push a checkpoint and end, move their remaining work to Codex writers, and widen the Claude polling interval.
- Before any move the old writer stops, or is confirmed dead, after committing and pushing or reporting its uncommitted state. One writer per branch holds through every move.
- Codex to another Codex machine or account: a fresh thread through `fleet.sh` in the branch's worktree there, with a [resume prompt](./references/templates.md#resume-prompt).
- Codex to Claude: a Claude writer in the same worktree with the [takeover preamble](./references/templates.md#worker-preamble). It resumes the same vibe session and moves its writer with vibe's harness switch before any other step; a Claude writer beside a ledger that still names the stopped Codex writer has every environment request refused.
- Claude to Codex: a Codex vibe session through `fleet.sh` in the same worktree, with a resume prompt.
- Fresh and resumed threads may stop to ask about a plugin version update, so every resume prompt says to keep the current version.

## Machines and CPU

- Run heavy checks (full test suites, typecheck, repo-wide lint and other gates, component story runs) on the least loaded machine, in the worker's own worktree there ([checklist step 4](./references/setup.md#checklist) gets the branch there). Keep the operator's daily machine for edits and git.
- Balance heavy work by measured load, not a fixed machine: before each heavy run, compare load per core (`uptime` against the core count) on each machine and send the run to the lower one. A fixed choice once drove one machine to more than twice its core count while the other sat idle.
- Cap heavy runs per machine at its `HEAVY_SLOTS` or `REMOTE_HEAVY_SLOTS`: `scripts/fleet.sh <orchDir> local|remote slot heavy <owner> <worktree> <command...>`.
- A shared e2e stack with fixed ports runs only under vibe's machine-wide e2e lock, the one every vibe session's e2e command already takes: `node ../vibe/scripts/e2e-lock.mjs run <command...>` on the machine that runs the stack. A second lock for the same stack would let two runs collide. The lock gives each run its own compose project, so a teardown removes only its own stack; name a stack another tool started on the same ports with `--foreign-compose <project>`. Only runs that start that stack take it; tests against a stand-in server, component story runs, unit tests and typecheck run outside it in parallel.
- `scripts/slot-lock.sh` underneath frees the slot when the command exits or is interrupted and reclaims one whose holder pid died; `scripts/slot-lock.sh --status <lockName>` on that machine lists holders.
- Kill only processes you started, by recorded pid, never by pattern: vibe's `hooks/kill-guard.mjs` refuses `pkill`, `killall` and `kill` of an unrecorded pid in every Claude session with the plugin. Other runs on that machine belong to someone else. Never signal a pid of 1 or lower or a process group you did not spawn: `kill(-1)` from a plugin test once ended every app on the operator's machine. Tests that send signals run on another machine, never the operator's daily one.
- Plugin marketplaces and env files on a remote machine live in persistent paths too.

## Quality gates and QA

- QA happens before merge; never call a PR ready to enqueue before its QA is done.
- Each PR moves through, in order: independent review → writer fixes → verification of the fixes → design or visual review where UI changed → full check at the final head → QA plan (agent-verified plus human-only checkpoints) → operator QA → one main merge → operator enqueues. A head change sends it back to the earliest step the change affects.
- QA runs on the feature-complete head, even when it conflicts with main; on a fast-moving main, a head kept current before QA goes stale during QA. vibe's publication leaves main unmerged until then; after QA, tell the writer to set final-merge mode (`vibe-sessions.mjs touch --main-merge final`), so its next publication merges main once, resolving version-file conflicts, reruns only the tests `code_tests_for` selects for the files the merge touched, and the operator enqueues at once; the merge queue retests against main. Before telling the operator to enqueue, `node ../handoff/scripts/qa-merge-order.mjs --worktree <wt> --qa-head <QA'd sha>` must pass, and so must vibe's criteria audit and rulings check (`../handoff/SKILL.md`). From then on, shepherd the pull request with `../vibe/scripts/shepherd.mjs`, polling every two minutes and re-merging main at once on a conflict. Never ask a writer to merge main mid-work unless a conflict blocks the build itself.
- Criteria are fixed before the build, because nobody is in the loop to ask for them while it runs.
  - A writer starts only once its plan holds a numbered acceptance-criteria list.
  - Each criterion is sourced to a ticket AC, a PRD line or an operator ruling.
  - A mid-flight ruling joins that list with its date.

  An unrequested write path, a missed operator ruling and a mislabeled defect each traced back to having no such list.
- Before an audit, reconcile operator chat and AskUserQuestion answers plus guide-session and QA records into `<orchDir>/rulings.md`, then run `node ../handoff/scripts/rulings-check.mjs --program <orchDir>/rulings.md --record <transcript-or-record> ...`; audit the acceptance criteria together with those rulings. The applicable per-ticket entries remain enforced by handoff's `rulings-check.mjs`.
- Before showing `<orchDir>/review.md`, run `node scripts/review-page-check.mjs <orchDir>/review.md`; duplicate or untyped finding IDs block the report.
- The QA plan is a two-way trace between that list and the diff: each checkpoint cites one criterion ID, a diff change mapping to no criterion is a finding, never a checkpoint, and a criterion with no change and no coverage is a gap. Regression checks on neighboring surfaces the diff touches are labeled separately; a regression failure is a bug, never a new requirement.
- Agent-first QA, zero human checkpoints by default: an agent verifies everything it can (e2e on the current head, DOM and accessibility reads, API second views, headless screenshots it compares with the saved reference itself) and records it. The operator gets only checkpoints an agent cannot cover: real-device feel, assistive tech, flows an agent cannot drive, a product call no reference settles; measure the rest (contrast ratios, box geometry, focus targets). `node scripts/qa-plan-check.mjs --plan <QA record> --criteria <ticket body> --prd <PRD body>` must pass before the plan reaches the operator: every rollout, flag and rollback requirement is a checkpoint, and it refuses a human checkpoint without such a reason, a visual one included. A defect an agent already observed goes to the writer with its measurement, not to the human checklist.
- A confirmed visual-QA finding on a surface the change touches is a required fix even when it predates the branch, is already on main or was called an owner's decision. User-facing copy still needs a human source: reuse approved copy or escalate the wording.
- Before handoff, `node scripts/finding-brief.mjs <orchDir> --findings <findings.json> --require-disposition` must pass. Every touched-surface finding records `fixed: <sha>` or, only when a fix cannot be made in this pull request, `ticket: <id>`.
- A QA rerun that toggles flags or moves data never uses the stack handed to the operator: `helpers.mjs <orchDir> hand <stack> --to <guide>` when the guide gets it, `unhand` when QA ends, and start the rerun helper with `--stack <its own stack>` (refused on a handed one).
- Writers push a tested checkpoint at least every 45 minutes of active work and never hold one for optional evidence (vibe's commit reports `pushDue`); review findings after that go out as follow-up commits reviewed per diff, and never add new scope to an unpushed checkpoint. A critical-path PR once sat unpushed for 5 hours while each review pass added scope.
- Human QA runs in a dedicated Claude QA-guide session per PR that the operator talks to directly. When the PR's QA plan is ready:
  1. Save the [QA guide prompt](./references/templates.md#qa-guide-prompt) to `prompts/`.
  2. Launch it headless from the repo root (`claude -p --output-format json` with the tools it needs allowed).
  3. Take `session_id` from the JSON and give the operator `cd <repo> && claude --resume <session_id>`.
  4. Keep a background wait on its findings file, re-armed like the monitor, and route each failure to the writer.

  Send QA findings to a writer only through `node scripts/finding-brief.mjs <orchDir> --findings <findings.json> --prompt <prompt> [--where remote]`: it refuses a finding with no story id or route, viewport, selector or screenshot, or explicit `touchedSurface`, and puts the screenshots where the writer's machine can open them (`fleet.sh` ships them with the prompt).
  You alone file a ticket for a QA finding (the QA guide never does), and only after searching open tickets created in the last day for the same subject. Two actors once filed the same follow-up a minute apart.
  Group audit and bug fixes into as few tickets and PRs as speed allows (operator ruling): one umbrella ticket, with PRs split by code area so writers work in parallel, never one ticket and PR per finding or per PRD.
  Before filing a ticket or moving one to in review, run `node ../vibe/scripts/ticket-write-check.mjs` with its project, parents and status; it refuses a past sprint, a parent that is executed, obsolete, done or canceled, and in review without the delivering pull request. Set the project explicitly rather than taking the default.
- Check the test selection in each push report (the PR evidence file's selected tests and their runs) and have QA compare it with the specs the PR edits; selection covers the whole branch diff, not the latest push.
- Every PR gets an independent review, then a verification pass of the fixes, before it is QA-ready. Resolve a thread only after the fix is verified in code, with a reply naming the fixing SHA.
- One review round per PR (operator ruling): threads raised after the round-one fixes are pushed never block or delay the merge. A valid one becomes a criterion on the PR's one follow-up ticket (created once in the current sprint project, assigned to the operator, `TODO`, related to the PR's ticket, titled `<PR ticket>: follow-ups from #<PR> review`; later rounds append to it), and the thread gets that ticket's link or why it is invalid, then is resolved. `shepherd.mjs --round-one-fixed-at` and `review-followup.mjs` enforce both.
- Before enqueue, run the lanes the diff can affect wherever PR CI skips them (the repo's lane selector, never full suites by default), and resolve shared version-file conflicts right before each enqueue, in merge order. The queue rebuilds on current main, and a skipped suite is not a pass.
- A release-version bump every UI PR touches (a component catalog version and its history entry) is made only at enqueue time, and the operator arms auto-merge in the same minute; made earlier, it re-conflicts with every other open PR.
- A fix merged to main reaches a preview only once the ref the preview's backing environment deploys from contains it: check ancestry against that ref (`git merge-base --is-ancestor <fix> <ref>`) before calling a preview fix live.
- Track merge order for stacked or overlapping PRs and tell each writer which one merges first.
- A before and after comparison uses the candidate's merge-base or current main as the baseline, never an unrelated branch.

## Pushback

Pushback applies principle 2; more judgment patterns from past programs: [references/judgment.md](./references/judgment.md).

- Debt to push back on also includes parallel code paths, shims and a second owner for the same behavior. Forwarding it for approval as is makes the operator do your review.
- No agent adds a key to the team's feature-flag service without the operator approving that key ([approval template](./references/templates.md#flag-approval)). Prefer one key per program or surface; corrections and removals are never gated.
- An instruction to match a prototype or design never removes what main ships: diff main's shipped controls and items against the target before you brief a writer, and keep any the target leaves out unless a human source retires it.
- Never invent product behavior or user-facing copy; cite the human source. Never write a row the repo reserves for human attestation; read the owning check's header and ask the operator.
- Respect operator boundaries on other teams' work, such as "don't fix main" while another owner is fixing it.
- Work outside the program goes to its owner (operator ruling): a security or infrastructure finding outside its scope, such as a runtime advisory, becomes a ticket assigned to that owner, and the worker investigating it stops. The program does not take the fix.

## Program practices

- Green watch: `board.mjs` requires a `green-watch` owner while PRs are watched (`MISSING-DUTY`). After program PRs merge, that owner follows each post-merge batch until `GREEN_REF` advances, with `GREEN_WATCH_AGENT` where the repo has one, and runs `node scripts/green-watch.mjs --repo <owner/repo> --worktree <clone> --program <merge shas>` before every report: it re-lists main's runs each time and covers every lane of every run containing a program PR, so a batch that starts later is not missed. It attributes every red to its PR and author, fixes ours in one PR, and files one ticket per other author in the current sprint, assigned to them with evidence and a fix. It never cuts a release.
- Placement: `fleet.sh slot heavy` refuses a machine whose load per core is over `MAX_LOAD_PER_CORE` (exit 4); send the run to the other machine. E2e and desktop app runs never go on the operator's daily machine.
- Repo knowledge: a repo fact a worker learns goes into the team's repo memory (`REPO_MEMORY_CMD`), and into the nearest `AGENTS.md` through that worker's PR when it binds code.
- Close-out: `executed-check.mjs --kind prd` before a PRD is executed (its flags section first) and `status-audit.mjs` at every merge and writer assignment.
- Deadline mode, only when the operator rules it (record it in `rulings.md` with its end): no pre-merge e2e, follow-up pushes run focused tests plus the affected typecheck and leave full lanes to CI, and extras ship in follow-up PRs.
- Runtime choice: judgment-heavy work and takeovers go to Claude writers, which are faster; bulk mechanical work goes to Codex on `CODEX_MODEL`, which is cheaper. Move work on usage and speed.

## Lessons loop

- Log every finding you route to a writer in the lessons ledger at the same moment, tagged new or repeat, with owner and fix. Batched later, they get lost. Format: [references/state.md](./references/state.md#lessons-ledger).
- A repeat after a shipped fix means the earlier encoding did not bite: make it a gate, not more prose.
- A plugin PR that encodes lessons replaces the prose its gate enforces and reports the net change in instruction length. The plugin must not get heavier.
- Batch lesson and tooling fixes into one open PR per repo and add to it until it merges, never one PR per lesson: each PR costs a full CI run. Before opening one, `node scripts/lessons-pr.mjs --repo <owner/repo>` must print `no open lessons PR`; otherwise push the batch onto the branch it names. Four stacked lessons PRs once had to be restacked onto main.
- A lesson's primary fix lives in vibe itself, its writer instructions plus a mechanical check, because many people run vibe without an orchestrator; a rule here is only a second layer.
- A lessons PR encodes general rules only. One repo's product rules, paths and component names go in that repo's own instruction files, gates or knowledge base, never in this plugin.

## Artifacts people read

Hard rule. A ticket, PR body, PR comment, review reply or any other artifact written for people never references a path on the operator's machine (a home path such as `~/`, a temp, scratchpad or worktree path) or says something is on someone's laptop.

- Evidence is uploaded and embedded: a screenshot goes into the ticket as an inline image through the ticket tool (for example a new document version with inline images); text evidence is quoted inline, briefly.
- A plan the ticket references is attached, never pointed at: an implementation plan is a plan document linked to the ticket, and a QA plan or other working file is uploaded as an attachment on the ticket and named by its attachment name.
- Check every worker draft for this before it is posted; vibe's ticket and PR body checks refuse a local path.

## Reporting to the operator

- Surface every problem the moment you see it: limits, stalls, failures, new human review comments, blockers.
- Keep status updates short.
- When the operator steps away, keep `<orchDir>/attention.md` current (decision needed, recommendation, what is blocked), keep reading idle writers' last messages, and lead with that list on return.
- Put every finding the operator reviews on one page using the stable `D`, `X`, `N`, `S` and `R` IDs in the [operator review template](./references/templates.md#operator-review-page); never restart numbering across audits.
- The final report lists, per PRD, which flags must be on to see each change.
- Before a PRD is marked executed, `node ../handoff/scripts/executed-check.mjs --kind prd --file <PRD text> --last-merge <time> --children <its PRODUCES children read now>` must pass: its first section lists each flag its shipped changes rely on, where to see it in production and its state checked after the last merge, and every child is DONE or CANCELED; report open ones instead.
