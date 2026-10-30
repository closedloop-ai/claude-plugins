# Local vibe benchmark and nightly evals

This package owns two local-only measurement paths:

- An on-demand Claude Code start-to-PR benchmark. It is a diagnostic, never a pull request requirement.
- A scheduled change-day eval baseline across Claude Code and Codex. It is the only routine model-driven eval.

No model-calling command runs in CI. CI runs only T0 contract tests, type checking, plugin validation, and the deterministic Codex runner tests. Pull requests do not need a benchmark section, eval evidence, an approval label, or a bypass.

## Behavior scope

`vibe-change-scope.ts` is the shared change-day classifier. Claude Code and Codex load the plugin manifests, skills, agents, hooks, and files those runtime components read or execute. Semantic manifest changes and runtime paths are behavior; a required manifest edit that changes only `version` is not. A behavior change to a closedloop-core skill is also in scope when any non-test, non-documentation vibe runtime source references that skill; reference discovery scans those sources from both repository trees, including future paths that fail closed as runtime behavior, so a new reference needs no allowlist edit. Unreferenced core skills, READMEs, changelogs, docs, evals, tests, fixture helpers, and benchmark infrastructure are non-behavior. A Markdown reference read by a loaded skill is behavior even when it looks like documentation. An unknown new path under `plugins/vibe` fails closed and triggers the nightly. A path-only classifier cannot prove that a runtime source edit changes comments only, so runtime source remains behavior.

Inspect a diff without making a model call:

```sh
node --experimental-strip-types tools/vibe-bench/src/cli.ts eval-scope <claude-plugins-checkout> <base-ref>
```

## Nightly T2 baseline

The nightly starts from a dedicated clean `main` checkout at fetched `origin/main`. If no behavior path changed since the latest accepted baseline, it prints `SKIPPED` and makes no model call. Otherwise it runs the full corpus once on both runtimes, then reruns only failures at most twice. Claude pins the agent to `claude-sonnet-5-5` and the judge to `claude-opus-5-5`. Codex pins its own agent and judge in `eval-policy.ts`.

Claude Code 2.1.311's embedded model catalog names the judge model `claude-opus-5-5`. Anthropic's current [models overview](https://platform.claude.com/docs/en/models/overview) lists the same exact Claude API ID, so the runtime catalog and public model catalog agree on the local `claude plugin eval` pin.

The stored artifact contains content-keyed case results, reliability history, the quarantine owner and deadline, separate Claude agent and judge costs, and an atomic latest pointer. Added or changed cases run and are reported but are not compared with older content. A case becomes must-pass after at least three observations at a 95 percent pass rate. The initial 29 runtime-specific main failures live in `eval-quarantine.json`. An expired quarantine entry never stops the job. Its case runs as gating evidence, and the nightly Slack alert names the expired case and owner.

The accepted lineage is keyed by every agent and judge model ID. A model-policy change runs the corpus even when no behavior path changed, prints `NEW_LINEAGE` with the old and new judge IDs, stores a fresh one-entry history, and sends no regression Slack message. Reliability requires three successful observations, so the first confirmed regression alert in a new lineage can occur on its fourth change-day nightly. The Haiku 4.5 result from 2026-10-30 remains historical evidence for the initial quarantine only; it is never compared with the Opus 5.5 lineage.

Run one nightly manually through the machine heavy slot:

```sh
<heavy-slot> vibe-eval-nightly <node> --experimental-strip-types tools/vibe-bench/src/eval-nightly.ts <clean-main-checkout> <run-root-parent> <results-store> <claude> <codex> <uv> <gh>
```

On a confirmed regression, the nightly writes a regression artifact and posts one message to `#vibe` through the Slack MCP connection already authenticated in Claude Code on the nightly Mac. The message names the case and runtime, the pull requests merged since the last green nightly with their authors, any direct commits on `main` with their authors, the quarantine owner, and the result artifact. An expired quarantine entry is included in the same alert and names its owner. Clean and skipped nights with no expiry send no message.

Slack delivery uses a short, non-persistent headless Claude Code call pinned to `claude-haiku-5-5`. It discovers the enabled Slack plugin path, disables built-in tools and ordinary user/project/local settings for the relay process, and permission-allows only `mcp__plugin_slack_slack__slack_send_message`. The formatter supplies the verified public `#vibe` channel ID `C0CC9G7V01G` and pre-rendered text. A run-owned `PreToolUse` gate permits exactly one call only when its `channel_id` and `message` byte-match those values, before the MCP write occurs; transcript verification remains a second check. Tests stub both Claude processes and never contact Slack. The Slack MCP connection acts on behalf of its authenticated user, so messages are expected to appear as that user rather than the team bot.

Missing executables, attribution failures, unavailable Claude or Slack MCP auth, timeouts, altered tool inputs, and failed delivery produce a `VIBE_NIGHTLY_INFRA_FAILURE` or `VIBE_NIGHTLY_SLACK_FAILURE` job-log line. Slack failure never blocks the eval run. Version 1 `pending` and `sent` delivery records remain readable and are upgraded to version 2 on their next transition. A failure proven to occur before the relay starts remains `pending` and can retry before later paid work. Once a relay attempt begins, its journal stays `attempting` unless an exact successful tool result is observed; it is not replayed automatically because the Slack MCP schema has no idempotency key. This at-most-once policy prevents an acknowledged-but-interrupted post from being duplicated. To reconcile, first check `#vibe`: set the version 2 record to `sent` with `deliveredAt` when the exact message exists, or set it to `pending` with `attemptedAt: null` only after confirming it was not posted. The machine-wide heavy slot is the single delivery owner, so no sidecar lock participates in reconciliation.

## Local scheduled task installation

The nightly is launched by a visible ChatGPT scheduled task rather than a hidden launch agent. On the configured Mac, the task has **Run on this computer** enabled, starts a new chat every day at 2:00 AM Central, and runs exactly one command:

```sh
<home>/.config/vibe-eval-nightly/run-nightly.sh
```

The private entry script is mode `0700` and lives outside every checkout. It supplies the explicit scheduler `PATH` and absolute Node, Claude, Codex, uv, gh, heavy-slot, clean-main, run-root, result-store, and log paths. It calls `schedule/run-nightly.sh` from the dedicated clean-main checkout, so future merges take effect without changing the scheduled task. The repository wrapper remains the owner of heavy-slot acquisition.

The entry script captures each run in `~/Library/Logs/vibe-eval-nightly/task-<UTC timestamp>.log` and prints exactly one final `VIBE_NIGHTLY_SUMMARY` JSON line. The line reports `result` (`SKIPPED`, `RAN`, or `FAILED`), passed and failed counts, whether Slack was posted, the artifact or log path, and the last `VIBE_NIGHTLY_*_FAILURE` line when present. The task reports those fields in its chat.

Keep the dedicated clone on `main`; do not point the task at a worker worktree. Before relying on alerts, run `claude mcp list` in the same macOS user account and require `plugin:slack:slack: https://mcp.slack.com/mcp ... Connected`. Complete Claude Code and Slack OAuth interactively if unavailable. The task reads the normal per-user credential stores; do not create a Slack token file.

Any equivalent visible local scheduler may call the same stable entry script. Do not add a second scheduler for the same nightly, and do not force a paid first run: execute the entry once manually and accept `SKIPPED` or a clear `FAILED` summary from preflight.

## On-demand start-to-PR benchmark

The benchmark measures the real Claude Code task-to-draft-PR path against a local seeded web stack and local MCP server. It pins `claude-sonnet-5-5` at effort `high`, records frontmatter model exceptions, and rejects root or subagent model drift. It uses the normal Claude credential store while isolating run-owned settings.

The benchmark baseline must use the claude-plugins SHA in the latest accepted nightly. The CLI checks that relationship before setup or model work:

```sh
<heavy-slot> vibe-benchmark <node> --experimental-strip-types tools/vibe-bench/src/cli.ts baseline <symphony-checkout> <claude-plugins-checkout> <latest-nightly-sha> <empty-run-root> <output-dir> <claude> <gh> <nightly-results-store>
```

One isolated seeded stack and one local MCP process are reused across the balanced samples. Setup time is recorded separately and does not consume the model execution budget. Full wall time still includes preflight, setup, model work, cleanup, and teardown. The target is less than ten minutes; a miss remains a measured miss.

Every proof pull request is a draft whose title contains `DO NOT MERGE` and whose body says it belongs to the benchmark. Each proof pull request is closed and every owned proof ref is removed on success, failure, timeout, or interrupt. Artifacts report every run, wall time, cost, tokens, calls, model and effort, and component, skill, worker, and phase attribution.

Use `compare` for a local trend comparison between immutable benchmark artifacts. Pass either `vibe` or `fleet-one-writer` explicitly so a balanced six-run artifact is partitioned into comparable three-run samples. Yellow or red values require a concrete local explanation. There is no publication command, PR body mutation, label, bypass, regression acceptance, release mode, or promotion mode.

## Focused diagnosis

`eval-local` remains available for an explicitly requested focused local investigation. It is not a gate:

```sh
<heavy-slot> vibe-eval-diagnosis <node> --experimental-strip-types tools/vibe-bench/src/cli.ts eval-local <claude-plugins-checkout> <full-sha> <empty-run-root> <output-dir> <claude> <codex> <uv> <full-or-deterministic> [case ...]
```

Omit case names for the full snapshot corpus. The command writes native result trees plus one hashed JSON and Markdown summary. Deterministic mode skips only the paid Codex wording grader and records every skip.
