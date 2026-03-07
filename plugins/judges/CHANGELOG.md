# judges plugin changelog

## [1.2.0] - Unreleased

### Added
- Added `context-manager-for-judges` agent to the `judges` plugin (moved from `code` plugin)

### Changed
- Generalized judge input contract to use orchestrator-provided `judge-input.json` (task + context envelope) instead of hardcoded artifact assumptions.
- Updated run-judges documentation and judge prompts to use source-of-truth ordering from envelope mappings.
- Standardized all judge agents (solid-liskov-substitution, custom-best-practices, readability, code-organization, solid-isp-dip, technical-accuracy, solid-open-closed, verbosity, test-judge) to use the same input format as dry-judge, goal-alignment-judge, and kiss-judge: read `judge-input.json` from `$CLOSEDLOOP_WORKDIR`, then read mapped artifacts from `primary_artifact` and `supporting_artifacts`.
- Centralized judge input-read requirements into shared preamble injection (`common_input_preamble.md`) so judge-specific files no longer duplicate required file contract text.
- Enforced strict SSOT by removing residual per-agent `Input Contract` stubs; `common_input_preamble.md` is now the single runtime source for input-loading guidance.
