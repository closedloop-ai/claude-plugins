# code-review Plugin

A multi-agent code review plugin for Claude Code that performs deep, partitioned code analysis with deterministic hygiene checks, risk-based model routing, and validated findings. Supports both local terminal output and GitHub PR inline comment posting via CI.

## Key Features

- **Multi-agent parallel review**: Splits changed files into partitions and spawns concurrent reviewer agents (Bug Hunter A, plus domain specialists) to review each partition independently
- **Deterministic hygiene checks**: Pattern-based checks for CI artifacts, sensitive file exposure, and path leakage — zero LLM tokens required
- **Risk-based model routing**: Scores each file partition by risk (size, file type, LOC) and routes high-risk partitions to more capable models
- **Cost-optimized orchestration**: The orchestrator walk is mechanical (run helper, read JSON, honor gates) and carries no diff or large artifacts in its own context, so it is cheap to run on a lower-cost session model while spawned reviewer and verifier subagents keep their own route-assigned models — run `/code-review` from a standard-context Sonnet session for the cheapest orchestrator without changing review quality (the worker subagents pin `effort: high`, so lowering the session effort too won't reduce reviewer reasoning depth)
- **Finding validation and deduplication**: Normalizes severity, filters low-confidence findings, deduplicates near-duplicate issues via Jaccard similarity, and validates line numbers against the actual diff
- **Incremental reviews**: Tracks prior review state to diff only new commits since the last successful review (auto-incremental mode)
- **Caching**: Content-addressed cache keyed on prompt hash and diff tip to skip re-reviewing unchanged partitions
- **Two output modes**: Local terminal output for developer workflow, or GitHub mode for CI pipelines that posts inline PR comments and a summary

## Architecture

```
plugins/code-review/
  .claude-plugin/plugin.json         Plugin manifest (see `version` field)
  SCHEMA.md                          Canonical Finding + ResultEnvelope schema (PLN-719); §12 documents the golden fixture harness
  agents/
    code-review-worker.md            Background worker agent used by every reviewer fleet spawn (Read, Write, Grep, Glob; permissions-stable across sessions)
    code-review-worker-graph.md      Graph-aware variant for the cross-file and design reviewers (Impact Analyzer, Bug Hunter B, fast-path, Design Critic); adds read-only codebase-memory-mcp tools — cross-file usage discovery for the cross-file roles, project-structure/dependency-graph analysis (get_architecture, query_graph) for the Design Critic
  commands/
    start.md                         Main /start command (orchestrator)
    shallow.md                       /shallow wrapper — `/start --depth shallow`
    deep.md                          /deep wrapper — `/start --depth deep`
    cost.md                          /cost command — token-cost attribution from session transcripts
  skills/
    spawn-reviewers/SKILL.md         Reviewer-fleet spawn/collection contract at stage_20_spawn_reviewers
    verify-findings/SKILL.md         Finding-verifier fleet dispatch at stage_23_verify_findings (PLN-722)
    singleton-dispatch/SKILL.md      Single-agent dispatch for stage_11_extract_signals / stage_15_coverage_critic (PLN-725)
    present-local/SKILL.md           Local-mode presenter at stage_29_present
    fix/SKILL.md                     Verifies and fixes BLOCKING/HIGH findings from a prior review session
  prompts/
    github-review.md                 GitHub-mode constraints and output steps (loaded conditionally)
  scripts/
    dist/cost-report.mjs             Bundled Node cost analyzer for /cost (sources at tools/code-review-cost/)
  tools/
    prompts/shared_prompt.txt        Shared reviewer constraints injected into every agent prompt
    prompts/bha_suffix.txt           Bug Hunter A reviewer persona and focus areas
    prompts/design_critic_suffix.txt Design Critic reviewer role (software-design craftsmanship; always-on at deep tier)
    prompts/impact_analyzer_prompt.txt   Impact Analyzer reviewer role (FEA-1401 cross-file blast radius; deep tier, signal-gated)
    prompts/coverage_critic_prompt.txt   Coverage critic role (standard/deep tiers)
    prompts/signal_extraction_prompt.txt Signal extraction role (standard/deep tiers)
    prompts/verifier_prompt.txt      Finding-verifier role (falsify-oriented; PLN-722)
    python/code_review_schema.py     Canonical Finding + ResultEnvelope schema + validators (PLN-719)
    python/test_code_review_schema.py  Schema tests + round-trips
    python/code_review_helpers.py    Deterministic helper CLI (parse-diff, hygiene, partition, route, validate, cache, finalize-result, arbitrate-budget, prepare-run, etc.)
    python/test_code_review_helpers.py   Unit tests for the helper CLI
    python/golden_fixture_harness.py     Golden fixture harness: replays canonical inputs through helper subcommands and diffs against expected envelopes (PLN-719 Phase 8)
    python/test_golden_fixtures.py       Pytest driver that runs every fixture under tools/python/fixtures/
    python/fixtures/<name>/              Per-fixture directory (config.yaml + inputs/ + expected/); 3 full scenarios + 6 README-stubs for future coverage
    python/prefix_golden_harness.py      Prefix golden harness + subprocess A/B parity oracle: walks the deterministic prefix against real git fixtures — in-process for golden snapshots, and per-stage-subprocess vs `run-prefix` for byte-equal parity (PLN-1229 Phase 0/1)
    python/test_prefix_golden.py         Pytest driver for the prefix harness: determinism oracle + golden diff across the prefix_fixtures/ matrix
    python/prefix_fixtures/<name>/       Per-fixture directory (expected/ golden snapshots); 7 branch scenarios (standard, fast-path, hygiene-only, empty-diff, cache-hit, since-last-review, coverage-critic)
```

### Foundation (PLN-719, schema_version 1)

Starting in version 2.0.0, every reviewer, helper, and consumer conforms to a
canonical schema documented in [SCHEMA.md](SCHEMA.md). Key contracts:

- **`review_result.json`** (canonical envelope) is the terminal artifact of every
  run. Findings bucket into `verified[] | justified[] | rejected[] | pending_verification[]`;
  coverage gaps live in `coverage_gaps[]` with `finding_scope: "system"`.
- **Three finding scopes** — `diff` / `system` / `pr_metadata` — make non-code-line
  findings (coverage gaps, prompt-injection signals) first-class.
- **`arbitrate-budget`** is the single owner of "which reviewers run, against what cap"
  (default cap=20, BHA floor=1 waived for docs-only PRs, required overflow
  fails closed and emits coverage gaps).
- **`prepare-run`** emits a declarative `run_plan.json` describing the 30-stage
  pipeline; the orchestrator runs its deterministic prefix in one process via
  `run-prefix` and walks the reviewer/verification/presentation tail
  stage-by-stage (PLN-1229).
- **Canonical `prompt_hash`** folds in `schema_version`: a MAJOR schema bump
  invalidates every cache namespace at once.

The terminal artifact of every review run is `review_result.json` (PLN-722 envelope).

### Component Roles

| Component | Role |
|---|---|
| `start.md` | Orchestrator command. Parses flags, sets up the session, runs the deterministic prefix in one process via `run-prefix` (then walks the reviewer tail stage-by-stage), spawns reviewer sub-agents, collects results, and presents findings |
| `github-review.md` | Loaded by the orchestrator only in GitHub mode. Contains PR metadata resolution, file-based handoff format for CI, and summary format |
| `code_review_helpers.py` | Python CLI that handles all deterministic work: git diff parsing, hygiene pattern matching, file partitioning, risk scoring/model routing, finding validation, cache management, and GitHub comment posting |
| `shared_prompt.txt` | Constraints injected into every reviewer agent prompt: file assignment rules, evidence standards, severity definitions, and output format |
| `bha_suffix.txt` | Bug Hunter A reviewer persona and focus areas (syntax errors, security, state management, error handling, data transformations) — appended to the Bug Hunter A agent prompt |

## Commands

### `/start`

Runs a comprehensive code review. Invokes the full pipeline: diff parsing, hygiene checks, agent spawning, finding validation, and result presentation.

**Syntax:**

```
/start [scope] [--github] [--hygiene-only] [--base <ref>] [--since-last-review] [--full-review] [--depth shallow|standard|deep]
```

**Scope arguments:**

| Argument | Behavior |
|---|---|
| _(none)_ | Review the open PR's diff for the current branch; with no open PR, diff the current branch from its fork point off the default branch |
| `staged` | Diff only staged (index) changes |
| `file1 file2 ...` | Diff specific files from the fork point off the default branch |
| `123` | Use PR #123's diff (local output, no posting) |

**Base ref resolution.** The default base branch is *detected*, not assumed: the helper reads the `origin/HEAD` symbolic ref, then probes `origin/main` / `origin/master`, then the same names locally, falling back to `main` only when nothing resolves. The diff runs from the fork point rather than a fixed ref — a clone holds both a local `<base>` and an `origin/<base>`, and either can lag the other (a stale local checkout, or unpushed local base commits). The helper takes the merge base of each against `HEAD` and uses whichever ref yields the *later* one, since that is the true fork point. This keeps commits that landed on the base branch after the fork out of the review diff under either kind of staleness.

**Mode flags:**

| Flag | Description |
|---|---|
| `--github` | GitHub CI mode: auto-detect PR from branch or accept explicit PR number, post inline comments via file-based handoff |
| `--github 123` | GitHub CI mode: review PR #123 specifically |
| `--hygiene-only` | Run only the deterministic hygiene checks. Zero LLM tokens consumed. Fast. |
| `--base <ref>` | Override the base branch for diffing (default: the repository's detected default branch) |
| `--since-last-review` | Review only commits added since the last successful review (local mode only) |
| `--full-review` | Force a full diff even when auto-incremental mode would narrow the scope |
| `--depth shallow\|standard\|deep` | Reviewer-fleet tier. Default `standard`. See **Depth Tiers** below |

**Examples:**

```bash
/start                               # Open PR diff, else changes on current branch since its fork point
/start staged                        # Only staged changes
/start src/auth.ts src/user.ts       # Specific files
/start 123                           # PR #123 diff locally
/start --github                      # CI: auto-detect PR, post comments
/start --github 123                  # CI: PR #123, post comments
/start --hygiene-only                # Hygiene checks only
/start --base develop                # Diff against develop instead of the default branch
/start --since-last-review           # Only new commits since last review
/start --full-review                 # Disable incremental narrowing
```

**Flag incompatibilities:**

- `--base` and `staged` cannot be combined
- `--since-last-review` requires branch scope (not staged)
- `--since-last-review` is local-only (incompatible with `--github`)
- `--since-last-review` and `--full-review` are mutually exclusive

### `/shallow` and `/deep`

Thin command-file wrappers around `/start` with `--depth` pre-bound. `/shallow` invokes the built-in fleet only (BHA + BHB + unified_auditor + verifier; no `critic-gates.json` entries, no signal extraction). `/deep` invokes the standard fleet plus the deep-tier reviewers: the **Design Critic** (always-on at deep — no signal trigger), and the FEA-1401 **Impact Analyzer** when signal extraction detects an exported-symbol change or symbol deletion.

### `/cost`

Attributes the token cost of code-review runs from Claude Code session transcripts (`review_result.json`'s `telemetry` block carries no token data — usage lives only in the transcripts). Reports total/mean/median/p90 spend, the main-orchestrator-vs-fleet split, cost by token kind (cache read, 1h/5m cache write, output, input), cost by depth tier (`deep`/`standard`/`shallow`), and cost per reviewer role with `$/run`. Establish a baseline before a change and compare after to measure the dollar impact of a cost-reduction change. Costs are estimates (raw transcript tokens × public Anthropic list prices).

**Syntax:**

```
/cost [--session <file.jsonl>] [--project <dir>] [--scan] [--depth deep|standard|shallow] [--baseline <file.json>] [--save <file.json>] [--json]
```

| Flag | Description |
|---|---|
| `--scan` | Scan every code-review session under `~/.claude/projects` (default when no args given) |
| `--session <file.jsonl>` | Attribute cost for one specific session transcript |
| `--project <dir>` | Attribute cost for every code-review session in one project directory |
| `--depth deep\|standard\|shallow` | Filter to a single depth tier so baseline/compare is like-for-like |
| `--save <file.json>` | Save the aggregate as a JSON baseline |
| `--baseline <file.json>` | Compare current spend against a saved baseline (prints mean-cost and per-role `$/run` deltas) |
| `--json` | Emit the full machine-readable aggregate (per-session rows included) |

The command runs a bundled Node analyzer (`scripts/dist/cost-report.mjs`, Node 18+, no install). Sources live outside the plugin at `tools/code-review-cost/`.

### Depth Tiers (PLN-807)

Three tiers select which reviewer fleet runs:

| Component | shallow | standard | deep |
|---|---|---|---|
| Hygiene (deterministic) | ✓ | ✓ | ✓ |
| `signal_extraction` | ✗ | ✓ | ✓ |
| `coverage_critic` | ✗ | ✓ | ✓ |
| `bug_hunter_a` (partitioned at >5000 LOC) | ✓ | ✓ | ✓ |
| `bug_hunter_b` | ✓ | ✓ | ✓ |
| `unified_auditor` | ✓ | ✓ | ✓ |
| `critic-gates.json` domain critics | ✗ | ✓ (≤3 total) | ✓ (≤3 total) |
| Verifier | ✓ | ✓ | ✓ |
| `fast_path_reviewer` (auto on tiny PRs) | ✓ (auto) | ✓ (auto) | ✓ (auto) |
| `design_critic` (always-on at deep) | ✗ | ✗ | ✓ |
| `impact_analyzer` (FEA-1401, on exported-symbol change/deletion) | ✗ | ✗ | ✓ (on signal) |

**Standard-mode budget arithmetic.** With PLN-807 Phase 4, `arbitrate-budget` reserves BHA partitions FIRST (from `_max_bha_partitions_by_loc`) and then allocates the remaining budget to critics and best-effort. The total domain-critic count across both required and best-effort buckets is capped uniformly at `DOMAIN_CRITIC_CAP` (default 3, operator-tunable via `.closedloop-ai/settings/code-review.json:domain_critic_cap`; by priority asc, reviewer asc) for both standard and deep tiers. Required-bucket critics dropped by the cap emit coverage-gap findings; cap-deferred entries carry `defer_reason: "domain_critic_cap"` in `deferred_for_budget`. PRs with sparse critic-gates rosters see identical fleet to pre-PLN-807.

**Tier-mismatch nudge.** Shallow runs emit a single LOW system-scoped finding (`system_marker: "tier_mismatch_nudge"`) when the diff would benefit from a higher tier. Heuristics: diff > 3000 LOC; schema/migration paths (`/migrations/`, `/schemas/`, `/models/`); public API surface (`plugin.json`, `index.ts`, `__init__.py`, etc.).

**Cache semantics.** `review_state.json` entries persist the tier they ran at. A cached shallow review does not satisfy a subsequent standard or deep invocation — `review-state-read` returns a cache miss when the cached tier is weaker than the new invocation tier. Legacy entries (pre-PLN-807, no `tier` field) are treated as standard-equivalent.

## Execution Pipeline

The orchestrator executes these steps in order:

1. **Parse flags and detect mode** — resolves `MODE` (local/github), `HYGIENE_ONLY`, `BASE_REF_OVERRIDE`, `SINCE_LAST_REVIEW`, `FULL_REVIEW`
2. **Session setup** — resolves the helpers path, creates a session-scoped working directory (`.closedloop-ai/code-review/cr-<random>/`), and runs `setup` subcommand to capture `start_time`, `repo_name`, and `global_cache`
3. **Parse scope and get diff data** — runs `parse-diff` subcommand to execute all git diff commands and produce a structured JSON blob with file statuses, LOC counts, changed line ranges, and patch content
4. **Materialize full-diff patches** — runs `extract-patches` immediately after `parse-diff` to write the consolidated `patches_all.txt` so downstream stages (and reviewer agents) can read the diff without Bash access
5. **Compute prompt hash and cache check** (if caching is active) — hashes the shared prompt and reviewer suffix, then checks the content-addressed cache for a prior result on this exact diff tip
6. **Deterministic hygiene checks** — pattern-match for CI artifacts, sensitive files (`.env`, `.pem`), and path leakage; if `--hygiene-only`, stop here
7. **Risk scoring and model routing** — scores each file by risk factors (LOC, file type, complexity); routes high-risk partitions to stronger models
8. **File partitioning and per-partition patches** — bin-packs files into agent-sized partitions balanced by LOC; when invoked with `--diff-scope` and `--cr-dir`, `partition` also writes the per-partition `patches_p<N>.txt` files alongside `partitions.json`
9. **Spawn reviewer agents in parallel** — launches one `code-review:code-review-worker` sub-agent per partition; all run concurrently with `run_in_background: true`
10. **Collect and validate findings** — collects all agent outputs, merges with hygiene findings, runs the `validate` subcommand (normalize severity, filter low-confidence, deduplicate, validate line numbers)
11. **Cache update** (if caching is active) — writes validated findings to the cache for future incremental runs
12. **Present results** — local mode: prints findings by severity in the terminal; GitHub mode: writes `.closedloop-ai/code-review-findings.json`, `.closedloop-ai/code-review-threads.json`, and `.closedloop-ai/code-review-summary.md` for the CI workflow to post
13. **Review state write** — persists the current diff tip so future `--since-last-review` runs can narrow the scope
14. **Footer** — prints elapsed time, token usage stats, and writes the deterministic verdict JSON to `<CR_DIR>/verdict.json` (consumed by the `code` plugin's `run-loop.sh`)

(Step numbers in this list are illustrative; the canonical 30-stage ordering lives in `prepare-run`'s `run_plan.json`. Steps 2–8 — the deterministic prefix through routing and partitioning — run in a single process via the `run-prefix` helper; the orchestrator walks the reviewer/validation/presentation tail from step 9 onward.)

## Helper CLI (`code_review_helpers.py`)

The helper script is a multi-subcommand Python CLI. The orchestrator invokes it via `python <helpers_path> <subcommand> [args]`.

| Subcommand | Description |
|---|---|
| `setup` | Emits start time, repo name, branch, and global cache flag as JSON |
| `parse-diff` | Runs git diff commands and produces structured JSON with file statuses, LOC, ranges, and patch lines |
| `hygiene` | Pattern-matches diff data for CI artifacts, sensitive files, and path leakage; emits findings JSON |
| `partition` | Bin-packs files into agent-sized partitions balanced by LOC; when `--diff-scope` and `--cr-dir` are passed it also writes per-partition `patches_p<N>.txt` files alongside `partitions.json` (PLN-719 Phase 5) |
| `route` | Computes risk scores and emits model routing decisions per partition |
| `validate` | Normalizes severity, filters low-confidence findings, deduplicates via Jaccard similarity, validates line numbers |
| `compute-hashes` | Computes `PROMPT_HASH` and `CONTEXT_KEY` from shared prompt and diff tip |
| `cache-check` | Checks the content-addressed cache for a prior result matching the current context key; enforces per-namespace TTL sweep-on-read so stale entries count as a miss (PLN-719 Phase 7) |
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
| `extract-patches` | Materializes the full-diff `patches_all.txt` immediately after `parse-diff`; per-partition patches are now produced by `partition` (PLN-719 Phase 5) |
| `finalize-result` | Consolidates validated findings + coverage state + verdict into the canonical `review_result.json` envelope; deep-merges `<cr_dir>/telemetry.json` into the canonical `telemetry` block and populates `telemetry.cache_hit_rate["bha"]` from `cache_result.json` (PLN-719 Phase 7/9) |
| `arbitrate-budget` | Applies the canonical reviewer cap policy; emits coverage gaps for required reviewers that overflow (PLN-719) |
| `prepare-run` | Emits a declarative `run_plan.json` describing the 30-stage pipeline (PLN-719) |
| `run-prefix` | Runs the whole deterministic prefix (setup through Gate B route + partition + spawn-spec derivation) in one process, resolving tokens and honoring gates/`on_failure`; pauses at the hygiene-only exit or a singleton needing an agent, otherwise returns `ready_for_reviewers` with the fast-path/cache-status decision — emitting a status JSON and resuming from a given stage (PLN-1229) |

## GitHub CI Mode

In GitHub mode (`--github`), the orchestrator does not post comments directly. Instead, it writes results to files that a CI workflow step reads and handles:

| File | Contents |
|---|---|
| `.closedloop-ai/code-review-findings.json` | Validated findings in structured JSON; CI workflow posts inline comments |
| `.closedloop-ai/code-review-threads.json` | Outdated review thread IDs; CI workflow resolves them |
| `.closedloop-ai/code-review-summary.md` | Review summary in Markdown; CI workflow posts as a PR comment |

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

## Configuration

Operator-tunable knobs live under `.closedloop-ai/settings/`. All files are optional; absent or malformed entries fall back to built-in defaults.

### `verdict-thresholds.json` (FEA-1401)

Tunes the verdict-precedence gates:

```json
{
  "impact_cumulative": 2
}
```

| Key | Default | Effect |
|---|---|---|
| `impact_cumulative` | `2` | Trigger `NEEDS_ATTENTION` when at least N BLOCKING/HIGH `ImpactAnalysis` findings survive verification on the same PR (the cumulative Impact gate — SCHEMA.md §5 verdict-precedence Rule 4 / FEA-1401 OQ#6), even if no single finding would gate on its own. Set to a very large number (e.g. `999`) to disable. Values below 1 are ignored. |

### `verification-gates.json` (PLN-722)

Sensitive-path policy. See `start.md` for the full glob syntax and the three supported keys (`sensitive_paths`, `tentative_on_paths`, `mandatory_human_review_paths`).

### `code-review.json` (PLN-774)

Operator-tunable reviewer behavior.

| Key | Default | Behavior |
|---|---|---|
| `bha_unified_threshold_loc` | `5000` | PRs with total changed LOC at or below this value get a single "unified" BHA partition so cross-region invariants (declaration ↔ enforcement, definition ↔ reference) stay visible to one reviewer's context. PRs above the threshold fall back to the standard bin-pack (`REBALANCE_LOC_BUDGET=1200` LOC per partition). **Setting the value to `0` disables unified mode entirely (always-partition; restores pre-PLN-774 behavior — the regression escape hatch).** Invalid entries (wrong type, negative) silently fall back to the default. |
| `out_of_hunk_confidence_floor` | `0.80` | P2+ findings whose line falls outside the file's changed range survive validation when `confidence >` this floor. `1.0` is a kill switch (strict in-hunk only); `0.0` admits every out-of-hunk P2+. |
| `domain_critic_cap` | `3` | How many domain critics may spawn across the required and best-effort buckets combined. `source: "core"` reviewers (Design Critic, Impact Analyzer) are exempt. **Setting the value to `0` spawns no domain critics at all (kill switch).** Invalid entries (wrong type, negative) silently fall back to the default. Also overridable per-run with `arbitrate-budget --domain-critic-cap`. |

**When to raise `domain_critic_cap`.** The cap drops by `(priority asc, reviewer asc)`. A repo whose `critic-gates.json` still uses the legacy `moduleCritics[]` schema gets every entry migrated as `required: False` with **no** `priority`, so all of them sit at the default `2` and the tiebreak degenerates to **alphabetical by reviewer name** — systematically favoring early names over relevance, and cutting the very critic the coverage critic proposed *for* the diff. Raising the cap is the blunt remedy; the precise one is migrating the relevant rules to the canonical `coverage[]` schema, which supports explicit `priority` and `required` (see `_migrate_module_critics` for what the legacy form forces).

The chosen mode + count surface in `partitions.json` (`partition_mode`, `partition_count`, `total_changed_loc`, `unified_threshold_loc`), propagate into `verify_manifest.json`, and render in both presenters (local-mode Verifier Stats footer and GitHub Step 6e). Under partitioned mode, `stats.verification.by_reviewer` splits BHA findings per partition (`bha_p0`, `bha_p1`, …) so an over-rejecting partition surfaces in the FP-rate column.

## Override Flow (PLN-773)

When the verifier dismisses a finding the operator believes is real, two flags falsify the dismissal without editing code:

| Flag | Effect |
|---|---|
| `--re-assert <id>[,<id>...]` | Write an override file at `<CACHE_DIR>/overrides/<finding_id>.json`. On the next run, `cmd_verify_prepare` honors the override (synthesizes a `RE_ASSERTED` verdict and skips the agent spawn) so long as the cited file's content hash still matches. Optional `--re-assert-reason='<why>'` is recorded in the override and in `pending-learnings/verifier-overrides.jsonl`. |
| `--review-dismissed` | Run a second opinion via the haiku verifier against the prior run's `rejected[]`. Any verdict that is NOT `REJECTED` auto-promotes via a `REVIEW_DISMISSED` override. Side-by-side diff lands at `<CR_DIR>/review_dismissed_diff.json`. |

Overrides survive across runs while the file content matches and the 90-day TTL (`CACHE_TTL_DAYS["overrides"]`) has not expired. Edit the cited line and the override auto-invalidates on the next run; the verifier runs normally. `mandatory_human_review_paths` (verification-gates.json) outranks every override — the operator-policy invariant always wins.

**Re-assert is best-effort against finding_id drift.** Finding IDs are assigned as `<reviewer>_f<index>` where `<index>` is the reviewer's emission position. Across re-runs the LLM may reorder or drop findings, so an override written against `bha_f3` on run N may map to a different finding (or no finding) on run N+1. The content-hash anchor prevents promoting an unrelated finding at a different line — but the common drift case is the override silently no-ops. Two mitigations: (1) re-assert and re-run immediately so the override is honored against the same emission set, and (2) inspect the verify-prepare manifest for `override_hits` / `override_invalidated` to confirm the override landed.

The presenter (local mode: the `present-local` skill, GitHub mode: `github-review.md` Step 6e, which writes `.closedloop-ai/code-review-verifier-stats.md`) surfaces:

- Per-reviewer FP rate (`stats.verification.by_reviewer[*].fp_rate`)
- Override count per reviewer (`stats.verification.by_reviewer[*].re_asserted`)
- Justified-finding counts (`stats.verification.justified_valid_count` / `justified_invalid_count`)

`pending-learnings/premise-justifications.jsonl` and `pending-learnings/verifier-overrides.jsonl` feed `self-learning:process-learnings` so the verifier's J2 (responsiveness) threshold and the per-reviewer FP-rate gate can tune over time. Both jsonl writers serialize via `fcntl.flock` so concurrent runs each get exactly one well-formed line per event.

## Reviewer Agent Constraints

Reviewer agents (spawned as `code-review:code-review-worker` sub-agents) operate under strict constraints defined in `shared_prompt.txt`:

- May only report findings for files explicitly assigned to their partition
- May only flag issues on lines present in the diff (added or modified lines)
- Must not flag pre-existing issues, style preferences, or linter-catchable issues
- Must not use Bash — all context gathered via Read, Grep, and Glob tools
- Must cite concrete evidence; speculation is discarded during validation
