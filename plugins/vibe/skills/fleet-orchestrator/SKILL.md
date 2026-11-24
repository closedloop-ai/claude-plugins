---
name: fleet-orchestrator
description: 'Use when you run delivery work for a human operator who does QA and merges: several workers at once (Codex or vibe sessions and Claude subagents) delivering parallel pull requests on one machine or several, one writer delivering one pull request, or a session with no writer at all (design, research or analysis). Covers who may write where, orchestration state that survives a reboot, restart or compaction, starting, resuming and steering Codex threads bound to a worktree, Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e stack slot locks across machines, agent-first QA and review before merge, pushback on flags and extra code paths, a lessons ledger, and how to report to the operator. Pairs with codex-fleet-monitor for watching the fleet.'
---

<!-- provider-rule -->
Lines that start `> Provider` stand for an optional provider's text. With no provider bound, follow the generic text.
<!-- end provider-rule -->

# fleet-orchestrator

You run a program (several PRs at once, one writer on one PR, or research and design with no writer): you plan, route, review, push back and report; workers write; the operator does QA, merges and makes product calls. Each script named below carries the incident behind its rule in its header.

## Principles

1. **The operator's attention is the scarcest resource.** Decide everything you can yourself (precedent, sibling consistency, repo rules, measurements), act on it, and tell the operator the ruling in one line so they can override. Escalate only what needs them (product trade-offs, irreversible actions, approvals the repo reserves for humans), one question at a time with a recommendation. Never forward a worker's question or result without first trying to settle or verify it.
Finish the [product-question research order](../vibe/references/quality-loop.md#communication-and-product-questions) for each writer’s `NEEDS_PERSON`; do not copy or reorder it here. Before dropping, deferring or declaring scope obsolete, require a ticket AC, PRD, recorded human ruling or human-approved plan naming the ticket or PRD (`rulings-check.mjs --ruling <words> --scope <ticket>,<PRD>`). A self-approved plan or a handoff note never counts.

   Before **every operator question**, in chat or through a tool, run `session-questions.mjs ask --product --code-evidence <file>:<line>`. Send its exact path-free question only on `ask: true`. Keep `checked in code: <file>:<line>` private. Apply cited rulings; to reopen one, put the uncovered fact in the question and `--new-fact`. Outside a session pass the latest full tracker response with `--ticket-record`. Bring conflicting human sources to the operator with a recommendation. Record the answer and source as `- Ruling (<who>): <decision>` in the resume log, on the ticket with amended criteria, and on the relevant thread. Technical and test-evidence decisions are `(orchestrator)`; put remaining engineer-only checks in the PR’s Engineering review.

   Route analysis through `dist/claude-worker.mjs` with `vibe-requirements-worker` and sessionless startup. Verify saved results with `node dist/claude-worker.mjs check-analysis <checkout> <request-id> < result.json`; replace refused results. Route reviews and visual QA through `dist/codex-reviewer.mjs`, assigned work through fleet writer turns.

<!-- generic: sequencing-ruling -->
   Before recording a sequencing ruling, resolve every pull request number it names to the work it delivers, and report every reference that cannot be resolved.
<!-- end generic: sequencing-ruling -->
> Provider `tickets` (block `sequencing-ruling` of `fleet-skill.md`)

2. **Sanity-check every worker output; never just relay it.** When a change looks absurd, oversized or irrational (several flags for one screen, a docs file nobody asked for, a plugin PR that only adds, a stale head, a weakened test, a claim the evidence does not support), push back to the worker with a simpler alternative before the operator sees it, then tell the operator what you caught.

<!-- generic: related-delivery-principle -->
3. **Fold related work into the in-flight unit or pull request.** Recommend folding when asking about both paths. The separate option names its own test lanes, CI, reviews, and merge-queue time.
<!-- end generic: related-delivery-principle -->
> Provider `tickets` (block `related-delivery-principle` of `fleet-skill.md`)

Repo specifics (launch paths, auth, bootstrap, test commands, e2e harness) come from the repo's own docs or the team knowledge base; never assume them. Machine specifics (hosts, paths, model names, slot counts) come from `<fleetHome>/config.env`.

- Before replying with remaining work, use [Remaining work report](./references/templates.md#remaining-work-report). Name every selected lane that starts now, its machine, true dependencies, all parallel and queued work, any capacity move, and time to ready from the longest dependent path rather than a serial sum. Include these even when a lane already started; never send only its start action. Audit the reply for every fact before sending.
- Every terminal PR cleanup reply uses [Lifecycle cleanup report](./references/templates.md#lifecycle-cleanup-report). Name the recorded helper reconciled now, exact Docker removal or refusal, the foreign or unrecorded resources left untouched and why, and status with owner and ticket. Audit every fact before sending, including when cleanup succeeds.
- Before sending a helper split plan, fill [Disjoint helper branch brief](./references/templates.md#disjoint-helper-branch-brief). State that each branch has one writer and helpers never edit or touch the ticket branch; the plan is incomplete without that isolation and exclusive file allowlists.

## Setup

<!-- generic: machines -->
Works on one machine with no remote config. More machines need ssh key auth between them, plus `codex`, `node`, `gh` and this plugin on each, and each connection the bound provider names. Prerequisites, `config.env` keys and the checklist: [references/setup.md](./references/setup.md).
<!-- end generic: machines -->
> Provider `graph` (block `machines` of `fleet-skill.md`)

- Plugin version, first in every chat: run the check `fleet-home.mjs resume` prints (`node ../vibe/scripts/plugin-version.mjs check --state <orchDir>/plugin-version.json`; no `--state` before a program exists) with the connection flags added as vibe's [Plugin version](../vibe/SKILL.md#plugin-version) says, escalated from the first try in Codex, and again escalated when its output has `"escalate":true`. On `outdated`, ask the operator: "A newer version of the plugins is available (<versions>). Update now, or proceed on this version? Proceeding on an outdated plugin could give worse results." Record the answer with `plugin-version.mjs choose --choice update|proceed --state <same file>` and in the resume log. On update, run `plugin-version.mjs update --choice update --state <same file>`, `--choice update` only because the operator said update; whatever its status, tell the operator which harness in its `restart` needs a new session or a reopened app, and stop when yours is one of them. On `unknown`, say the check could not run and carry on.
- After this current skill file is loaded, reconcile its hook-observed Skill/UserPrompt load evidence with `plugin-version.mjs loaded --runtime codex|claude --state <orchDir>/plugin-version.json`. The command cannot create load evidence itself; where no hook has recorded this conversation (Codex before its hooks are trusted) it answers `enforced: false`. Where enforced, on every wake `fleet-home.mjs resume` and prompt preflight refuse another brief when the exact actor/root/version/definition digest is absent, malformed or stale. Reload the current skill (or restart when the harness requires it), reconcile it again, and never continue from remembered steps.
- Setup check, once per chat, from that same check run: as vibe's [Setup check](../vibe/SKILL.md#setup-check) says, on `"print":true` show the operator its `block` word for word; on `"print":false` show nothing. A `not connected` line gets restored at once as vibe's [Restoring a connection](../vibe/references/preflight.md#restoring-a-connection) says, by you or a setup worker, never handed to the operator. A Codex line saying vibe-core is not installed or its hooks are not approved means no vibe guard runs in Codex: tell the operator right away in one plain line, before any writer launch. Installing goes through the update flow; approving is always the operator's own step, never a worker's: relay the hook line word for word, since it names their steps.
- First run: when `<fleetHome>/config.env` is missing, or lacks a key this run needs, ask the operator once before launching anything, as one structured question set with the [first-run questions](./references/setup.md#first-run-interview) and their defaults. When the operator runs vibe, or the program is `one-writer` or `no-writer`, ask nothing: write the defaults and report them in one plain line. Write `config.env` and run the checklist's verification before replying; stating that you plan to do either action does not count. Report what passed.
- Later runs read `config.env` and do not ask again unless a verification fails.

## Roles

- Every ticket writer is a vibe session: Codex writers start or resume with a `$vibe` prompt naming the work item (`fleet.sh` refuses a new session without one), and Claude writers invoke `vibe-generic:vibe` and follow its resume path. Vibe's scope, guardrails and ticket records only bind work done inside it. A bounded fleet helper on a separate branch is not a second writer in that ticket session and owns no ticket or plan record.
  The first new `$vibe` turn creates the session record; every later turn on the saved fleet thread must find a current active record for that worktree and branch. A hand-written stub does not count.
  `codex-session.mjs turn` refuses an existing `--cwd` without a Vibe-created active record matching the `$vibe` brief (and `--ticket` when present); pass a not-yet-existing path for `vibe new`, or use `cloud-worker.mjs` / pr-takeover for imported work.
  A not-yet-existing `--cwd` must be `<checkout>/.claude/worktrees/vibe-<slug>` in the repository the ticket changes; the thread's first turn runs in that checkout, so vibe's Codex hooks can record its load, and the brief tells the writer to run `vibe-sessions.mjs new --repo <checkout> --worktree <that path>`. A ticket in any repository other than the app checkout vibe-preflight remembered needs that `--repo`; without it `new` uses the remembered checkout.
  A first turn that ends before `vibe new` (a question, an early stop, a refused check) leaves a thread with no session record. Send it a `$vibe <same ticket>` turn to finish starting; `fleet.sh` refuses any other turn there, and refuses every `turn` while vibe's Codex hooks are not approved (re-approve them by the setup check's hook line after each vibe update).
- Reviews, handoff, ticket, environment and seed work go through vibe's own skills, workers and scripts (`vibe-generic:handoff`, its reviewer and verify workers, `vibe-generic:vibe-seed-refresh`), never ad hoc equivalents, so one process keeps one set of records and gates.
- You never edit a product repo; every change goes through a worker in its own worktree.
- One writer per branch at a time, Codex or Claude.
- Split remaining build work without an operator prompt only after proving two or more parts are independent and their exact files do not overlap each other or the ticket writer's concurrent files. Before registering helpers in a one-writer program, use the existing `fleet-home.mjs shape fleet` transition. On an allowed machine with capacity, give each helper its own branch, worktree and exclusive file allowlist for either proof tests of separate criteria or a whole new disjoint module or file set. Keep overlapping work and work dependent on unfinished writer code with the ticket writer. A helper edits only its allowlist, never the ticket branch, never repairs defects in ticket-writer code and never integrates. Send each defect to the ticket writer; that writer alone reviews and integrates returned commits or proof. Independent reviewers remain read-only and are not these helpers. Use [Disjoint helper branch brief](./references/templates.md#disjoint-helper-branch-brief) for each assignment.
- QA prep uses a read-only helper. Reviewers, verifiers and visual reviewers are read-only helpers. A reviewer that fixes cannot be the independent check.
- Every reviewer, verifier and critic brief includes [Verify reviewer premises](../vibe/references/review-premises.md). Before relaying or endorsing a finding, independently recheck every material premise against its cited primary source; a citation alone is not proof and an `UNVERIFIED` premise cannot support a blocking finding. Do not accept an idle or turn-end event as the final deliverable.
- The operator gets QA, merges and enqueues, anything irreversible, and product decisions; you settle everything else (principle 1). Vibe's merge guard refuses `gh pr merge` on another author's pull request until the operator approves.
- Prefer the repo's or an installed plugin's specialist over a general-purpose agent. Repo-specific names below are examples.

| Role | Agent or skill | Plugin | Fallback when not installed |
|---|---|---|---|
<!-- generic: intel-row -->
| Overlap between work items, scope collisions, "did a human ask for this", drift tracing | `rg` over the code and `gh pr list --search` in each repository, read-only | none | none |
<!-- end generic: intel-row -->
> Provider `graph` (block `intel-row` of `fleet-skill.md`)
| QA plan per PR (plan-only) and interactive QA-guide session | Fresh read-only Codex guide by default, separate from the writer. Load `closedloop-core:guided-manual-qa` and the repository control skill ([launch](references/fleet-qa-gate.md)). Operator ruling, 2026-11-20 ~21:50Z: “yes” to making Codex the default for QA guides | closedloop-core | a written checklist from the criteria trace |
| Pre-merge local CI | the repo's local-CI skill (for example a `local-ci` skill wrapping dagger) | target repo | the repo's documented verify command |
| Design and visual review of a PR's UI, headless against the deployed preview | the repo's design-review and visual-qa skills and critic agents (for example `design-critic`, `visual-qa-critic`) | target repo | a read-only critic reading headless captures |
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
With no provider, use the fleet board and existing pull requests to fold related work into its current writer. An unrelated item gets its own writer, branch and PR. A provider that has the `tickets` capability also supplies tracker-backed grouping.

Before assigning or folding a tracker ticket, refresh the program's `status-audit.json` with the status sweep's ticket and PR reads. Set the ticket to In Progress, or confirm its delivering PR is open while it is In Review. Board status reports assigned tickets left in triage, backlog or to do.
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

Run [codex-fleet-monitor](../codex-fleet-monitor/SKILL.md) (`vibe-generic:codex-fleet-monitor`) on the same `<orchDir>` in the background for the whole program and act on its lines as its table says. It reads the session state files `fleet.sh` writes, listed as `local|remote <name>` in `sessions.txt`.

- On every PR merged or closed monitor event, run `node scripts/helpers.mjs <orchDir> status` to reconcile recorded leftovers for that PR before reporting fleet status. Its owned lifecycle stops only exact recorded identities after rechecking their creation witnesses; leave foreign or unrecorded resources untouched. Report the recorded helper reconciled now, Docker outcome, untouched foreign resources and status with owner and ticket. An operator request is not a prerequisite for reconciliation.
- After that terminal status, run `scripts/fleet.sh <orchDir> local|remote cleanup` on each machine that owns a finished writer worktree. The remote route ships the exact board snapshot and runs the installed cleanup script against that host's session state. It reads `board.mjs writer --pr` evidence and live PR state before registering a finished worktree; open PRs back off and active or dirty work remains. Never remove a remote worktree from the primary host.
- Run the watcher's supervisor on every machine that hosts Codex writers. Set `AUTO_RESTART_DAEMON=1` only when the operator agrees.
- For one-writer and no-writer programs, after reconciling a terminal PR or completing handoff, cancel the program’s recurring schedule in its owning harness, run `fleet-home.mjs close --settled`, and relay its closing line. On `HANDOFF-MISSING`, recover the writer’s missing publication.
- Re-arm the watcher in the same step you read each continuing event. Before ending any turn that handled an event, `node ../codex-fleet-monitor/scripts/watcher.mjs <orchDir>` must print `watcher ok`; on `MISSING` (`board.mjs status` prints `WATCHER-MISSING`), re-arm it, never with `&`.
- Act on every watcher event, including terminal PR changes, `STOP` and `ORPHAN`; none is merely informational.
- The armed watcher is your heartbeat (`HEARTBEAT` every 30 quiet minutes); on every wake read every teammate message first. While the operator is away, also keep a recurring schedule (loop or cron, 20 to 30 minutes) that does the same and checks `watcher.mjs`. Recovery resumes an idle Codex writer on its default once its question's deadline passes.
- Answer a writer's question within 15 minutes, echoing its id (`board.mjs <orchDir> answered <writer> --id <id> --text <answer>`); send other mid-run changes to what it builds as `deliver <id> --kind scope --to <writer> --text <change>`, a message naming the id, then `told`. The watcher and `board.mjs status` flag `QUESTION-UNANSWERED`, `UNACKED` and `UNACKED-SCOPE` after 15 minutes, and `SCOPE-NOT-STARTED` for a worktree still clean at its old head 30 minutes on.
- On a `HOOK-APPROVAL <machine>` line (that machine's Codex vibe or vibe-core changed version and a vibe-core hook now needs approval), relay it to the operator at once in one plain line; approving is theirs, never a worker's.
- On `STALE-PR` (a PR needing its writer with no push for 45 minutes), ask the owning writer for an ETA, unblock it, or reassign it, whatever it reports being busy with.
- Push only a declared push-ready head (`--ready <sha>`, with `--visual-qa <findings.json>` for a UI diff). Review and verification accept the uncommitted diff before its first commit; then commit once, declare, push once and open the PR. `writer --base <remote-ref|OID>` records the verified pre-PR parent; parent commits are never ready. The live GitHub base is authoritative afterward. `push-check` must print `READY`; `status`/`watch-lines` flag undeclared local commits as `UNREADY-COMMIT` and unreadable history/base as `PUSH-READY-UNKNOWN`. Restore evidence before pushing; cadence never authorizes checkpoint commits. Operator ruling, 2026-10-29: "every commit to an open PR is a sign of a bad orchestration framework. we should codify this to never happen again. we don't commit until we're sure that commit is push ready."
- For an in-flight branch that already has old checkpoint commits, treat its current pushed PR head as historical baseline. Never rewrite it or declare its ancestors ready; keep the next repair uncommitted until one new head is push-ready. A remote board row uses `--where remote --base <full OID>`: `NO-HEAD` is informational because its owning machine checks history, while this board still requires the exact declared ready head before push.
- Before opening a PR, reviewers inspect the uncommitted change identified by HEAD plus diff/tree hashes. After opening, compare published evidence with the pushed PR head (`gh pr view <n> --json headRefOid`); observe automatically started checks and reviews, never manually trigger another review.

For a publisher plugin version bump, attach the handoff run report with `board.mjs <orchDir> writer <name> --ready <sha> --runs <runs.json>`. The push check compares the head, full selected workflow commands and successful release-contract results.

## Codex sessions

> Read `references/fleet-codex-sessions.md` (block `codex-sessions-rules`) when a Codex writer session is started, steered, read or ended.

## Claude workers

- Launch each Claude writer with the [worker preamble](./references/templates.md#worker-preamble) saved to `prompts/`.
- Hold an agent with TaskStop, never a message; check nothing it started still runs.
- Batch asks to a writer at milestones; side work goes to read-only workers.
- A pane teammate sees messages only when its turn ends, so writers keep turns short. On `UNACKED`, or an idle worker that ignored a message, resend once, then interrupt after the second unanswered delivery: ask the operator to press Esc in the named pane. A resend never reaches a writer mid-turn: on `UNACKED-SCOPE` or `SCOPE-NOT-STARTED` interrupt at once, or TaskStop and relaunch it with the change in its prompt. Keep long briefs in a file and send its path.
- A standing duty (main's post-merge health, a PR shepherd, the watcher) always has a live owner: `board.mjs <orchDir> duty <duty> --owner <writer or helper>`. Name the replacement in the same step you stop or move its owner; `helpers.mjs stopped` refuses an owner, and `board.mjs status` prints `UNOWNED-DUTY`.
- Register each reviewer, verifier or critic helper with `helpers.mjs <orchDir> start <name> --kind reviewer|verifier|critic --worktree <source worktree> --worker-id <actual native ID> --capabilities <parent-discovered capability record> --brief <file>`; it captures source identity at start. The helper writes its final deliverable with the exact last line `FINAL <recorded token> <start tree hash> <worker ID> <session ID> <turn ID> completed`, then calls `helpers.mjs <orchDir> final <name> --deliverable <file> --session-id <id> --turn-id <id> --out <private report>` after it actually finishes. Independently verify it before `accepted`; if the helper was deliberately superseded, run `abandoned <name> --reason <why>` instead. Only an accepted or abandoned helper may be `stopped`, and abandonment never counts as review evidence. Run `status` with every monitor event; record and stop owned processes through the same helper entry.
  Record spawned process identities with `helpers.mjs <orchDir> pid <name> <pid...>`; use `--group` only for one it spawned detached.
  For a native critic, run `helpers.mjs <orchDir> final <name> --deliverable <file> --session-id <id> --turn-id <turn> --completion-event <page> --out <report>`. Accept with `helpers.mjs <orchDir> accepted <name> --report <report>` and retain the head-bound findings file for the visual-QA gate.
  Launch Codex reviewers with `../vibe/scripts/dist/codex-reviewer.mjs` as in [handoff step 9](../handoff/references/handoff-pr.md). Launch the Codex visual critic through the same command with `--role visual-qa-critic --agent-definition <repo-agent-file>`. Pass its returned `visualQa` path to the ready gate with `--visual-qa <findings.json>`. A critic needs no review receipt. Findings use `{"head":"<full commit SHA>","findings":[]}`. Each needs boolean `touchedSurface`; resolve touched findings with `fixed: <sha>` or `ticket: <id>`.

  Record placement and writer ownership before dispatch. Pass grouping evidence with `--candidates <file>`. Fold overlapping work into the named owner. For a separate writer, branch or PR, use `--separate-reason "<operator's exact quote>"` from the ticket's sourced entry in the program's `rulings.md`.
- A long-lived QA helper records its owner, ticket, repository, PR and ending condition when it starts; reserve an empty unique Compose project before starting it, then record exact Docker resources after creation. `helpers.mjs status` reconciles a recorded QA stack when its PR merges or closes, including containers, volumes and networks, and lists any leftover with owner and ticket. Do not clean a process or Docker resource without its matching recorded identity. A refusal stays in the ledger for the next monitor event.
- For a PR-owned QA stack, register `helpers.mjs <orchDir> start <name> --owner <writer> --ticket <slug> --repo <owner/repo> --pr <n> --ending pr-terminal --project <compose>` before startup. `pr-terminal` is the only accepted ending value. After startup, run `helpers.mjs <orchDir> resources <name> --project <compose>` to capture the exact container, volume and network identities and creation witnesses. A reserved project cannot be marked stopped until those records reconcile; a read failure stays visible as a leftover.
- Per-ticket PostgreSQL, performance and seed scratch stacks use `scripts/helpers.mjs <orchDir> scratch-run <name> --owner <writer> --ticket <slug> --worktree <path> --ttl-seconds <60..86400> --compose-file <file>`. It reuses `helpers.mjs start/resources`, labels services and named data resources, and refuses locally built service images it cannot prove owned. The scheduled cleanup sweep reconciles expired stacks after the writer lease ends; `helpers.mjs status` reports due stacks. Raw scratch Docker starts are refused in scoped vibe/fleet Bash calls.
- The recorded owner may explicitly retire an abandoned scratch stack before its TTL with `helpers.mjs <orchDir> stopped <name> --owner <writer> --owner-token <recorded token>`; any other owner or token is refused and the same exact Docker witnesses still govern cleanup. A stack whose writer lease still says `active` is not reaped automatically; its recorded owner must use this explicit stop.

## Fleet board and direct messages

`scripts/board.mjs` keeps `<orchDir>/board.md`, the page every writer reads:

> Provider `tickets` (block `status-sweep` of `fleet-skill.md`)
- When you launch a writer, add its row (`board.mjs <orchDir> writer <name> --tickets <a,b> --runtime codex|claude --where local|remote --worktree <path> --pr <n> --repo <owner/repo> --head <sha> --status <text> --deps <a,b>`) and its PR's `<owner/repo> <n> <writer>` line to `prs.txt`. Update the row on every push report.
- Lock operator-scoped work with `board.mjs <orchDir> writer <name> --scope-locked "<operator words>" --ruling-source <citation>` and route refused scope to the lessons destination it names.
<!-- generic: ruling-renderers -->
- A settled UX ruling is saved once as a reference file with its screenshots in a shared evidence location. Find every renderer of the behavior with `rg` across each open PR's diff and main, then `board.mjs <orchDir> deliver <ruling> --kind ruling --reference <file> --to <every owning writer and QA guide>`. Every QA plan for that behavior cites it; one shared component beats each PR building its own.
<!-- end generic: ruling-renderers -->
> Provider `graph` (block `ruling-renderers` of `fleet-skill.md`)
- When QA prep marks a human checkpoint ready, or rebinds results, `deliver <checkpoint> --kind checkpoint --head <sha> --to <guide>` and message the guide yourself with the checkpoint, its launch steps and the head.
- After each message, `board.mjs <orchDir> told <item> <recipient>`. Run `board.mjs <orchDir> status` with every monitor event and act on each line: `STALE` (the board misses a pushed head), `UNTOLD`, `UNOWNED-DUTY`. A `SLOW` row is a Codex writer 30 minutes without a push on a PR with unresolved human threads: have it push and hand the branch to a Claude writer.

## Moving work between runtimes and accounts

> Read `references/fleet-recovery.md` (block `recovery-rules`) when a writer must move runtime, account or machine, a writer is dead, a `codex-usage` or `claude-usage` band reaches its limit, a `codex-usage` band will reach `MOVE_AT_PERCENT` before the work is done, the operator reports high Claude usage, or an engineer takes over a pull request.

## Machines and CPU

- Run heavy checks (full suites, typecheck, repo-wide lint and other gates, component story runs) through `scripts/fleet.sh <orchDir> local|remote slot heavy <owner> <worktree> <command...>`, in the worker's own worktree on that machine ([checklist step 4](./references/setup.md#checklist) gets the branch there). It caps runs at `HEAVY_SLOTS` or `REMOTE_HEAVY_SLOTS` and refuses a machine over `MAX_LOAD_PER_CORE` (exit 4). For non-E2E refusals, use the printed cloud route after the exact head is pushed. Exit 74 means a remote shipment failed before the command ran and can be retried. Only the operator may override that routing by setting `FLEET_FORCE_HERE=1` with `FLEET_FORCE_REASON` to the reason they chose; the reason is written into the slot holder record. Writers never set `FLEET_FORCE_HERE`, its reason, or `FLEET_LOAD`; production admission always reads the target machine. A force is still refused above the fixed hard ceiling of four times the core count. When the force or its reason is absent, normal routing applies. With `LOCAL_HEAVY_BARRED=1`, local heavy work exits 78 even if forced. Exit 78 means that bar, the containerized E2E disk preflight refused the command, or the remote host did not have the exact required vibe version; its stderr names which cause. Keep the operator's daily machine for edits and git; e2e and desktop app runs never go there.
- A verified `zsh -lic 'e2e/run-containerized.sh ...'` build receives the shared Docker backing-disk check inside the acquired slot. Pass `--containerized-e2e-build` when a wrapper obscures it. The check requires 64 GB decimal free; lighter checks do not take this gate. Run the frozen render as handoff's `frozen-render-gate.mjs` shell step, outside any fleet heavy slot: its builds take the heavy slot themselves.
- A screenshot capture through a slot passes `--capture <spec.json>` (`ticket`, `ref`, `pages`, `states`, optional `override`) after the worktree path; `scripts/fleet.sh` runs `../vibe/scripts/capture-guard.mjs` first and refuses it (exit 79) as `../vibe/references/quality-loop-visual-qa.md`, block `when-to-capture`, says; only an operator ruling recorded for that ticket in the program rulings, carrying `capture-guard override: baseline` or `capture-guard override: budget` for the refusal it lifts and quoted in the spec's `override`, lets it run. Before approving any capture, including after a compaction, read `../vibe/scripts/capture-guard.mjs status --ticket <slug> --ledger <orchDir>/captures`.
- Before reporting or waiting on remaining work, identify true dependencies. Start independent repository selected integration, unit, typecheck and lint lanes at once through available heavy slots on allowed machines, even while e2e is queued or running elsewhere. A lane waiting only for a full slot or load moves to another allowed machine with capacity; report the move. Route an eligible refused lane using `CLOUD-VALIDATE` once its exact head is pushed. Respect operator exclusions, machine load and slot limits, no dagger restrictions and the daily machine's no visible e2e rule. Keep the repository lane selector and `qa-impact.mjs` decision on which checks are needed. A lane runs the way its CI job runs: a proof harness never sets `umask 077` or exports `VITEST_MAX_WORKERS` above a tool's configured cap.
- A shared e2e stack with fixed ports runs only under vibe's machine-wide e2e lock: `node ../vibe/scripts/e2e-lock.mjs run --head <sha> --source-hash <treeSha256> --owner <writer> --label <run-label> --ticket <slug> <command...>` on the machine that runs it, where the machine slot reports the owner, label, ticket and compose project; receipts name HEAD plus diff/tree hashes, including dirty source. Each run gets its own compose project, so a teardown removes only its own stack; name a stack another tool started with `--foreign-compose <project>`. Unit tests, typecheck, story runs and stand-in server tests run outside it.
- `scripts/slot-lock.sh --status <lockName>` on a machine lists slot holders.
- Stop only owned processes with `fleet.sh <program> local stop-owned <recorded-pid>`, even during plugin upgrades. `hooks/kill-guard.mjs` refuses the rest. Run signal tests on another machine and keep fleet guards trusted.
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

- Green watch: `board.mjs` requires a `green-watch` owner while PRs are watched (`MISSING-DUTY`); a Sonnet watcher runs `green-watch.mjs --repo <owner/repo>` for each `NEW-RED`, checks each mock block with `mock-gap.mjs`, and starts an Opus fixer for attribution or a fix: a vibe writer (Claude `vibe-generic:vibe`, Codex `$vibe`) briefed by `GREEN_WATCH_AGENT`, stopped after merge. A watcher that cannot SendMessage writes an atomic Markdown event under `<orchDir>/events/`; `watch.sh` surfaces it. The fix passes lanes, `pr-preflight.mjs` and guardrails. Attribute from `gh pr view <n> --json author,headRefName`, never a worker's word. For a visual baseline, compare the diff and record its counted `Baseline inventory:` plus one cited `Baseline element:` per new element; "plausibly intended" never passes. File another author's red only once that PR's ticket, PRD and design rulings show the change was not asked for (a requested change is accepted and cited). After core work, run the full e2e suites on main yourself on the CI-identical runner; a fix auto-merges only after its specs and latest reds pass.
- Repo knowledge: a repo fact a worker learns goes into the team's repo memory (`REPO_MEMORY_CMD`), and into the nearest `AGENTS.md` through that worker's PR when it binds code.
- Deadline mode, only when the operator rules it (record it in `rulings.md` with its end): no pre-merge e2e (`pre-pr-lanes.mjs --skip <lanes> --skip-ruling <the ruling>`), follow-up pushes run focused tests plus the affected typecheck and leave full lanes to CI, and extras ship in follow-up PRs.
- Runtime choice: judgment-heavy work and takeovers go to Claude writers, which are faster; bulk mechanical work goes to Codex on `CODEX_MODEL`, which is cheaper. Move work on usage and speed.

### Cloud workers

Before assigning a writer, record placement with `board.mjs <orchDir> placement <ticket> --evidence <file>` ({codeOnly, needsRunningApp, localEvidence[]}). A cloud placement requires `--keep-local <exact operator quote> --ruling-source <rulings.md citation>` or, after import, `--worktree <path> --import-request <file> --lane-receipt <receipt basename>`. Use `../vibe/scripts/cloud-worker.mjs record-evidence`, then `dispatch --request <file>`; use `poll` and `import` to resume and return work, `abandon` to end a dropped task. After local handoff, full lanes and independent review (Claude imports: Codex or trace-proven `claude-fable-5-2`; Codex imports: Claude), run `refresh-import` before `ready`. Keep graph evidence in the brief; Claude clears auto-attached connectors.
- Pin the active Claude account with `cloud-worker.mjs pin` after setting `CLOUD_CLAUDE_ENV`, then run `check --fleet-dir <orchDir>`. On the exact pushed Vibe head, `validate` lane `cloud-capabilities` measures Docker, virtual-display Electron and lane setup. Use a current matching `runtimeTool` receipt for protected lanes or route them to laptop2. Use the documented frozen-render gate lane from the proof tooling checkout with separately pinned application inputs.
- Cloud work goes through `cloud-worker.mjs` (Claude Code routines), never an `isolation: remote` Agent, which can run locally; every cloud report states the host, repository and commit it ran on.
- To test a pushed head with no Vibe session, `validate --request <file>` (`provider: "claude"`, branch, full commit, model, lanes `[{name, command}]`, a local checkout as `worktree`; the repository comes from its GitHub origin and the install from the tree's lockfile unless `repository` or `install` is given) runs those lanes on that exact commit in Claude cloud, changes nothing, and refuses a result for another commit or with a changed file. Codex is refused: its CLI returns no report.
- `node scripts/dispatch-route.mjs --manifest <triage manifest>` defaults mechanical work to Codex and accepts fresh usage readings. Set `FLEET_CLASS_ROUTING=0` to choose manually. `dispatch-budget.mjs` (`FLEET_BUDGET_GUIDANCE=1`) reports the budget; `slot heavy` enforces capacity.

## Lessons loop

- Log every finding you route to a writer in the lessons ledger at the same moment, tagged new or repeat, with owner and fix. Format: [references/state.md](./references/state.md#lessons-ledger).
- A repeat after a shipped fix means the earlier encoding did not bite: make it a gate, not more prose.
- A plugin PR that encodes lessons replaces the prose its gate enforces and reports the net change in instruction length, measured at the final head with `node scripts/instruction-words.mjs --base <last release> --changelog CHANGELOG.md --version <x.y.z>`. The plugin must not get heavier.
- Batch lesson and tooling fixes into one open PR per repo until it merges. Before opening one, `node scripts/lessons-pr.mjs --repo <owner/repo>` must print `no open lessons PR`; otherwise push onto the branch it names.
- A lesson's primary fix lives in vibe itself (writer instructions plus a mechanical check), since many run vibe without an orchestrator; a rule here is a second layer. Lessons PRs encode general rules; one repo's rules, paths and component names go in that repo's own files.

## Artifacts people read

Hard rule: a ticket, PR body, comment, reply or other artifact for people never names a path on the operator's machine or says something is on someone's laptop. Evidence is embedded (screenshots as inline images, text quoted briefly); a plan is a linked plan document or a ticket attachment, never a path. Check every worker draft before it is posted; vibe's ticket and PR body checks refuse a local path.

## Reporting to the operator

- Surface each new problem once, immediately and briefly. Before approving a rerun, read the failed run's kept session or trace and current code; rerun only when they cannot answer it. Do not relay an idle or turn-end notification that adds no fact.
- For a remaining-work answer, compute time to ready from the dependency graph's longest dependent path, not a sum of independent lanes. Use the [Remaining work report](./references/templates.md#remaining-work-report). The response is incomplete until it states the duration and names the dependent steps and assumptions that produce it. Every ETA for queued work is computed from the remaining queue: state how many runs are still queued or running and each one's estimate, and restate the ETA the moment a step adds more than 30 minutes.
- Before reporting a count or an "only" claim, require a complete zero-exit command; otherwise call it partial. Principle 2 covers your findings too.
- When the operator steps away (vibe's `away-protocol` hook puts this checklist in context on "brb", "stepping away" and the like, and the return checklist on "I'm back"), keep `<orchDir>/attention.md` current (decision needed, recommendation, what is blocked), keep reading idle writers' last messages, and lead with that list on return.
- Put every finding the operator reviews on one page using the stable `D`, `X`, `N`, `S` and `R` IDs in the [operator review template](./references/templates.md#operator-review-page); never restart numbering across audits.
- The final report lists, per PRD, which flags must be on to see each change.
- Before a PRD is marked executed, `node ../handoff/scripts/executed-check.mjs --kind prd --file <PRD text> --last-merge <time> --children <its PRODUCES children read now>` must pass; report open children instead.
