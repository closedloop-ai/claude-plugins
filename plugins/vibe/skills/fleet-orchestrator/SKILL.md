---
name: fleet-orchestrator
description: 'Use when you orchestrate several workers at once (Codex or vibe sessions and Claude subagents) delivering parallel pull requests, on one machine or across several, for a human operator who does QA and merges. Covers who may write where, orchestration state that survives a reboot, restart or compaction, starting, resuming and steering Codex threads bound to a worktree, Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e stack slot locks across machines, agent-first QA and review before merge, pushback on flags and extra code paths, a lessons ledger, and how to report to the operator. Pairs with codex-fleet-monitor for watching the fleet.'
---

# fleet-orchestrator

You run a program of several PRs at once: you plan, route, review, push back and report; workers write; the operator does QA, merges and makes product calls. Each rule below carries its reason so you can apply it to cases it does not name.

## Principles

1. **The operator's attention is the scarcest resource.** Decide everything you can yourself (precedent, sibling consistency, repo rules, measurements), act on it, and tell the operator the ruling in one line so they can override. Escalate only what needs them (product trade-offs, irreversible actions, approvals the repo reserves for humans), one question at a time with a recommendation. Never forward a worker's question or result without first trying to settle or verify it.
   Before any ruling on behavior, read in this order:
   1. the ticket's acceptance criteria and scope lines;
   2. its PRD;
   3. the PR's human review threads on that behavior, resolved ones included;
   4. closedloop-graph for related tickets and other open PRs touching it;
   5. only then precedent (the established product your team follows for UX precedent, `UX_PRECEDENT` in config, then the repo's own siblings) and sibling consistency.

   A human-sourced line that conflicts with the ruling goes to the operator as a question with a recommendation. Record every ruling with its source in the resume log, and tell the writer to cite it on the ticket and the relevant thread.

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

## Research with closedloop-graph

The closedloop-graph MCP server is required; decide from it, not from guesses. Tool guide: [vibe's closedloop-graph reference](../vibe/references/closedloop-graph.md).

- Before assigning work or ruling between PRs, check open-PR and ticket overlap with `query_collisions` and `blast_radius_tickets`; read a ticket's PRD lineage and children with `ticket_detail`.
- Before a shared change, read its callers and importers (`code_callers`, `code_importers`).
- Which tests to run, or rerun, after any change, fix or merge (a conflict resolution included) is decided by `code_tests_for`, the only route to tests, over the files that change touched: run exactly those and nothing broader by default. Files that map to no tests (changelog, README, version text) run none, and CI confirms.
- Trace a surprising difference in a before and after comparison to the commit and ticket that introduced it before blaming the PR.
- Every worker prompt requires the same graph-first research (the preamble and resume templates carry it).

## State and persistence

- Keep all orchestration state in one persistent directory, never `/tmp` or a session scratchpad. A forced reboot wiped `/tmp` once and orphaned every Codex thread. Layout: [references/state.md](./references/state.md).
- Write every prompt to `prompts/` before sending it. A restarted orchestrator can then see what each worker was told; `fleet.sh` only accepts prompt files.
- Keep a dated resume log (rulings, merge order, who owns what, pending items) and read it first after any restart or compaction. Your memory of the program does not survive either.
- After your own restart, subagents are gone: re-arm the watcher, relaunch Claude workers from their saved prompts, and tell the operator what you restarted.
- If a remote machine reboots or loses its session state, its Codex threads cannot be reattached: start fresh threads in the same worktrees with [resume prompts](./references/templates.md#resume-prompt) built from `prompts/` and the resume log.

## Monitoring

Run [codex-fleet-monitor](../codex-fleet-monitor/SKILL.md) (`vibe:codex-fleet-monitor`) on the same `<orchDir>` in the background for the whole program and act on its lines as its table says, including usage bands, paid-credit spending and request files. It reads the session state files `fleet.sh` writes, listed as `local|remote <name>` in `sessions.txt`.

- Re-arm the watcher in the same step you read each event. It only watches while running, and it costs nothing while waiting.
- Before you or a reviewer inspect a head, check it equals the pushed PR head (`gh pr view <n> --json headRefOid`). Sessions sometimes report local, unpushed commits.

## Codex sessions

`scripts/fleet.sh` drives a session on this machine (`local`) or on `REMOTE_HOST` (`remote`, which copies the scripts and the prompt file there first) through the managed Codex App Server, using the monitor's client.

```sh
scripts/fleet.sh <orchDir> local|remote session turn  <name> --prompt-file <file> [--cwd <worktree>] [--model <m>] [--effort <e>] [--sandbox <mode>]
scripts/fleet.sh <orchDir> local|remote session steer <name> --prompt-file <file>
scripts/fleet.sh <orchDir> local|remote session last  <name> [--count <n>]
```

`turn` starts a thread bound to `--cwd` the first time (refusing a different cwd later) and resumes it afterwards, then starts a turn; `--model` and `--effort` default to `CODEX_MODEL` and `CODEX_EFFORT`, and a new session refuses to start without an effort or with a prompt that does not start with `$vibe`. Model, effort, sandbox and each prompt file sent persist in the session's state file. `steer` adds to the active turn and fails when none is running. `last` prints the monitor's status line and the last agent messages.

- Run Codex at the high effort level, not the maximum: the maximum burns the limit far faster for little gain on PR work. The thread runs on `CODEX_MODEL`; vibe's own worker-model policy picks each sub-agent's model, so never name one in a prompt.
- No computer use in Codex: no browser, in-app browser, desktop app UI or screenshots. It is the fastest drain. Code host work goes through its CLI.
- Visual work is a request file a Codex session writes only through `scripts/request-visual.mjs` ([template](./references/templates.md#visual-request)), which refuses a head that is not the PR's pushed head; a Claude worker does it and you steer the findings back as text.

## Claude workers

- Launch each Claude writer with the [worker preamble](./references/templates.md#worker-preamble) saved to `prompts/`. It starts with invoking vibe and carries the worktree, PR, reading, test, git, thread-reply and report rules so no writer improvises them.
- A message to a busy worker arrives only when it goes idle; if it idles without acting on one, resend it shortly.
- Polling and watch workers run on the cheapest capable model.
- When CPU is tight, give the next review to an idle reviewer that finished, rather than spawning a new one.

## Moving work between runtimes and accounts

- Move a machine's busiest writers when its `codex-usage` band reaches `MOVE_AT_PERCENT`, or its trend says it will before the work is done, and on any `LIMIT` or `LIMIT-SPENDING-CREDITS` line. Move a Claude writer when it hits its usage or rate limit; the monitor cannot read Claude usage, so you learn it from the worker's errors or from the operator.
- Before any move the old writer stops, or is confirmed dead, after committing and pushing or reporting its uncommitted state. One writer per branch holds through every move.
- Codex to another Codex machine or account: a fresh thread through `fleet.sh` in the branch's worktree there, with a [resume prompt](./references/templates.md#resume-prompt).
- Codex to Claude: a Claude writer in the same worktree with the [takeover preamble](./references/templates.md#worker-preamble). It invokes `vibe:vibe`, never edits the Codex session's records, and commits normally; vibe has no session migration for this yet, so log the gap to the lessons ledger.
- Claude to Codex: a Codex vibe session through `fleet.sh` in the same worktree, with a resume prompt.
- Fresh and resumed threads may stop to ask about a plugin version update, so every resume prompt says to keep the current version.

## Machines and CPU

- Run heavy checks (full test suites, typecheck, repo-wide lint and other gates, component story runs) on the least loaded machine, in the worker's own worktree there ([checklist step 4](./references/setup.md#checklist) gets the branch there). Keep the operator's daily machine for edits and git.
- Balance heavy work by measured load, not a fixed machine: before each heavy run, compare load per core (`uptime` against the core count) on each machine and send the run to the lower one. A fixed choice once drove one machine to more than twice its core count while the other sat idle.
- Cap heavy runs per machine at its `HEAVY_SLOTS` or `REMOTE_HEAVY_SLOTS`: `scripts/fleet.sh <orchDir> local|remote slot heavy <owner> <worktree> <command...>`.
- A shared e2e stack with fixed ports runs only under vibe's machine-wide e2e lock, the one every vibe session's e2e command already takes: `node ../vibe/scripts/e2e-lock.mjs run <command...>` on the machine that runs the stack. A second lock for the same stack would let two runs collide. Only runs that start that stack take it; tests against a stand-in server, component story runs, unit tests and typecheck run outside it in parallel.
- `scripts/slot-lock.sh` underneath frees the slot when the command exits or is interrupted and reclaims one whose holder pid died; `scripts/slot-lock.sh --status <lockName>` on that machine lists holders.
- Kill only processes you started, matched by pid or worktree path, never an unscoped `pkill`. Other runs on that machine belong to someone else.
- Plugin marketplaces and env files on a remote machine live in persistent paths too.

## Quality gates and QA

- QA happens before merge; never call a PR ready to enqueue before its QA is done.
- Each PR moves through, in order: independent review → writer fixes → verification of the fixes → design or visual review where UI changed → full check at the final head → QA plan (agent-verified plus human-only checkpoints) → operator QA → version-file conflicts resolved → operator enqueues. A head change sends it back to the earliest step the change affects.
- Agent-first QA: an agent verifies everything it can (e2e on the current head, DOM and accessibility reads, API second views, headless screenshots it reads itself) and records it. The operator gets only checkpoints that need a human: perceptual judgment, real-device feel, assistive tech, product judgment, flows an agent cannot drive; measure the rest (contrast ratios, box geometry, focus targets). A defect an agent already observed goes to the writer with its measurement, not to the human checklist.
- Human QA runs in a dedicated Claude QA-guide session per PR that the operator talks to directly. When the PR's QA plan is ready, save the [QA guide prompt](./references/templates.md#qa-guide-prompt) to `prompts/` and launch it headless from the repo root (`claude -p --output-format json` with the tools it needs allowed); take `session_id` from the JSON and give the operator `cd <repo> && claude --resume <session_id>`. Keep a background wait on its findings file, re-armed like the monitor, and route each failure to the writer.
- Every PR gets an independent review, then a verification pass of the fixes, before it is QA-ready. Resolve a thread only after the fix is verified in code, with a reply naming the fixing SHA.
- Before enqueue, run a containerized or full check wherever PR CI skips suites, and resolve shared version-file conflicts right before each enqueue, in merge order. The queue rebuilds on current main, and a skipped suite is not a pass.
- Track merge order for stacked or overlapping PRs and tell each writer which one merges first.
- A before and after comparison uses the candidate's merge-base or current main as the baseline, never an unrelated branch.

## Pushback

Pushback applies principle 2; more judgment patterns from past programs: [references/judgment.md](./references/judgment.md).

- Debt to push back on also includes parallel code paths, shims and a second owner for the same behavior. Forwarding it for approval as is makes the operator do your review.
- No agent adds a key to the team's feature-flag service without the operator approving that key ([approval template](./references/templates.md#flag-approval)). Prefer one key per program or surface; corrections and removals are never gated.
- Never invent product behavior or user-facing copy; cite the human source.
- Respect operator boundaries on other teams' work, such as "don't fix main" while another owner is fixing it.

## Lessons loop

- Log every finding you route to a writer in the lessons ledger at the same moment, tagged new or repeat, with owner and fix. Batched later, they get lost. Format: [references/state.md](./references/state.md#lessons-ledger).
- A repeat after a shipped fix means the earlier encoding did not bite: make it a gate, not more prose.
- A plugin PR that encodes lessons replaces the prose its gate enforces and reports the net change in instruction length. The plugin must not get heavier.

## Reporting to the operator

- Surface every problem the moment you see it: limits, stalls, failures, new human review comments, blockers.
- Keep status updates short.
- The final report lists, per PRD, which flags must be on to see each change.
