# Changelog

## [1.4.0] - 2026-03-24

### Added

- plan-importer agent (sonnet): reads an externally supplied plan file and emits a normalized in-session plan, replacing `plan-draft-writer` when `CLOSEDLOOP_PLAN_FILE` is set.
- `--plan` argument for `setup-closedloop.sh`: accepts a path to an existing plan file and writes it to `.closedloop/plan.md`.
- `CLOSEDLOOP_PLAN_FILE` env var propagation: `closedloop-env/scripts/get-env.sh` now includes `CLOSEDLOOP_PLAN_FILE` in the environment output block so subagents receive the variable.
- Orchestrator phase-gating for imported plans: `prompts/prompt.md` sets `plan_was_imported = true` when `CLOSEDLOOP_PLAN_FILE` is set and skips phases 0.9, 1.1, 1.3, 1.4.x, 2.5, 2.6, 2.7, proceeding directly to Phase 3.
- `run-loop.sh` plan judge skip via `.closedloop/imported-plan` marker: when the marker file is present `run_judges_if_needed` exits early, bypassing the judge pipeline for imported plans.
- `validate_plan.py` bidirectional AC and gap sync checks: verifies that every acceptance criterion references a task and every task references an AC; reports gaps in both directions.

## [1.3.0] - 2026-03-22

### Added

- `feedback-explorer` agent (haiku): pre-fetches codebase context referenced in reviewer feedback before plan-agent revises, cutting revision time from ~6 minutes to ~2-3 minutes.
- `plan-with-codex` Step 2e now spawns feedback-explorer before resuming plan-agent, writing a `{stem}.context` brief with pre-fetched code snippets.

### Fixed

- `plan-with-codex`: Replace inline Bash `printf` state writes with Write tool calls so the user only approves the file path once instead of re-approving every round.
- `plan-with-codex`: Replace Bash `grep`/`cut` state reads with a single Read tool call; explicitly ignore unknown keys for cross-flow compatibility with `debate-loop.sh`.
