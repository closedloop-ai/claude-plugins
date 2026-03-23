# Changelog

## [1.3.0] - 2026-03-22

### Added

- `feedback-explorer` agent (haiku): pre-fetches codebase context referenced in reviewer feedback before plan-agent revises, cutting revision time from ~6 minutes to ~2-3 minutes.
- `plan-with-codex` Step 2e now spawns feedback-explorer before resuming plan-agent, writing a `{stem}.context` brief with pre-fetched code snippets.

### Fixed

- `plan-with-codex`: Replace inline Bash `printf` state writes with Write tool calls so the user only approves the file path once instead of re-approving every round.
- `plan-with-codex`: Replace Bash `grep`/`cut` state reads with a single Read tool call; explicitly ignore unknown keys for cross-flow compatibility with `debate-loop.sh`.
