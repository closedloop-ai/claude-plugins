# Changelog

All notable changes to the claude-plugins project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are listed newest-first; each plugin section is treated as released when merged to `main`.

### code v1.12.0

#### Added
- New `pre-tool-use-hook.sh` and `post-tool-use-hook.sh` hooks (FEA-889 of PRD-254) that emit `tool`, `skill`, and `spawn` perf events to `perf.jsonl` for every Claude Code tool invocation inside a Loop. The pre-hook writes a sentinel file at `$CLOSEDLOOP_WORKDIR/.tool-calls/{TOOL_USE_ID}` capturing call-time attribution (`started_at`, `tool_name`, `agent_id`, `run_id`, `command`, `iteration`); the post-hook reads it to compute `duration_s` and emit the `tool` event, deletes it on success, and additionally emits a `skill` event for `Skill` tool calls. The pre-hook emits a `spawn` event with `parent_session_id`, `parent_agent_id`, and `planned_subagent_type` for `Agent` tool calls. Both hooks gated behind `CLOSEDLOOP_PERF_V2=1` and use the `trap 'exit 0' ERR` fail-open pattern so a hook crash never blocks the underlying tool call or the Loop. Registered in `plugins/code/hooks/hooks.json` as a new `PreToolUse` entry and the first `PostToolUse` entry. New `minClaudeCodeVersion: "1.0.33"` in plugin.json documents the required `tool_use_id`/`PostToolUse` payload contract.
- Correlation-id resolution prefers `tool_use_id` → `tool_call_id` and skips silently if both are absent. The earlier counter-file fallback was removed because it was race-prone under parallel tool invocations: two pre-hooks could read the same counter value, write the same sentinel name, and the post-hooks would correlate to the wrong calls. Skipping is the only safe option without atomic locking.
- Post-hook now treats the sentinel as the authoritative source for `run_id`, `command`, and `iteration` (in addition to `tool_name` and `agent_id`), with env vars as fallback. This keeps tool-event attribution stable even if iteration advances or env vars drift between the pre and post hook firing.
- Defense-in-depth: corrupt sentinel JSON (empty `started_at` after parse) suppresses the tool event entirely rather than emitting a record with `started_at: ""` and `duration_s: 0` — the missing-timing case now consistently surfaces as "no event" rather than "polluted event."
- `CLOSEDLOOP_ITERATION` is numerically validated before `--argjson` in both hooks. A non-numeric value silently aborted the hook via `trap exit 0 ERR` and lost the sentinel; values not matching `^[0-9]+$` are now normalized to `0`.
- Bash test suite under `plugins/code/hooks/tests/` (5 files, 103 tests total) covering `tool` event emission, `skill` event emission with `tool_input.skill` → `tool_input.command` fallback, `spawn` event emission for `Agent` calls, fail-open contract for both hooks, and a new `test_correlation.sh` (20 tests) that exercises real pre→post correlation, sentinel-attribution-wins-over-env-drift, corrupt-sentinel suppression, missing-correlation-id silent skip, and non-numeric iteration normalization.

### code v1.11.7

#### Added
- Per-run `claude-output.jsonl` archival in `run-loop.sh`. New helpers `sanitize_output_run_id`, `rename_orphan_output_on_start`, and `rename_output_on_exit` rename the live JSONL to `claude-output-<run_id>.jsonl` on every loop exit (including spurious-complete, interrupt, and error paths) and write a `claude-output.name.txt` sidecar pointing at the latest archived file. On startup, any orphaned `claude-output.jsonl` left from a prior run is renamed using the previous `RUN_ID` from `state.json` or the last entry in `runs.log` (or an `orphan-<timestamp>` fallback), and the sidecar is cleared so consumers do not read stale prior-run pointers. Run id values are sanitized (`[^A-Za-z0-9._-]` collapsed to `_`) before being interpolated into the destination filename. New tests in `test_run_loop_failure_marker.py` cover the rename-on-exit, orphan-rename-from-runs.log, and workdir-root `runs.log` paths.
- Claude session-id capture in `run-loop.sh`. New helpers `extract_claude_session_id` (jq-based extraction across `session_id`/`sessionId`/`message.*`/`item.*` shapes), `record_claude_session_id` (sets `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID`, exports `CLOSEDLOOP_SESSION_ID`), and `sanitize_runs_log_field` (strips `\r`/`\n` and replaces `|` with `_`). `record_claude_session_id` writes `$workdir/session-id.txt` only for the `plan_execute` command so post-loop `code_review` and fix sessions do not overwrite the operation-level correlation id consumed by desktop finalization. Plan/execute, post-loop review, and fix invocations now capture session ids and route them into the runs.log entry for that step. New tests cover the primary plan/execute write, the code-review preservation of the primary session, and the runs.log workdir-root location with sanitized command/session fields.

#### Changed
- `write_runs_log_entry` in `run-loop.sh` now writes to `$workdir/runs.log` instead of `$workdir/.learnings/runs.log`, matching the new `self-learning` `prune-learnings.sh` and `evaluate_goal.py` location. Keeps the runs ledger at the workdir root next to `state.json` and `plan.json` rather than nested inside `.learnings/`.
- `runs.log` row format extended to `run_id|timestamp|goal|iteration|status|command|last_session_id`. The first five fields are the legacy contract; `command` (e.g. `plan_execute`, `code_review`, `self_learning`) and `last_session_id` are append-only so older self-learning readers stay compatible. `write_runs_log_entry` accepts optional 4th/5th arguments for explicit command/session overrides and falls back to `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID` (or `session-id.txt`) otherwise.
- `--codex-model` default in the `/code:plan-with-codex` README documentation updated from `gpt-5.4` to `gpt-5.3-codex` to match the actual command default.

### self-learning v1.2.2

#### Changed
- `prune-learnings.sh` and `evaluate_goal.py` now read and rotate `runs.log` from `$WORKDIR/runs.log` instead of `$LEARNINGS_DIR/runs.log` (`<workdir>/.learnings/runs.log`). The runs ledger now lives at the workdir root alongside `state.json` and `plan.json`, matching where `run-loop.sh` writes it. New tests `test_prune_learnings.py` and a `test_reduce_failures_reads_runs_log_from_workdir_root` case in `test_evaluate_goal.py` lock in the new location.
- `goal-stats` command documentation (`commands/goal-stats.md`) now describes the pipe-delimited `runs.log` row format `run_id|timestamp|goal|iteration|status[|command|last_session_id]` and notes that `command` and `last_session_id` are optional append-only fields so legacy 4+ field rows remain valid. The `runs.log` data-source description was updated to mention the optional command/session correlation columns.
- `evaluate_goal.py` comment on `RUNS_LOG_MIN_FIELDS` clarifies that reduce-failures only needs `run_id` and `iteration`, so legacy 4+ field rows and newer session-correlated rows are both accepted.

#### Fixed
- `prune-learnings.sh` session enumeration in `prune_sessions()` no longer relies on `mapfile` piped through `tac`. Replaced `mapfile -t all_sessions < <(ls -1t "$sessions_dir" | tac)` with a `while IFS= read -r ... done < <(ls -1tr ...)` loop, which avoids the `tac` external dependency (not present on default macOS) and keeps the oldest-first ordering needed for FIFO pruning.

### code v1.11.6

#### Added
- New `record_run.sh` script emits exactly one `run` event per Loop to `perf.jsonl` carrying `command`, `repo`, `branch`, and `started_at`, so every perf record can be attributed to the slash-command that launched the Loop. Gated behind `CLOSEDLOOP_PERF_V2=1`; fails open on any unexpected error (`trap 'exit 0' ERR`). Invoked synchronously from `run-loop.sh:main()` with `|| true` and only on fresh-start invocations (resumed Loops do not re-emit), so the `run` event is appended before the first `phase` event without ever changing the Loop's exit code and without violating PRD-254 AC-1's "exactly one `run` event per Loop" guarantee.
- New `CLOSEDLOOP_COMMAND` environment variable exported by `run-loop.sh` next to `CLOSEDLOOP_RUN_ID`, derived from `PROMPT_NAME` and defaulting to `interactive` for bare `/code:code` invocations. The launching command is also persisted in `state.json` (`command:` field in the YAML frontmatter) and restored on resume so `CLOSEDLOOP_COMMAND` keeps its original value instead of degrading to `"interactive"` when the `--prompt` CLI flag isn't re-passed. Older state files lacking the `command` field preserve prior behavior. Hooks and child processes inherit the variable automatically.
- New `command` field on every `phase`, `iteration`, `pipeline_step`, and `agent` perf event when `CLOSEDLOOP_PERF_V2=1`. Implemented in `record_phase.sh`, `subagent-stop-hook.sh`, and the `emit_perf_event` helper in `run-loop.sh` (which folds the gate into a single `jq -n -c` filter via `--arg perf_v2` rather than spawning a second `jq` per event). The field is omitted entirely when the gate is off, preserving the legacy JSON shape.
- `record_run.sh` captures `repo` and `branch` via `git -C` with GNU `timeout` as a hang guard when available, falling back to bare `git -C ...` when `timeout` isn't on `PATH` (default macOS without `coreutils`) so dev machines never silently emit empty `repo`/`branch` fields.
- New `plugins/code/tools/python/test_record_run.py` (covering gate behavior, JSON shape, fail-open paths, repo/branch capture under a fake-`git` PATH shim, and a no-`timeout`-on-PATH regression case) and `plugins/code/tools/python/test_record_phase.py` (covering V2 gating, field correctness, and missing-state fail-open). Both files run under `pytest` with no extra fixtures.
- One-line note in `prompts/prompt.md` documenting that `record_run.sh` is invoked automatically by `run-loop.sh` at the start of every Loop (before Phase 0.9) and requires no orchestrator action.

### self-learning v1.2.1

#### Changed
- Coordination version bump alongside `code` v1.11.6 per the PRD-254 producer-side rollout (FEA-887). No functional changes; the bump exists so the two plugins ship together as a matched set, mirroring the FEA-764 precedent.

### code v1.11.5

#### Fixed
- Phase 1 of the orchestrator prompt (`plugins/code/prompts/prompt.md`) now tolerates a `plan.json` whose contents are raw markdown instead of JSON — a shape produced by older gateway versions that wrote the plan source straight to `plan.json`. Before activating the `code:plan-validate` skill, the orchestrator validates `plan.json` with `python3 -m json.tool`; if parsing fails, it renames the file to `plan-source.md`, sets `CLOSEDLOOP_PLAN_FILE` to that path, marks `plan_was_imported = true`, and routes through `@code:plan-importer`. A new branch in the "plan.json does NOT exist" path also picks up a pre-existing `plan-source.md` for import. This unblocks runs that previously failed at Phase 1 with `EMPTY_FILE`/`FORMAT_ISSUES` against markdown content.

### code v1.11.4

#### Added
- Three new common-misses items (13-15) and two new contract-heavy review-surface bullets in the `decision-table` skill's `references/review-prevention.md`: **replay or continuation path bypasses an initial-entry gate** (conflict replays, retry callbacks, confirmation callbacks, and deferred command callbacks must enforce the same guard, policy, validation, target resolver, or health check as the original entry path); **owner-scoped pending state leaks across surfaces** (loading, disabled, or label state reading a global pending/checking flag without matching the current owner, command, document, target, or attempt id); and **sentinel value semantics collapse** (omitted, `undefined`, `null`, empty, and explicit payload values that have different downstream meaning but are defaulted, coalesced, or serialized as the wrong shape).

#### Fixed
- `detect_spurious_complete` in `run-loop.sh` was firing on legitimate `AWAITING_USER_SEQUENCE` hard stops (most visibly the Phase 1.1 plan review checkpoint), causing `/code:code` to fail with a `PENDING_TASKS_BLOCKED_BY_QUESTIONS` marker the moment the orchestrator drafted a new plan. The detector inspected only `plan.json`, where pending tasks and open questions are expected on a freshly drafted plan. It now reads `state.json.status` first and short-circuits when the status is `AWAITING_USER` — final-completion regressions (`status: "COMPLETED"` with leftover `pendingTasks`) are still flagged as before. New tests in `test_run_loop_failure_marker.py` cover the AWAITING_USER skip plus the existing positive/negative cases for `detect_spurious_complete`.
- Phase 5.5 telemetry instruction in the orchestrator prompt now writes `decision-table-verifications.jsonl` directly under `$CLOSEDLOOP_WORKDIR` instead of `$CLOSEDLOOP_WORKDIR/.closedloop-ai/`, matching where the rest of the run's per-loop artifacts (`plan.json`, `log.md`, `state.json`) live and avoiding a bespoke nested directory the haiku subagent had to `mkdir -p` on every Phase 5.5 exit.

### code v1.11.3

#### Added
- Four new edge-case sections in the `decision-table` skill's `references/edge-cases.md`: **State propagation across isolation boundaries** (subprocesses, workers, callbacks, transactions, child tasks — require explicit propagation rows for success, validation failure, dependency failure, cancellation/timeout, and partial-output branches, plus a real production-sequencing test); **Finalizer-visible cleanup state** (deferred finalizers, traps, disposers, signal handlers, process-exit hooks — require rows describing handle scope, clearing, and exit-via-error paths, plus a failure-path test that exits through the real finalizer); **Transformed input validation parity** (trim/parse/decode/normalize/canonicalize/default/coerce flows — require rows for raw, transformed, validated, and consumed values plus mutations that prove validation runs against the consumed value); **Canonical value persistence** (paths, identities, endpoints, workspaces, profiles, tenants — require rows distinguishing raw, expanded, normalized, canonical/resolved, and serialized output, plus alternate-spelling tests proving durable output uses the canonical value).
- Five new common-misses items (8-12) and six new contract-heavy review-surface bullets in the `decision-table` skill's `references/review-prevention.md` covering: cleanup/finalizer state scoped too narrowly for the actual cleanup mechanism; durable output that serializes raw input after validation used a transformed value; validation that checks a different representation than the consumed value; state produced inside an isolated execution context without an explicit propagation mechanism; and distinct modeled states whose observable status/message/affordance/styling/telemetry/response signal is indistinguishable in implementation despite the table treating them as different outcomes.

### code-review v1.5.5

#### Fixed
- `/start` command now passes `--diff-scope` and `--original-scope` to `code_review_helpers.py` using the `--flag=value` form instead of `--flag "value"` (three call sites: standard-flow `extract-patches`, fast-path `extract-patches`, and `auto-incremental`). The space-separated form caused `argparse` to treat scope values that began with a leading dash as a separate option and fail with `unrecognized arguments`; the `=` form binds the value unambiguously.

### code v1.11.2

#### Fixed
- Migrated 6 SKILL.md files (`build-status-cache`, `codex-review`, `critic-cache`, `cross-repo-cache`, `extract-plan-md`, `plan-validate`) and the `plan-with-codex` command from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable (commands use `${CLAUDE_PLUGIN_ROOT}/skills/<name>/...`). The `<base_directory>` placeholder was relying on the model to infer the path from context — Claude Code's harness only pre-substitutes `${CLAUDE_SKILL_DIR}` (per the [official skills docs](https://code.claude.com/docs/en/skills.md)), so the prior pattern was unreliable. Removed the now-stale "shown above as 'Base directory for this skill'" explanatory text from the affected SKILL.md files.
- Phase 5 build-cache stamp instruction in the orchestrator prompt was using a relative `bash scripts/check_build_cache.sh` path that resolved against the orchestrator's CWD (typically wrong). Replaced with the absolute `bash "$CLAUDE_PLUGIN_ROOT/skills/build-status-cache/scripts/check_build_cache.sh" "$CLOSEDLOOP_WORKDIR" stamp` pattern that matches the other cache-stamp invocations in `prompt.md`.
- Migrated bare `python ...` invocations to `python3 ...` in `find-plugin-file` SKILL.md (7 examples + the slash-command integration snippet), `find_plugin_file.py` docstring, and the `amend-plan` command (12 invocations of `python "$AMEND_STATE_PATH" ...`). Modern macOS and many Linux distros do not symlink `python` → `python3`, so bare `python` was failing with `command not found: python` mid-orchestration when the orchestrator activated the `find-plugin-file` skill or ran `amend-plan` from `prompt.md`-driven workflows.
- `run-loop.sh` now guards against spurious `<promise>COMPLETE</promise>` emissions. The orchestrator's Phase 7 contract forbids emitting `COMPLETE` when `plan.json` has pending tasks, but it sometimes violates that contract — typically when tasks are blocked by unanswered questions. The runner now reads `plan.json` directly (not via `validate_plan.py` extraction, which would mask `pendingTasks` on a `FORMAT_ISSUES` plan), and if `pendingTasks` is non-empty after `COMPLETE` is detected, it routes through `fail_loop_user_visible` (from v1.11.1) with `RUNNER_ERROR` plus `PENDING_TASKS_BLOCKED_BY_QUESTIONS` (when open questions remain) or `PENDING_TASKS_AT_COMPLETION`. The `loop-error.json` marker carries an actionable user message; post-loop code review is skipped. New helpers `detect_spurious_complete()` and `handle_spurious_complete()` keep the orchestration loop readable. `iteration` perf events use `status="spurious_complete"` instead of `"completed"` for these cases.
- `run-loop.sh` now signs user-visible `loop-error.json` markers with the per-run `CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET` provided by Electron, then unsets the exported env var before spawning Claude. This lets the parent harness emit trusted intentional failure markers while preventing repository/tool commands from forging the marker by writing JSON directly into the workdir. Failure-marker tests now cover signed output, missing-secret rejection, and secret removal from the exported environment.

#### Changed
- Flattened `CHANGELOG.md` structure: removed the `## [Unreleased]` and `## [Releases]` separator headings. Every plugin entry is now listed newest-first under the top-level `# Changelog` heading and is treated as released when merged to `main`. Updated `.claude/commands/update-documentation.md` to teach `/update-documentation` runs not to reintroduce those headings.

### code-review v1.5.4

#### Fixed
- Migrated 25+ bare `python <HELPERS> ...` invocations in the `/start` command to `python3 <HELPERS> ...`. Same root cause as the corresponding `code` plugin entry — bare `python` is unresolved on modern macOS and many Linux distros.

### judges v1.5.2

#### Fixed
- Migrated `eval-cache` SKILL.md from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable. Removed the stale "shown above as 'Base directory for this skill'" explanatory text. See the corresponding `code` plugin entry for context.

### platform v1.1.3

#### Fixed
- Migrated `upload-artifact` SKILL.md (both `--list-projects` and upload invocations) from the unofficial `<base_directory>` placeholder to the documented `${CLAUDE_SKILL_DIR}` substitution variable. See the corresponding `code` plugin entry for context.

### code v1.11.1

#### Added
- New runner-side user-visible failure marker infrastructure in `run-loop.sh`. Helpers `write_loop_user_visible_failure()` and `fail_loop_user_visible()` emit a structured `{code, message, result.subcode}` JSON marker to `$CLOSEDLOOP_WORKDIR/loop-error.json` so downstream consumers (e.g. the Electron desktop app's finalizer) can surface actionable runner failures to the user. Inputs are validated: `code` against an allowlist (`RUNNER_ERROR`, `PRE_RUN_VALIDATION_FAILED`, `PLAN_STATE_UNAVAILABLE`), `subcode` against `^[A-Z][A-Z0-9_]{2,63}$`, and `message` length 1-1000 characters. Marker is written atomically (`tmp` then `mv`) under `umask 077`. The bottom-of-file `trap` and `main "$@"` invocation are now guarded by `[[ "${BASH_SOURCE[0]}" == "$0" ]]` so the script can be sourced (e.g. by tests) without launching the loop. New tests in `plugins/code/tools/python/test_run_loop_failure_marker.py` cover the happy path, the unsupported-code rejection, and the fail-and-exit path.

### judges v1.6.0

#### Added
- Feature artifact type support (`--artifact-type feature`) in `run-judges` skill — evaluates feature artifacts using 3 judges (`feature-completeness-judge`, `prd-testability-judge`, `prd-dependency-judge`) in 1 batch and writes `$CLOSEDLOOP_WORKDIR/feature-judges.json`. Explicitly excludes `prd-auditor` (assumes US-###/AC-#.# numbering not present in feature artifacts) and `prd-scope-judge` (assumes In/Out-of-Scope sections not required for feature artifacts). Reuses `prd_preamble.md` — no separate `feature_preamble.md` is needed.
- `"feature"` category in `validate_judge_report.py`: added to `JUDGE_REGISTRY` with 3 expected judges, to `VALID_SUFFIXES` mapping `feature` to `["-feature-judges"]`, and to `DEFAULT_FILENAMES` mapping `feature` to `feature-judges.json`.
- `TestCategoryFeatureValidation` test class in `validate_judge_report.py` tests with 8 test methods covering the new feature category.
- Complete `SKILL.md` documentation for feature mode in `run-judges` skill.

### judges v1.5.2

#### Added
- New `feature-completeness-judge` agent (sonnet) that evaluates incoming Feature/PRD requests for readiness before plan creation. Reads `$CLOSEDLOOP_WORKDIR/prd.md` and emits a CaseScore. Applies five checks: Problem Statement Presence (blocking, user-pain framings only — pure business-opportunity framings no longer satisfy the check), Clarity and Specificity (major, with context-aware suppression of vague qualifiers when the same paragraph supplies a measurable target, observable behavior, or bounded scope reference), Acceptance Criteria (major), Ambiguous Language (minor, capped at 5), and Solution Essence (blocking — Feature must include either a Proposed Solution or a Desired Outcome section).

#### Changed
- `run-judges` PRD mode now runs the 5 PRD judges across **2 sequential batches** (`batch_1`: feature-completeness-judge + prd-auditor + prd-scope-judge; `batch_2`: prd-dependency-judge + prd-testability-judge) to respect the Task tool's 4-concurrent-agent limit. Sub-step numbering renumbered (`batch_1=1`, `batch_2=2`, `aggregate=3`, `validate=4`); skill description, batch tables, success checklist, troubleshooting guide, and PRD Mode Execution Flow narrative all updated.
- `JUDGE_REGISTRY["prd"]` in `validate_judge_report.py` now includes `feature-completeness-judge`; PRD validator tests updated for 5-judge expectations.

### code v1.11.0

#### Added
- New `record_phase.sh` script that appends a `phase` event to `perf.jsonl` from the current `state.json`. Captures `phase`, `status`, `start_sha`, `started_at`, `run_id`, and `iteration` so per-phase wall-clock durations can be reconstructed across an entire run.

#### Changed
- Orchestrator State Tracking section in `prompt.md` now instructs the orchestrator to call `record_phase.sh` after every `state.json` write (non-blocking; failures ignored). Phase events stream into the same `perf.jsonl` file as iteration, pipeline_step, and agent timing events.

### self-learning v1.2.0

#### Added
- New `summarize_phases()` aggregator in `perf_summary.py` that reads `phase` events from `perf.jsonl`, derives per-phase durations from the gap to the next phase event in the same `(run_id, iteration)` (or to the iteration's `ended_at` for the final phase), and reports count/avg/min/max/total. Phases never pair across iteration boundaries.
- Phases summary table added to `perf_summary.py` text output and `phases` field added to its JSON output, alongside the existing Iterations / Pipeline Steps / Sub-steps / Agents tables.
- New `--timeline` CLI flag and `phase_timeline()` function in `perf_summary.py` that emits a chronological per-instance view (one row per phase invocation with `run_id`, `iteration`, `started_at`, `ended_at`, `duration_s`). Incomplete final phases (no following phase event AND no iteration `ended_at`) are emitted with `ended_at=""` and `duration_s=null` so in-progress runs remain visible. Works with `--format json` for machine-readable output.
- Tests for phase summarization and timeline covering iteration boundaries, missing iteration end (final phase skipped vs surfaced), aggregation across iterations, total-time descending sort, and per-row run/iteration provenance.

### code v1.10.0

#### Added
- New `decision-table` skill for generating code-grounded decision-table artifacts that map current vs. intended control-flow behavior, capturing recovery, retry, finalization, validation, and state-machine edge cases under `.closedloop-ai/decision-tables/`. Includes baseline/target table rules, behavioral edge-case expansion guidance (call-site inventory for shared surfaces, exception scope, serverless async side effects, testable invariants), post-implementation verification sections, contract-heavy review checklist, and a referenced artifact format template at `references/artifact-format.md`.
- New `behavior-verifier` agent that activates the `decision-table` skill in verification-only mode (SKILL.md step 17), reads final code against the artifact's Intended Change rows, appends Verification Findings and Final Alignment Status, and emits a structured `ALIGNED` or `MISALIGNED` verdict with a typed `<drift_rows>` JSON block (`code_drift`, `test_drift`, `plan_ambiguity`) for orchestrator routing. Read-and-report only — never modifies code or tests.
- Optional `decisionTable` property on the plan schema (`path` + `status` enum: `pending|aligned|aligned_with_clarifications|verification_failed`) so the orchestrator can persist artifact pointers and verification state across iterations.
- Phase 5.5 Behavioral Verification loop in the orchestrator prompt with a 5-attempt cap, drift routing by kind (`code_drift` → `implementation-subagent`, `test_drift` → `test-engineer`, `plan_ambiguity` → haiku append), parse-failure circuit breaker, and per-run telemetry emit to `.closedloop-ai/decision-table-verifications.jsonl` (timestamp, final status, iteration count, drift counts, parse failures, phase duration).
- `startSha` state-tracking field initialized once per run from `CLOSEDLOOP_START_SHA` in `config.env` and propagated on every `state.json` write so Phase 5.5 can scope the changed-file set without re-reading config.

#### Changed
- `plan-writer` Finalize Mode now generates the decision-table artifact via a snapshot/set-difference algorithm (mkdir → ls before → activate `decision-table` skill → comm -13 to compute new files) and writes `decisionTable.path` + `status: "pending"` into `plan.json`. Skips when `plan_was_imported=true` or `simple_mode=true`. Emits `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH` and withholds `PLAN_WRITER_COMPLETE` when 0 or >1 new artifact files appear, delegating the hard stop to the orchestrator rather than guessing.
- `plan-writer` Completion section adds a decision-table gate that re-verifies `plan.json.decisionTable.path` is non-empty and the artifact file is non-zero bytes before emitting `PLAN_WRITER_COMPLETE`.
- `plan-validate` skill now validates the optional `decisionTable` shape and surfaces `decision_table_path` and `decision_table_status` in the `extract_data` output (always present; empty strings when the field is absent), so the orchestrator can read both values without touching the filesystem. PLAN_VALID example in `SKILL.md` updated.
- Phase 2.7 in the orchestrator prompt now passes `plan_was_imported` and `simple_mode` flags through to `plan-writer` and inspects the launch output for `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH`. On marker present: executes AWAITING_USER_SEQUENCE pointing at `.closedloop-ai/decision-tables/` and HARD STOPS, treating the marker as authoritative even if `PLAN_WRITER_COMPLETE` was also emitted.
- Phase 7 completion summary now reads `decision_table_status` from the latest `plan-validate` output and logs `Behavioral alignment verified` (or `…with plan clarifications`) referencing the artifact path.
- `loop-agents.json`: registered `code:behavior-verifier` (max 3 iterations, promise `BEHAVIOR_VERIFIER_COMPLETE`, ALIGNED/MISALIGNED criteria with required `<drift_rows>` fields and `kind` enum); extended `code:plan-writer` `verification_criteria` so `DECISION_TABLE_ARTIFACT_COUNT_MISMATCH` is a legitimate detection state, not a loop failure. `code:behavior-verifier` added to `learning_agents.agents` for capture coverage.
- Available Skills table in the orchestrator prompt now lists `code:decision-table` with usage in Phase 2.7 (generation via plan-writer) and Phase 5.5 (verification-only via behavior-verifier).

### code v1.9.4

#### Fixed
- `setup-closedloop.sh` no longer clobbers `CLOSEDLOOP_PLAN_FILE` when the env var is already set by the caller (e.g. closedloop-electron). Previously, omitting `--plan` unconditionally overwrote the env var with an empty string, causing imported plans to be silently ignored and regenerated from scratch.

### code v1.9.3

#### Changed
- Migrated subagent resumption pattern from Task-based re-launch to SendMessage continuation across orchestrator prompt, `visual-qa-subagent` agent, `iterative-retrieval` skill, and `/code` command allowed-tools list
- Orchestrator Phase 6 INCOMPLETE_DOCS and BLOCKED handlers now store `agent_id` from initial Task spawn and continue via `SendMessage(to=<agent_id>)` instead of launching fresh Task instances
- Added async wait rule requiring orchestrator to wait for `<task-notification>` before proceeding after SendMessage dispatch
- `run-loop.sh` now pins `--model claude-opus-4-6` and `--effort high` on the per-iteration `claude` invocation

### code-review v1.5.3

#### Fixed
- Clarified `partitions.json` schema documentation in `/start` command. The partition output's `files[]` entries use the key `file` (not `path`) for the file path, but the prior doc only listed the entry-level shape implicitly via `{filepath_1}` placeholders. The underspecification caused the orchestrator LLM to construct ad-hoc Python one-liners against `partitions.json` using `f['path']`, throwing `KeyError: 'path'` mid-pipeline. The doc now spells out each entry as `{"file", "loc", "is_test", "line_range"?}`, adds a placeholder-to-source mapping for the per-agent prompt template, and instructs the orchestrator to use the Read tool rather than introspect the JSON shell-style.

### code-review v1.5.2

#### Fixed
- Fixed `test_github_mode` test isolation to prevent `CR_GLOBAL_CACHE` environment variable from leaking into test assertions

### code v1.9.2

#### Changed
- `run-loop.sh` and `debate-loop.sh` now consume the `CLAUDE_BIN` environment variable when set, falling back to bare `claude` otherwise. Complements closedloop-electron PR #111 so the Electron desktop app's pre-validated claude binary path is actually used by every subprocess invocation -- fixes silent failures for users whose `claude` is installed outside `/opt/homebrew/bin` (non-Homebrew macOS setups, manual symlinks, etc.)
- `debate-loop.sh` dependency check verifies the resolved `$CLAUDE` path rather than a bare `claude` lookup, so custom binary locations are correctly validated at startup

### code v1.9.1

#### Added
- `--request-file` parameter in `codex-review` skill and `run_codex_review.sh` so Codex reads the original user request before reviewing and judges the plan against the actual request, not just the plan's self-framing
- "Re-scoped" revision-summary bucket in `plan-agent` for findings accepted as the minimal required or enabling change
- Additional tests in `test_setup_closedloop.py` covering unquoted paths with spaces in slash-command arguments

#### Changed
- `plan-agent` scope discipline now distinguishes between required work, justified localized enabling refactors, and true optional scope creep — findings are no longer rejected solely because they look broader than the current task
- `/plan-with-codex` command switched from `Agent(resume=...)` to `SendMessage` for plan-agent continuation across rounds, preserving full prior context via transcript auto-resume
- Round-aware Codex review prompts in `run_codex_review.sh`: round 1 is a broad material audit, rounds 2-4 are delta reviews that verify prior findings, rounds 5+ are blocker-only convergence reviews
- `debate-loop.sh` now forwards the original prompt to `run_codex_review.sh` via `--request-file` and uses the refactor-aware revision guidance when asking plan-agent to revise
- `setup-closedloop.sh` argument parser tolerates unquoted paths containing spaces by joining consecutive non-flag tokens into a single value for `--prd`, `--plan`, `--add-dir`, and the positional workdir
- `/code` slash command now invokes `setup-closedloop.sh` via `bash "${CLAUDE_PLUGIN_ROOT}/scripts/setup-closedloop.sh"` for portability
- `run-loop.sh` now emits quoted `/code:code` arguments for workdir, `--prompt`, `--prd`, and `--add-dir` in loop state, preserving argument boundaries for values that contain spaces
- `plan-with-codex` command gains `SendMessage` in its allowed-tools list

### platform v1.1.2

#### Changed
- `upload-artifact` skill renamed terminology from "artifact" to "document" to match the renamed ClosedLoop MCP tools (`create-artifact` → `create-document`, `create-artifact-version` → `create-document-version`). Skill description, prompts, and result reporting updated accordingly.
- `upload-artifact` now supports the `FEATURE` document type alongside `PRD`, `IMPLEMENTATION_PLAN`, and `TEMPLATE`.
- `upload_artifact.py` and the skill's `--artifact-id` flag now accept a UUID or a user-facing slug (`PRD-*`, `PLN-*`, `FEA-*`) for new-version uploads; the MCP server resolves the identifier. `--project-id` and `--workstream-id` similarly accept slugs (`PRO-*`, `WRK-*`).
- Result payloads now include `document_id` (mirroring `artifact_id` for backward compatibility) and report the document slug alongside the ID.
- `context-engineering` skill: Refactoring Existing Prompts section gains a "Dropped qualifiers" pitfall row (load-bearing single modifiers like `only`, `unless`, `when appropriate`, `must`, `never`) and a four-step Validation Pass that requires labeling every removed line as relocated, redundant, or dropped on purpose before declaring a refactor done.

### platform v1.1.1

#### Changed
- `upload-artifact` skill now reads `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` from the current shell environment instead of `.env.local`, and falls back to MCP mode when either variable is missing
- `upload_artifact.py` defaults `--api-key` and `--url` to the `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` environment variables, exiting with a clear parser error when neither the flag nor the env var is set

### self-learning v1.1.2

#### Changed
- `process-chat-learnings.sh` now consumes the `CLAUDE_BIN` environment variable when set, falling back to bare `claude` otherwise — matches the `code` plugin pattern so desktop-spawned learning runs use the pre-validated binary

### bootstrap v1.2.0

#### Changed
- Migrated critic-gates configuration path from `.claude/settings/critic-gates.json` to `.closedloop-ai/settings/critic-gates.json` across `agent-decomposer`, `agent-prompt-validator`, `generation-validator`, and `agent-bootstrap` command
- Migrated schema validation path from `.claude/schemas/` to `.closedloop-ai/schemas/` in `agent-prompt-validator`
- Updated agent output path references from `.claude/runs/` to `.closedloop-ai/runs/` in `agent-prompt-generator`
- Updated bootstrap configuration documentation in `agent-bootstrap.md` to reference `.closedloop-ai/` state directory

### code v1.9.0

#### Added
- Multi-repo planning and exploration support via new `--add-dir` flag in `run-loop.sh`, exposing `CLOSEDLOOP_ADD_DIRS` and `CLOSEDLOOP_REPO_MAP` env vars to downstream agents
- `pre-explorer` agent produces per-repo code maps (`code-map-{name}.json`) when secondary repos are supplied
- `plan-draft-writer` agent emits multi-repo plans with a `## Repositories` table and `@{repo}:path` task prefixes
- `repositories` map field added to the plan root schema in `plan-schema.json` for multi-repo plan traceability, keyed by repo short-name with `path` and `isPrimary` metadata
- Tier 0 explicit-directory discovery and dedup helpers in `discover-repos.sh`, with structured JSON output and a `local: true` marker on `--add-dir` peers
- Tests for `discover-repos.sh` and `setup-closedloop.sh` (`test_discover_repos.py`, `test_setup_closedloop.py`) plus new multi-repo cases in `test_validate_plan.py`

#### Fixed
- `run-loop.sh` now scans the full per-iteration stream for the `<promise>` completion marker instead of only inspecting the final `type==result` record, preventing missed completion signals when the orchestrator emits the promise in an intermediate message followed by additional tool_use or wrap-up output
- `discover-repos.sh` now filters add-dirs that are ancestors of the workdir and deduplicates repo entries to prevent duplicate discovery results

#### Changed
- Consolidated Tier 0 `discover-repos.sh` tests into a single scenario-driven harness, replacing the prior fragmented per-case test files
- Migrated workdir internal state directory from `.closedloop/` to `.closedloop-ai/` across hooks, setup scripts, and loop state management
- Established `CLOSEDLOOP_STATE_DIR` constant as single source of truth for state directory name across shell scripts
- Added `Skill` to `plan-evaluator` agent's allowed tools to enable `code:plan-validate` skill execution

### code v1.6.0

#### Changed
- Migrated all remaining `.claude/` path references to `.closedloop-ai/` across hooks, scripts, agents, skills, and orchestrator prompt -- completes the directory migration started in v1.1.0
- Replaced `gawk` FPAT-based TOON parser with portable `csv_split()` function in `pretooluse-hook.sh` and `subagent-start-hook.sh`, removing the hard dependency on GNU awk
- Refactored awk array usage from associative `patterns[n]["key"]` to parallel flat arrays for POSIX awk compatibility
- Updated `install-dependencies.sh` to verify any `awk` instead of requiring `gawk` with FPAT support
- Updated org learnings copy path in `run-loop.sh` to use `.closedloop-ai/learnings/` with workdir-adjacent state directory resolution

#### Removed
- Removed all legacy `.claude/.closedloop/` session/workdir/env fallback paths from `loop-stop-hook.sh`, `pretooluse-hook.sh`, `session-end-hook.sh`, `subagent-start-hook.sh`, `subagent-stop-hook.sh`, and `setup-closedloop.sh`
- Removed legacy `~/.claude/.learnings/org-patterns.toon` fallback from `pretooluse-hook.sh` and `subagent-start-hook.sh`
- Removed legacy cleanup logic from `session-end-hook.sh` (PID cleanup, stale session removal, legacy directory deletion)

#### Added
- Tests for legacy path ignorance in pretooluse and subagent-start hooks, setup-closedloop, and self-learning flag tests
- Tests for portable awk injection (`test_injects_when_only_plain_awk_is_available`) in both hook test suites

### code-review v1.4.0

#### Changed
- Migrated GitHub mode output file paths from `.claude/` to `.closedloop-ai/`: `code-review-findings.json`, `code-review-threads.json`, and `code-review-summary.md`
- Updated `route` subcommand to read critic-gates from `.closedloop-ai/settings/critic-gates.json`
- Simplified fast-path routing to `total_loc <= 200` threshold only (was `<= 150 LOC AND <= 5 files AND no domain critics`); domain critics are now folded into the fast-path agent as an additional pass

#### Added
- Structured reasoning protocol for Premise Reviewer: `AUTHOR'S CLAIM / COUNTER-EVIDENCE / ALTERNATIVE CHECK / CONCLUSION` validation gate before reporting premise findings
- Reasoning certificate for Bug Hunter A: `PREMISE / TRACE / DIVERGENCE / GUARD CHECK / CONCLUSION` trace-based bug confirmation gate with emission filtering
- Domain critic pass injection in fast-path reviewer via `{DOMAIN_CRITIC_PASS}` placeholder, enabling domain expert review within single-agent fast-path runs
- Replaced shared prompt reasoning checklist with structured `PREMISE / EVIDENCE / GUARD CHECK / SEVERITY CHECK` analysis framework

### judges v1.5.1

#### Changed
- Migrated perf-substep state paths from `.closedloop/` to `.closedloop-ai/` in `run-judges` skill telemetry instrumentation

### judges v1.5.0

#### Changed
- Migrated threshold override paths from `.claude/settings/threshold-overrides.json` to `.closedloop-ai/settings/threshold-overrides.json` in `run-judges` skill (both run-specific and repo-level locations)

### platform v1.1.0

#### Changed
- Version bump to align with cross-plugin `.closedloop-ai/` directory migration

### self-learning v1.1.1

#### Changed
- Established `CLOSEDLOOP_STATE_DIR` constant as single source of truth for state directory name in `bootstrap-learnings.sh`, `compute_success_rates.py`, and `write_merged_patterns.py`

### self-learning v1.1.0

#### Changed
- Migrated org learnings paths from `.claude/learnings/` to `.closedloop-ai/learnings/` across `pull-learnings`, `push-learnings`, and `bootstrap-learnings.sh`
- Migrated run path references from `.claude/runs/` to `.closedloop-ai/runs/` in `process-learnings` command
- Simplified `preflight-check.sh` to verify `awk` availability instead of requiring `gawk` with FPAT support

#### Removed
- Removed legacy `~/.claude/.learnings/org-patterns.toon` fallback from `compute_success_rates.py` and `write_merged_patterns.py`
- Removed legacy session file lookup path from `evaluate_goal.py`

#### Added
- Test verifying CLI ignores legacy home TOON path in `test_compute_success_rates.py`

### code v1.5.10

#### Changed
- Enhanced `plan-agent` with verification-before-proposing requirements: must `Read` every function, type, and validator before writing tasks that modify them; must check receiving validators/schemas when tasks construct events or payloads
- `plan-agent` now requires explicit task dependency declarations ("Depends on T-A.B"), null/empty/missing edge case specification for every new field, and accurate summary language (no overclaiming)
- Added multi-repository plan guidelines to `plan-agent`: absolute file paths for cross-repo references, per-repo file existence verification, repo labels on tasks, and cross-repo contract documentation
- Added self-check gates to `plan-agent`: modification targets verified, validators audited, edge cases specified, dependencies declared, summary accuracy confirmed -- with a concrete good-vs-bad task example

### code v1.5.9

#### Fixed
- `stream_formatter.py` now uses `Optional[str]` instead of `str | None` union syntax,
  making it import-safe on Python 3.9 and preventing silent JSONL pipeline truncation
  on macOS systems using the default system Python

### code v1.5.8

#### Removed
- Deleted `feedback-explorer` agent and removed its integration from `plan-with-codex` debate loop -- plan-agent now receives feedback directly without pre-fetched context briefs
- Removed `{stem}.context` sidecar file from `plan-with-codex` debate loop

#### Changed
- Updated default Codex model from `gpt-5.4` to `gpt-5.3-codex` in `plan-with-codex` command and `debate-loop.sh` (completes model migration started in v1.5.5)
- Reduced Codex reasoning effort from `xhigh` to `high` in `run_codex_review.sh`

### code v1.5.7

#### Added
- Ghost loop detection in `run-loop.sh` -- tracks consecutive empty iterations and aborts after 3 to prevent infinite loops with no output
- Session/context limit detection from `is_error` flag in Claude JSONL result records, with immediate abort and `context_limit` run log entry
- Session/context limit detection from stderr pattern matching (`prompt is too long`, `context limit reached`, etc.), with immediate abort on non-zero exit

### code-review v1.3.0

#### Added
- PR auto-detection in local mode: when the current branch has an open PR, `resolve-scope` now auto-detects it via `gh pr view` and scopes the review to the PR diff instead of `main...HEAD`
- Small-diff fast path: diffs with <=150 LOC and <=5 files now route to a single fast-path reviewer agent instead of spawning the full 5-agent fleet, reducing review time and token usage
- Fast-path reviewer performs three scoped passes (Bug Hunter, Bug Hunter B / Unified Auditor, Premise) in a single agent run
- Partition cap enforcement with unconditional force-merge fallback when budget-respecting merges cannot reduce partition count below the cap

#### Changed
- Deferred cache-status printing from Task 6 to Task 8 (standard flow) or Task 7 (hygiene-only exit) to allow fast-path routing to suppress cache output
- `extract-patches` `--partitions-file` is now optional; omitting it produces only `patches_all.txt`
- Reviewer/model routing lines in local output and GitHub summary are now conditional on `fast_path`
- Footer omits `--cache-result` on fast-path runs (cache intentionally bypassed)
- Renamed Step 4 to Step 4A (standard flow) and added Step 4B (fast-path flow); Step 5.5 now gated on `fast_path == false`

### code v1.5.6

#### Added
- Severity gate for Codex debate rounds 5+ in `run_codex_review.sh` -- only flags findings that would cause functionally wrong behavior (incorrect output, data loss, crashes, security holes); suppresses wording ambiguities, hypothetical misimplementations, and style suggestions

#### Changed
- Split Codex debate round handling into three tiers: round 1 (initial review), rounds 2-4 (standard re-review), rounds 5+ (severity-gated re-review with elevated approval bar)
- Codex responses with no verdict AND no findings now emit `CODEX_EMPTY` instead of defaulting to `NEEDS_CHANGES`, distinguishing truncated/empty responses from genuine review feedback

### code v1.5.5

#### Changed
- Updated default Codex model from `gpt-5.4` to `gpt-5.3-codex` in `codex-review` skill parameter docs and `run_codex_review.sh` default
- Migrated remaining `.claude/work` path references to `.closedloop-ai/work` in orchestrator prompt example and `extract-plan-md` skill usage examples

### code v1.5.4

#### Removed
- Removed self-learning write references from agent prompts: `implementation-subagent`, `plan-importer`, `plan-writer`, `plan-draft-writer`, `generic-discovery`, `cross-repo-coordinator`, `build-validator`, `verification-subagent`, `plan-validator`, `code-reviewer` -- learning capture sections, Organization Learnings sections, and `self-learning:learning-quality` skill references
- Deleted learning prompt files: `plan-writer-learning.md`, `implementation-learning.md`, `discovery-learning.md`

### code v1.5.3

#### Changed
- Migrated work directory paths from `.claude/` to `.closedloop-ai/` across `run-loop.sh` (state file, progress log, directory creation), `amend-plan` command (default workdir), and `cancel-code` command (loop state file path)
- Enhanced `codex-review` prompt with 6 new analysis criteria: canonical state preservation, task specificity, behavioral precision, order-of-operations, lifecycle symmetry, and test fidelity -- plus implementability-focused preamble instructions

### code v1.5.2

#### Added
- Rule 8 in `build-validator` agent: never use `pkill`, `killall`, or broad kill patterns — use `timeout` to bound hung commands and report stuck processes as failures instead of killing them

#### Security
- Added `pkill` and `killall` to credential-theft blocklist in `pretooluse-hook.sh` — broad process killing is now globally denied to prevent worktree agents from killing processes outside their context

### self-learning v1.0.4

#### Changed
- Migrated `.claude/work` path reference to `.closedloop-ai/work` in `process-chat-learnings.sh` usage documentation

### code v1.5.1

#### Removed
- Removed judge integration from `run-loop.sh` — `run_judges_if_needed`, `has_code_changes`, `resolve_judges_agents_dir`, `ensure_agents_snapshot`, `store_agents_snapshot`, and `check_completion` functions removed along with Step 11 judge invocation in `post_iteration_processing`
- Deleted `run_judges_test_helper.sh` and `test_run_loop_imported_plan.py` (tests for removed judge functions)

#### Changed
- Refactored `run-loop.sh` workdir references to use a single `effective_workdir` local variable instead of repeated `${workdir:-$WORKDIR}` expansions

### judges v1.4.0

#### Added
- Agents snapshot pre-step in `run-judges` skill — creates `$CLOSEDLOOP_WORKDIR/agents-snapshot/` with all judge agent `.md` files and a `manifest.json` before judge execution begins (skipped if snapshot already exists)
- New `ensure_agents_snapshot.sh` script in `run-judges` skill scripts

#### Changed
- Renamed plan evaluation output from `judges.json` to `plan-judges.json` for consistency with `code-judges.json` and `prd-judges.json`
- Updated `validate_judge_report.py` default filename for plan category to `plan-judges.json`

### code v1.5.0

#### Added
- `--self-learning` opt-in flag for `run-loop.sh` -- self-learning is now disabled by default
- `CLOSEDLOOP_SELF_LEARNING` config propagation via `config.env` and state frontmatter
- Self-learning guard in `subagent-start-hook.sh` to skip learning injection when disabled
- Self-learning guard in `subagent-stop-hook.sh` to skip entire learning region when disabled
- Self-learning guard in `pretooluse-hook.sh` to skip tool-specific pattern injection when disabled

#### Changed
- `post_iteration_processing()` skips steps 2-10 when self-learning is off; step 1 (changed-files.json) and step 11 (judges) always run
- `bootstrap_learnings()` skips `.learnings/` directory creation when self-learning is off
- `run_background_pruning()` skips pruning when self-learning is off
- Resume restores `SELF_LEARNING` from state frontmatter and re-exports to hooks

### code v1.4.1

#### Added
- New `feedback-explorer` agent (haiku) for pre-fetching codebase context referenced in reviewer feedback, reducing redundant exploration during plan revisions with delta caching across debate rounds
- Deferral detection in `plan-with-codex` -- scans plans for "Deferred", "Out of Scope", "Future Work" items and requires explicit user approval before excluding work from scope
- Exclusions sidecar file (`{stem}.exclusions`) in `plan-with-codex` to persist user-confirmed deferral decisions across debate rounds

#### Changed
- `plan-with-codex` argument-hint updated to positional syntax instead of optional bracket notation
- `plan-with-codex` uses Write tool for state persistence instead of Bash printf
- `plan-with-codex` launches `feedback-explorer` before `plan-agent` revision rounds to pre-fetch context
- `plan-agent` enforces "no silent deferrals" rule -- must not create deferred/out-of-scope sections without explicit user approval
- `plan-agent` supports pre-fetched context briefs from `feedback-explorer`, reads brief before revision to skip redundant exploration
- Added `Write` tool to `plan-agent` tools list

#### Fixed
- Fixed `plan-with-codex` to use fully qualified agent name `code:feedback-explorer`

### platform v1.0.2

#### Added
- New "Refactoring Existing Prompts" section in `context-engineering` skill covering pitfalls for stale cross-references, over-abstraction, lost preconditions, and silent behavior changes

### code v1.2.1

#### Changed
- `plan-agent` now verifies Codex findings against the codebase before acting -- rejects findings that don't hold up with evidence, writes a revision summary for cross-round context
- `codex-review` skill accepts `--revisions-file` parameter, injecting Claude's revision summary into Codex's prompt on rounds > 1 so rejected findings are not re-raised

#### Fixed
- Fixed `plan-with-codex` resume path triggering a redundant user review checkpoint when the user had already confirmed by choosing "resume with existing plan"

### code v1.2.0

#### Added
- New `plan-agent` agent for creating and revising implementation plans via codebase exploration
- New `plan-with-codex` command for iterative plan refinement through Claude + Codex debate loops
- New `codex-review` skill to run Codex plan reviews and return structured verdict feedback
- New `debate-loop.sh` script providing standalone CLI for Claude + Codex debate orchestration
- New `plan-review.sh` hook that triggers Codex review when Claude exits plan mode

### code-review v1.2.0

#### Added
- New `resolve-scope` subcommand in `code_review_helpers.py` -- deterministic scope resolution replacing inline shell logic for PR branch lookup, git fetch, base-ref overrides, and path filter preservation
- New `fetch-intent` subcommand -- fetches PR description or commit messages as intent context for the Premise Reviewer
- New `classify-intent` subcommand -- classifies diff intent (`feature`, `fix`, `refactor`, `mixed`) from PR metadata and file statuses for model routing
- New `collect-findings` subcommand -- merges `agent_*.json` files and hygiene findings into a single `findings.json`, replacing inline Python-in-Bash merge logic
- New `verdict` subcommand -- computes deterministic PR verdict (`approve`, `needs_attention`, `decline`) from validated findings, replacing inline orchestrator logic
- New `prep-assets` subcommand -- copies `shared_prompt.txt` and `bha_suffix.txt` from plugin to CR_DIR in a single step, consolidating scattered `cp` commands
- New `extract-patches` subcommand -- extracts per-partition and full-diff patches to disk with batched extraction for large diffs (>200 files)
- New `bha_suffix.txt` prompt file -- Bug Hunter A persona and focus areas extracted from inline heredoc in `start.md`
- Intent-aware model routing: Premise Reviewer uses Opus for fix/refactor/mixed intents, Sonnet for feature intents; BHA uses Opus for implementation partitions, Sonnet for test-only partitions
- Mixed-partition splitting in `partition` subcommand -- separates test files from implementation files when impl LOC exceeds threshold
- Agent cap enforcement via `--max-bha-agents` parameter in `partition`, computed from `route` output
- Trivial partition merging -- partitions below 20 LOC are absorbed into same-type normal partitions
- Cache status message (`status_kind`, `status_message`) appended to `cache_result.json` by `cache-check`, replacing orchestrator-side message formatting
- `--exclude-test-partitions` flag on `cache-update` to skip caching files from Sonnet-reviewed test-only partitions
- Self-discard validation rule (check 7) in `shared_prompt.txt` -- agents must discard findings they conclude are not actually problems

#### Changed
- Refactored `start.md` orchestrator to delegate workflow steps to Python subcommands instead of inline shell logic
- `setup` subcommand now accepts `--cr-dir-prefix` and creates CR_DIR with random suffix, removing the need for the orchestrator to generate random directory names
- `route` subcommand now accepts `--intent` parameter and outputs `max_bha_agents` for downstream partition cap enforcement
- Reduced default partition LOC budget from 800 to 500

### judges v1.3.1

#### Changed
- `run-judges` skill now accepts a `--workdir <path>` parameter for standalone use outside `run-loop.sh`; resolved in order: `--workdir` arg → `$CLOSEDLOOP_WORKDIR` env var → `.closedloop-ai/judges` default (directory created automatically if absent)

### code v1.1.4

#### Changed
- `run-loop.sh` judge invocations (`plan_judges`, `code_judges`) now pass `--workdir $workdir` explicitly in the `claude -p` prompt, aligning with the updated `run-judges` skill parameter contract

### judges v1.3.0

#### Added
- New `prd` artifact type support in `run-judges` skill — 4 dedicated PRD judges executed in 2-phase execution, output to `prd-judges.json`, validated with `--category prd`
- New `prd-auditor` agent — structural completeness auditor for draft PRDs; checks US/AC coverage, success metrics table completeness, critical open questions, scope section structure, kill criteria presence, and template section inventory
- New `prd-dependency-judge` agent — evaluates PRD dependency completeness and risk assessment; flags missing dependencies, underdefined integration points, and unacknowledged cross-team risks
- New `prd-testability-judge` agent — evaluates whether PRD acceptance criteria are testable and measurable; flags vague or unverifiable criteria and missing success metrics
- New `prd-scope-judge` agent — evaluates PRD scope discipline and hypothesis traceability; flags stories with no traceable origin, out-of-scope overlaps, story count exceeding 8, and unacknowledged dependencies; emits review-delta JSON
- New `prd_preamble.md` in `skills/artifact-type-tailored-context/preambles/` — artifact-type-tailored context preamble injected before PRD judge prompts
- `validate_judge_report.py`: Added `prd` category to `JUDGE_REGISTRY` with 4 expected judges (`prd-auditor`, `prd-dependency-judge`, `prd-testability-judge`, `prd-scope-judge`)
- `validate_judge_report.py`: Replaced `valid_suffixes` list with `VALID_SUFFIXES` dict mapping each category to its accepted `report_id` suffixes (`prd` maps to `["-prd-judges"]`)
- `validate_judge_report.py`: Reconciled `JUDGE_REGISTRY` plan set — removed phantom entries `efficiency-judge` and `informativeness-relevance-judge`; added `brownfield-accuracy-judge`, `codebase-grounding-judge`, and `convention-adherence-judge`
- `judge-input.schema.json`: Added `"prd"` to the `evaluation_type` enum

### code v1.1.3

#### Added
- `stream_formatter.py` now accumulates per-model token usage from assistant events and prints a summary in the format the harness expects, fixing zero token counts for PLAN/EXECUTE loops

#### Fixed
- `stream_formatter.py` returns early on `BrokenPipeError` before printing usage summary, preventing tracebacks when used in pipelines with early-exit consumers

### judges v1.2.0

#### Added
- New `brownfield-accuracy-judge` agent — evaluates how accurately a plan accounts for existing code (reuse vs reimplementation, integration-point accuracy, scope accuracy against investigation findings)
- New `codebase-grounding-judge` agent — detects hallucinated file paths, nonexistent modules, and fabricated APIs by comparing plan claims against the investigation log
- New `convention-adherence-judge` agent — evaluates whether a plan follows the conventions, patterns, and style found in the actual codebase as documented in the investigation log

#### Changed
- Updated `run-judges` skill to support 16 plan judges (up from 13), adding the three new grounding/brownfield/convention judges in Batch 4
- `brownfield-accuracy-judge` and `convention-adherence-judge` now invoke `@code:pre-explorer` to generate `investigation-log.md` when absent, instead of immediately scoring 0.5; fall back to 0.5 only if pre-explorer fails or the file remains absent
- `codebase-grounding-judge`: add validation step to ensure net-new code does not duplicate existing functionality (e.g., utilities/helpers already in codebase)

### code v1.1.2

#### Fixed
- Restored boolean semantics for `has_code_changes` in `run-loop.sh` and updated judge gating to skip code judges when no implementation changes are detected, without relying on numeric stdout parsing

### judges v1.1.0

#### Added
- New `context-manager-for-judges` agent (moved from `code` plugin) to orchestrate context compression for judge evaluation
- New `judge-input.schema.json` — formal JSON schema defining the standard judge input contract with `source_of_truth` field
- Investigation log (`investigation-log.md`) reuse in plan judge context with pre-explorer fallback when no `CLOSEDLOOP_WORKDIR` is set

#### Changed
- Generalized judge input contract to use orchestrator-provided `judge-input.json` (task + context envelope) instead of hardcoded artifact assumptions
- Standardized all judge agents to read `judge-input.json` from `$CLOSEDLOOP_WORKDIR` and load mapped artifacts via source-of-truth ordering
- Centralized judge input-read requirements into shared preamble `common_input_preamble.md`; judge-specific files no longer duplicate input-contract boilerplate
- Enforced strict SSOT by removing residual per-agent `Input Contract` stubs; `common_input_preamble.md` is now the single runtime source for input-loading guidance

#### Fixed
- Added `source_of_truth` to required array in `judge-input.schema.json` — schema now matches SKILL.md and judge agent expectations for evidence prioritization

### code v1.1.0

#### Changed
- Migrated session/hook data directory from `.claude/.closedloop/` to `.closedloop-ai/` across all hooks (`session-start`, `session-end`, `subagent-start`, `subagent-stop`, `pretooluse`, `loop-stop`) and `setup-closedloop.sh`, with legacy fallback for mid-upgrade sessions
- Added legacy directory cleanup in `session-end-hook.sh` — removes stale PID mappings, expired session files, and deletes empty legacy directory on session end

### self-learning v1.0.3

#### Fixed
- Fixed pattern cap trimming to sort by staleness flags only instead of confidence — low-confidence patterns were always dropped before being observed, preventing them from ever earning higher confidence
- Fixed extraneous f-string prefix lint warning in `write_merged_patterns.py` default header

#### Changed
- Updated `process-learnings` cap strategy to trim `[PRUNE]` then `[STALE]` then `[REVIEW]`, with `seen_count` as tiebreaker

### code v1.1.1

#### Added
- Integrated `investigation-log.md` into judge context assembly, sourced from `$CLOSEDLOOP_WORKDIR`

#### Fixed
- Fixed judges agents path resolution in `run-loop.sh` to support monorepo, cache, and marketplace installation layouts via a four-level fallback strategy (`CLOSEDLOOP_JUDGES_AGENTS_DIR` env override → repo-relative path → non-versioned sibling → latest semver-versioned sibling)
- Fixed agent snapshot to read judge agents from the judges plugin rather than the code plugin, and corrected `plugin` field in manifest to `"judges"`

### code-review v1.1.0

#### Breaking
- Removed `github-review` slash command — `/code-review:github-review` is no longer a valid entry point. Use `/code-review:start --github` instead.
- Renamed `review.md` → `start.md` — slash command is now `/code-review:start`
- Moved `github-review.md` from `commands/` to `prompts/` — callers using `${CLAUDE_PLUGIN_ROOT}/commands/github-review.md` must update to `${CLAUDE_PLUGIN_ROOT}/prompts/github-review.md`

#### Changed
- Unified session directory path for all modes — removed `$RUNNER_TEMP` override in GitHub CI, now uses `.closedloop-ai/code-review/cr-<RANDOM>` everywhere
- Replaced Bash heredoc/cat usage with Write and Read tools for PR metadata file operations in `github-review.md`
- Updated temp file path references from `$RUNNER_TEMP/cr-review/` to `<CR_DIR>/*` in GitHub mode constraints
- Fixed usage examples to use `/start` to match the command filename
- Fixed internal references from `code-review-github.md` to `github-review.md`

#### Added
- Compound Bash command prohibition in GitHub mode — no `&&`, `||`, `;`, or `|` pipes allowed

### code v1.0.5

#### Changed
- Updated `review-delta.schema.json` description to reference "code hybrid workflow" instead of "impl-plan hybrid workflow"
- Updated `compliance-checkpoint.md` to reference `/code` instead of `/impl-plan`
- Removed `Bash` from `visual-qa-subagent` tool list to prevent shell access during visual QA

#### Security
- Added credential theft blocklist to `pretooluse-hook.sh`: denies Bash commands and file access targeting macOS Keychain, browser cookie databases, SSH private keys, and cloud credentials
- Blocklist applies to all Claude sessions, not just ClosedLoop-managed sessions

### bootstrap v1.1.0

#### Added
- Schema-aligned constraints in AGENT_FORMAT.md: `tools`, `skills`, `permissionMode` fields, `name` kebab-case/64-char limit, `description` 1024-char limit, expanded 8-color enum with `cyan`/`pink`
- Context-engineering activation in agent-prompt-generator via `platform:context-engineering` skill
- Tools/skills inline format validation in agent-prompt-validator (BLOCKING on block array syntax)
- `additionalProperties` violation detection and `skills`→`Skill` tool cross-check
- Critic Review Schema Alignment (Check 8) and critic-gates.json Structure Validation (Check 9) in generation-validator
- critic-gates.json schema validation in bootstrap-validator
- Context-engineering compliance warnings in anti-pattern detection

#### Changed
- `description` max raised from 120 → 1024 chars (warn >200)
- `model` enum now accepts `inherit`
- `color` field changed from required to optional; enum expanded to 8 values
- Removed legacy `prd2plan/` directory namespace — agent output now writes to `.claude/agents/` (flat)
- Moved `.bootstrap-metadata.json` from `.claude/agents/prd2plan/` to `.closedloop-ai/bootstrap-metadata.json`
- Replaced all `/impl-plan` command references with `/code`
- Removed DAG validation infrastructure (deleted `impl-plan-dag.schema.json`, removed Check 2 from bootstrap-validator)
- Updated default `--target-command` from `impl-plan` to `code`
- Updated default `--output-dir` from `.claude/agents/prd2plan/` to `.claude/agents/`

### code v1.0.4

#### Changed
- Generalized `prd-creator` skill description and replaced analytics discovery step with risks assessment
- Updated PRD template to add compliance checkpoint and remove event instrumentation section
- Revised story patterns and examples references to align with compliance-focused workflow

#### Removed
- Deleted `event-instrumentation.md` reference

### code v1.0.3

#### Changed
- Migrated learnings path from `~/.claude/.learnings/` to `~/.closedloop-ai/learnings/` in `pretooluse-hook.sh` and `subagent-start-hook.sh` with legacy fallback

### self-learning v1.0.2

#### Changed
- Migrated learnings path from `~/.claude/.learnings/` to `~/.closedloop-ai/learnings/` across commands, tools, and skills with legacy fallback

### bootstrap v1.0.0

#### Added
- Initial release
- Bootstrap plugin for ClosedLoop agent creation and validation

### code v1.0.2

#### Added
- Step 8.5 in `run-loop.sh` for deterministic TOON writing via `write_merged_patterns.py`

### code v1.0.1

#### Added
- New `prd-creator` skill for drafting lightweight PRDs through conversational workflow

### code v1.0.0

#### Added
- Initial release

### code-review v1.0.0

#### Added
- Initial release

### judges v1.0.0

#### Added
- Initial release

### platform v1.0.1

#### Added
- New `claude-creator` skill for scaffolding and creating new skills from scratch

### platform v1.0.0

#### Added
- Initial release

### self-learning v1.0.1

#### Added
- New `write_merged_patterns.py` tool for deterministic JSON-to-TOON conversion

#### Changed
- Refactored `process-learnings` command to output `merge-result.json` instead of writing TOON directly
- Updated `process-chat-learnings.sh` to run deterministic TOON write step after classification

### self-learning v1.0.0

#### Added
- Initial release
