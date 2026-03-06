# ClosedLoop Glossary

A comprehensive guide to ClosedLoop terminology and concepts.

## Orchestration

**Closed Loop**
The external bash loop (`run-loop.sh`) that drives fresh-context Claude iterations. Each iteration launches `claude -p` with a clean context window, preventing context exhaustion on long tasks. State persists between iterations in `.claude/closedloop-loop.local.md`.

**Orchestrator**
The `prompt.md` system prompt loaded by `run-loop.sh` at the start of each iteration. Coordinates 8 workflow phases (discovery, planning, judge review, plan refinement, implementation, verification, build validation, and learning capture) entirely through subagent delegation. The orchestrator never reads project files directly.

**Loop Step**
A single `claude -p` invocation within the Closed Loop. Each step gets a fresh 200k token context window purely for the current phase of work.

**run-loop.sh**
The core bash script (~1100 lines) that drives the Closed Loop. Manages lock files, agent snapshots, goal configuration, and runs an 11-step post-iteration pipeline including pattern relevance scoring, goal evaluation, citation verification, learning processing, and judge execution.

## Agents

**Agent**
A specialized Claude instance defined by a `.md` file with YAML frontmatter specifying `name`, `description`, `model`, `tools`, and `skills`. Each agent has a focused responsibility and is invoked by the orchestrator for a specific phase.

**Subagent**
An agent invoked by the orchestrator (or another agent) via Claude Code's Task tool to handle a specific phase. Subagents run in isolated contexts and return results to the caller.

**Judge**
A read-only evaluation agent that scores implementation plans or code against quality principles (DRY, KISS, SOLID, readability, goal alignment, etc.). Judges produce structured `CaseScore` JSON reports with `final_status` (1=PASS, 2=FAIL, 3=ERROR) consumed by `plan-writer` to refine the plan. The closedloop plugin includes 13 judge agents.

**Context Manager for Judges**
The coordinator agent (`context-manager-for-judges`) that prepares compressed context within a 30K token budget and dispatches parallel judge runs. Handles both plan-type and code-type evaluations with different budget allocations.

## Planning

**Implementation Plan**
A structured task breakdown stored as `plan.json` with a parallel `plan.md` markdown representation. Contains `pendingTasks`, `completedTasks`, `acceptanceCriteria`, `openQuestions`, `answeredQuestions`, and `gaps`. Produced by `plan-draft-writer` and refined by `plan-writer`.

**Plan Draft**
The initial plan produced by `plan-draft-writer` (opus model) for human review. Contains no code snippets — focuses on scope, architecture, and task decomposition. A hard stop for human approval occurs after draft creation.

**PRD (Product Requirements Document)**
The input specification consumed by the planning agents. Auto-discovered from the working directory (`prd.md`, `prd.pdf`, `requirements.md`, `requirements.txt`, `ticket.md`, or the first non-hidden file).

**Plan Evaluator**
Agent that evaluates whether a plan is eligible for simple-mode processing (skipping code-map generation, cross-repo discovery, and critic reviews) and selects which critic agents should review it. Uses 6 complexity thresholds to make the determination.

**Plan Validator**
Agent that checks plan structural validity against the plan schema. Validates JSON structure, task format, required section headers, checkbox format, and detects storage/query mismatches.

**Pre-Explorer**
Lightweight agent (haiku model) that investigates the codebase before planning begins. Produces `requirements-extract.json`, `code-map.json`, and `investigation-log.md` so that `plan-draft-writer` can skip mechanical exploration and focus on architecture.

## Learning System

**Self-Learning System**
The feedback loop that captures patterns from runs and injects them into future contexts. The `learning-capture` agent records patterns after each run. Hooks re-inject relevant patterns into future subagent contexts. Success rates are computed deterministically against configurable goals. This is the "closed loop" that gives the project its name.

**org-patterns.toon**
The primary learning store — a TOON-format file containing extracted patterns indexed by context. Each pattern has fields: `id`, `category`, `summary`, `confidence`, `seen_count`, `success_rate`, `flags`, `applies_to`, `context`, `repo`. Capped at 50 patterns.

**Learning Capture**
The agent that extracts actionable patterns from an implementation or discovery run. Classifies patterns as `closedloop` (tool-level) or `organization` (project-level) with categories: `mistake`, `pattern`, `convention`, or `insight`.

**outcomes.log**
A pipe-delimited log file recording which patterns were applied, injected, and whether they were verified against actual code changes. Used by `compute_success_rates.py` to calculate pattern effectiveness.

**Success Rate**
A computed metric measuring how often a pattern achieves its stated goal. Formula: `applied_without_unverified / total_injected`. Patterns with low success rates get flagged with `[REVIEW]` or `[PRUNE]`.

**Goal**
A named configuration object in `goal.yaml` that defines an evaluation target for the learning system. Each goal has a `description` (required), optional `success_criteria` (threshold or binary type), optional `pattern_priority` array, and optional `metrics` array. Goal names are user-defined — examples include `reduce-failures`, `swe-bench`, `minimize-tokens`, and `maximize-coverage`, but any name is valid.

## Format

**TOON (Token-Oriented Object Notation)**
A compact, LLM-optimized serialization format achieving ~40% token reduction vs JSON while maintaining lossless round-trip compatibility. Used for the learning pattern store (`org-patterns.toon`).

**TOON Array**
A TOON construct for inline arrays: `tags[3]: admin,ops,dev`. The count in brackets indicates the number of elements.

**TOON Table**
A TOON construct for uniform object arrays. Uses `{field,names}` declarations followed by tabular rows with 2-space indentation, avoiding the repetitive key names of JSON arrays.

## Hooks

**Hook**
A lifecycle script registered in `hooks.json` that fires on a Claude Code event. The closedloop plugin registers 5 hooks across 6 scripts.

**SessionStart / SessionEnd**
Hooks that fire when a Claude Code session opens or closes. `SessionStart` creates PID-to-session-ID mappings. `SessionEnd` cleans up stale mappings and orphaned state files.

**SubagentStart**
Hook that fires when a subagent begins. Performs three key functions: (1) writes base environment variables to `.claude/.closedloop/env`, (2) injects `<closedloop-environment>` block with paths and config, and (3) filters and injects relevant patterns from `org-patterns.toon` as `<organization-learnings>`.

**SubagentStop**
Hook that fires when a subagent completes. Handles learning acknowledgment enforcement, outcome logging to `outcomes.log`, build result tracking, performance telemetry to `perf.jsonl`, and cleanup.

**PreToolUse**
Hook that fires before a `Bash`, `Write`, or `Edit` tool call. Provides just-in-time learning pattern injection filtered by tool-specific context tags (e.g., build/test patterns for Bash, react/typescript patterns for Write/Edit).

## Commands

**`/code`** — Bootstraps the Closed Loop. Sets up the environment, reads the orchestrator prompt, and begins the phase-based workflow.

**`/cancel-code`** — Stops the running Closed Loop by removing the state file.

**`/code-review`** — Multi-agent code review with modes: local (default) and `--github`. Flags: `--hygiene-only` (zero-LLM fast checks), `--since-last-review` (auto-incremental), `--full-review`, `--base <ref>`. Uses a V2 content-addressed cache for cross-PR reuse.

**`/amend-plan`** — Interactive amendment of `plan.json`. Supports directives, questions, confirmations, and unstructured input.

**`/process-learnings`** — Runs the full learning pipeline: find pending learnings, classify via `learning-capture` agent, validate and reword, aggregate into `org-patterns.toon`, write project patterns to `CLAUDE.md`.

**`/export-closedloop-learnings`** — Exports pending closedloop learnings to `~/.closedloop-ai/learnings/closedloop-learnings.json`. Deduplicates by trigger match or 80%+ word overlap.

**`/pull-learnings`** — Imports organization patterns from a shared repository (requires `CLAUDE_ORG_ID`). Converts JSON to TOON. Prevents echo patterns from the current project.

**`/push-learnings`** — Exports local patterns to a shared repository (requires `CLAUDE_ORG_ID`). Converts TOON to JSON. Resolves ID collisions.

**`/prune-learnings`** — Removes stale and low-quality patterns. Configurable via `retention.yaml` (max runs, sessions, log lines, archive age).

**`/goal-stats`** — Analyzes `runs.log` and `outcomes.log` for pass rate, average score, top contributing patterns, underperforming patterns, and improvement trends.

## Skills

**Skill**
A reusable instruction set loaded into an agent's context via the `skills:` frontmatter field. Skill identifiers use the format `plugin-name:skill-name` (e.g., `closedloop:toon-format`).

**artifact-type-tailored-context** — Compresses artifacts to fit within a token budget using three tiers: full content, intelligent compression, and hard truncation.

**build-status-cache** — Skips rebuild when no code changed since last passing build. Uses git diff hash comparison.

**critic-cache** — Skips critic reviews when plan hash matches stored hash from previous review.

**cross-repo-cache** — Skips cross-repo coordinator when peer repo git hashes are unchanged.

**eval-cache** — Skips plan-evaluator when `plan-evaluation.json` is newer than `plan.json`.

**extract-plan-md** — Syncs `plan.md` with `plan.json` content field. Required after any edit to `plan.json`.

**find-plugin-file** — Locates files within the Claude Code plugins cache with automatic latest-version resolution.

**iterative-retrieval** — 4-phase protocol for orchestrators to refine sub-agent queries through dispatch, evaluation, refinement, and loop.

**learning-quality** — Structured decision tree for capturing high-quality learnings with 5-step filter and hard rejection criteria.

**plan-structure** — Reusable guidance for plan creation phases. References the plan template and conventions playbook.

**plan-validate** — Deterministic Python script validation replacing most `plan-validator` agent calls. Validates JSON parsing, schema fields, task format, required headers, and array sync.

**run-judges** — Orchestrates parallel judge execution. Plan mode: 13 judges in 4 batches. Code mode: 11 judges in 3 batches.

**closedloop-env** — Provides ClosedLoop environment paths (`CLOSEDLOOP_WORKDIR`, `CLAUDE_PLUGIN_ROOT`, `CLOSEDLOOP_PRD_FILE`, `CLOSEDLOOP_MAX_ITERATIONS`) to agents.

**toon-format** — TOON syntax specification and examples. Defines the tabular array format, quoting rules, and reserved literals.

**upload-artifact** — Uploads files as ClosedLoop artifacts (PRD, implementation plan, template) via MCP or API.
