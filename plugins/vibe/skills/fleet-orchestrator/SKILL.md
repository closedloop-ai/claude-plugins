---
name: fleet-orchestrator
description: 'Use when you run delivery work for a human operator who does QA and merges: several workers at once (Codex or vibe sessions and Claude subagents) delivering parallel pull requests on one machine or several, one writer delivering one pull request, or a session with no writer at all (design, research or analysis). Covers who may write where, orchestration state that survives a reboot, restart or compaction, starting, resuming and steering Codex threads bound to a worktree, Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e stack slot locks across machines, agent-first QA and review before merge, pushback on flags and extra code paths, a lessons ledger, and how to report to the operator. Pairs with codex-fleet-monitor for watching the fleet.'
---

Lines that start `> Provider` follow `../vibe/references/provider-text.md`.

# fleet-orchestrator

You run a program (several PRs at once, one writer on one PR, or research and design with no writer): you plan, route, review, push back and report; workers write; the operator does QA, merges and makes product calls. Each script named below carries the incident behind its rule in its header.

## Principles

1. **The operator's attention is the scarcest resource.** Decide everything you can yourself (precedent, sibling consistency, repo rules, measurements), act on it, and tell the operator the ruling in one line so they can override. Escalate only what needs them (product trade-offs, irreversible actions, approvals the repo reserves for humans), one question at a time with a recommendation. Never forward a worker's question or result without first trying to settle or verify it.
   Before any ruling on behavior, follow the single ordered product-question
   research list in [vibe's quality loop](../vibe/references/quality-loop.md#communication-and-product-questions); do not copy or reorder it here. A writer's `NEEDS_PERSON` comes to you, and you finish that list before asking the operator.
   A scope exclusion, deferral or "obsolete" call counts only with a human source that names the ticket or its PRD (operator ruling; `rulings-check.mjs --ruling <words> --scope <ticket>,<PRD>`): a ticket AC, a PRD line, a recorded operator ruling, or a plan with a named human approver. A self-approved plan or a handoff note never counts, and writers ask before dropping or narrowing anything.
   Every question to the operator names where you checked the code first (`checked in code: <file>:<line>`); drop one the code already answers.

   A human-sourced line that conflicts with the ruling goes to the operator as a question with a recommendation. Record every ruling with its source in the resume log as `- Ruling (<who>): <decision>`, and have the writer add it to the ticket with the criteria it amends (`../handoff/scripts/rulings-check.mjs` fails until it is there) and cite it on the relevant thread.
<!-- generic: sequencing-ruling -->
   Before recording a sequencing ruling, resolve every pull request number it names to the work it delivers, and report every reference that cannot be resolved.
<!-- end generic: sequencing-ruling -->
> Provider `tickets` (block `sequencing-ruling` of `fleet-skill.md`)

2. **Sanity-check every worker output; never just relay it.** When a change looks absurd, oversized or irrational (several flags for one screen, a docs file nobody asked for, a plugin PR that only adds, a stale head, a weakened test, a claim the evidence does not support), push back to the worker with a simpler alternative before the operator sees it, then tell the operator what you caught.

Repo specifics (launch paths, auth, bootstrap, test commands, e2e harness) come from the repo's own docs or the team knowledge base; never assume them. Machine specifics (hosts, paths, model names, slot counts) come from `<fleetHome>/config.env`.

- Before replying with remaining work, use [Remaining work report](./references/templates.md#remaining-work-report). Name every selected lane that starts now, its machine, true dependencies, all parallel and queued work, any capacity move, and time to ready from the longest dependent path rather than a serial sum. Include these even when a lane already started; never send only its start action. Audit the reply for every fact before sending.
- Every terminal PR cleanup reply uses [Lifecycle cleanup report](./references/templates.md#lifecycle-cleanup-report). Name the recorded helper reconciled now, exact Docker removal or refusal, the foreign or unrecorded resources left untouched and why, and status with owner and ticket. Audit every fact before sending, including when cleanup succeeds.
- Before sending a helper split plan, fill [Disjoint helper branch brief](./references/templates.md#disjoint-helper-branch-brief). State that each branch has one writer and helpers never edit or touch the ticket branch; the plan is incomplete without that isolation and exclusive file allowlists.

## Setup

<!-- generic: machines -->
Works on one machine with no remote config. More machines need ssh key auth between them, plus `codex`, `node`, `gh` and this plugin on each, and each connection the bound provider names. Prerequisites, `config.env` keys and the checklist: [references/setup.md](./references/setup.md).
<!-- end generic: machines -->
> Provider `graph` (block `machines` of `fleet-skill.md`)

- Plugin version, first in every chat: run `node ../vibe/scripts/plugin-version.mjs provider` and make each connection call it names, then run the check `fleet-home.mjs resume` prints (`node ../vibe/scripts/plugin-version.mjs check --state <orchDir>/plugin-version.json`; no `--state` before a program exists) with the connection flags added as vibe's [Plugin version](../vibe/SKILL.md#plugin-version) says, escalated from the first try in Codex, and again escalated when its output has `"escalate":true`. On `outdated`, ask the operator: "A newer version of the plugins is available (<versions>). Update now, or proceed on this version? Proceeding on an outdated plugin could give worse results." Record the answer with `plugin-version.mjs choose --choice update|proceed --state <same file>` and in the resume log. On update, run `plugin-version.mjs update --choice update --state <same file>`, `--choice update` only because the operator said update; whatever its status, tell the operator which harness in its `restart` needs a new session or a reopened app, and stop when yours is one of them. On `unknown`, say the check could not run and carry on.
- After this current skill file is loaded, reconcile its hook-observed Skill/UserPrompt load evidence with `plugin-version.mjs loaded --runtime codex|claude --state <orchDir>/plugin-version.json`. The command cannot create load evidence itself; where no hook has recorded this conversation (Codex before its hooks are trusted) it answers `enforced: false`. Where enforced, on every wake `fleet-home.mjs resume` and prompt preflight refuse another brief when the exact actor/root/version/definition digest is absent, malformed or stale. Reload the current skill (or restart when the harness requires it), reconcile it again, and never continue from remembered steps.
- Setup check, once per chat, from that same check run: as vibe's [Setup check](../vibe/SKILL.md#setup-check) says, on `"print":true` show the operator its `block` word for word; on `"print":false` show nothing. A `not connected` line gets restored at once as vibe's [Restoring a connection](../vibe/references/preflight.md#restoring-a-connection) says, by you or a setup worker, never handed to the operator. A Codex line saying vibe-core is not installed or its hooks are not approved means no vibe guard runs in Codex: tell the operator right away in one plain line, before any writer launch. Installing goes through the update flow; approving is always the operator's own step, never a worker's: they need to open Codex once and approve vibe-core's hooks in /hooks.
- First run: when `<fleetHome>/config.env` is missing, or lacks a key this run needs, ask the operator once before launching anything, as one structured question set with the [first-run questions](./references/setup.md#first-run-interview) and their defaults. When the operator runs vibe, or the program is `one-writer` or `no-writer`, ask nothing: write the defaults and report them in one plain line. Write `config.env` and run the checklist's verification before replying; stating that you plan to do either action does not count. Report what passed.
- Later runs read `config.env` and do not ask again unless a verification fails.

## Roles

- Every ticket writer is a vibe session: Codex writers start or resume with a `$vibe` prompt naming the work item (`fleet.sh` refuses a new session without one), and Claude writers invoke `vibe:vibe` and follow its resume path. Vibe's scope, guardrails and ticket records only bind work done inside it. A bounded fleet helper on a separate branch is not a second writer in that ticket session and owns no ticket or plan record.
  The first new `$vibe` turn creates the session record; every later turn on the saved fleet thread must find a current active record for that worktree and branch. A hand-written stub does not count.
  `codex-session.mjs turn` refuses an existing `--cwd` without a Vibe-created active record matching the `$vibe` brief (and `--ticket` when present); pass a not-yet-existing path for `vibe new`, or use `cloud-worker.mjs` / pr-takeover for imported work.
  A not-yet-existing `--cwd` must be `<checkout>/.claude/worktrees/vibe-<slug>` in the repository the ticket changes; the thread's first turn runs in that checkout, so vibe's Codex hooks can record its load, and the brief tells the writer to run `vibe-sessions.mjs new --repo <checkout> --worktree <that path>`. A ticket in any repository other than the app checkout vibe-preflight remembered needs that `--repo`; without it `new` uses the remembered checkout.
  A first turn that ends before `vibe new` (a question, an early stop, a refused check) leaves a thread with no session record. Send it a `$vibe <same ticket>` turn to finish starting; `fleet.sh` refuses any other turn there, and refuses every `turn` while vibe's Codex hooks are not approved (re-approve them in Codex's `/hooks` after each vibe update).
- Reviews, handoff, ticket, environment and seed work go through vibe's own skills, workers and scripts (`vibe:handoff`, its reviewer and verify workers, `vibe:vibe-seed-refresh`), never ad hoc equivalents, so one process keeps one set of records and gates.
- You never edit a product repo; every change goes through a worker in its own worktree.
- One writer per branch at a time, Codex or Claude.
- Split remaining build work without an operator prompt only after proving two or more parts are independent and their exact files do not overlap each other or the ticket writer's concurrent files. Before registering helpers in a one-writer program, use the existing `fleet-home.mjs shape fleet` transition. On an allowed machine with capacity, give each helper its own branch, worktree and exclusive file allowlist for either proof tests of separate criteria or a whole new disjoint module or file set. Keep overlapping work and work dependent on unfinished writer code with the ticket writer. A helper edits only its allowlist, never the ticket branch, never repairs defects in ticket-writer code and never integrates. Send each defect to the ticket writer; that writer alone reviews and integrates returned commits or proof. Independent reviewers remain read-only and are not these helpers. Use [Disjoint helper branch brief](./references/templates.md#disjoint-helper-branch-brief) for each assignment.
- Reviewers, verifiers, QA prep and visual reviewers are read-only Claude subagents; a reviewer that fixes cannot be the independent check.
- Every reviewer, verifier and critic brief includes [Verify reviewer premises](../vibe/references/review-premises.md). Before relaying or endorsing a finding, independently recheck every material premise against its cited primary source; a citation alone is not proof and an `UNVERIFIED` premise cannot support a blocking finding. Do not accept an idle or turn-end event as the final deliverable.
- The operator gets QA, merges and enqueues, anything irreversible, and product decisions; you settle everything else (principle 1). Vibe's merge guard refuses `gh pr merge` on another author's pull request until the operator approves.
- Prefer the repo's or an installed plugin's specialist over a general-purpose agent. Repo-specific names below are examples.

| Role | Agent or skill | Plugin | Fallback when not installed |
|---|---|---|---|
<!-- generic: intel-row -->
| Overlap between work items, scope collisions, "did a human ask for this", drift tracing | `rg` over the code and `gh pr list --search` in each repository, read-only | none | none |
<!-- end generic: intel-row -->
> Provider `graph` (block `intel-row` of `fleet-skill.md`)
| QA plan per PR (plan-only) and the QA-guide session (one checkpoint at a time) | `closedloop-core:guided-manual-qa` in a Claude worker | closedloop-core | a written checklist from the criteria trace |
| Pre-merge local CI | the repo's local-CI skill (for example a `local-ci` skill wrapping dagger) | target repo | the repo's documented verify command |
| Design and visual review of a PR's UI, headless against the deployed preview | the repo's design-review and visual-qa skills and critic agents (for example `design-critic`, `visual-qa-critic`) | target repo | a Claude reviewer reading headless captures |
| Running app reproduction and verification | the repo's run-and-drive skill (for example `control`) in a Claude worker on an allowed machine, with displayless Desktop and headless browser modes only | target repo | headless captures; unsupported Desktop scenario left to automatically started CI |
| Turning a repeated mistake into a guard | `closedloop-core:prevent-recurrence` | closedloop-core | the lessons loop below |
| Writers, reviews, handoff, ticket, environment | vibe's own workers (above) | vibe | none; vibe is required |
| Watchers, pollers, narrow log diagnosis | Sonnet subagents; `codex-fleet-monitor` for the fleet; the `app-server-orchestrator` skill to steer Codex threads | vibe, Codex skills | `fleet.sh session last` polling |

## Programs with one writer or none

For one writer on one PR, or nobody writing code (design, research, analysis): `fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet` records the shape, `fleet-home.mjs shape` changes it before the program grows, and `board.mjs writer` refuses a writer the shape does not allow. Which sections apply:

<!-- generic: shapes -->
- Both shapes: Principles (evidence before every claim), Setup, Research, State and persistence (resume log, rulings), Pushback, Lessons loop, Artifacts people read, Reporting to the operator.
<!-- end generic: shapes -->
> Provider `graph` (block `shapes` of `fleet-skill.md`)
- one-writer, also: Roles, Related tickets become one unit, Monitoring, Codex sessions, Claude workers, Machines and CPU, Program practices; Quality gates and QA except merge order and shared version-file conflicts; from Fleet board and direct messages only its row and deliveries; from Moving work between runtimes and accounts only a takeover of its writer, which keeps the writer's board row name.
- no-writer, also: only read-only helpers from Roles and Claude workers, a heavy check you run from Machines and CPU, repo knowledge from Program practices; nothing else.

<!-- generic: research -->
## Research

Decide from evidence, not guesses (vibe's [repository-intelligence reference](../vibe/references/repository-intelligence.md)).

- Before assigning work or ruling between PRs, check the open PRs that touch the same files (`gh pr list` and each PR's changed files). Shared files count as overlap; assign one owner or an explicit merge order.
- Before dispatching an item, and in every QA-prep brief, check `rulings.md` and the operator's recorded answers for a newer ruling on the same capability; on a hit, stop and ask the operator.
- Before a shared change, read its callers and importers (`rg`).
<!-- end generic: research -->
> Provider `graph+tickets` (block `research` of `fleet-skill.md`)
- Trace a surprising difference in a before and after comparison to the commit and ticket that introduced it before blaming the PR.
- Attribute a file's origin or a first failure from local history only through `scripts/history-origin.mjs --repo <repo> --path <file>`.

## Related tickets become one unit

<!-- generic: units -->
With no provider, each work item the operator gives goes to its own writer, branch and PR; nothing groups items into units. A provider that has the `tickets` capability supplies the grouping.
<!-- end generic: units -->
> Provider `tickets` (block `units` of `fleet-skill.md`)
## State and persistence

- All state lives in one fleet home, never `/tmp` or a scratchpad: reused files at its top, each program under `programs/<slug>/` ([layout and a new chat's steps](./references/state.md)). `fleet-home.mjs start` and `resume` bind this chat to its program, so its hooks and scripts find it with no environment variable, and several orchestrator chats can share one home. `<orchDir>` below is the home or the program dir; give workers the program dir `resume` prints after `ACTIVE`, since a home running several chats' programs refuses a caller bound to none (`AMBIGUOUS-HOME`). `board.mjs status` fails on state written outside it.
- Write every prompt to `prompts/` before sending it, and keep the dated resume log; after a restart or compaction, follow a new chat's steps and tell the operator what you restarted (vibe's SessionStart hook puts that reading list in context after a compaction).
- In Claude Code, start orchestrator chats with `fleet-claude` (`fleet-home.mjs launcher --install`), which sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `<fleetHome>/context-guard.json` (`resume` seeds it), never via user settings. On vibe's flush prompt, update the state files; its PreCompact hook keeps them out of summaries.
- Validate every saved prompt with `scripts/skill-freshness.mjs` before sending it. Codex `fleet.sh` validates on the target host against that host's installed plugin and target writer state; review-helper registration binds its exact worker/definition; the Claude launcher and SendMessage hook enforce their dispatch boundaries. A real target-repository shorthand path wins over plugin shorthand. An explicit or absent plugin script path is a refusal, never a reason to search the whole home folder.
- When the operator changes the program (no build, design only, another PRD, start over), append the quoted ruling to `rulings.md` and a resume-log entry naming the new program before acting on it (vibe's `program-change` hook reminds you); a different program is `fleet-home.mjs start <slug>`.
- A remote machine that lost session state cannot reattach its Codex threads: start fresh ones in the same worktrees with [resume prompts](./references/templates.md#resume-prompt).

## Monitoring

Run [codex-fleet-monitor](../codex-fleet-monitor/SKILL.md) (`vibe:codex-fleet-monitor`) on the same `<orchDir>` in the background for the whole program and act on its lines as its table says. It reads the session state files `fleet.sh` writes, listed as `local|remote <name>` in `sessions.txt`.

- On every PR merged or closed monitor event, run `node scripts/helpers.mjs <orchDir> status` to reconcile recorded leftovers for that PR before reporting fleet status. Its owned lifecycle stops only exact recorded identities after rechecking their creation witnesses; leave foreign or unrecorded resources untouched. Report the recorded helper reconciled now, Docker outcome, untouched foreign resources and status with owner and ticket. An operator request is not a prerequisite for reconciliation.
- After that terminal status, run `scripts/fleet.sh <orchDir> local|remote cleanup` on each machine that owns a finished writer worktree. The remote route ships the exact board snapshot and runs the installed cleanup script against that host's session state. It reads `board.mjs writer --pr` evidence and live PR state before registering a finished worktree; open PRs back off and active or dirty work remains. Never remove a remote worktree from the primary host.
- Run the watcher's supervisor on every machine that hosts Codex writers. Set `AUTO_RESTART_DAEMON=1` only when the operator agrees.
- Re-arm the watcher in the same step you read each event. Before ending any turn that handled an event, `node ../codex-fleet-monitor/scripts/watcher.mjs <orchDir>` must print `watcher ok`; on `MISSING` (`board.mjs status` prints `WATCHER-MISSING`), re-arm it, never with `&`.
- The armed watcher is your heartbeat (`HEARTBEAT` every 30 quiet minutes); on every wake read every teammate message first. While the operator is away, also keep a recurring schedule (loop or cron, 20 to 30 minutes) that does the same and checks `watcher.mjs`. Recovery resumes an idle Codex writer on its default once its question's deadline passes.
- Answer a writer's question within 15 minutes, echoing its id (`board.mjs <orchDir> answered <writer> --id <id> --text <answer>`); send other mid-run changes to what it builds as `deliver <id> --kind scope --to <writer> --text <change>`, a message naming the id, then `told`. The watcher and `board.mjs status` flag `QUESTION-UNANSWERED`, `UNACKED` and `UNACKED-SCOPE` after 15 minutes, and `SCOPE-NOT-STARTED` for a worktree still clean at its old head 30 minutes on.
- On a `HOOK-APPROVAL <machine>` line (that machine's Codex vibe or vibe-core changed version and a vibe-core hook now needs approval), relay it to the operator at once in one plain line; approving is theirs, never a worker's.
- On `STALE-PR` (a PR needing its writer with no push for 45 minutes), ask the owning writer for an ETA, unblock it, or reassign it, whatever it reports being busy with.
- Push only a declared push-ready head (`--ready <sha>`). Review and verification accept the uncommitted diff before its first commit; then commit once, declare, push once and open the PR. `writer --base <remote-ref|OID>` records the verified pre-PR parent; parent commits are never ready. The live GitHub base is authoritative afterward. `push-check` must print `READY`; `status`/`watch-lines` flag undeclared local commits as `UNREADY-COMMIT` and unreadable history/base as `PUSH-READY-UNKNOWN`. Restore evidence before pushing; cadence never authorizes checkpoint commits. Operator ruling, 2026-10-29: "every commit to an open PR is a sign of a bad orchestration framework. we should codify this to never happen again. we don't commit until we're sure that commit is push ready."
- For an in-flight branch that already has old checkpoint commits, treat its current pushed PR head as historical baseline. Never rewrite it or declare its ancestors ready; keep the next repair uncommitted until one new head is push-ready. A remote board row uses `--where remote --base <full OID>`: `NO-HEAD` is informational because its owning machine checks history, while this board still requires the exact declared ready head before push.
- Before opening a PR, reviewers inspect the uncommitted change identified by HEAD plus diff/tree hashes. After opening, compare published evidence with the pushed PR head (`gh pr view <n> --json headRefOid`); observe automatically started checks and reviews, never manually trigger another review.

## Codex sessions

> Read `references/fleet-codex-sessions.md` (block `codex-sessions-rules`) when a Codex writer session is started, steered, read or ended.

## Claude workers

- Launch each Claude writer with the [worker preamble](./references/templates.md#worker-preamble) saved to `prompts/`.
- Hold an agent with TaskStop, never a message; check nothing it started still runs.
- Batch asks to a writer at milestones; side work goes to read-only workers.
- A pane teammate sees messages only when its turn ends, so writers keep turns short. On `UNACKED`, or an idle worker that ignored a message, resend once, then interrupt after the second unanswered delivery: ask the operator to press Esc in the named pane. A resend never reaches a writer mid-turn: on `UNACKED-SCOPE` or `SCOPE-NOT-STARTED` interrupt at once, or TaskStop and relaunch it with the change in its prompt. Keep long briefs in a file and send its path.
- A standing duty (main's post-merge health, a PR shepherd, the watcher) always has a live owner: `board.mjs <orchDir> duty <duty> --owner <writer or helper>`. Name the replacement in the same step you stop or move its owner; `helpers.mjs stopped` refuses an owner, and `board.mjs status` prints `UNOWNED-DUTY`.
- Register each reviewer, verifier or critic helper with `helpers.mjs <orchDir> start <name> --kind reviewer|verifier|critic --worktree <source worktree> --worker-id <actual native ID> --capabilities <parent-discovered capability record> --brief <file>`; it captures source identity at start. The helper writes its final deliverable with the exact last line `FINAL <recorded token> <start tree hash> <worker ID> <session ID> <turn ID> completed`, then calls `helpers.mjs <orchDir> final <name> --deliverable <file> --session-id <id> --turn-id <id> --out <private report>` after it actually finishes. When App Server `thread/read` can identify that thread, save its response and pass `--completion-event <file>` so `final` and `stopped` verify the completed turn. Independently read and verify the deliverable and every premise before `helpers.mjs <orchDir> accepted <name> --report <private report>`; only then call `stopped`. An idle or turn-end notification is never acceptance. `accepted` and `stopped` refuse a missing, nonfinal or stale report. Non-review operational helpers use `--kind other` and keep their existing cleanup lifecycle. Run `helpers.mjs <orchDir> status` with every monitor event (including terminal PR changes, `STOP` and `ORPHAN`). A helper records each process it starts with `helpers.mjs <orchDir> pid <name> <pid...>` (`--group` only for one it spawned detached), and `stopped` ends them.
  For Codex review roles, launch a managed App Server thread (using the existing App Server orchestrator), record its exact thread ID as `--worker-id`, and pass `--runtime codex --role <agent name> --agent-definition <canonical agent file>` at start. The receipt reader requires `thread/read` to return that thread's completed turn and MCP items. A native subagent without a readable managed thread cannot clear review through a hand-authored tool-call list.
- A long-lived QA helper records its owner, ticket, repository, PR and ending condition when it starts; reserve an empty unique Compose project before starting it, then record exact Docker resources after creation. `helpers.mjs status` reconciles a recorded QA stack when its PR merges or closes, including containers, volumes and networks, and lists any leftover with owner and ticket. Do not clean a process or Docker resource without its matching recorded identity. A refusal stays in the ledger for the next monitor event.
- For a PR-owned QA stack, register `helpers.mjs <orchDir> start <name> --owner <writer> --ticket <slug> --repo <owner/repo> --pr <n> --ending pr-terminal --project <compose>` before startup. `pr-terminal` is the only accepted ending value. After startup, run `helpers.mjs <orchDir> resources <name> --project <compose>` to capture the exact container, volume and network identities and creation witnesses. A reserved project cannot be marked stopped until those records reconcile; a read failure stays visible as a leftover.
- Per-ticket PostgreSQL, performance and seed scratch stacks use `scripts/helpers.mjs <orchDir> scratch-run <name> --owner <writer> --ticket <slug> --worktree <path> --ttl-seconds <60..86400> --compose-file <file>`. It reuses `helpers.mjs start/resources`, labels services and named data resources, and refuses locally built service images it cannot prove owned. The scheduled cleanup sweep reconciles expired stacks after the writer lease ends; `helpers.mjs status` reports due stacks. Raw scratch Docker starts are refused in scoped vibe/fleet Bash calls.
- The recorded owner may explicitly retire an abandoned scratch stack before its TTL with `helpers.mjs <orchDir> stopped <name> --owner <writer> --owner-token <recorded token>`; any other owner or token is refused and the same exact Docker witnesses still govern cleanup. A stack whose writer lease still says `active` is not reaped automatically; its recorded owner must use this explicit stop.

## Fleet board and direct messages

`scripts/board.mjs` keeps `<orchDir>/board.md`, the page every writer reads:

> Provider `tickets` (block `status-sweep` of `fleet-skill.md`)
- When you launch a writer, add its row (`board.mjs <orchDir> writer <name> --tickets <a,b> --runtime codex|claude --where local|remote --worktree <path> --pr <n> --repo <owner/repo> --head <sha> --status <text> --deps <a,b>`) and its PR's `<owner/repo> <n> <writer>` line to `prs.txt`. Update the row on every push report.
<!-- generic: ruling-renderers -->
- A settled UX ruling is saved once as a reference file with its screenshots in a shared evidence location. Find every renderer of the behavior with `rg` across each open PR's diff and main, then `board.mjs <orchDir> deliver <ruling> --kind ruling --reference <file> --to <every owning writer and QA guide>`. Every QA plan for that behavior cites it; one shared component beats each PR building its own.
<!-- end generic: ruling-renderers -->
> Provider `graph` (block `ruling-renderers` of `fleet-skill.md`)
- When QA prep marks a human checkpoint ready, or rebinds results, `deliver <checkpoint> --kind checkpoint --head <sha> --to <guide>` and message the guide yourself with the checkpoint, its launch steps and the head.
- After each message, `board.mjs <orchDir> told <item> <recipient>`. Run `board.mjs <orchDir> status` with every monitor event and act on each line: `STALE` (the board misses a pushed head), `UNTOLD`, `UNOWNED-DUTY`. A `SLOW` row is a Codex writer 30 minutes without a push on a PR with unresolved human threads: have it push and hand the branch to a Claude writer.

## Moving work between runtimes and accounts

> Read `references/fleet-recovery.md` (block `recovery-rules`) when a writer must move runtime, account or machine, a writer is dead, a `codex-usage` or `claude-usage` band reaches its limit, a `codex-usage` band will reach `MOVE_AT_PERCENT` before the work is done, the operator reports high Claude usage, or an engineer takes over a pull request.

## Machines and CPU

- Run heavy checks (full suites, typecheck, repo-wide lint and other gates, component story runs) through `scripts/fleet.sh <orchDir> local|remote slot heavy <owner> <worktree> <command...>`, in the worker's own worktree on that machine ([checklist step 4](./references/setup.md#checklist) gets the branch there). It caps runs at `HEAVY_SLOTS` or `REMOTE_HEAVY_SLOTS` and refuses a machine over `MAX_LOAD_PER_CORE` (exit 4): send the run to the other machine. Only the operator may override that routing by setting `FLEET_FORCE_HERE=1` with `FLEET_FORCE_REASON` to the reason they chose; the reason is written into the slot holder record. Writers never set `FLEET_FORCE_HERE`, its reason, or `FLEET_LOAD`; production admission always reads the target machine. A force is still refused above the fixed hard ceiling of four times the core count. When the force or its reason is absent, normal routing applies. Exit 78 means the containerized E2E disk preflight refused the command or the remote host did not have the exact required vibe version; its stderr names which cause. Keep the operator's daily machine for edits and git; e2e and desktop app runs never go there.
- A verified `e2e/run-containerized.sh` or `dagger call e-2-e` build receives the shared Docker backing-disk check inside the acquired slot, immediately before its command. Pass `--containerized-e2e-build` after the worktree path when a wrapper obscures that exact command shape. The check requires 64 GB decimal free; `--no-build`, lint, typecheck, tests and Storybook do not take this Docker disk gate. The remote slot verifies the installed vibe version and invokes its same admission subcommand on the owning host.
- Before reporting or waiting on remaining work, identify true dependencies. Start independent repository selected integration, unit, typecheck and lint lanes at once through available heavy slots on allowed machines, even while e2e is queued or running elsewhere. A lane waiting only for a full slot or load moves to another allowed machine with capacity; report the move. Respect operator exclusions, machine load and slot limits, no dagger restrictions and the daily machine's no visible e2e rule. Keep the repository lane selector and `qa-impact.mjs` decision on which checks are needed.
- A shared e2e stack with fixed ports runs only under vibe's machine-wide e2e lock: `node ../vibe/scripts/e2e-lock.mjs run --head <sha> --source-hash <treeSha256> --owner <writer> --ticket <slug> <command...>` on the machine that runs it, never a second lock; receipts name HEAD plus diff/tree hashes, including dirty source. Each run gets its own compose project, so a teardown removes only its own stack; name a stack another tool started with `--foreign-compose <project>`. Unit tests, typecheck, story runs and stand-in server tests run outside it.
- `scripts/slot-lock.sh --status <lockName>` on a machine lists slot holders.
- Kill only processes you started, by recorded pid; vibe-core's `hooks/kill-guard.mjs` refuses the rest. Tests that send signals run on another machine, never the operator's daily one.
- Plugin marketplaces and env files on a remote machine live in persistent paths too.

## Quality gates and QA

- A writer starts only once its plan holds a numbered acceptance-criteria list, each criterion sourced to a ticket AC, a PRD line or an operator ruling; a mid-flight ruling joins it with its date. Nobody is in the loop to ask while the build runs.

> Read `references/fleet-qa-gate.md` (block `qa-gate-rules`) when a pull request is being reviewed, QA'd or prepared to enqueue.

## Pushback

Pushback applies principle 2; more patterns: [references/judgment.md](./references/judgment.md).

- Debt to push back on includes parallel code paths, shims and a second owner for the same behavior; forwarding it for approval as is makes the operator do your review.
- Honor the repo's reserved writer policy for generated files. Keep a feature PR off a bot owned screen map, never hand resolve its conflicts, and put the repo's prescribed screen change lines in the PR body. A generator change follows the repo's explicit exception.
- No agent adds a key to the team's feature-flag service without the operator approving that key ([approval template](./references/templates.md#flag-approval)). Prefer one key per program or surface; corrections and removals are never gated.
- An instruction to match a prototype or design never removes what main ships: diff main's shipped controls against the target before briefing a writer, and keep any it leaves out unless a human source retires it.
- Never invent product behavior or user-facing copy; cite the human source. Never write a row the repo reserves for human attestation; read the owning check's header and ask the operator.
- Respect operator boundaries on other teams' work, such as "don't fix main" while another owner is fixing it.
- Work outside the program goes to its owner (operator ruling): a security or infrastructure finding outside its scope becomes a ticket assigned to that owner, and the worker investigating it stops.

## Program practices

- Green watch: `board.mjs` requires a `green-watch` owner while PRs are watched (`MISSING-DUTY`); a Sonnet watcher runs `green-watch.mjs --repo <owner/repo>` for each `NEW-RED`, checks each mock block with `mock-gap.mjs`, and starts an Opus fixer for attribution or a fix: a vibe writer (Claude `vibe:vibe`, Codex `$vibe`) briefed by `GREEN_WATCH_AGENT`, stopped after merge. A watcher that cannot SendMessage writes an atomic Markdown event under `<orchDir>/events/`; `watch.sh` surfaces it. The fix passes lanes, `pr-preflight.mjs` and guardrails. Attribute from `gh pr view <n> --json author,headRefName`, never a worker's word. For a visual baseline, compare the diff and record its counted `Baseline inventory:` plus one cited `Baseline element:` per new element; "plausibly intended" never passes. File another author's red only once that PR's ticket, PRD and design rulings show the change was not asked for (a requested change is accepted and cited). After core work, run the full e2e suites on main yourself on the CI-identical runner; a fix auto-merges only after its specs and latest reds pass.
- Repo knowledge: a repo fact a worker learns goes into the team's repo memory (`REPO_MEMORY_CMD`), and into the nearest `AGENTS.md` through that worker's PR when it binds code.
- Deadline mode, only when the operator rules it (record it in `rulings.md` with its end): no pre-merge e2e (`pre-pr-lanes.mjs --skip <lanes> --skip-ruling <the ruling>`), follow-up pushes run focused tests plus the affected typecheck and leave full lanes to CI, and extras ship in follow-up PRs.
- Runtime choice: judgment-heavy work and takeovers go to Claude writers, which are faster; bulk mechanical work goes to Codex on `CODEX_MODEL`, which is cheaper. Move work on usage and speed.

### Cloud workers

Before every writer start, whatever the routing switch below says, record the ticket's placement: `board.mjs <orchDir> placement <ticket> --evidence <file>` (`{codeOnly, needsRunningApp, localEvidence[]}`) runs the one check, vibe-core's `lib/fleet-orchestrator/scripts/cloud-placement.mjs`. `board.mjs writer --tickets`, and `unit --writer` folding into a running writer, refuse a ticket with no decision, and a cloud one unless the operator's reason is recorded with `--keep-local <reason>`. An imported cloud task given a local writer row records `--keep-local "cloud import <task id>"`. Cloud is code-only work needing no running app or local evidence, dispatched with `../vibe/scripts/cloud-worker.mjs` (a wrapper; the code is vibe-core's `lib/vibe/scripts/cloud-worker.mjs`), which refuses anything else. From the Vibe session, locked criteria and local graph results, run its `record-evidence`, then `dispatch --request <file>`; `poll` and `import` resume and return the task to Vibe. After the unchanged local handoff, full lanes and an independent review (a Claude import takes Codex or a launcher reviewer run with `"reviewModel": "claude-fable-5-2"`, never the writer; a Codex import takes Claude), run `refresh-import` before `ready` or opening a PR. The existing PR guard enforces the import witness. Keep graph research in the brief, never a cloud connector. Claude clears auto-attached connectors before run.
- Claude cloud runs only in a configured environment (`VIBE_CLOUD_CLAUDE_ENV`, or `CLOUD_CLAUDE_ENV` in `config.env`); run `../vibe/scripts/cloud-worker.mjs check` before the first dispatch, and act on each failure's named fix.
- Cloud work goes through `cloud-worker.mjs` (Claude Code routines), never an Agent launched with `isolation: remote`, which can run locally; every cloud report states the host, repository and commit it ran on.
- To test a pushed head with no Vibe session, `validate --request <file>` (branch, full commit, model, lanes `[{name, command}]`, a local checkout as `worktree`; the repository comes from its GitHub origin and the install from the tree's lockfile unless `repository` or `install` is given) runs those lanes on that exact commit in Claude cloud, changes nothing, and refuses a result for another commit or with a changed file. Codex is refused: its CLI returns no report.
- Off by default, and never the placement: `node scripts/dispatch-route.mjs --manifest <triage manifest> [--codex-usage <line> --codex-read-at <time>] [--claude-usage <line> --claude-read-at <time>]` (`FLEET_CLASS_ROUTING=1`) names the runtime for a ticket from its class and the usage lines, each used only with a read time no older than 30 minutes and never when it reports an unknown reading, and whether its pull request gets a QA-guide session; `node scripts/dispatch-budget.mjs` (`FLEET_BUDGET_GUIDANCE=1`) says how many heavy runs the shared worker budget has room for when `VIBE_HEAVY_BUDGET=on`, and otherwise the slot count. `slot heavy` still enforces its caps.

## Lessons loop

- Log every finding you route to a writer in the lessons ledger at the same moment, tagged new or repeat, with owner and fix. Format: [references/state.md](./references/state.md#lessons-ledger).
- A repeat after a shipped fix means the earlier encoding did not bite: make it a gate, not more prose.
- A plugin PR that encodes lessons replaces the prose its gate enforces and reports the net change in instruction length, measured at the final head with `node scripts/instruction-words.mjs --base <last release> --changelog CHANGELOG.md --version <x.y.z>`. The plugin must not get heavier.
- Batch lesson and tooling fixes into one open PR per repo until it merges. Before opening one, `node scripts/lessons-pr.mjs --repo <owner/repo>` must print `no open lessons PR`; otherwise push onto the branch it names.
- A lesson's primary fix lives in vibe itself (writer instructions plus a mechanical check), since many run vibe without an orchestrator; a rule here is a second layer. Lessons PRs encode general rules; one repo's rules, paths and component names go in that repo's own files.

## Artifacts people read

Hard rule: a ticket, PR body, comment, reply or other artifact for people never names a path on the operator's machine or says something is on someone's laptop. Evidence is embedded (screenshots as inline images, text quoted briefly); a plan is a linked plan document or a ticket attachment, never a path. Check every worker draft before it is posted; vibe's ticket and PR body checks refuse a local path.

## Reporting to the operator

- Surface every problem the moment you see it: limits, stalls, failures, new human review comments, blockers. Keep status updates short.
- For a remaining-work answer, compute time to ready from the dependency graph's longest dependent path, not a sum of independent lanes. Use the [Remaining work report](./references/templates.md#remaining-work-report). The response is incomplete until it states the duration and names the dependent steps and assumptions that produce it.
- Before reporting a count or an "only" claim from a command you ran, check that it exited 0 and that no `head`, `tail` or tool truncation cut its output; otherwise rerun the narrow command or call the figure partial. Principle 2 holds for your own findings too.
- When the operator steps away (vibe's `away-protocol` hook puts this checklist in context on "brb", "stepping away" and the like, and the return checklist on "I'm back"), keep `<orchDir>/attention.md` current (decision needed, recommendation, what is blocked), keep reading idle writers' last messages, and lead with that list on return.
- Put every finding the operator reviews on one page using the stable `D`, `X`, `N`, `S` and `R` IDs in the [operator review template](./references/templates.md#operator-review-page); never restart numbering across audits.
- The final report lists, per PRD, which flags must be on to see each change.
- Before a PRD is marked executed, `node ../handoff/scripts/executed-check.mjs --kind prd --file <PRD text> --last-merge <time> --children <its PRODUCES children read now>` must pass; report open children instead.
