# Local vibe benchmark and nightly evals

This package owns two local-only measurement paths:

- An on-demand Claude Code start-to-PR benchmark. It is a diagnostic, never a pull request requirement.
- A scheduled change-day eval baseline across Claude Code and Codex. It is the only routine model-driven eval.

No model-calling command runs in CI. CI runs only T0 contract tests, type checking, plugin validation, and the deterministic Codex runner tests. Pull requests do not need a benchmark section, eval evidence, an approval label, or a bypass.

## Behavior scope

`vibe-change-scope.ts` is the shared change-day classifier. Claude Code and Codex load the plugin manifests, skills, agents, hooks, and files those runtime components read or execute. Semantic manifest changes and runtime paths are behavior; a required manifest edit that changes only `version` is not. Unreferenced READMEs, changelogs, docs, evals, tests, and benchmark infrastructure are non-behavior. A Markdown reference read by a loaded skill is behavior even when it looks like documentation. An unknown new path under `plugins/vibe` fails closed and triggers the nightly. A path-only classifier cannot prove that a runtime source edit changes comments only, so runtime source remains behavior.

Inspect a diff without making a model call:

```sh
node --experimental-strip-types tools/vibe-bench/src/cli.ts eval-scope <claude-plugins-checkout> <base-ref>
```

## Nightly T2 baseline

The nightly starts from a dedicated clean `main` checkout at fetched `origin/main`. If no behavior path changed since the latest accepted baseline, it prints `SKIPPED` and makes no model call. Otherwise it runs the full corpus once on both runtimes, then reruns only failures at most twice. Claude pins the agent to `claude-sonnet-5-5` and the judge to `claude-opus-5-5`. Codex pins its own agent and judge in `eval-policy.ts`.

Claude Code 2.1.311's embedded model catalog names the judge model `claude-opus-5-5`. Anthropic's public model-status and prompting pages currently describe the public Opus family as `claude-opus-5`, so the installed Claude Code runtime catalog is the exact authority for this local `claude plugin eval` pin. The relevant public references are [Anthropic model deprecations](https://docs.anthropic.com/en/docs/about-claude/model-deprecations) and [Anthropic prompt templates and variables](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/prompt-templates-and-variables).

The stored artifact contains content-keyed case results, reliability history, the quarantine owner and deadline, separate Claude agent and judge costs, and an atomic latest pointer. Added or changed cases run and are reported but are not compared with older content. A case becomes must-pass after at least three observations at a 95 percent pass rate. The initial 29 runtime-specific main failures live in `eval-quarantine.json`.

The accepted lineage is keyed by every agent and judge model ID. A model-policy change runs the corpus even when no behavior path changed, prints `NEW_LINEAGE` with the old and new judge IDs, stores a fresh one-entry history, and sends no regression Slack message. The following comparable nightly can compare within the new lineage. The Haiku 4.5 result from 2026-10-30 remains historical evidence for the initial quarantine only; it is never compared with the Opus 5.5 lineage.

Run one nightly manually through the machine heavy slot:

```sh
<heavy-slot> vibe-eval-nightly <node> --experimental-strip-types tools/vibe-bench/src/eval-nightly.ts <clean-main-checkout> <run-root-parent> <results-store> <claude> <codex> <uv> <gh>
```

The scheduler validates Slack credentials before acquiring the slot. On a confirmed regression, it writes a regression artifact and posts one message to `#vibe` through the existing team Slack bot. The message names the case and runtime, the pull requests merged since the last green nightly with their authors, the quarantine owner, and the result artifact. Clean and skipped nights send no message. The bot call uses Slack `chat.postMessage`; tests use a stub sender and never contact Slack.

Slack credentials are stripped from model and grader child environments. If delivery fails after the baseline is stored, the pending regression artifact is retried before any later paid work, so a transient Slack failure does not force another corpus run.

## Private launchd installation

Do not install the job from a feature branch. Install it only after this change is merged and the same tree is present on `main` in the dedicated checkout.

The example runs at 02:00 local time. The heavy slot is the concurrency guard. The off-hours time also avoids spending an interactive session waiting for the slot, but correctness does not depend on working-hour avoidance.

1. Create a dedicated clone that always stays on `main`. Do not use a worker worktree:

   ```sh
   git clone git@github.com:closedloop-ai/claude-plugins.git <clean-main-checkout>
   git -C <clean-main-checkout> switch main
   git -C <clean-main-checkout> pull --ff-only origin main
   ```

2. Create private scheduler, run, result, and log locations outside the repository:

   ```sh
   install -d -m 0700 <scheduler-private-dir> <run-root-parent> <results-store> <log-dir>
   ```

3. Record absolute paths from `command -v node`, `command -v claude`, `command -v codex`, `command -v uv`, and `command -v gh`, plus the absolute machine heavy-slot path. Do not rely on launchd's `PATH`.
4. Create `<scheduler-private-dir>/vibe-eval.env` outside the repository with mode `0600`:

   ```sh
   SLACK_BOT_TOKEN='<existing team bot OAuth token>'
   SLACK_CHANNEL_ID='<#vibe channel ID>'
   ```

   Then protect it with `chmod 0600 <scheduler-private-dir>/vibe-eval.env`. The wrapper rejects a symlink, a file owned by another user, any mode other than `0600`, a location inside the checkout, duplicate keys, and every key other than the two exact Slack names. It parses values as data and never sources the file as shell code.

   Reuse the existing team Slack bot and its `chat:write` permission. Ensure the bot is a member of `#vibe`. Do not create a second app or commit either value.
5. Copy `schedule/com.closedloop.vibe-eval-t2.plist.example` to `<scheduler-private-dir>/com.closedloop.vibe-eval-t2.plist`. Replace every placeholder with an absolute path: the nightly wrapper, private environment file, heavy slot, Node, nightly TypeScript entrypoint, dedicated checkout, external run-root parent, external results store, Claude, Codex, uv, gh, and the two log files. Keep the private plist outside the clone.
6. Validate and install the private copy:

   ```sh
   plutil -lint <scheduler-private-dir>/com.closedloop.vibe-eval-t2.plist
   launchctl bootstrap gui/$(id -u) <scheduler-private-dir>/com.closedloop.vibe-eval-t2.plist
   launchctl print gui/$(id -u)/com.closedloop.vibe-eval-t2
   ```

7. Confirm the printed `ProgramArguments` are absolute and point to the clean main clone, external run-root parent and results store, private environment file, explicit tool binaries, and heavy-slot script.
8. Do not force a paid first run. Let the next 02:00 invocation perform change detection, or use `launchctl kickstart` only when an operator explicitly requests a run.

`schedule/run-nightly.sh` fails with a clear job-log error when the environment file or either Slack value is missing. The plist holds no credential.

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
