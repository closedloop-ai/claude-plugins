# Changelog

All notable changes to the claude-plugins project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
