# Codex vibe evals

From the repository root, with Codex CLI installed and signed in:

```sh
uv run --with Pillow==12.3.0 python plugins/vibe/evals/codex/run.py
```

The runner discovers one case for every Claude `evals/*/prompt.md`. Case IDs
use `executive-` and `product-manager-`. Prompts, histories, scaffold scripts,
reference PNGs and regex graders come from the Claude cases rather than a
second copy. Only harness instructions change: Codex loads the installed skill
instead of Claude's Skill tool. Named recipients become role email identities,
and self-identification becomes a role; the scenario and routing intent stay
the same. The expired Claude sign-in scenarios still describe a failed Claude
child, even though Codex is the subject answering that scenario.

Each invocation installs snapshots of this worktree's `plugins/vibe` and its
sibling `plugins/closedloop-core` into a private local marketplace and
`CODEX_HOME`. The user's plugin installs and config stay untouched. Existing
`CODEX_HOME` authentication is copied privately for the run and removed on exit.
No service connection config is copied. Login shells are disabled so screenshot
commands use the runner's Python environment, which must have Pillow.

The defaults are two concurrent processes, a total wall-clock cost cap of 1800
seconds including setup and graders, 180 seconds per reply case, 300 seconds per
visual case, and 90 seconds per wording grader. A timeout kills the full child
process group. The source case's tool-turn limit is also graded. There are no
retries, baseline arms, or automatic review triggers. Lower the time cap with
`--max-seconds`, use `--concurrency 1`, select a persona ID with `--case`, inspect
IDs with `--list`, or select a plugin checkout with `--plugin`. `--output` must
be empty and should be outside the repository.

`gpt-6-sol` runs the cases at low reasoning effort. Regex must-say,
must-not-say, route, CSS file, and tool-use checks run first. Deterministic
behavior checks cover the remaining non-wording Claude graders, including
reference criteria mapped to tokens and render/view ordering after the final
edit. Missing evidence fails. These checks validate the specific fixture
properties and recorded comparisons, not arbitrary image similarity. Only
plain-language wording uses `gpt-6-luna`, and only after deterministic checks
pass. Override models with `--model` and `--grader-model` for account availability.
The cheap grader never decides routing, file correctness or reference evidence.

Visual cases use the same stand-in repository and Pillow renderer as Claude.
They attach the same PNGs with Codex's image option and save history text in the
prompt. No browser, Electron window, actual app or external ticket is started.
The 22 other cases rehearse one reply from supplied session state in read-only
mode. This is behavior coverage, not a substitute for live app validation.

The console reports each case and failure. Private artifacts include input,
reply, events, rollout tool calls, the modified fixture, usage and `results.json`.
Usage is reported as tokens and elapsed seconds, never currency. Failures return
exit status 1. Preserve these artifacts for diagnosis; do not commit the private
home or raw transcripts. A measured Claude run is needed to establish a model
comparison; a Codex failure against a shared grader alone does not prove Claude
passes it. Neither model suite runs in CI. Local runner regression tests use no
model calls and run with the repository's normal pytest discovery.

The [main 642d235 baseline](baselines/main-642d235.md) lists all 26 results,
remaining plugin failures and the selected-state fixture limitation.
