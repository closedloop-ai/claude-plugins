---
name: fleet-orchestrator
description: 'Use when you orchestrate several workers at once (Codex or vibe sessions and Claude subagents) delivering parallel pull requests, on one machine or across several, for a human operator who does QA and merges. Covers who may write where, orchestration state that survives a reboot, restart or compaction, starting, resuming and steering Codex threads bound to a worktree, Codex budget rules, a Claude takeover of a dead Codex writer, CPU and shared e2e stack slot locks across machines, agent-first QA and review before merge, pushback on flags and extra code paths, a lessons ledger, and how to report to the operator. Pairs with codex-fleet-monitor for watching the fleet.'
---

# fleet-orchestrator

You run a program of several PRs at once: you plan, route, review, push back and report; workers write; the operator does QA, merges and makes product calls. Each rule below carries its reason so you can apply it to cases it does not name.

Repo specifics (launch paths, auth, bootstrap, test commands, e2e harness) come from the repo's own docs (its `AGENTS.md` files or contributor guide) or the team knowledge base; look them up, never assume them. Machine specifics (hosts, paths, model names, slot counts) come from `<orchDir>/config.env`.

## Setup

Works on one machine with no remote config. More machines need ssh key auth between them, plus `codex`, `node` and `gh` on each. Prerequisites, the `config.env` keys with placeholders, and the setup checklist: [references/setup.md](./references/setup.md).

## Roles

- Every writer is a vibe session, and no un-vibed writer ever edits a PR branch: Codex writers start or resume with a `$vibe` prompt naming the ticket or PRD (`fleet.sh` refuses a new session whose prompt does not start with `$vibe`), and Claude writers invoke `vibe:vibe` and follow its resume path. Vibe's scope, guardrails and ticket records only bind work done inside it.
- Reviews, handoff, ticket, environment and seed work go through vibe's own skills, workers and scripts (`vibe:handoff`, its reviewer and verify workers, `vibe:vibe-seed-refresh`), never ad hoc equivalents. One process keeps one set of records and gates.
- You never edit a product repo; every change goes through a worker in its own worktree. Keeps one owner per change and your context free for judgment.
- One writer per branch at a time, Codex or Claude. Two writers on one branch overwrite each other.
- Reviewers, verifiers, QA prep and visual reviewers are read-only Claude subagents. A reviewer that fixes cannot be the independent check.
- The operator gets QA, merges and enqueues, anything irreversible, and product decisions. Ask one question at a time, with context and a recommended option.

## State and persistence

- Keep all orchestration state in one persistent directory, never `/tmp` or a session scratchpad. A forced reboot wiped `/tmp` once and orphaned every Codex thread. Layout: [references/state.md](./references/state.md).
- Write every prompt to `prompts/` before sending it. A restarted orchestrator can then see what each worker was told; `fleet.sh` only accepts prompt files.
- Keep a dated resume log (rulings, merge order, who owns what, pending items) and read it first after any restart or compaction. Your memory of the program does not survive either.
- After your own restart, subagents are gone: re-arm the watcher, relaunch Claude workers from their saved prompts, and tell the operator what you restarted.
- If a remote machine reboots or loses its session state, its Codex threads cannot be reattached: start fresh threads in the same worktrees with resume prompts built from `prompts/` and the resume log, and say "keep the current version" in them.

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

- Run Codex at the high effort level, not the maximum: the maximum burns the limit far faster for little gain on PR work. Writers and reviewers use `CODEX_MODEL`; tell each session in its prompt to run explorer and read-only sub-agents on `CODEX_EXPLORER_MODEL`.
- No computer use in Codex: no browser, in-app browser, desktop app UI or screenshots. It is the fastest drain. Code host work goes through its CLI.
- Visual work is a request file a Codex session drops in the requests dir ([template](./references/templates.md#visual-request)); a Claude worker does it and you steer the findings back as text.
- Watch the usage rate, not just the level: estimate time to the limit from the trend, and move a machine's busiest sessions to another machine or account as fresh threads with resume prompts before they stop mid-fix.
- A dead Codex writer (limit, crash) is taken over by a Claude writer in the same worktree, with the [takeover preamble](./references/templates.md#worker-preamble). Vibe has no path yet to move a Codex writer's session to Claude, so the Claude writer still invokes `vibe:vibe` and follows its rules, never edits the Codex session's records, and commits normally; log the gap to the lessons ledger.
- Fresh and resumed threads may stop to ask about a plugin version update; say "keep the current version" in the resume prompt.

## Claude workers

- Launch each Claude writer with the [worker preamble](./references/templates.md#worker-preamble) saved to `prompts/`. It starts with invoking vibe and carries the worktree, PR, reading, test, git, thread-reply and report rules so no writer improvises them.
- A message to a busy worker arrives only when it goes idle; if it idles without acting on one, resend it shortly.
- Polling and watch workers run on the cheapest capable model.
- When CPU is tight, give the next review to an idle reviewer that finished, rather than spawning a new one.

## Machines and CPU

- Run heavy checks (full test suites, typecheck, repo-wide lint and other gates, component story runs) on the least loaded machine, in the worker's own worktree there ([checklist step 4](./references/setup.md#checklist) gets the branch there). Keep the operator's daily machine for edits and git.
- Cap heavy runs per machine at its `HEAVY_SLOTS` or `REMOTE_HEAVY_SLOTS`: `scripts/fleet.sh <orchDir> local|remote slot heavy <owner> <worktree> <command...>`.
- A shared e2e stack with fixed ports takes a machine-wide single slot: `scripts/fleet.sh <orchDir> local|remote slot e2e-stack <owner> <worktree> <command...>`. Only runs that start that stack take it; tests against a stand-in server, component story runs, unit tests and typecheck run outside it in parallel.
- `scripts/slot-lock.sh` underneath frees the slot when the command exits or is interrupted and reclaims one whose holder pid died; `scripts/slot-lock.sh --status <lockName>` on that machine lists holders.
- Kill only processes you started, matched by pid or worktree path, never an unscoped `pkill`. Other runs on that machine belong to someone else.
- Plugin marketplaces and env files on a remote machine live in persistent paths too.

## Quality gates and QA

- QA happens before merge; never call a PR ready to enqueue before its QA is done.
- Each PR moves through, in order: independent review → writer fixes → verification of the fixes → design or visual review where UI changed → full check at the final head → QA plan (agent-verified plus human-only checkpoints) → operator QA → version-file conflicts resolved → operator enqueues. A head change sends it back to the earliest step the change affects.
- Agent-first QA: an agent verifies everything it can (e2e on the current head, DOM and accessibility reads, API second views, headless screenshots it reads itself) and records it. The operator gets only checkpoints that need a human: perceptual judgment, real-device feel, assistive tech, product judgment, flows an agent cannot drive; measure the rest (contrast ratios, box geometry, focus targets). A defect an agent already observed goes to the writer with its measurement, not to the human checklist.
- Every PR gets an independent review, then a verification pass of the fixes, before it is QA-ready. Resolve a thread only after the fix is verified in code, with a reply naming the fixing SHA.
- Before enqueue, run a containerized or full check wherever PR CI skips suites, and resolve shared version-file conflicts right before each enqueue, in merge order. The queue rebuilds on current main, and a skipped suite is not a pass.
- Track merge order for stacked or overlapping PRs and tell each writer which one merges first.
- A before and after comparison uses the candidate's merge-base or current main as the baseline, never an unrelated branch. Trace a surprising difference to the commit and ticket that introduced it before blaming the PR.

## Pushback

More judgment patterns from past programs: [references/judgment.md](./references/judgment.md).

- When a worker's design looks irrational or adds debt (extra feature flags, parallel code paths, shims, a second owner for the same behavior, new docs files, plugin PRs that only add), push back with a simpler alternative and tell the operator what you spotted. Forwarding it for approval as is makes the operator do your review.
- No agent adds a key to the team's feature-flag service without the operator approving that key ([approval template](./references/templates.md#flag-approval)). Prefer one key per program or surface; corrections and removals are never gated.
- Settle unspecified UX by precedent (how the established product your team follows for UX precedent does it, then the repo's own siblings) and tell the operator the ruling in one line; escalate only what precedent cannot settle.
- Never invent product behavior or user-facing copy; cite the human source.
- Respect operator boundaries on other teams' work, such as "don't fix main" while another owner is fixing it.

## Lessons loop

- Log every finding you route to a writer in the lessons ledger at the same moment, tagged new or repeat, with owner and fix. Batched later, they get lost. Format: [references/state.md](./references/state.md#lessons-ledger).
- A repeat after a shipped fix means the earlier encoding did not bite: make it a gate, not more prose.
- A plugin PR that encodes lessons replaces the prose its gate enforces and reports the net change in instruction length. The plugin must not get heavier.

## Reporting to the operator

- Surface every problem the moment you see it: limits, stalls, failures, new human review comments, blockers.
- Keep status updates short; ask one question at a time with context and a recommended option.
- The final report lists, per PRD, which flags must be on to see each change.
