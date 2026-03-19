# code-review Plugin

A multi-agent code review plugin for Claude Code that performs deep, partitioned code analysis with deterministic hygiene checks, risk-based model routing, and validated findings. Supports both local terminal output and GitHub PR inline comment posting via CI.

## Key Features

- **Multi-agent parallel review**: Splits changed files into partitions and spawns concurrent reviewer agents (Bug Hunter A, plus domain specialists) to review each partition independently
- **Deterministic hygiene checks**: Pattern-based checks for CI artifacts, sensitive file exposure, and path leakage — zero LLM tokens required
- **Risk-based model routing**: Scores each file partition by risk (size, file type, LOC) and routes high-risk partitions to more capable models
- **Finding validation and deduplication**: Normalizes severity, filters low-confidence findings, deduplicates near-duplicate issues via Jaccard similarity, and validates line numbers against the actual diff
- **Incremental reviews**: Tracks prior review state to diff only new commits since the last successful review (auto-incremental mode)
- **Caching**: Content-addressed cache keyed on prompt hash and diff tip to skip re-reviewing unchanged partitions
- **Two output modes**: Local terminal output for developer workflow, or GitHub mode for CI pipelines that posts inline PR comments and a summary

## Architecture

```
plugins/code-review/
  .claude-plugin/plugin.json         Plugin manifest
  commands/
    start.md                         Main /start command (orchestrator)
  prompts/
    github-review.md                 GitHub-mode constraints and output steps (loaded conditionally)
  tools/
    prompts/shared_prompt.txt        Shared reviewer constraints injected into every agent prompt
    prompts/bha_suffix.txt           Bug Hunter A reviewer persona and focus areas
    python/code_review_helpers.py    Deterministic helper CLI (parse-diff, hygiene, partition, route, validate, cache, etc.)
    python/test_code_review_helpers.py   Unit tests for the helper CLI
```

### Component Roles

| Component | Role |
|---|---|
| `start.md` | Orchestrator command. Parses flags, sets up the session, invokes the helper CLI subcommands in sequence, spawns reviewer sub-agents, collects results, and presents findings |
| `github-review.md` | Loaded by the orchestrator only in GitHub mode. Contains PR metadata resolution, file-based handoff format for CI, and summary format |
| `code_review_helpers.py` | Python CLI that handles all deterministic work: git diff parsing, hygiene pattern matching, file partitioning, risk scoring/model routing, finding validation, cache management, and GitHub comment posting |
| `shared_prompt.txt` | Constraints injected into every reviewer agent prompt: file assignment rules, evidence standards, severity definitions, and output format |
| `bha_suffix.txt` | Bug Hunter A reviewer persona and focus areas (syntax errors, security, state management, error handling, data transformations) — appended to the Bug Hunter A agent prompt |

## Commands

### `/start`

Runs a comprehensive code review. Invokes the full pipeline: diff parsing, hygiene checks, agent spawning, finding validation, and result presentation.

**Syntax:**

```
/start [scope] [--github] [--hygiene-only] [--base <ref>] [--since-last-review] [--full-review]
```

**Scope arguments:**

| Argument | Behavior |
|---|---|
| _(none)_ | Diff current branch vs `main` |
| `staged` | Diff only staged (index) changes |
| `file1 file2 ...` | Diff specific files against `main` |
| `123` | Use PR #123's diff (local output, no posting) |

**Mode flags:**

| Flag | Description |
|---|---|
| `--github` | GitHub CI mode: auto-detect PR from branch or accept explicit PR number, post inline comments via file-based handoff |
| `--github 123` | GitHub CI mode: review PR #123 specifically |
| `--hygiene-only` | Run only the deterministic hygiene checks. Zero LLM tokens consumed. Fast. |
| `--base <ref>` | Override the base branch for diffing (default: `main`) |
| `--since-last-review` | Review only commits added since the last successful review (local mode only) |
| `--full-review` | Force a full diff even when auto-incremental mode would narrow the scope |

**Examples:**

```bash
/start                               # All changes on current branch vs main
/start staged                        # Only staged changes
/start src/auth.ts src/user.ts       # Specific files
/start 123                           # PR #123 diff locally
/start --github                      # CI: auto-detect PR, post comments
/start --github 123                  # CI: PR #123, post comments
/start --hygiene-only                # Hygiene checks only
/start --base develop                # Diff against develop instead of main
/start --since-last-review           # Only new commits since last review
/start --full-review                 # Disable incremental narrowing
```

**Flag incompatibilities:**

- `--base` and `staged` cannot be combined
- `--since-last-review` requires branch scope (not staged)
- `--since-last-review` is local-only (incompatible with `--github`)
- `--since-last-review` and `--full-review` are mutually exclusive

## Execution Pipeline

The orchestrator executes these steps in order:

1. **Parse flags and detect mode** — resolves `MODE` (local/github), `HYGIENE_ONLY`, `BASE_REF_OVERRIDE`, `SINCE_LAST_REVIEW`, `FULL_REVIEW`
2. **Session setup** — resolves the helpers path, creates a session-scoped working directory (`.closedloop-ai/code-review/cr-<random>/`), and runs `setup` subcommand to capture `start_time`, `repo_name`, and `global_cache`
3. **Parse scope and get diff data** — runs `parse-diff` subcommand to execute all git diff commands and produce a structured JSON blob with file statuses, LOC counts, changed line ranges, and patch content
4. **Compute prompt hash and cache check** (if caching is active) — hashes the shared prompt and reviewer suffix, then checks the content-addressed cache for a prior result on this exact diff tip
5. **Deterministic hygiene checks** — pattern-match for CI artifacts, sensitive files (`.env`, `.pem`), and path leakage; if `--hygiene-only`, stop here
6. **Risk scoring and model routing** — scores each file by risk factors (LOC, file type, complexity); routes high-risk partitions to stronger models
7. **File partitioning** — bin-packs files into agent-sized partitions balanced by LOC
8. **Patch pre-extraction** — extracts diff patches to disk so reviewer agents can read them without Bash access
9. **Spawn reviewer agents in parallel** — launches one `code:code-review-worker` sub-agent per partition; all run concurrently with `run_in_background: true`
10. **Collect and validate findings** — collects all agent outputs, merges with hygiene findings, runs the `validate` subcommand (normalize severity, filter low-confidence, deduplicate, validate line numbers)
11. **Cache update** (if caching is active) — writes validated findings to the cache for future incremental runs
12. **Present results** — local mode: prints findings by severity in the terminal; GitHub mode: writes `.claude/code-review-findings.json`, `.claude/code-review-threads.json`, and `.claude/code-review-summary.md` for the CI workflow to post
13. **Review state write** — persists the current diff tip so future `--since-last-review` runs can narrow the scope
14. **Footer** — prints elapsed time, token usage stats, and a deterministic `<pr_verdict>` tag

## Helper CLI (`code_review_helpers.py`)

The helper script is a multi-subcommand Python CLI. The orchestrator invokes it via `python <helpers_path> <subcommand> [args]`.

| Subcommand | Description |
|---|---|
| `setup` | Emits start time, repo name, branch, and global cache flag as JSON |
| `parse-diff` | Runs git diff commands and produces structured JSON with file statuses, LOC, ranges, and patch lines |
| `hygiene` | Pattern-matches diff data for CI artifacts, sensitive files, and path leakage; emits findings JSON |
| `partition` | Bin-packs files into agent-sized partitions balanced by LOC |
| `route` | Computes risk scores and emits model routing decisions per partition |
| `validate` | Normalizes severity, filters low-confidence findings, deduplicates via Jaccard similarity, validates line numbers |
| `compute-hashes` | Computes `PROMPT_HASH` and `CONTEXT_KEY` from shared prompt and diff tip |
| `cache-check` | Checks the content-addressed cache for a prior result matching the current context key |
| `cache-update` | Writes validated findings to the cache after a successful run |
| `auto-incremental` | Evaluates whether the diff scope can be narrowed to commits since the last successful review |
| `finalize-cache` | Resolves the final cache directory path after scope and PR number are known |
| `review-state-read` | Reads persisted review state (last reviewed commit) for a branch |
| `review-state-write` | Persists the current diff tip as the last successful review state |
| `post-comments` | Posts validated findings as inline GitHub PR comments (GitHub mode) |
| `resolve-threads` | Resolves outdated bot review threads on a PR (GitHub mode) |
| `session-tokens` | Collects token usage stats from the session |
| `footer` | Computes the formatted review footer string |
| `resolve-scope` | Resolves diff scope (branch, PR number, base ref, path filter) from CLI arguments and git context |
| `fetch-intent` | Fetches context (PR description, recent commits) used to classify the diff intent |
| `classify-intent` | Classifies the diff intent (feature, bugfix, refactor, etc.) for model routing |
| `collect-findings` | Merges agent findings with hygiene findings into a single list |
| `verdict` | Computes the PR verdict (APPROVED / NEEDS_ATTENTION / CHANGES_REQUESTED) from validated findings |
| `prep-assets` | Copies prompt assets from the plugin root into the session CR_DIR |
| `extract-patches` | Extracts git diff patches to per-file disk files for reviewer agents to read |

## GitHub CI Mode

In GitHub mode (`--github`), the orchestrator does not post comments directly. Instead, it writes results to files that a CI workflow step reads and handles:

| File | Contents |
|---|---|
| `.claude/code-review-findings.json` | Validated findings in structured JSON; CI workflow posts inline comments |
| `.claude/code-review-threads.json` | Outdated review thread IDs; CI workflow resolves them |
| `.claude/code-review-summary.md` | Review summary in Markdown; CI workflow posts as a PR comment |

This file-based handoff ensures that Claude never directly calls GitHub mutation APIs during the review (read-only), and lets the CI workflow handle deduplication, error handling, and rate limiting.

**Summary status labels** (written to summary only — no approval/rejection API calls):

- `Changes Requested` — one or more BLOCKING findings
- `Needs Attention` — one or more HIGH findings, no BLOCKING
- `Approved` — MEDIUM or no findings

## Finding Severity Levels

| Severity | Priority | Criteria |
|---|---|---|
| BLOCKING | P0 | Security vulnerabilities, runtime crashes, data loss or corruption |
| HIGH | P1 | Bugs that will cause errors in production, broken API contracts, race conditions |
| MEDIUM | P2 | Real code quality issues, DRY violations, minor bugs |
| MEDIUM | P3 | Suggestions and nice-to-haves |

Each finding includes: file path, line number, severity, category, issue title, explanation, recommendation, code snippet, priority (0-3), and confidence (0.0-1.0). Findings with confidence below 0.5 are discarded during validation.

## Reviewer Agent Constraints

Reviewer agents (spawned as `code:code-review-worker` sub-agents) operate under strict constraints defined in `shared_prompt.txt`:

- May only report findings for files explicitly assigned to their partition
- May only flag issues on lines present in the diff (added or modified lines)
- Must not flag pre-existing issues, style preferences, or linter-catchable issues
- Must not use Bash — all context gathered via Read, Grep, and Glob tools
- Must cite concrete evidence; speculation is discarded during validation
