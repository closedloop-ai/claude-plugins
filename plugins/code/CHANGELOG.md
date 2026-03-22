# Changelog

## [1.2.3] - 2026-03-22

### Fixed

- `plan-with-codex`: Replace inline Bash `printf` state writes with Write tool calls so the user only approves the file path once instead of re-approving every round.
- `plan-with-codex`: Replace Bash `grep`/`cut` state reads with a single Read tool call; explicitly ignore unknown keys for cross-flow compatibility with `debate-loop.sh`.
