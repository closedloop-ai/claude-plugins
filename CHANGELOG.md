# Changelog

All notable changes to the claude-plugins project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are listed newest-first; each plugin section is treated as released when merged to `main`.

### code-review v3.3.0

#### Changed
- `run-prefix` now runs the **entire** deterministic review prefix in one process, folding in the Gate B model-routing (`route`) and file partitioning that previously sat outside the runner. After the cache check it computes the routing decision itself (writing `spawn.json.route`), then — unless the fast path is selected — partitions the changed files (applying the reviewer-budget caps and, when a cache directory is active, restricting partitions to the files that missed the cache). In fast-path mode partitioning is skipped entirely and the cached Bug-Hunter-A replay artifact is removed. The terminal result is now `ready_for_reviewers`, which carries the `fast_path` decision, the Bug-Hunter-A agent cap, and the cache status message so the orchestrator can print the routing and cache notices without re-reading `spawn.json`; a routing failure is surfaced as an `error` result. Documented in `SCHEMA.md`.
- The subprocess A/B parity oracle now walks the whole prefix through partitioning and spawn-spec derivation on both sides, so its byte-identical-artifact guarantee covers the fast-path and partitioned branches (including `partitions.json` and `spawn.json`) across all seven fixtures.

### code-review v3.2.0

#### Added
- New `run-prefix` helper subcommand: a resumable, in-process runner for the deterministic review prefix (stages `setup` through `cache-check`). It reads `run_plan.json` and walks the stages in one process — resolving each stage's placeholder tokens from prior-stage artifacts, redirecting stdout per stage, and honoring `on_failure` policies and validation gates — instead of one orchestrator turn per stage. It pauses only at genuine decision points (the hygiene-only early exit, a signal-extraction or coverage-critic singleton that needs an agent, or the route/partition boundary), emitting a status JSON that tells the orchestrator what to do next, and resumes from a given stage on re-invocation. A failed `continue_with_coverage_gap` stage emits a canonical `agent-failure` system finding so the gap is auditable. Documented as the `run-prefix` result contract in `SCHEMA.md`.
- Subprocess A/B parity oracle for the prefix: the golden-fixture harness now walks each fixture two ways — one subprocess per stage (reproducing the current per-stage orchestrator walk) versus the new `run-prefix` runner — and asserts byte-identical normalized artifacts through `cache-check` across all seven fixtures, plus a pause-sequence check pinning the resumable segment boundaries. Contract tests cover token resolution, resumable dependency reconstruction, singleton detection, `on_failure` handling, and the runner's error/boundary returns.
- `run-prefix` failure diagnostics are attributed per stage: each in-process stage's stderr is captured and folded into the returned status message (and, for a `continue_with_coverage_gap` stage, into the emitted `agent-failure` finding's explanation), and an unexpected stage crash logs its full traceback — so a batched-runner failure stays diagnosable without reproducing it, now that one process spans many stages.

### code-review v3.1.1

#### Added
- Deterministic golden-fixture harness for the review pipeline's front half: it walks the whole deterministic prefix (setup through reviewer-spawn-spec derivation) in-process against real, pinned-date git fixtures — with the signal-extraction and coverage-critic singleton agents stubbed and the hygiene-only exit and routing/fast-path branches reproduced — and snapshots every intermediate artifact for byte-level regression detection. Ships seven fixtures (standard/partitioned, fast-path, hygiene-only, empty-diff, cache-hit, since-last-review, coverage-critic) with committed golden snapshots and a cross-run determinism check.
- Targeted branch tests for the `cache-check`, `resolve-scope`, `auto-incremental`, and `finalize-cache` helpers covering their previously-untested degradation and mode/scope paths (missing diff data, unreadable setup, forced/auto incremental rebase and same-head fallbacks, and the GitHub/global/PR-scoped cache directories).

### code-review v3.1.0

#### Added
- New **Design Critic** reviewer — an always-on, deep-tier conditional core reviewer that evaluates software-design craftsmanship (module depth and information hiding, SOLID, dependency direction and layer boundaries, project structure), drawing on *A Philosophy of Software Design*, SOLID, and *Clean Architecture*. It is a `source: "core"` reviewer (exempt from the domain-critic cap), runs on Sonnet, and emits `category: "Code Quality"` findings scoped to design flaws a change introduces or worsens.
- Both conditional core reviewers (the Design Critic and the Impact Analyzer) now appear on the operator-facing "Reviewers:" fleet-summary line. The non-partitioned core set is derived from `_SPAWN_CORE_ROLES` so future core reviewers are listed automatically.

#### Changed
- The domain-critic cap is now a uniform 3 across both standard and deep reviews (previously 5). Deep-tier breadth comes from the always-on Design Critic and the signal-gated Impact Analyzer rather than a wider domain-critic allowance.
- The Design Critic is graph-aware: it runs on the graph-enabled review worker and uses the `codebase-memory-mcp` knowledge graph (`get_architecture` for module/layer layout, `query_graph` for dependency direction and import cycles) when the repository is indexed, falling back to grep otherwise. The graph worker's tool set gained `get_architecture` and `query_graph`.

#### Removed
- Removed the unused `callsite_snippet_hash` field from `external_impact[]` entries and the coupled `snippet_hash_matched` evidence-check field. Impact-analysis callsites are now validated by reading the cited file and content-matching the verbatim `callsite_snippet`.

### code-review v3.0.0

#### Removed
- Retired the `Premise` finding category and its entire processing layer, now inert since the premise reviewer was removed (no producer emits `category: "Premise"`). Dropped `Premise` from the `CATEGORIES` schema enum; removed the two verdict-precedence rules that gated on Premise findings (the Premise priority-0 → `CHANGES_REQUESTED` rule and the cumulative-Premise → `NEEDS_ATTENTION` rule) along with the `_count_gateable_premise_medium` helper, the `premise_cumulative_medium` operator threshold, and its `justification_rate_alert` companion; removed the Premise-scoped `stats` telemetry sub-blocks (`by_subcategory`, `justification`, `premise_cumulative_medium_count`); removed the verifier "always verify Premise" eligibility branch and the Premise extra-strictness blocks from `verifier_prompt.txt`; and deleted the four `premise_*.md` fix templates with their `/fix` dispatch rows. The shared/BHA reviewer prompts keep the generic "PREMISE:" reasoning step (what the code is supposed to do), and the general author-justification machinery — the `justified[]` bucket, `JUSTIFIED-VALID`/`JUSTIFIED-INVALID` verdicts, the verifier's J1/J2 audit, and the justification-audit learning stream — is retained; only the Premise-specific pieces were removed.
- Removed the four now-unreachable Premise reasoning-certificate kinds (`necessity`, `cohesion`, `workaround`, `complexity`) from `REASONING_CERTIFICATE_KINDS`; only the active reviewer/reasoning-step kinds (`impact`, `test_quality`, `sibling_pattern`, `bha`, `bhb`, `auditor`) remain.

#### Changed
- Bumped `SCHEMA_VERSION` 1 → 2 for the `Finding` + `ResultEnvelope` contract to reflect the removed `Premise` category and telemetry keys. Because the schema version is folded into the prompt/cache hash, this invalidates the Bug Hunter A and verification caches once on rollout. `verdict-thresholds.json` now exposes only `impact_cumulative` (the FEA-1401 cumulative Impact gate, PLN-726 OQ#6), and `stats` retains `impact_cumulative_count` in place of the removed premise count.
- Pinned `effort: high` in the `code-review-worker` and `code-review-worker-graph` subagent definitions so the reviewer fleet's reasoning depth no longer drops when `/code-review` is run from a lower session effort level. Reasoning effort, unlike `model`, has no per-invocation override — a spawned reviewer otherwise inherits the session effort — so pinning it in frontmatter holds every reviewer at `high` regardless of the session level (`high` is valid on both Opus and Sonnet, the route-assigned reviewer models). `start.md` and `README.md` now document the effort axis alongside the existing session-model cost guidance.

#### Fixed
- Corrected documentation and a test left stale by the `Premise` removal and the renumbered verdict-precedence list. The cumulative Impact verdict gate is now referenced by name (FEA-1401 / PLN-726 OQ#6) in `start.md` and `README.md` rather than a bare ordinal that collided with `SCHEMA.md`'s sequential rules, and a numbering note in `SCHEMA.md` records that `_compute_canonical_verdict`'s plan-derived rule labels do not map 1:1 to that list. The `SCHEMA.md` deferred-fixture count now matches `_DEFERRED_FIXTURES` (3 deferred; `golden_injection_quarantine` is listed as a shipped fixture). The schema test that exercised the removed `stats.justification` / `stats.by_subcategory` telemetry sub-blocks now targets the live `stats.verification` sub-block (`justified_valid_count` / `justified_invalid_count` / `by_reviewer`).
- Restored the operator-facing Impact gate count in GitHub-mode output: the `github-review.md` Verifier Stats block now shows `Impact gateable count` (`stats.impact_cumulative_count`, gate threshold `impact_cumulative`) to match the local-mode presenter — the removed Premise cumulative-gate display had left GitHub mode with no line for the envelope's sole operator-tunable verdict-gate count. Also clarified the `golden_schema_v1_round_trip` fixture description to reflect that it round-trips a `schema_version: 1` finding through the current `schema_version: 2` envelope (a v1-finding backward-compat probe), instead of implying a stale v1-only test.

### code-review v2.37.1

#### Fixed
- Removed the `model: sonnet` frontmatter override from the `/start`, `/deep`, and `/shallow` commands (added in v2.37.0). A per-command model override inherits the session's context-window tier, so on a 1M-context session the orchestrator resolved to Sonnet-with-1M, which bills as extra pay-as-you-go API usage outside a Pro/Max subscription — the opposite of the intended saving, with no per-command way to opt out. The orchestrator now runs on the session model again; the turn-and-context discipline rules from v2.37.0 (which are model-independent) are retained, and `start.md`/`README.md` now document running `/code-review` from a standard-context Sonnet session as the way to get the cheaper orchestrator.

### code-review v2.37.0

#### Changed
- The review orchestrator (`/start`, `/deep`, `/shallow`) now runs on Sonnet via a `model: sonnet` line in each command's frontmatter. The walk is mechanical (run helper, read JSON, honor gates), so the orchestration spine no longer consumes Opus tokens for what is the majority of a review's turns. Spawned reviewer and verifier subagents keep their own route-assigned models (Bug Hunter A defaults Opus, domain critics Sonnet, Impact Analyzer Opus) because a subagent's `model` outranks the session model — the Sonnet spine never downgrades a reviewer. If an org `availableModels` allowlist excludes Sonnet, the session keeps its current model and the run still completes.
- Added turn-and-context discipline rules to the walker contract in `start.md`. The orchestrator never reads `diff_data.json` or `patches_*.txt` into its own context (they are passed to helpers and reviewers as file-path arguments); a run of consecutive `on_failure: abort` helper stages with no associated gate, branch, or stdout dependency may be chained in a single shell invocation to cut turn count (gate-bearing, `continue`, and stdout-dependent stages run solo, so chain failures abort unambiguously); and intermediate stage progress is no longer narrated as prose. These reduce the cache-read cost that dominates orchestrator spend.

### code-review v2.36.0

#### Removed
- Removed the premise reviewer from the reviewer fleet. It no longer spawns on any tier: dropped from `COVERAGE_CORE_REQUIRED`, the `cmd_route` model map (with the BHA budget math adjusted to `9 - 2 - critics`), `_SPAWN_CORE_ROLES`, `_spawn_resolve_models`, and the fleet display/model-summary rendering. The `premise_prompt.txt` asset and its `--premise-prompt` wiring (the `compute-hashes` prompt-hash fold and the `stage_18` argument) are removed, and the `spawn-reviewers` skill, `start.md`, `shallow.md`, and `SCHEMA.md` no longer spawn or document it. Removing the premise prompt from the prompt hash invalidates the Bug Hunter A and verification caches once on rollout. The `Premise` finding category and its verdict gates, telemetry sub-blocks, and verifier handling are retained for now (no reviewer emits `Premise` findings after this change).

#### Changed
- Standard reviews now cap domain critics at 3 (deep keeps 5). `cmd_arbitrate_budget` reads the invocation `--depth` (plumbed through `stage_16` and `cli.json`) and applies the tighter per-source cap for the standard and shallow tiers, so a standard run keeps only the three highest-priority relevant critics instead of filling the fleet to the full cap on every PR. An unspecified depth retains the previous cap of 5.

#### Fixed
- Corrected the `/start` and `/shallow` command docs to match the v2.36.0 fleet changes: the standard-tier descriptions and tier tables now state the depth-aware critic cap (≤3 standard, ≤5 deep), and the `/shallow` description no longer lists the removed premise reviewer.

### code-review v2.35.0

#### Added
- New `/code-review:cost` command and a committed `cost-report` tool that attribute the token cost of code-review runs from Claude Code session transcripts (the review pipeline's `review_result.json` telemetry carries no token data, so cost is reconstructed from the transcripts). It reports total spend, the main-orchestrator vs subagent-fleet split, cost by token kind (cache read, 1h/5m cache write, output, input), cost by depth tier (deep/standard/shallow), and cost per reviewer role with per-run figures. Depth is resolved from the command variant and any `--depth` argument so `/code-review:start` runs are classified accurately. Supports `--session`, `--project`, and `--scan` inputs, a `--depth` filter for like-for-like comparison, `--json` output, and `--save`/`--baseline` modes that capture a baseline aggregate and report the cost delta of a later change. Tool sources and vitest suites live under `tools/code-review-cost/`; the bundled CLI is committed at `plugins/code-review/scripts/dist/cost-report.mjs` and runs on Node 18+ with no install.

### code-review v2.34.1

#### Fixed
- GitHub-mode code review (`/code-review:shallow --github <pr>`) no longer exits before producing any review artifacts on the fast path. On small PRs the orchestrator routes to a single fast-path reviewer; it previously launched that reviewer as a background task and then ended its turn to wait for it, but under headless `claude -p` there is no asynchronous subagent-completion notification, so the run terminated (`terminal_reason: "completed"`) before the collect, validate, verify, finalize, and output stages executed, leaving the PR with an empty fallback summary and no `.closedloop-ai/code-review-*` artifacts. The `spawn-reviewers` skill now spawns and collects the single fast-path reviewer synchronously and documents the headless-mode constraint for both the fast path and the standard reviewer fleet, so the orchestrator never ends its turn while a reviewer is still running.

### code v1.14.7

#### Changed
- Hardened the `decision-table` skill with evidence artifacts and role-aware adversarial verification. The artifact format now records receipts for high-yield claims such as changed exports/subpaths, CLI flags, filesystem writes, trusted/persisted fields, replay/idempotency, and integration-boundary coverage; `Covered` claims require named fail-closed tests while `not applicable` claims require source evidence such as grep, export, call-site, schema, or query inventories. The workflow now defines coordinator-run adversarial lanes for abuse/filesystem/input, published contract compatibility, input parsing, state/replay/idempotency, and test realism, with a subagent fallback that records sequential self-passes or blocks alignment when independent review was required but unavailable.

### code v1.14.4

#### Changed
- Hardened the `decision-table` skill so generated artifacts stop accepting unproven coverage claims. Every `Covered`, `not applicable`, or `already covered` disposition now must cite a specific test name and the wrong-input or negative case that test fails closed on; a claim backed only by a happy-path assertion or by no test at all (security findings included) is treated as `Not aligned`. Added a partial-update rule requiring upsert-triggered derivations, reducers, stamped fields, or validation to consume the post-merge result (existing state union patch) rather than the incoming patch alone, with a required single-field test row. Added gate-versus-filter parity guidance for predicates enforced at a gate but re-derived independently in a list filter, terminal/disposition check, batch/unscoped routing path, or early short-circuit, requiring a shared helper or parity test.

### code-review v2.34.0

#### Fixed
- Local PR review (`/code-review <PR>`) no longer dismisses every finding when the PR's head branch is not checked out (e.g. reviewing a PR while on another branch). The diff was computed from the fetched remote refs while reviewer and verifier agents read source from the working tree, so the verifier's existence check failed for every finding and rejected them all. Reviews now read source at the PR head.

#### Added
- PR-head worktree isolation for local PR review: `resolve-scope` materializes a detached git worktree at the PR head SHA under the session directory, recorded as `review_root` (and `worktree_path`/`head_sha`) in `scope.json`. Reviewer prompts and per-finding verifier inputs (including the dismissed-finding second-opinion fleet) read source under `review_root` so the content agents Read/Grep matches the code under review. Reading the working tree directly is used only when HEAD already is the PR head with a clean tree; when isolation is required but cannot be established, the run fails closed (aborts) rather than reviewing the wrong branch. Skipped for hygiene-only runs, staged/file/branch scope, and GitHub mode (where the runner already checks out the head).
- `--hygiene-only` argument on the `resolve-scope` helper to skip worktree creation on the hygiene-only fast path.

#### Changed
- Graph-aware reviewers (Bug Hunter B, Impact Analyzer, fast-path) run grep-only (`GRAPH_PROJECT=""`) whenever a PR-head worktree is active, since the knowledge graph indexes the operator's checkout rather than the PR head being reviewed.
- The PR-head worktree path read from `scope.json` is validated against the canonical `<cr_dir>/pr_head_worktree` before being used for reads or destructive teardown, and a startup garbage-collector reclaims worktrees orphaned by runs that aborted before the footer teardown — with an age guard so a concurrent in-flight review's worktree is never deleted.
- Override content-hash validation anchors to the PR head — reading the worktree when present, else `git show <head_sha>:<file>` — so an override re-asserted after the worktree was torn down still matches on the next run instead of being silently dropped.

### code v1.14.0

#### Added
- New `design-inventory` skill: a staged Claude Design handoff pipeline that reviews inside the platform. Stage A decomposes a design export zip deterministically (typed design units covering screens, persistent chrome regions, and standalone components; interaction signals including scroll sync and pointer-drag scrubbing; doc headers; spec overlays; large-file splitting), builds one per-unit context pack so each analyst reads a single file, fans out per-unit analysts that compare the design against the current web-ui into schema-validated `findings.json` documents (each finding carrying a recommended action of accept/decline/discuss with a rationale), and publishes a platform "Design Review" Feature document. The review document carries inline images via the FEA-1762 attachments contract, with a capability probe that degrades to an image-stripped body when inline images are unavailable. Stage B is edit-to-review: the human edits that document in the platform - deleting a theme heading declines all its members, deleting a finding heading declines one, editing a "What changes" line amends, leaving a section accepts - and survival is judged solely from per-heading id anchors. Stage C derives decisions from the edited document, plans a per-screen ticket graph (one UI ticket per screen/region with primary-screen-owned shared components, plus an API ticket per screen with accepted backend gaps, wired together by BLOCKS edges), and creates DRAFT feature tickets only for accepted units; each ticket gets a workdir-only design pack (sliced design source, reference screenshots, decision-applied findings, token-resolved visual spec) and a UI/API ticket body, with its own shots uploaded inline. Review documents and ticket bodies never use numbered lists; there are no design-system component tickets and no per-component tickets.
- New `design-unit-analyst` agent: reads a single pre-assembled context pack first, analyzes one design unit (screen, region, component, or flow) state-vs-spec with per-type comparison targets, maps every added UI element to an exact existing Storybook component or a net-new proposal, converts machine-extracted token drift into findings, attaches a recommended accept/decline/discuss action to every finding, cites 1-3 anchoring CSS selectors per finding, and must pass the schema validator before returning. It is bound by a hard no-VCS rule and a turn budget (target under 40 tool calls, write findings once, validate once).
- New `capture-design-shots` tool: serves the extracted export locally, loads it in headless Chromium (Playwright resolved at runtime from the target repo's node_modules, degrading gracefully when unavailable), navigates to the unit's screen, outlines each finding's `spec.selectors` matches plus a per-theme union of member selectors, and screenshots the regions. A single batched multimodal verifier runs once for the whole run, Reading every captured shot against its finding's title and summary and stripping any screenshot whose highlight does not match.
- TypeScript toolchain for the skill's scripts: twelve CLIs (`design-export-extract`, `build-route-map`, `build-component-index`, `extract-visual-spec`, `validate-findings`, `build-context-pack`, `render-review-doc`, `capture-design-shots`, `upload-inline-images`, `derive-decisions-from-doc`, `plan-ticket-graph`, `build-design-pack`) in strict TypeScript with co-located vitest suites and esbuild-bundled `dist/*.mjs` so running them requires only Node 18+. Sources and tests live at `tools/design-inventory/` (outside the plugin tree); the plugin ships only the committed bundles under `plugins/code/skills/design-inventory/scripts/dist/`. The component index enrichment resolves source paths, prop names, and cva variants in a single pruned filesystem walk; the route map derives Next.js app/pages router tables plus a chrome map from layout files. Repo-side inventories are keyed by repo constants only and never by export contents; the deprecated-screen list is read from `.closedloop-ai/design-inventory/deprecated-screens.json` in the target repo; workdirs that resolve inside the repo working tree are excluded via .git/info/exclude before extraction, and temp-path exports default their workdir to /tmp.

### code v1.13.3

#### Added
- New `record_native_iteration_once.sh` helper records native terminal iteration telemetry idempotently from the current terminal `state.json` snapshot, preventing duplicate rows when multiple terminal branches invoke telemetry for the same state.
- Regression coverage for native prompt expansion payloads, hostile `config.env` parsing, persisted tool/spawn telemetry attribution, idempotent native iteration recording, and prompt terminal telemetry contracts.

#### Changed
- Native terminal prompt paths now call `record_native_iteration_once.sh` after terminal `state.json` writes, covering `/code:code`, `/code:create-plan`, `/code:execute-implementation`, the plan review Stop path, and shared hard-stop handoffs.
- `closedloop_env.sh` now safely hydrates `CLOSEDLOOP_WORKDIR` in addition to run id, iteration, and command metadata, while preserving environment-value precedence and avoiding shell execution.
- `pre-tool-use-hook.sh` now hydrates persisted native run metadata from `.closedloop-ai/config.env` before writing tool sentinels or Agent spawn events.

#### Fixed
- `user-prompt-expansion-hook.sh` now prefers the documented `command_args` payload field while preserving legacy argument fields.
- `user-prompt-expansion-hook.sh` no longer sources workspace `config.env`, so repo-controlled config values are parsed as data instead of executed as shell.
- `record_iteration.sh` now parses UTC `started_at` timestamps with `date -j -u -f` on macOS so native iteration durations are not offset by the local timezone.

### code v1.13.2

Give the native in-session `/code:create-plan` and `/code:execute-implementation` commands the same perf/telemetry trail the external run-loop already produces. Previously only `run-loop.sh` wrote `run` and `iteration` events to `perf.jsonl`; the single-shot commands left no iteration record, so native runs were invisible to downstream telemetry.

#### Added
- New `UserPromptExpansion` hook in `hooks.json` matching `create-plan|execute-implementation`, backed by the new `hooks/user-prompt-expansion-hook.sh`. The hook seeds native PLAN/EXECUTE perf metadata: it resolves the run's `config.env` from candidate sources (`CLOSEDLOOP_WORKDIR`, input JSON workdir fields, the command's first argument, then `cwd`), writes `CLOSEDLOOP_RUN_ID`, `CLOSEDLOOP_ITERATION=0`, and `CLOSEDLOOP_COMMAND` (`PLAN` or `EXECUTE`) into both `config.env` and the environment, and records the run-start event via `record_run.sh`. The `config.env` rewrite is staged to a temp file and atomically renamed into place so an interruption can never leave the file empty. It fails open on every error so prompt expansion never blocks the command.
- New `scripts/record_iteration.sh` — appends one synthetic native-command `iteration` event to `perf.jsonl`. It derives `status`/`claude_exit_code` (`ok`/0 vs `error`/1) from `state.json` — a missing `state.json`, or one that has not reached `COMPLETED`, is recorded as `error`/1 — and computes `duration_s` from the matching `run` event's `started_at`.
- New `scripts/closedloop_env.sh` — shared `load_closedloop_env` helper that hydrates `CLOSEDLOOP_RUN_ID`, `CLOSEDLOOP_ITERATION`, and `CLOSEDLOOP_COMMAND` from `config.env` while letting non-empty environment values win (the environment is the source of truth; `config.env` is the fallback). It parses the file line-by-line for those three allowlisted keys rather than sourcing it, so a malformed or hostile `config.env` can never execute arbitrary shell. It is the single source of truth for both `record_iteration.sh` and `record_phase.sh`, and is a no-op when the config file is absent.

#### Changed
- `scripts/record_phase.sh` now sources `closedloop_env.sh` and hydrates env vars from `config.env` before recording, so native phase telemetry picks up the run metadata the expansion hook seeded.
- `prompts/plan-prompt.md` (Phase 2.8 completion) now runs `record_iteration.sh` after `record_phase.sh`, so a completed plan-only session emits an iteration event.
- `prompts/execute-prompt.md` (completion) now runs `record_iteration.sh` before emitting `<promise>IMPLEMENTATION_COMPLETE</promise>`, so a completed implementation session emits an iteration event.

### code v1.13.0

Split the single closed-loop orchestrator into two standalone single-shot commands, so planning and implementation can run as separate in-session phases instead of only through the external run-loop. The new commands share the existing subagent fleet and phase model but each scopes itself to one half of the workflow and stops with its own promise marker.

#### Added
- New `/code:create-plan` command — a planning-only orchestrator that runs phases 0.9–2.8, writes `state.json` with `status: COMPLETED`, and emits `<promise>PLAN_COMPLETE</promise>`. It never proceeds to implementation. Backed by the new `prompts/plan-prompt.md`, selected via `setup-closedloop.sh --prompt plan-prompt`.
- New `/code:execute-implementation` command — an implementation-only orchestrator that runs phases 3–7 plus in-session review rounds (with a `--review-cycles <n>` argument), requires an existing finalized `plan.json`, and emits `<promise>IMPLEMENTATION_COMPLETE</promise>`. If no `plan.json` exists it hard-stops and points the user to `/code:create-plan`. Backed by the new `prompts/execute-prompt.md`, selected via `setup-closedloop.sh --prompt execute-prompt`.
- New `prompts/plan-prompt.md` and `prompts/execute-prompt.md` orchestrator prompts, each defining a scoped ORCHESTRATOR identity (delegate-only, no file reads) for its half of the workflow.

#### Changed
- `prompts/prompt.md` now performs mandatory deterministic multi-repo detection immediately after `startSha` init (first iteration only), sourcing `CLOSEDLOOP_ADD_DIRS` and `CLOSEDLOOP_REPO_MAP` from `config.env`. When `ADD_DIRS` is non-empty the orchestrator prepends an explicit `MULTI_REPO_DIRECTIVE` to the pre-explorer and plan-draft-writer launches (requiring per-secondary-repo `code-map-{name}.json` output and the `repositories` field plus `@{repo-name}:path` references in `plan.json`), rather than relying on the planning agents to self-detect multi-repo mode.
- `plan.json` now carries top-level `simple_mode` and `plan_was_imported` booleans, defined in `schemas/plan-schema.json`. `plan-writer` persists both flags at finalization, and the `plan-validate` skill (`validate_plan.py` `extract_data`) surfaces them in its VALID output, so the separate `/code:execute-implementation` session can recover them without reading plan files.

#### Fixed
- `setup-closedloop.sh` now recognizes `--review-cycles <n>` as a parsed option that consumes its value. Previously the flag fell through to the unknown-option catch-all and its bare numeric value was appended to `WORKDIR`, corrupting the working directory and aborting startup before the orchestrator loaded. The value is read directly by the implementation orchestrator (`prompts/execute-prompt.md` Phase 6.5) from the command arguments; it is not persisted to `config.env`.
- `commands/execute-implementation.md` frontmatter now lists `SlashCommand` in `allowed-tools`. Without it the Phase 6.5 in-session review round could not invoke `/code-review:start`, so the review silently never ran even though `prompts/execute-prompt.md` mandated it.
- `/code:execute-implementation` no longer hard-stops simple-mode or imported plans at Phase 5.5. The orchestrator now recovers `simple_mode` and `plan_was_imported` from the `plan-validate` output and skips Phase 5.5 (behavioral verification) when either is true — mirroring `plan-writer`'s rule for skipping decision-table generation. Previously both flags defaulted to `false` in the fresh execute session (no planning-session memory, file reads forbidden), so plans created without a decision table reached an empty-`decision_table_path` hard stop with a misleading "re-run /code:create-plan" message.

### code-review v2.33.0

MINOR bump — relocate the two remaining agent-dispatch sections out of the `/start` command into dedicated skills. `commands/start.md` drops from ~587 to ~463 lines; the dispatch protocols now enter orchestrator context only when their stages are reached.

#### Added
- New `verify-findings` skill: the finding-verifier fleet dispatch for `stage_23_verify_findings`. Reads `verify_manifest.json`, spawns one falsify-oriented verifier per `to_verify[]` entry, skips `cache_hits[]`, and degrades missing verifier outputs to `pending_verification[]`.
- New `singleton-dispatch` skill: the PLN-725 single-agent dispatch for `stage_11_extract_signals` and `stage_15_coverage_critic`. Covers the `cache_hit` / `skipped` / `needs_agent` status gate, the synchronous singleton spawn, the by-convention `pln725_*.json` write target, and fail-closed semantics. The `skipped` status documents all three `coverage-critic-prepare` reasons (`no-critic`, `no-roster`, `no-candidates`).

#### Changed
- The `/start` command now invokes the `verify-findings` skill for `stage_23` and the `singleton-dispatch` skill for the PLN-725 stages instead of inline sections; the `spawn-reviewers` skill, walker contract, execution model, and per-stage notes were repointed accordingly. Dispatch content was relocated verbatim — no change to dispatch behavior.

### code-review v2.32.0

MINOR bump — relocate the reviewer-fleet dispatch out of the `/start` orchestrator into a dedicated `spawn-reviewers` skill, plus security hardening of the reviewer prompts and schema-doc fixes. The orchestrator command is now a lean spine that walks the declarative run plan and invokes the skill at the spawn stage, so the fleet-dispatch content no longer loads into orchestrator context during the deterministic pipeline prefix or on hygiene-only / full-cache-hit runs that never reach the spawn stage.

#### Added
- New `spawn-reviewers` skill that owns the full reviewer-fleet dispatch at `stage_20_spawn_reviewers`: spawn-spec consumption, GRAPH_PROJECT resolution, the per-agent prompt template and role suffixes (Bug Hunter A/B, Unified Auditor, Domain Critics, Premise, Impact Analyzer), the standard / fast-path / all-cached / gated-by-verify branches, the static-table fallback, the spawn + collection contract, and agent-failure recovery. The content is relocated verbatim from `commands/start.md`, which drops from ~1046 to ~587 lines.

#### Changed
- The `/start` command's `agent_fleet` dispatch for `stage_20_spawn_reviewers` now invokes the `spawn-reviewers` skill instead of an inline section; walker-contract, execution-model, and per-stage references were repointed accordingly.
- Reviewer agents now read `shared_prompt.txt` (including the untrusted-content policy) before the patches file, and the diff/patch text is explicitly labelled untrusted data so a reviewer-targeted prompt injection in PR content cannot be encountered before the policy is loaded.
- Domain-critic names from `critic-gates.json` are validated against a restricted grammar (with a safe fallback) and rendered as quoted data rather than interpolated into instruction text, preventing prompt-directive injection through a critic name.

#### Fixed
- `SCHEMA.md` §1 Finding example now lists `priority: 0 | 1 | 2 | 3`, matching the `PRIORITIES` constant in `code_review_schema.py` (the `3` / P3 tier was previously omitted from the doc).
- `SCHEMA.md` closed-vocabulary table now documents the `static` value of `arbitrate_status` (emitted by the shallow-tier static spawn spec), which the constant already permitted.
- Documentation and source-comment references to the reviewer-fleet dispatch and static reviewer table now point at the `spawn-reviewers` skill rather than `start.md`.

### code-review v2.31.1

PATCH bump — fix GitHub-mode inline comments silently dropping when a PR moves or renames files. GitHub's `pulls/{pr}/comments` API rejects any inline comment whose line is not part of the PR diff with a 422; reviewers flagging lines outside the changed hunks (common on moved/renamed files) therefore failed to post and survived only in the summary.

#### Fixed
- `cmd_post_comments` no longer attempts an inline post for findings the validator tagged `out_of_hunk_kept` — those lines are outside the diff and cannot be anchored — and now treats a runtime 422 ("line not in diff") as a non-inline skip rather than a failure, covering moved/renamed files where the diff parser and GitHub disagree on what is in-diff. The affected findings still appear in the summary comment, and the posting tally gains an `out-of-hunk=` counter so the case is visible instead of reported as a failure.

#### Changed
- `prompts/github-review.md` step 6b documents that the post-comments step owns out-of-hunk suppression, so the findings file must still include every verified finding for the summary's findings list.

### code-review v2.31.0

MINOR bump — optional `codebase-memory-mcp` knowledge-graph integration for the cross-file reviewers (Impact Analyzer and Bug Hunter B), with a provenance-aware verifier so graph-only callsites are first-class. When the MCP server is connected and this repo is indexed, the graph-aware reviewers use `search_graph`/`trace_path`/`get_code_snippet` to find cross-file usages grep cannot reach — aliased imports, re-exports, dynamic dispatch — and to resolve service/API implementations by qualified name instead of Glob-guessing the file. The integration falls back to grep silently when the server is absent or the repo is unindexed, so behavior is unchanged when the MCP is not installed; reviews never trigger indexing.

Graph access is isolated to a dedicated worker so the trust boundary stays tight, every graph call is scoped to the resolved project with returned-path validation to prevent cross-repo leakage, and Impact Analyzer findings carry a per-callsite `discovery` provenance tag so the verifier can audit graph-discovered callsites by file-read + snippet-hash without requiring grep reproducibility.

#### Added
- `agents/code-review-worker-graph.md` — a new graph-aware worker (core `Read, Write, Grep, Glob` plus four read-only `mcp__codebase-memory-mcp__*` query tools: `search_graph`, `trace_path`, `get_code_snippet`, `search_code`). Only the graph-aware roles (Bug Hunter B, Impact Analyzer, fast-path) spawn as this type; the generic `code-review-worker` — used by every other reviewer plus the verifier fleet and the PLN-725 singletons — keeps its original `Read, Write, Grep, Glob`-only allowlist, so the adversarial/verification roles get no graph access. Indexing and write graph tools are excluded from both workers.
- `tools/prompts/shared_prompt.txt` gains an "Optional: codebase knowledge graph" protocol: availability is decided by a `GRAPH_PROJECT` value the orchestrator resolves; every graph call must pass `project=<GRAPH_PROJECT>` and validate that returned paths are inside the current checkout (rejecting any path that escapes the repo), preventing another indexed repo's source from leaking into findings or PR comments.
- `external_impact[]` entries carry a `discovery` field (`"grep"` default | `"graph"`) recorded in `code_review_schema.py` (`ExternalImpact` dataclass + `EXTERNAL_IMPACT_DISCOVERY` vocabulary), validated by `validate_finding`, and documented in `SCHEMA.md`. Tests cover the schema vocabulary and the substrate-agnostic DOWNGRADE-trim audit (graph entries are trimmed only when their own evidence check fails; verified graph entries survive even when a grep entry is rejected).
- `validate_finding` now rejects `external_impact[].file` values that are absolute, drive-lettered, or contain `..` traversal. The graph substrate broadened where these paths originate (grep is confined to cwd; graph results are not), so this deterministic in-repo check backstops the agent's prompt-level path validation — an out-of-checkout path that survived to persistence would otherwise be Read verbatim by the verifier's per-callsite audit (a plain worker with unsandboxed Read), exposing foreign file content in the dismissed-findings output.

#### Changed
- `commands/start.md` routes spawns to the correct worker type per role, resolves `GRAPH_PROJECT` once via `list_projects` (matching the project to the current checkout; empty/ambiguous → grep-only), and threads it into the Bug Hunter B, Impact Analyzer, and fast-path prompts. Agent-failure recovery and fast-path settings select the graph worker for the graph-aware roles. The deep-tier description's "greps the codebase" wording is corrected to "via the knowledge graph when indexed, else grep".
- `tools/prompts/impact_analyzer_prompt.txt` Inputs/Step 2 now run grep first (the verifier's proof of record) and use the graph additively: grep-discovered callsites are tagged `discovery: "grep"` and listed in the certificate's `external_usages_found`; graph-only callsites are tagged `discovery: "graph"` and listed in a new `graph_discovered_usages` certificate field, keeping the grep-replay set clean. Adds a worked example for a graph-discovered alias callsite; extends the local untrusted-content policy and tool list to the graph tools.
- `tools/prompts/verifier_prompt.txt` makes the per-entry callsite audit explicitly substrate-agnostic (read + hash verifies grep AND graph entries) and scopes the grep-replay completeness check to `external_usages_found` only — graph-discovered usages are no longer counted as "missing" replay hits, and an all-graph finding (empty `external_usages_found`) skips the replay gate. This is the change that lets the graph surface the alias/dynamic callsites grep misses without the finding self-rejecting.
- `tools/prompts/shared_prompt.txt` untrusted-content policy and the `external_impact`/`grep_query_used` output-format docs now describe graph-tool outputs and the `discovery`/provenance semantics.

#### Fixed
- `commands/start.md` validates the resolved `GRAPH_PROJECT` against `^[A-Za-z0-9_.-]{1,200}$` before substituting it into the reviewer prompts; a non-matching value is discarded (grep-only). The project name is MCP-returned data placed in the prompt's trusted instruction zone (outside any `<untrusted_input>` block), so without this gate a name containing newlines or directive-like text could inject instructions into the spawned reviewers.
- Untrusted-content policy in `shared_prompt.txt` and `impact_analyzer_prompt.txt` now explicitly covers graph METADATA (symbol names, node labels, qualified names, descriptions from `search_graph`/`trace_path`), not just graph-returned source — attacker-influenced identifiers (e.g. a symbol named to look like a reviewer directive) are a live injection vector that the prior "such as … source" wording left ambiguous.
- `commands/start.md` agent-failure recovery step 3 now names the Impact Analyzer alongside Bug Hunter B as a graph-aware role that re-spawns on `code-review-worker-graph`; previously only Bug Hunter B was named, so a failed Impact Analyzer could be retried on the graph-less worker and silently lose graph-augmented discovery.
- Role enumerations in `agents/code-review-worker.md` and `tools/prompts/shared_prompt.txt` now list all three graph-aware roles (Bug Hunter B, Impact Analyzer, fast-path); the fast-path reviewer was previously omitted. `agents/code-review-worker.md` also documents the graph-worker split (the generic worker's note describing why it has no graph access).
- `agents/code-review-worker-graph.md` tool-usage list uses consistent short tool names with a single note that the allowlist prefixes each with `mcp__codebase-memory-mcp__`, instead of mixing full and short forms.

#### Tests
- The graph-provenance survival test now drives a DOWNGRADE verdict (with all entries verified) so it actually exercises `_trim_unverified_external_impact`'s no-op path; under the prior CONFIRMED verdict the trim was never invoked, so a regression that trimmed on CONFIRMED would have passed undetected. The duplicated `_evidence_check` verifier fixture is hoisted to a module-level `_impact_evidence_check` shared by both Impact trim test classes.

### code-review v2.30.5

PATCH bump — marketplace-cache fallback for `${CLAUDE_PLUGIN_ROOT}` resolution. Closes the gap operators were hitting when running `/code-review` from a non-monorepo repo in a session where the marketplace plugin is installed but the env var did not get exposed: previously stage 0b's outcome 3 hard-failed in that case, even though `~/.claude/plugins/cache/closedloop-ai/code-review/<version>/` was sitting right there and would have worked.

#### Changed
- `commands/start.md` stage 0b grows a new outcome 3 (marketplace-cache fallback) inserted between the in-repo dogfood case (outcome 2) and the misconfiguration hard-fail (now outcome 4). When the env var is empty AND no in-repo tree exists at cwd, probe `~/.claude/plugins/cache/closedloop-ai/code-review/*/` and pick the highest-semver subdirectory via `ls -d ... | sort -V | tail -1`. If the resolved directory contains `tools/python/code_review_helpers.py`, use it as `PLUGIN_ROOT` and emit a one-line stderr notice (`Notice: CLAUDE_PLUGIN_ROOT empty; resolved to marketplace cache <PLUGIN_ROOT>`) so the fallback is observable in the run log — operators reading transcripts can tell which plugin version actually ran. Falls through to the hard-fail when the cache directory is missing OR present but stale (no version subdirectory contains the helpers script).
- `commands/start.md` outcome 4 (misconfiguration hard-fail) error message updated to acknowledge all three failed probes: env var empty, no in-repo tree, no marketplace cache. Previously the message only cited the env var and the in-repo path, leaving operators with a populated cache to wonder why the documented "marketplace install" remediation wasn't being honored.

PATCH bump — PR #146 review-feedback follow-ups for v2.30.3. Closes the GitHub-vs-local presenter parity gap that v2.30.0 documented but never implemented, restores the `### code-review v2.30.1` heading that the `/update-documentation` run for v2.30.2 swallowed, and corrects the Rule 6 inline comment so it stops claiming a reachability case that current Rule 2/3 precedence excludes.

#### Fixed
- `cmd_post_comments._format_comment_body` now renders `external_impact[]` as an `**Affected callsites** (N):` sub-bullet list for findings with `category: "ImpactAnalysis"`. Entries sort by `(file, line)` ascending, cap at 10 with an overflow pointer to `review_result.json`, and include the `impact_type` enum value in parentheses after each callsite. Without this, the v2.30.0 `prompts/github-review.md` claim that "the post-comments workflow renders external_impact[] as a sub-bullet list" was unfulfilled — GitHub reviewers silently lost the callsite blast radius that local reviewers got via the present-local skill. Parity with `skills/present-local/SKILL.md`'s rendering shape.
- `_compute_canonical_verdict` Rule 6 inline comment no longer claims the gate "matters in the narrow case where Impact findings split BLOCKING vs HIGH severity across separate symbols". Under current precedence, Rules 2 (any BLOCKING → CHANGES_REQUESTED) and 3 (any HIGH → NEEDS_ATTENTION) fire first across all categories, so by the time control reaches Rule 6 the BLOCKING/HIGH-Impact count is always 0 and the gate is structurally unreachable. The new text describes Rule 6 as a documented safety-net retained per PLN-726 OQ#6 for future refactors that narrow Rules 2/3 (e.g. excluding ImpactAnalysis from the any-category gate).
- CHANGELOG.md `### code-review v2.30.1` heading restored — the v2.30.2 `/update-documentation` run swallowed it the same way the v2.30.1 run swallowed v2.29.2, leaving v2.30.1's paragraph and Fixed/Added sections rendering inside the v2.30.2 heading. Same bug class as the v2.29.2 fix in v2.30.1 (the skill writes adjacent same-plugin entries without re-asserting the preceding heading).
- `prompts/github-review.md` Impact Analyzer paragraph now cites the canonical implementation (`cmd_post_comments._format_comment_body`) and names the exact sub-bullet shape, sort order, and 10-entry cap so the documented contract matches the code.

#### Added
- `TestCmdPostComments.test_impact_analysis_renders_external_impact_subbullets` covers the new ImpactAnalysis rendering path: assertion shape, `(file, line)` sort order, and `impact_type` inclusion.
- `TestCmdPostComments.test_impact_analysis_caps_at_ten_with_overflow_pointer` covers the 10-entry display cap and the overflow-pointer text.
- `TestCmdPostComments.test_non_impact_category_omits_external_impact` covers the category gate (no sub-bullets rendered for non-ImpactAnalysis findings even when an `external_impact[]` happens to be present on the dict).
- `TestCmdPostComments.test_impact_analysis_empty_external_impact_omitted` covers the empty-list short-circuit (no header rendered when the analyzer found no breaking callsites).

### code-review v2.30.3

PATCH bump — cr-95440 review-feedback follow-ups for v2.30.0 / v2.30.1. Fixes two real bugs: the v2.30.1 budget-exemption test passed vacuously (wrong coverage section seeded), and the v2.30.0 verifier prompt promised DOWNGRADE would trim un-verified `external_impact[]` entries that the consolidation code never actually trimmed. Plus prompt hardening and test cleanup.

#### Fixed
- `test_budget_prune_preserves_core_be_when_capacity_tight` now delegates to the canonical `_run_arbitrate_budget` driver, which seeds the plan into `coverage.json.final` where `cmd_arbitrate_budget` actually reads it (the previous direct invocation seeded `coverage.json.initial` so arbitration was a no-op and the exemption assertion held vacuously). Uses the `tmp_path` fixture instead of a fixed `fixtures/tmp_arbitrate` directory, removes the manual `shutil.rmtree` cleanup, tightens `rc in (0, 1)` to `rc == 0` (via the shared driver), and adds an assertion that at least one critic-source entry was actually deferred — pinning that the exemption operates by displacing competing critic entries, not by silently raising the cap.
- `_merge_verifier_fields` now implements the DOWNGRADE-trim contract promised in `verifier_prompt.txt`. When the verifier downgrades an ImpactAnalysis finding AND its `evidence_checks[]` carry per-callsite `verified: false` entries, the corresponding `external_impact[]` entries are removed before persistence. Match policy: the evidence check's `source` field must equal `<file>:<line>` of the impact entry AND the `claim` must begin with `"external impact at"` (defends against pre-existing evidence checks emitted for justification audits or anchor-existence checks that happen to cite a colliding file:line). Without this trim, downstream consumers (`/fix`'s callsite update flow, the presenter's sub-bullet rendering) would act on hallucinated callsites the verifier had already flagged as un-reproducible.
- `impact_analyzer_prompt.txt` now specifies the `callsite_snippet_hash` algorithm explicitly: sha256 hex digest of the UTF-8 encoded `callsite_snippet`. Previously the prompt said "deterministic hex digest" leaving algorithm choice open-ended, and the verifier prompt's hash-replay step would silently fail (or worse, silently succeed under a different algorithm) without algorithm agreement.
- `verifier_prompt.txt` per-entry callsite audit now names sha256 as the algorithm the verifier must use to replay `callsite_snippet_hash`, matching the algorithm specified in the Impact Analyzer prompt and the convention already established for `evidence[].snippet_hash`.
- `impact_analyzer_prompt.txt` now opens with the canonical `<untrusted_content_policy>` block (mirroring `shared_prompt.txt`) plus an Impact-specific note that codebase files read OUTSIDE the diff via Grep are untrusted input — a malicious sibling file is the easiest injection vector for this reviewer specifically. Adds QUARANTINE handling: when the PR description was quarantined upstream, infer symbol changes from diff structure alone.
- `commands/start.md` Impact Analyzer spawn block reordered to read `{CR_DIR}/shared_prompt.txt` BEFORE `{CR_DIR}/patches_all.txt` so the injection policy is in context before any untrusted content (the diff itself) is loaded. Annotates `patches_all.txt` and the CLAUDE.md reads as untrusted inputs in the prompt body.
- `TestFEA1401Telemetry._impact_finding` and `TestFEA1401VerdictRule._impact_finding` consolidated into a module-level `_make_impact_finding(severity, *, verdict=None)` helper. Both classes now delegate; the new `TestFEA1401DowngradeTrim` class delegates too. Single source of truth for the canonical fixture shape.
- `test_rule_6_fires_when_threshold_lowered` renamed to `test_thresholds_dict_flows_through_compute_canonical_verdict` so the test name reflects what the test actually proves (the thresholds-dict-read path works end-to-end) rather than claiming Rule 6 isolation that the test cannot deliver under current Rule 2/3 precedence. The new name removes the misleading guard claim.

#### Added
- `TestFEA1401DowngradeTrim` covers the new `_merge_verifier_fields` DOWNGRADE-trim path: trims `external_impact[]` entries flagged unverified, retains entries when all checks verify, ignores the trim path on CONFIRMED verdicts and on non-ImpactAnalysis categories, and ignores evidence_checks whose claim prefix doesn't match `"external impact at"` (defending against anchor-existence and justification-audit evidence checks that share file:line with a callsite).
- `_trim_unverified_external_impact(finding, verdict_data)` helper exposed for tests and future callers.

### code-review v2.30.2

PATCH bump — dogfood-feedback follow-ups. Documents the in-repo plugin-tree fallback path that operators dogfooding the plugin against its own branch already discovered manually, and pins the intentional verdict-field-naming asymmetry between `review_result.json` and `verdict.json` so future inspectors don't read the absent `canonical_verdict` field as a bug.

#### Changed
- `commands/start.md` stage 0b now documents three explicit resolution outcomes for `${CLAUDE_PLUGIN_ROOT}`: (1) the normal marketplace-cached case where the env var resolves; (2) the in-repo dogfood case where the env var is empty AND `plugins/code-review/.claude-plugin/plugin.json` exists at the cwd — the orchestrator should set `PLUGIN_ROOT = <pwd>/plugins/code-review` so the run exercises the in-repo helpers being reviewed, not a stale marketplace copy; (3) the genuine misconfiguration case where the env var is empty AND no in-repo tree exists — hard-fail with an actionable error message rather than producing malformed paths every helper invocation would crash on. Previously the prompt assumed the env var always resolved, leaving the orchestrator to ad-hoc-discover the fallback (which it did correctly, but unobservably).
- `code_review_schema.py` adds a multi-line comment block adjacent to `VERDICTS` documenting why `review_result.json.verdict` IS the canonical verdict (no parallel `canonical_verdict` field), while `verdict.json` carries both keys (legacy `approve|needs_attention|decline` for run-loop.sh AND canonical for envelope-aware consumers). Inspectors reading `review_result.json` via jq and seeing `"canonical_verdict": null` should know the field is absent by design, not unset.

### code-review v2.30.1

PATCH bump — review-feedback follow-ups for v2.30.0. Wires up the telemetry plumbing the Verifier Stats footer already referenced, parses the configurable Rule 6 threshold, exempts conditional core reviewers from the domain-critic budget prune, documents the missing `deferred_symbols[]` output contract, and tightens v2.30.0's test cleanup.

#### Fixed
- `_stats_from_findings` now populates `stats.impact_cumulative_count` via `_count_gateable_impact(verified)`. v2.30.0 added the SKILL.md Verifier Stats footer line and Rule 6 docstring's "telemetry reports the count" claim but never wired the key into the stats dict; the footer was rendering None.
- `_load_verdict_thresholds` now parses `impact_cumulative` from `verdict-thresholds.json` with the same validation contract as `premise_cumulative_medium` (int, ≥ 1, not bool; invalid values fall back to the default). The Rule 6 docstring claimed the threshold was operator-configurable but the loader never read it.
- `_compute_canonical_verdict` thresholds-fallback dict now seeds `impact_cumulative` to `_VERDICT_IMPACT_THRESHOLD_DEFAULT` so a caller that omits the thresholds argument still gets Rule 6 evaluated against the documented default (2). Previously the fallback only seeded `premise_cumulative_medium`, and Rule 6's `thresholds.get("impact_cumulative", _VERDICT_IMPACT_THRESHOLD_DEFAULT)` accidentally worked through the local default — fragile and inconsistent with Rule 4's wiring.
- `_compute_canonical_verdict` docstring updated to list both threshold defaults (`premise_cumulative_medium=3`, `impact_cumulative=2`) and cite the canonical constants, replacing the previous "built-in default (3)" line that omitted the new threshold.
- `cmd_arbitrate_budget` best-effort prune now reserves `source: "core"` entries BEFORE pruning critic-source entries against remaining capacity. Without this, a deep run on a repo with a critic-heavy `critic-gates.json` could silently drop the Impact Analyzer in favor of project-specific critics. Core best-effort entries got into the plan via a tier+signal gate the operator explicitly opted into; treating them like required core for capacity purposes honors that intent. When capacity is genuinely tight, the spawn-spec exceeds cap rather than dropping the opted-in reviewer.
- `impact_analyzer_prompt.txt` now documents the `deferred_symbols[]` output contract the local presenter has been reading from `agent_impact.json`. Adds a top-level `deferred_symbols` array (entries shape `{symbol, file, line, change_nature, reason}`) and the full output envelope (`{findings, deferred_symbols}`). Without this, the SKILL.md "Deferred Impact symbols" footer block could only render when the reviewer happened to emit a structurally compatible array — a contract gap.
- `TestFEA1401SignalTaxonomy._taxonomy()` delegates to the canonical `load_signal_taxonomy()` helper (matching the pattern in `TestSignalExtractionValidator._taxonomy()`) instead of re-reading `signal_taxonomy.json` inline. The duplicate inline loader would drift the moment `load_signal_taxonomy` gained validation.
- `TestFEA1401PrepAssets::test_prep_assets_copies_impact_prompt` no longer computes a discarded `plugin_root` via `Path(__file__).resolve().parents[1]` before overwriting it on the next line with the correct three-parent ascent. Removed the dead assignment and the stale resolution comment.
- `test_rule_6_fires_when_unreachable_by_prior_rules` renamed to `test_rule_6_is_noop_for_medium_impact_under_current_precedence` so the name reflects what the test actually asserts (the rule is a no-op for MEDIUM-only Impact findings under current Rule 2/3 precedence). A new companion test `test_rule_6_fires_when_threshold_lowered` proves the rule machinery itself works when a configurable threshold makes it reachable.
- CHANGELOG.md `### code-review v2.29.2` heading restored — the `/update-documentation` skill's previous run accidentally swallowed it so the v2.29.2 section body was rendering inside the v2.30.0 heading.

#### Added
- `TestFEA1401StageWiring` covers `stage_14_resolve_coverage` threading `--depth deep` and `--depth standard` end-to-end (mirrors the `test_stage_07_auto_incremental_passes_depth` pattern). Without this test the wiring change in v2.30.0's stages.json had no targeted regression guard.
- `TestFEA1401Telemetry` covers the `stats.impact_cumulative_count` key (populated value matches `_count_gateable_impact`; zero when no Impact findings present).
- `TestFEA1401VerdictThresholds` covers the new `impact_cumulative` threshold parse path (default-when-no-config, valid operator override, invalid-value fallback for 0 / string / bool).
- `TestFEA1401BudgetExemption` covers the core-best-effort prune exemption end-to-end via `cmd_arbitrate_budget`.

### code-review v2.30.0

FEA-1401 / PLN-726 Component A — Cross-File Impact Analyzer. MINOR bump — new core reviewer, new schema registry (`COVERAGE_CORE_CONDITIONAL`), new signal taxonomy entries, new verdict rule, new per-run prompt asset. Opt-in via `/start --depth deep` (or `/deep`); zero impact on shallow or standard runs.

#### Added
- Impact Analyzer reviewer (`AGENT_ID: impact`, model default `opus`). Identifies changed exported symbols in the diff (function/method signatures, type definitions, exported constants, class API surface, schema fields, deletions), greps the codebase for external usages outside the diff, reads context around each usage (±20 lines), and emits findings with `category: "ImpactAnalysis"` anchored at the diff line where the symbol changed. Each finding's `external_impact[]` array lists every breaking callsite (file, line, `impact_type`, description, `callsite_snippet`, `callsite_snippet_hash`, confidence). Cost-capped at 30 symbols × 50 callsites per symbol with a 5-minute wall budget, 100 grep ops (soft), 250 read ops (soft); deferred symbols surface in the Coverage Plan footer.
- `tools/prompts/impact_analyzer_prompt.txt` — full Impact Analyzer prompt with algorithm, reasoning-certificate shape (`kind: "impact"`), cost-cap policy, four worked examples (signature change with 3 breaking callsites, symbol deletion with 5 callsites, backwards-compatible change with no finding, renamed constant with stale string-references), and seven `impact_type` enum values mapped to compatibility classifications.
- `COVERAGE_CORE_CONDITIONAL` schema registry in `code_review_schema.py`. Declares conditional core reviewers that ship with the plugin (vs. project-specific `critic-gates.json` entries) but spawn only when both `min_depth` ≤ invocation depth AND at least one signal trigger fires. First entry: Impact Analyzer with `min_depth: "deep"` and two signal triggers.
- `exported_symbol_change` and `symbol_deletion` signals in `signal_taxonomy.json`. Drive the Impact Analyzer's conditional spawn from `signal_extraction` output. Recommended min-confidence floors of 0.8 and 0.85 respectively.
- `--depth shallow|standard|deep` flag on the `resolve-coverage` helper subcommand. `stage_14_resolve_coverage` threads `--depth {depth}` so the conditional-core tier band gates Impact Analyzer registration without requiring orchestrator-level branching.
- `invocation_depth` parameter on `resolve_coverage()`. Defaults to `None` (back-compat — falls back to `standard` for the band check); explicit values gate `COVERAGE_CORE_CONDITIONAL` entries by tier.
- Conditional-core evaluation loop in `resolve_coverage` runs after the `COVERAGE_CORE_REQUIRED` always-add loop. For each registry entry, checks tier band (`_DEPTH_RANK[invocation_depth] >= _DEPTH_RANK[entry.min_depth]`) AND signal-trigger firing via `_trigger_fires`. Eligible entries land in `best_effort[]` with `source: "core"` and the matched trigger captured on the entry.
- `impact` entry in `_SPAWN_CORE_ROLES` (non-partitioned, `patches_all.txt`, `agent_id: "impact"`) and `_spawn_resolve_models` (default `opus`, overridable via `spawn.json.route.models.impact`). The spawn-spec walker spawns Impact like any other non-partitioned core reviewer once the coverage plan lists it.
- `Impact Analyzer` entry in `_FLEET_DISPLAY_NAMES` so the local presenter and Coverage Plan footer render the snake_case `impact` reviewer with its operator-facing name.
- `_count_gateable_impact(verified)` helper. Counts verified `category: "ImpactAnalysis"` findings whose severity is BLOCKING or HIGH and whose `verifier_verdict` is not `JUSTIFIED-VALID`.
- `_compute_canonical_verdict` Rule 6 (FEA-1401 OQ#6 cumulative Impact gate). When `_count_gateable_impact(verified) >= 2`, returns `NEEDS_ATTENTION`. Configurable via `verdict-thresholds.json` `impact_cumulative` (default 2). Under current precedence Rule 6 is subsumed by Rule 2 (BLOCKING any-category → CHANGES_REQUESTED) and Rule 3 (HIGH any-category → NEEDS_ATTENTION); kept in place per OQ#6 as a defensive safety net for future Rule 2/3 refactors that narrow the categories they cover.
- Impact Analyzer spawn block in `commands/start.md`. Tells the orchestrator to `Read {CR_DIR}/impact_analyzer_prompt.txt` (the per-run asset copied by `prep-assets`), thread `<files_assigned>` over the full diff scope (no partitioning), and constrain tools to Read/Grep/Glob (no Bash).
- `impact_analyzer_prompt.txt` copy in `cmd_prep_assets`. Edits to the source bust the prompt-hash on the same contract as `premise_prompt.txt` and `verifier_prompt.txt`, so cache entries built against the old prompt are invalidated.
- External Impact Verification section in `verifier_prompt.txt`. Adds a per-callsite audit path for findings with non-empty `external_impact[]`: anchor existence check (same EXISTENCE CHECK rules), symbol-change confirmation against the certificate's `change_nature`, per-entry callsite reading with snippet-hash comparison and `impact_type` validation, guard check that flags suppressed breakages the reviewer should have excluded, and `grep_query_used` replay for the first 5 findings in a batch (substantially different replay results → REJECTED with `rejection_class: "evidence_not_found"`). Dispatch: all entries verified → CONFIRMED; some verified → DOWNGRADE (severity drops one tier, un-verified entries trimmed); none verified or symbol-change refutation → REJECTED.
- Local presenter rendering for `external_impact[]` sub-bullets after `Recommendation` in finding cards (BLOCKING / HIGH / MEDIUM sections). Entries sort by `(file, line)`; cap at 10 displayed with overflow pointer.
- Local presenter "Deferred Impact symbols" footer block rendered only when the Impact Analyzer's `agent_impact.json` carries a non-empty `deferred_symbols[]` list (cost cap fired). Lists each deferred symbol with file:line and change nature so operators see what was sampled vs analyzed.
- `Impact gateable count` and threshold line in the Verifier Stats footer block.

#### Changed
- `commands/start.md` source-branching block extends the `source == "core"` reviewer dispatch table from four roles (`bug_hunter_a`, `bug_hunter_b`, `unified_auditor`, `premise_reviewer`) to five — adds `impact → Impact Analyzer` with the constraint that the entry only appears in `agents[]` when invocation depth is `deep` AND signal extraction emitted `exported_symbol_change` or `symbol_deletion`.
- `commands/start.md` Depth Tiers section's `deep` bullet now describes the Impact Analyzer behavior (cross-file blast-radius reviewer, signal-gated, cost caps, verifier per-entry audit, Rule 6 escalation) instead of reserving the slot for a future occupant.
- `commands/deep.md` rewritten to describe the now-shipped Impact Analyzer: when it spawns (`exported_symbol_change ≥ 0.8` or `symbol_deletion ≥ 0.85`), what it does, cost containment (30 × 50 cap, 5-min wall budget), and the verdict escalation rule (≥2 verified BLOCKING/HIGH Impact → NEEDS_ATTENTION).
- `shared_prompt.txt` output_format documents `external_impact[]` and `grep_query_used` as optional canonical fields. Reviewers that don't emit them omit them; the Impact Analyzer MUST emit both. Includes the full per-entry shape (file/line/`impact_type`/description/`callsite_snippet`/`callsite_snippet_hash`/confidence) and the seven-value `impact_type` enum.
- `prompts/github-review.md` `code-review-findings.json` writer documentation now notes that ImpactAnalysis findings carry `external_impact[]` and `grep_query_used` through validate verbatim; the existing post-comments workflow handles rendering inline.
- `_compute_canonical_verdict` docstring updated: Rule 6 is no longer a placeholder; the Impact-gate threshold (default 2) is now a real participant in verdict computation alongside Rule 4's Premise-MEDIUM cumulative gate.

### code-review v2.29.2

PATCH bump — documentation/comment accuracy fixes plus one test-helper consolidation and two test-isolation fixes. No production behavior change.

#### Fixed
- `_check_tier_mismatch_nudge` docstring now describes the MEDIUM severity actually emitted (previously said "Emit a single LOW system-scoped finding" and "severity is fixed at LOW"). Updated text explains the SEVERITY_NORMALIZE rationale (`"low"` → `"DISCARD"`) and notes the `Coverage` category keeps the finding out of Rule 4's cumulative Premise gate.
- `cmd_hygiene` inline comment "single LOW finding" updated to "single MEDIUM finding" so it matches the emitted severity.
- `start.md` and `shallow.md` Depth Tiers descriptions now describe the `tier_mismatch_nudge` finding as MEDIUM (category `Coverage`) instead of LOW.
- `TestPLN807Phase5TierMismatchNudge` class docstring updated to match the MEDIUM assertion the same PR introduced and to record the SEVERITY_NORMALIZE rationale alongside it.
- `_select_domain_critics` docstring no longer claims the caller surfaces deferred required entries as coverage-gap findings — that emission was removed in v2.29.1. New text describes the actual contract: cap-deferred entries from EITHER bucket land in `deferred_for_budget` with `defer_reason: "domain_critic_cap"`, and the caller does NOT emit coverage-gap findings (doing so would trip `_compute_canonical_verdict` Rule 1).
- `_validate_stages_config` inline comment corrected: said `min_depth >= max_depth` is "the floor", but the load-time invariant is `min_depth <= max_depth` (`>=` describes the error condition the validator raises on, not the valid band).
- `test_auto_incremental_skips_when_cached_tier_weaker` now sets `CR_AUTO_INCREMENTAL=1` via `monkeypatch.setenv` before invoking `cmd_auto_incremental`. Without this, a shell with `CR_AUTO_INCREMENTAL=0` would skip the entire tier-gate branch and the test's "tier upgrade" assertion would fail spuriously.
- `test_auto_incremental_without_depth_preserves_legacy_behavior` now mocks `code_review_helpers._run_git` via `patch(..., return_value="")` so the ancestry check passes deterministically regardless of the test environment's git state. Previously the synthetic `last_sha="abc123"` would raise `CalledProcessError` (git present) or propagate `FileNotFoundError` (git absent) instead of exercising the intended depth-bypass branch.

#### Changed
- `make_auto_incremental_args` factory in `conftest.py` replaces the two parallel `cmd_auto_incremental` Namespace factories that previously lived in `TestAutoIncremental._make_args` and `TestPLN807ReviewFixes._make_auto_inc_args`. Both classes now delegate to the shared factory; new `depth` and `base_ref` defaults live in one place, so a future field addition updates one factory instead of two.

### code-review v2.29.1

PR #144 review-feedback follow-ups. PATCH bump — no schema additions; one behavior change (cap-deferred required critics no longer block) and a cluster of correctness, schema-contract, and documentation fixes.

#### Fixed
- `cmd_arbitrate_budget` PASS path no longer emits coverage-gap findings for required critics dropped by `DOMAIN_CRITIC_CAP`. Cap-deferred required critics now land in `deferred_for_budget` with `defer_reason: "domain_critic_cap"`, matching the BLOCKING-branch behavior. Previously, any repo whose `critic-gates.json` resolved more than 5 required domain critics on a single PR was hit with auto-CHANGES_REQUESTED via `_compute_canonical_verdict` Rule 1 (any required coverage gap → CHANGES_REQUESTED). The cap is a hardcoded per-source soft limit, not a coverage failure.
- `_check_tier_mismatch_nudge` now emits `severity: "MEDIUM"` instead of `"LOW"`. `_normalize_findings`'s `SEVERITY_NORMALIZE` map sends `"low"` → `"DISCARD"`, which would silently filter the nudge out before it reached the operator. MEDIUM survives validate without escalating any verdict rule (Coverage category, not Premise — so Rule 4's cumulative Premise MEDIUM gate does not fire).
- Schema/migration path heuristic in the tier-mismatch nudge now uses path-aware segment matching via `_matches_schema_or_migration_path`. Previously the substring-with-leading-slash patterns (`/migrations/`, `/schemas/`, `/models/`) missed root-level paths (`migrations/0001.sql`, `schemas/user.py`, `models/user.rb`). The new matcher splits on `/` and looks for any directory segment in the schema-dir set, so both root-level and nested layouts fire.
- `cmd_arbitrate_budget` BLOCKING-branch BHA partition computation aligned with the PASS path's BHA-first allocation. Previously the BLOCKING branch computed BHA from leftover capacity using the pre-PLN-807 formula, which could crush BHA on critic-heavy plans even though the PASS path was reordered in v2.29.0.
- `cmd_auto_incremental` now accepts `--depth` and refuses to seed an incremental scope from a cached review whose stored `tier` is weaker than the current invocation tier. Without this, a cached shallow review's SHA would feed a follow-up standard or deep run's `git diff <last_sha>...HEAD`, narrowing the scope to files changed since the shallow run and skipping every older file that never received premise/critic coverage. `stage_07_auto_incremental` now threads `--depth {depth}` so the new gate fires in real runs.
- `stage_19c_derive_static_spec` depends on `stage_19_cache_check` instead of `stage_17_partition`. Gate B's fast-path branch skips `stage_17_partition`, so a dependency-aware walker would skip the static-spec stage too, leaving no spawn spec for shallow + fast-path PRs.
- `arbitrate_status: "static"` added to `SPAWN_SPEC_ARBITRATE_STATUSES`. PLN-807 introduced the value in v2.29.0 but did not register it with the canonical enum, so shared-schema consumers and tests would reject generated shallow specs.
- `_validate_stages_config` now requires every `stages.json` entry to declare an explicit `min_depth` at config-load time, matching the `test_every_stage_has_explicit_min_depth` invariant. A new stage added without a tier tag fails loud at load instead of silently inheriting the implicit `standard` default and leaking out of shallow.
- `cmd_evaluate_gate` docstring no longer claims it consults "the same table `prepare-run` writes into `run_plan.json`" without qualification. After PLN-807, `prepare-run` writes the TIER-FILTERED gate list; the helper consults the unfiltered canonical table. Updated to describe both sides of the relationship and note the walker should not invoke the helper for tier-filtered stages.
- `start.md` Stage 0a now parses `--depth shallow|standard|deep`, defaults to `standard`, validates the value, and removes both tokens from `$ARGUMENTS` before computing `SCOPE_ARGS`. Without this, a direct `/start --depth shallow` left `--depth shallow` in the trailing args, where it would either pollute `SCOPE_ARGS` or be passed verbatim to `resolve-scope`.
- `plugins/code-review/README.md` no longer hardcodes a stale plugin manifest version in the architecture-tree paragraph (was "version 2.6.0" against a 2.29.x manifest); now points at the `version` field directly.
- `start.md` stage-count claim "30-stage pipeline" updated to "37 for standard / deep, ~27 for shallow" — pin reflects the post-PLN-807 tier-filtered run plan. `shallow.md` stage-count claim "12-14 stages" updated to "core pipeline minus 10 standard-only stages" (the original estimate was wrong by ~2×).

#### Changed
- `_validate_invocation_depth` helper extracts the `--depth` validation block that previously duplicated across `cmd_hygiene`, `cmd_prepare_run`, `cmd_review_state_read/write`, and `cmd_auto_incremental`. Returns `(ok, error_msg)` for fail-closed call sites.
- `_max_bha_partitions_by_loc` already caps at `DEFAULT_MAX_BHA_AGENTS`, so the BHA-target computation in `cmd_arbitrate_budget` no longer wraps it in a second `min()`. Removes a redundant inner `min(max_bha, DEFAULT_MAX_BHA_AGENTS)`.

### code-review v2.29.0

PLN-807: depth-tiered code review commands (shallow / standard / deep) plus a standard-mode budget arithmetic refinement that reserves BHA partitions before allocating critics. MINOR bump — new commands, new schema fields, and a behavior change in `arbitrate-budget` that only narrows the fleet when `critic-gates.json` triggers more than 5 entries (sparse rosters are unchanged).

#### Added
- `/shallow` and `/deep` commands as thin wrappers around `/start` with `--depth` pre-bound. `/shallow` runs the built-in fleet only (BHA + BHB + unified_auditor + verifier; no premise, no `critic-gates.json` entries, no signal extraction). `/deep` runs the standard fleet plus any reviewer tagged `min_depth: deep` in `stages.json` (reserved for the FEA-1401 Impact Analyzer slot — today equivalent to standard).
- `--depth shallow|standard|deep` flag on the `prepare-run`, `hygiene`, `review-state-read`, and `review-state-write` helper subcommands. Default `standard`. `start.md` documents the tier behavior in a new "Depth Tiers" section and threads `--depth <DEPTH>` through the canonical `prepare-run` invocation.
- `min_depth` and `max_depth` fields on `stages.json` entries. The run-plan builder emits only stages whose tier band brackets the invocation depth. Most stages need only `min_depth` (defaulting to `standard` for backwards compatibility); a stage that REPLACES another at a lower tier pins both bounds.
- `cmd_derive_static_spec` (`derive-static-spec` helper subcommand) and a new `stage_19c_derive_static_spec` (`min_depth: shallow` + `max_depth: shallow`) that runs only in shallow. Writes `spawn.json.spec` with `arbitrate_status: "static"` carrying the shallow fleet (BHA × N partitions + BHB + unified_auditor). Reuses `_derive_spawn_agents_from_plan` so BHA partition expansion, docs-only handling, dedup, and patches-file naming match the standard path exactly. Fast-path passthrough applies in shallow too.
- `DOMAIN_CRITIC_CAP = 5` constant and `_select_domain_critics` helper. The total domain-critic count across both required and best-effort buckets is capped at 5. Selection order: required critics by (priority ascending, reviewer name ascending), then best-effort critics by the same key fill remainder.
- `defer_reason` field on `deferred_for_budget` entries. Cap-deferred entries carry `defer_reason: "domain_critic_cap"`; budget-deferred entries carry no `defer_reason` (historical default preserved).
- `domain_critic_cap` and `domain_critic_cap_fired` fields on the coverage plan's `budget` block expose the cap constant and whether it fired this run.
- `tier` field on `review_state.json` entries. `review-state-read --depth <tier>` returns `{}` when the cached entry's tier is weaker than the invocation tier, forcing the upgrade to actually run premise and critics. Stale entries without a `tier` field are treated as standard-equivalent (legacy behavior preserved for shallow/standard; deep invocations require an explicit `tier: "deep"` write).
- `_check_tier_mismatch_nudge` helper in `cmd_hygiene`. When `--depth shallow` is invoked on a PR that would benefit from a higher tier, hygiene emits a single LOW system-scoped finding (`system_marker: "tier_mismatch_nudge"`) consolidating all firing heuristics. Heuristics: diff > 3000 LOC; schema/migration paths (`/migrations/`, `/schemas/`, `/models/`, `schema.prisma`, `schema.sql`); public API surface files (`plugin.json`, `package.json`, `index.ts`, `index.tsx`, `index.js`, `__init__.py`).
- `{depth}` template variable on `stages.json` args so any stage can substitute the invocation tier directly. `stage_27_review_state_write` now passes `--depth {depth}` (persisting the tier that ran); `stage_12_hygiene` now passes `--depth {depth}` (so the nudge can fire).
- `_filter_stages_by_depth`, `_filter_validation_gates_by_stages`, `_entry_satisfies_depth`, `_is_critic_entry`, and `_annotate_defer_reason` helpers exposed for tests and downstream consumers.

#### Changed
- `cmd_arbitrate_budget` reordered: the BHA partition target is computed FIRST from `_max_bha_partitions_by_loc(diff_data)` and reserved before any critic allocation. Pre-PLN-807 the order was reversed (required overflow → best_effort prune → BHA from leftover), which crushed BHA to its floor=1 partition when `critic-gates.json` produced many triggers on a large-LOC PR. With BHA reserved up front, BHA's coverage budget is no longer eaten by critic-roster growth.
- `cmd_arbitrate_budget` BLOCKING-verdict branch now applies the domain-critic cap. Preserves the "no required drops on BLOCKING" semantics: required critics in excess of cap land in `deferred_for_budget` (with `defer_reason: "domain_critic_cap"`), not in `dropped_required`.
- Run-plan builder rewrites `depends_on` on each surviving stage to drop entries that reference tier-filtered stages, so the orchestrator never sees dangling-stage references. Validation gates are filtered alongside stages: a gate whose `after_stage` is tier-filtered is also dropped.
- `cmd_review_state_write` and `cmd_review_state_read` validate `--depth` against the canonical tier set (`shallow|standard|deep`) and exit 1 on invalid values.
- `_validate_stages_config` rejects invalid `min_depth` / `max_depth` values at config-load time and enforces `min_depth <= max_depth` so a swapped band can't make a stage unreachable.
- `start.md` argument-hint, Usage block, and a new "Depth Tiers" section document the `--depth` flag, the per-tier fleet composition, the tier-mismatch nudge, and the cache transition semantics. The `prepare-run` bash snippet now includes `--depth <DEPTH>` with a paragraph explaining the filter behavior.
- `plugins/code-review/README.md` documents the three tiers, the standard-mode budget arithmetic, the `DOMAIN_CRITIC_CAP`, the tier-mismatch nudge heuristics, and the tier-aware `review_state.json` cache semantics.

### code-review v2.28.1

#### Fixed (cr-52603 review-feedback follow-ups for v2.28.0)
- `TestArbitrateBudgetCrDirDefault` class docstring no longer claims `_run_arbitrate_budget` "exercises only the legacy fallback". v2.28.0 refactored the helper to seed via `_write_coverage_section` and pass `--cr-dir`, so the docstring's stated rationale was invalidated by the same diff. Class docstring rewritten to describe the per-verdict short-circuit semantics this class actually pins.
- `test_unreadable_coverage_plan_initial_blocks` now actually exercises its stated contract. v2.28.0 removed the explicit-path fallback from `cmd_verify_coverage`, but the test still wrote a standalone `coverage_plan.json` and asserted BLOCKING — passing vacuously because the absence of `coverage.json.final` (not `.initial`) also triggers BLOCKING with `check: input`. The test now seeds `coverage.json.final` via `_write_coverage_section`, omits `.initial`, and asserts the violation message names the `initial` section so the regression named in the title is the regression the test actually catches.
- Inline comment on `test_malformed_verify_section_treated_as_pass` no longer claims `isinstance(doc, dict)` is the gate that causes PASS. `_write_coverage_section(tmp_path, "verify", {})` writes a valid empty dict; the actual PASS-through path is `verdict = doc.get("verdict")` → `None` → `not isinstance(verdict, str)` → returns `(None, [])`. Comment rewritten to name the correct branch in `_normalize_coverage_verify_doc`.
- "legacy tag mapping" inline comment in `cmd_verdict` test renamed to "legacy string mapping (CHANGES_REQUESTED → 'decline')". v2.28.0 deleted the `<pr_verdict>` XML tag and the `tag` field; the assertion checks `_CANONICAL_TO_LEGACY_VERDICT` output, which is a string mapping, not a tag.
- Trailing newlines restored on `github_pr42_all_flags.json` and `local_no_pr_empty_flags.json`. v2.28.0's regeneration step dropped them; POSIX text-file convention requires them and the missing newline created permanent diff-noise on every future regeneration.

### code-review v2.28.0

Evidence-based audit of every backward-compat / legacy surface in the plugin. Each surface was kept only if grep found a real external consumer; everything else was deleted. MINOR bump (not PATCH) because the helper CLI surface contracts change: subcommand removal, flag rename, and verdict-artifact field set — consistent with prior monorepo precedent for similar consolidation work (v2.25.0 / v2.26.0 / v2.27.0).

#### Removed
- `cmd_migrate_critic_gates` subcommand and its 4 args (`--input`, `--output`, `--in-place`, `--dry-run`) plus mutex-group config. No grep hits anywhere for `migrate-critic-gates` invocation outside the function's own definition. The `migrate_legacy_module_critics` helper that does the actual `moduleCritics[]` → `coverage[]` migration is retained because it's called from `cmd_resolve_coverage` (the bootstrap-plugin cross-plugin contract still produces `moduleCritics[]`).
- `<pr_verdict>` XML tag and the `tag` field from `verdict.json`. Grep finds zero consumers of the XML tag anywhere in the monorepo. The `verdict.json` JSON `.verdict` field IS consumed by `plugins/code/scripts/run-loop.sh:987` (which keys on the legacy `"approve"` / `"needs_attention"` / `"decline"` strings); the `_CANONICAL_TO_LEGACY_VERDICT` mapping is retained for that.
- 10 explicit-path "backward-compat fallback" CLI args that `stages.json` never passes (verified by grep): `coverage-critic-prepare --coverage-plan-initial`; `coverage-critic-consolidate --coverage-plan-initial` + `--manifest`; `verify-coverage --coverage-plan` + `--coverage-plan-initial`; `arbitrate-budget --coverage-plan` + `--coverage-verify` + `--output`; `derive-spawn-spec --coverage-plan` + `--route`. All canonical callers use `--cr-dir` and the section-based read/write paths.
- `_read_coverage_verify_verdict` helper — only used by the deleted `arbitrate-budget --coverage-verify` arg path.
- `discarded_line_not_changed: 0` validate-stats key. Grep finds zero readers outside the writer itself; superseded by `discarded_out_of_hunk_low_confidence`.
- `partitions.json` bare-list shape acceptance in `cmd_derive_spawn_spec`. `cmd_partition` always emits the wrapped form `{"partitions": [...], "partition_count": ...}`; only test fixtures used the bare list.
- `partitions.json` without `partition_count` fallback in `cmd_verify_prepare`. `cmd_partition` always emits `partition_count`; cache-replay scenarios were the only source of older shapes and caches turn over.
- The `[DEPRECATED]` warning-text prefix on migrated `moduleCritics[]` entries; warning text is now plain prose.

#### Changed
- Renamed `--validate-output` flag to `--findings-validated` on `cmd_verdict` and `cmd_finalize_result`. The flag was misnamed — `stages.json` has always passed `{cr_dir}/findings_validated.json` to it; the README/SCHEMA claim that `validate_output.json` was "still emitted alongside `review_result.json`" was documentation drift (no file by that name is ever written). README, SCHEMA.md, `github-review.md`, and `cli.json` updated to match reality.
- `cmd_arbitrate_budget` now requires `--cr-dir` (previously optional, but the only canonical caller passed it). Reads input plan from `coverage.json.final`, verifier verdict from `coverage.json.verify`, writes arbitrated plan back into `coverage.json.final`.
- `cmd_verify_coverage`, `cmd_coverage_critic_consolidate`, `cmd_coverage_critic_prepare`, `cmd_derive_spawn_spec` all simplified to single-path implementations reading from `coverage.json` / `spawn.json` sections.
- `<CR_DIR>/verdict.json` now contains `verdict` (legacy string for `run-loop.sh`), `canonical_verdict` (envelope verdict), and `reason` — no longer the `tag` field.
- Updated `SCHEMA.md`, `README.md`, `commands/start.md` to describe current behavior. Removed the false `validate_output.json` dual-emission claim. Reframed the `<pr_verdict>` table entry as `verdict.json`. Rewrote the Repo Hygiene "alias for Hygiene" schema comment (it's the canonical category for repo-level findings, not an alias). Rewrote the `normalize_legacy_finding` section header from "Normalization: legacy -> canonical" to describe what the function actually does (fills canonical fields on partially-shaped findings from non-canonical producers).

#### Tests
- Deleted `TestMigrateCriticGatesCLI` (10 tests) and `TestPR124MigrationIdempotent` (2 tests) — both exercised the removed subcommand.
- Deleted `test_no_coverage_verify_flag_keeps_backward_compat` and `test_mutex_group_accepts_single_choice` + `test_mutex_group_rejects_both_choices` — exercised removed args.
- Refactored `_run_arbitrate_budget` (helper), `_write_coverage_critic_inputs` (helper), `_run_derive_spawn_spec` (helper), `TestPLN725Phase6VerifyCoverageCommand._run` (helper), and `TestCoverageCriticConsolidateCLI._prepare` / `_consolidate_args` to seed inputs into canonical sections instead of standalone files.
- Updated `TestMigrateLegacyModuleCritics` and `TestResolveCoverage` to assert on the new warning text (no `[DEPRECATED]` prefix).
- Regenerated all three snapshot fixtures (`cli_parser_resolved.json`, `local_no_pr_empty_flags.json`, `github_pr42_all_flags.json`) to reflect the smaller arg surface.
- Deleted `TestPR124MutuallyExclusiveDestArgs` — exercised the deleted `migrate-critic-gates` subcommand's mutex contract; the test now passes only because argparse rejects an unknown command, not because mutex routing works.

#### Docs (review fixes from PR #142)
- `commands/start.md` "PR Verdict" section now describes the current `verdict.json` field set (`verdict` / `canonical_verdict` / `reason`) instead of telling the walker to print a `tag` value. The `tag` field was removed; printing a final-line tag was a no-op contract that would have surfaced as a broken UI banner.
- `prompts/github-review.md` GitHub Summary "Discarded — line not changed" stat replaced with "Discarded — out-of-hunk (low confidence)" reading `discarded_out_of_hunk_low_confidence`. The original `discarded_line_not_changed` field was deleted in this PR.
- `code_review_helpers.py` PLN-725 component-list comment no longer enumerates `migrate-critic-gates` as a subcommand. The inline `migrate_legacy_module_critics` helper is called out instead.
- Stale docstring fallbacks on `cmd_coverage_critic_prepare`, `cmd_verify_coverage`, and `cmd_derive_spawn_spec` no longer advertise removed `--coverage-plan-initial` / `--coverage-plan` / `--route` paths.

### code-review v2.27.6

#### Fixed
- `evaluate_validation_gate` is now reachable from the walker. v2.27.5 advertised that the walker "shells into" the gate enforcer but shipped only the Python helper — no `evaluate-gate` subcommand existed in `cli.json` and `start.md` step 7 didn't reference any helper invocation, so the implementation was test-only. v2.27.6 ships the `cmd_evaluate_gate` CLI wrapper, registers `evaluate-gate` in `cli.json`, and rewrites `start.md` step 7 to instruct the walker to invoke `python3 <HELPERS> evaluate-gate --cr-dir <CR_DIR> --after-stage <stage_id>` after every stage. The exit code is the gate verdict; the walker reads `on_failure_action` from `run_plan.json` and applies it.
- `evaluate_validation_gate` and `start.md` step 7 now both explicitly document the dict-value requirement on section keys (not just key presence). v2.27.5's prose said the walker should "assert every listed section key is present as a top-level dict key," but the implementation also rejected non-dict values to catch corrupt-atomic-write scenarios where a section is mid-replace written as `null`. With the walker now shelling into the helper the two are aligned by construction, and the prose contract makes the dict-value check explicit for any future Python-side caller.
- `evaluate_validation_gate` rejects gate definitions where `required_sections[file]` is a bare string instead of a list. Without the type guard the inner `for key in section_keys` loop silently iterated per-character (`"final"` → `['f', 'i', 'n', 'a', 'l']`) and surfaced as `"missing required section 'f'"`. The new guard names the bad type so the operator can fix the gate spec.
- Test docstring `test_glob_outputs_are_not_treated_as_literal_paths` now reads "erroneously fails" (was "erroneously passes"). The skip prevents an erroneous *failure*: without it, `Path("agent_*.json").is_file()` returns False on every real filesystem and the gate would always fail; the skip lets the call trivially pass since glob enforcement is delegated to the spawn-spec roster check.

### code-review v2.27.5

Four production bugs in the CRS Phase A walker, the coverage-resolver wiring, the validation-gate contract, and the BLOCKING-verdict arbitration path. None of these had test coverage that exercised the production codepath end-to-end; each is now pinned by a focused regression test.

#### Fixed
- `/start staged` no longer dies at the first stage. The Phase 4b walker rewrite (PR #107) dropped the `--flag=value` form for scope args; staged reviews resolve `DIFF_SCOPE` to `--cached`, which space-separated argparse interpreted as an unknown option (`--scope: expected one argument`) and aborted `stage_05_parse_diff`. The four scope-consuming stages (`parse-diff`, `extract-patches`, `auto-incremental`, `partition`) now emit the joined form so leading-dash scope values bind unambiguously. Restores the v1.5.5 fix.
- `stage_14_resolve_coverage` now wires `--critic-gates .closedloop-ai/settings/critic-gates.json` into its args. Pre-fix, `cmd_resolve_coverage` silently fell back to `_EMPTY_CRITIC_GATES` when the arg was absent (no error, no warning), so every production run ignored configured `coverage[]` rules and migrated `moduleCritics[]` entries. Only the core reviewer floor routed.
- Validation gates now enforce `required_sections`. The field was declared on the `stage_16_arbitrate_budget` gate in v2.27.1 but the walker contract in `start.md` only checked `outputs` existence — so the stage-16 gate fired-true on `coverage.json` from stage_14 even when stages 15/15b/15c/16 all failed to populate `.final`. New `evaluate_validation_gate` helper plus the `evaluate-gate` CLI subcommand (`cmd_evaluate_gate`) make the contract deterministic and testable; `start.md` step 7 now instructs the walker to shell out to `python3 <HELPERS> evaluate-gate --cr-dir <CR_DIR> --after-stage <stage_id>` after every stage, so the markdown spec and the Python implementation cannot drift.
- BLOCKING verify verdict no longer drops BHA. `cmd_arbitrate_budget` hardcoded `budget.bha_partitions: 0` on the BLOCKING short-circuit, which propagated through `bha_partitions_cap` in `derive-spawn-spec` and skipped every BHA partition with `reason: budget_capped` — contradicting the start.md contract that BLOCKING preserves core reviewers and only annotates. BHA is `source: "core"` and survives derive-spawn-spec's plan sanitization; the BLOCKING path now computes BHA with the same floor-honoring formula as the PASS path. Docs-only PRs still get 0 (the BHA floor is waived on both paths).

Evidence-based audit of every backward-compat / legacy surface in the plugin. Each surface was kept only if grep found a real external consumer; everything else was deleted. MINOR bump (not PATCH) because the helper CLI surface contracts change: subcommand removal, flag rename, and verdict-artifact field set — consistent with prior monorepo precedent for similar consolidation work (v2.25.0 / v2.26.0 / v2.27.0).

#### Removed
- `cmd_migrate_critic_gates` subcommand and its 4 args (`--input`, `--output`, `--in-place`, `--dry-run`) plus mutex-group config. No grep hits anywhere for `migrate-critic-gates` invocation outside the function's own definition. The `migrate_legacy_module_critics` helper that does the actual `moduleCritics[]` → `coverage[]` migration is retained because it's called from `cmd_resolve_coverage` (the bootstrap-plugin cross-plugin contract still produces `moduleCritics[]`).
- `<pr_verdict>` XML tag and the `tag` field from `verdict.json`. Grep finds zero consumers of the XML tag anywhere in the monorepo. The `verdict.json` JSON `.verdict` field IS consumed by `plugins/code/scripts/run-loop.sh:987` (which keys on the legacy `"approve"` / `"needs_attention"` / `"decline"` strings); the `_CANONICAL_TO_LEGACY_VERDICT` mapping is retained for that.
- 10 explicit-path "backward-compat fallback" CLI args that `stages.json` never passes (verified by grep): `coverage-critic-prepare --coverage-plan-initial`; `coverage-critic-consolidate --coverage-plan-initial` + `--manifest`; `verify-coverage --coverage-plan` + `--coverage-plan-initial`; `arbitrate-budget --coverage-plan` + `--coverage-verify` + `--output`; `derive-spawn-spec --coverage-plan` + `--route`. All canonical callers use `--cr-dir` and the section-based read/write paths.
- `_read_coverage_verify_verdict` helper — only used by the deleted `arbitrate-budget --coverage-verify` arg path.
- `discarded_line_not_changed: 0` validate-stats key. Grep finds zero readers outside the writer itself; superseded by `discarded_out_of_hunk_low_confidence`.
- `partitions.json` bare-list shape acceptance in `cmd_derive_spawn_spec`. `cmd_partition` always emits the wrapped form `{"partitions": [...], "partition_count": ...}`; only test fixtures used the bare list.
- `partitions.json` without `partition_count` fallback in `cmd_verify_prepare`. `cmd_partition` always emits `partition_count`; cache-replay scenarios were the only source of older shapes and caches turn over.
- The `[DEPRECATED]` warning-text prefix on migrated `moduleCritics[]` entries; warning text is now plain prose.

#### Changed
- Renamed `--validate-output` flag to `--findings-validated` on `cmd_verdict` and `cmd_finalize_result`. The flag was misnamed — `stages.json` has always passed `{cr_dir}/findings_validated.json` to it; the README/SCHEMA claim that `validate_output.json` was "still emitted alongside `review_result.json`" was documentation drift (no file by that name is ever written). README, SCHEMA.md, `github-review.md`, and `cli.json` updated to match reality.
- `cmd_arbitrate_budget` now requires `--cr-dir` (previously optional, but the only canonical caller passed it). Reads input plan from `coverage.json.final`, verifier verdict from `coverage.json.verify`, writes arbitrated plan back into `coverage.json.final`.
- `cmd_verify_coverage`, `cmd_coverage_critic_consolidate`, `cmd_coverage_critic_prepare`, `cmd_derive_spawn_spec` all simplified to single-path implementations reading from `coverage.json` / `spawn.json` sections.
- `<CR_DIR>/verdict.json` now contains `verdict` (legacy string for `run-loop.sh`), `canonical_verdict` (envelope verdict), and `reason` — no longer the `tag` field.
- Updated `SCHEMA.md`, `README.md`, `commands/start.md` to describe current behavior. Removed the false `validate_output.json` dual-emission claim. Reframed the `<pr_verdict>` table entry as `verdict.json`. Rewrote the Repo Hygiene "alias for Hygiene" schema comment (it's the canonical category for repo-level findings, not an alias). Rewrote the `normalize_legacy_finding` section header from "Normalization: legacy -> canonical" to describe what the function actually does (fills canonical fields on partially-shaped findings from non-canonical producers).

#### Tests
- Deleted `TestMigrateCriticGatesCLI` (10 tests) and `TestPR124MigrationIdempotent` (2 tests) — both exercised the removed subcommand.
- Deleted `test_no_coverage_verify_flag_keeps_backward_compat` and `test_mutex_group_accepts_single_choice` + `test_mutex_group_rejects_both_choices` — exercised removed args.
- Refactored `_run_arbitrate_budget` (helper), `_write_coverage_critic_inputs` (helper), `_run_derive_spawn_spec` (helper), `TestPLN725Phase6VerifyCoverageCommand._run` (helper), and `TestCoverageCriticConsolidateCLI._prepare` / `_consolidate_args` to seed inputs into canonical sections instead of standalone files.
- Updated `TestMigrateLegacyModuleCritics` and `TestResolveCoverage` to assert on the new warning text (no `[DEPRECATED]` prefix).
- Regenerated all three snapshot fixtures (`cli_parser_resolved.json`, `local_no_pr_empty_flags.json`, `github_pr42_all_flags.json`) to reflect the smaller arg surface.
- Deleted `TestPR124MutuallyExclusiveDestArgs` — exercised the deleted `migrate-critic-gates` subcommand's mutex contract; the test now passes only because argparse rejects an unknown command, not because mutex routing works.

#### Docs (review fixes from PR #142)
- `commands/start.md` "PR Verdict" section now describes the current `verdict.json` field set (`verdict` / `canonical_verdict` / `reason`) instead of telling the walker to print a `tag` value. The `tag` field was removed; printing a final-line tag was a no-op contract that would have surfaced as a broken UI banner.
- `prompts/github-review.md` GitHub Summary "Discarded — line not changed" stat replaced with "Discarded — out-of-hunk (low confidence)" reading `discarded_out_of_hunk_low_confidence`. The original `discarded_line_not_changed` field was deleted in this PR.
- `code_review_helpers.py` PLN-725 component-list comment no longer enumerates `migrate-critic-gates` as a subcommand. The inline `migrate_legacy_module_critics` helper is called out instead.
- Stale docstring fallbacks on `cmd_coverage_critic_prepare`, `cmd_verify_coverage`, and `cmd_derive_spawn_spec` no longer advertise removed `--coverage-plan-initial` / `--coverage-plan` / `--route` paths.

1051 tests pass, ruff clean, pyright 0 errors / 0 warnings / 0 informations.

### code-review v2.27.4

#### Fixed
- `README.md` Override Flow section lead-in now reads "two flags" (was "three"). v2.27.2 removed the `--no-verify` row from the table but left the count stale, so the operator docs disagreed with the table beneath them.

### code-review v2.27.3

#### Fixed
- `_run_verify_consolidate` test helper docstring no longer carries PR #114 historical-framing prose; trimmed to a single-line summary to match its sibling `_run_verify_prepare`, which was already cleaned in v2.27.2.
- `TestCRSPhaseACLIConfigLoader` class docstring now reports `196 args` (down from a stale `199 args`) so the calibration anchor for `cli_parser_resolved.json` audits matches the regenerated fixture.
- `cli_parser_resolved.json` snapshot fixture now ends with a trailing newline, matching POSIX convention so future regenerations diff cleanly.

#### Changed
- `cmd_parse_diff` no longer carries a dead `include_patch_lines` local variable. After v2.27.2 hardcoded the value to `True`, the `if include_patch_lines:` guard at line 510 and the two parameter pass-throughs at lines 494/501 were no-op constant references. The local is gone; `_parse_u0_output` is called with `True` inline and `result["patch_lines"]` is unconditionally populated. `_parse_u0_output` retains its `include_patch_lines` parameter for the internal API exercise covered by `test_include_patch_lines_false`.
- Renamed test `test_no_patch_lines_flag` → `test_include_patch_lines_false`. The flag was removed in v2.27.2; the test still exercises the `_parse_u0_output(..., include_patch_lines=False)` internal API path, but its name no longer references the dead CLI flag.

### code-review v2.27.2

#### Changed
- Stripped historical-framing prose from `start.md`, `code_review_helpers.py`, `code_review_schema.py`, `SCHEMA.md`, and `README.md`. Stage descriptions, docstrings, and inline comments no longer carry phase labels (`Phase A/B/C/D`), version-tagged "as of" markers, or `pre-vN.M.K` references to prior behavior. The text now describes the code as it stands; legitimate backward-compatibility shims (e.g. `--coverage-plan-initial`, `--manifest`, `--coverage-plan`, `--route`, `validate_output.json` dual-emission, `<pr_verdict>` tag, migrated `moduleCritics[]` entries) are framed as such instead of as "legacy". Reduces every agent invocation's prompt budget by the size of the historical framing it previously carried.

#### Removed
- Deleted unwired `--no-verify` / `--no-verify-reason` flags from `cli.json` plus all references in `cmd_verify_prepare`, the verify manifest, presenter audit banners (`github-review.md`, `present-local/SKILL.md`), the operator-flag README table, and the `pending_verification.md` template. The PLN-773 emergency-bypass pair was defined in `cli.json` and parsed by `cmd_verify_prepare` but never plumbed through `stages.json` — no orchestration path could invoke it. If the bypass is needed in the future it can be re-added with proper stages.json wiring.
- Deleted unwired `--no-patch-lines` flag from `cli.json` plus the dead `args.no_patch_lines` reference in `cmd_parse_diff`. The flag was never passed by any stage.
- Test class `TestNoVerifyBypass` (3 tests) and the `no_verify`/`no_verify_reason` kwargs on the `_run_verify_prepare` shared helper.

#### Fixed
- Regenerated `cli_parser_resolved.json` snapshot fixture to reflect the removed `--no-verify`, `--no-verify-reason`, and `--no-patch-lines` flags. All 1061 tests pass.

### code-review v2.27.1

#### Fixed
- Partial-write window in `_emit_skipped_coverage_plan` and `cmd_coverage_critic_prepare` cache-hit path. Pre-fix, both paths called `_write_coverage_section` twice in sequence (`.final` then `.critic`); an `OSError` on the second write would leave `coverage.json` with an updated `.final` section and a stale `.critic` section, and the next stage's consumer (consolidate's cache-hit / skipped no-op) would see a contradiction. New `_write_coverage_sections` (plural) atomic batched variant merges every update into one `tmp + os.replace`, so either both sections land or neither does.
- `coverage_plan_well_formed` validation gate at `stage_16_arbitrate_budget` no longer fires vacuously. Pre-fix, the gate's `outputs: ["<CR_DIR>/coverage.json"]` would pass-true as soon as `stage_14_resolve_coverage` ran (the aggregate exists from stage_14 onward), masking failures in stages 15/15b/15c/16 that should populate the `.final` section. The gate now declares `required_sections: {"<CR_DIR>/coverage.json": ["final"]}` so any enforcer can distinguish "any coverage state on disk" from "post-arbitrate `final` plan present."
- Stale docstrings still naming `coverage_plan.json`: `_write_cached_coverage_critic` (fail-open rationale), `merge_critic_additions` (purpose), the `derive-spawn-spec` block comment and section preamble (`_SPAWN_CORE_ROLES` mapping doc), and `cmd_derive_spawn_spec` (reads/writes line). All now reference `coverage.json.final` directly.

#### Changed
- `_read_spawn_state` / `_write_spawn_section` and `_read_coverage_state` / `_write_coverage_section` now delegate to shared `_read_state_aggregate` / `_write_state_sections` helpers. Pre-fix, the spawn and coverage helper pairs duplicated ~30 lines of identical atomic-write logic differing only in filename and section vocabulary. The shared helpers accept any state-aggregate filename whose section vocabulary is registered in `_STATE_SECTION_VOCAB`; the four named wrappers remain as thin call-site sugar so consumers read as `_write_coverage_section(cr_dir, "final", payload)` rather than threading the filename through every call.
- Test helper `_read_coverage_section` now delegates to the production `_read_coverage_state` helper instead of duplicating the parse-and-coerce logic. Pre-fix, the test helper silently re-raised on malformed JSON while its sibling `_coverage_section_present` swallowed the same error — an inconsistency that would let a flaky-fixture test pass under one helper and fail under the other. Both helpers now share the production read path.

#### Added
- `TestStateAggregateHelpers` — eight direct unit tests for the shared `_read_state_aggregate` / `_write_state_sections` contract: missing-file → `{}`, non-dict → `{}`, unknown-section rejection, unknown-filename rejection, single-section preservation, multi-section atomic write, partial-rejection of mixed-valid-and-invalid batched updates (no speculative write), and named-wrapper routing. Plus `TestValidationGatesCoverageFinalRequired` pinning the `required_sections` field on the `coverage_plan_well_formed` gate so a future refactor that drops it regresses loudly.
- `TestCoverageCriticPrepareCrDirDefault` (3 tests), `TestVerifyCoverageCrDirDefault` (3 tests), and `TestArbitrateBudgetCrDirDefault` (3 tests) — pin the Phase C `--cr-dir` default path for each of the three cmds whose existing test classes only exercised the legacy `--coverage-plan-initial` / `--coverage-plan` / `--coverage-verify` explicit-path fallbacks. Each class covers the canonical happy-path read-from-section behavior plus the missing-section degradation (BLOCKING on missing `.final` or `.initial` for verify-coverage; exit 1 on missing `.initial` for prepare; BLOCKING short-circuit propagation from `.verify` for arbitrate-budget).

### code-review v2.27.0

#### Changed
- Coverage decision artifacts consolidated. The pre-v2.27.0 pipeline produced four separate JSON files in `<CR_DIR>` to describe the deterministic-coverage decision: `coverage_plan_initial.json` (rule-resolved pre-critic plan, written by `stage_14_resolve_coverage`), `coverage_critic_manifest.json` (prep manifest with `status: cache_hit | skipped | needs_agent`, written by `stage_15_coverage_critic`), `coverage_plan.json` (post-consolidate plan, written by `stage_15b_coverage_critic_consolidate`, mutated in place by `stage_16_arbitrate_budget`), and `coverage_verify.json` (verifier verdict, written by `stage_15c_verify_coverage`). All four are now sections of a single `coverage.json`: `state["initial"]`, `state["critic"]`, `state["final"]`, `state["verify"]`. The downstream consumers (`cmd_arbitrate_budget`, `cmd_derive_spawn_spec`, `cmd_finalize_result`) read one file with section lookups instead of opening four separate paths. Net: 4 wire-format artifacts → 1.
- New `_read_coverage_state` and `_write_coverage_section` helpers in `code_review_helpers.py`, mirroring the Phase D `_read_spawn_state` / `_write_spawn_section` pattern. The section writer uses atomic read-modify-write (tmp + `os.replace`) so a crash mid-write leaves the prior state intact rather than a half-written file. Each of the four stages writes its own section without clobbering the others — `cmd_resolve_coverage` updates `.initial`, `cmd_coverage_critic_prepare` updates `.critic` (and `.final` on cache_hit/skipped paths), `cmd_coverage_critic_consolidate` updates `.final`, `cmd_verify_coverage` updates `.verify`, `cmd_arbitrate_budget` mutates `.final` in place. `_COVERAGE_STATE_SECTIONS` is a frozenset closed-vocabulary check; passing an unknown section name raises `ValueError` at the call site rather than silently scribbling a typo into the aggregate.
- `cmd_resolve_coverage` writes the initial plan into `coverage.json.initial` via atomic section update. The stdout summary's `output_path` field is replaced with `coverage_state` (the path to the aggregate file) since the artifact target is no longer a unique standalone path.
- `cmd_coverage_critic_prepare` reads the initial plan from `coverage.json.initial` by default (the legacy `--coverage-plan-initial` explicit-path arg is still accepted as a fallback for callers that haven't switched). Writes the prep manifest into `coverage.json.critic`. On cache-hit, also writes the cached final plan into `coverage.json.final`. On `--no-critic` / `no-roster` / `no-candidates` skip paths, writes the initial plan straight through into `coverage.json.final` via `_emit_skipped_coverage_plan` (refactored to take `cr_dir` instead of separate output/manifest paths). The LLM-input artifacts (`coverage_critic_input.json` + diff summary) stay standalone — they're large single-consumer prompt material that doesn't fit the atomic-section aggregate.
- `cmd_coverage_critic_consolidate` reads the initial plan from `coverage.json.initial` and the manifest from `coverage.json.critic` by default (legacy `--coverage-plan-initial` / `--manifest` args remain accepted). Writes the merged plan into `coverage.json.final`. The cache-hit / skipped no-op now checks `coverage.json.final` presence directly instead of `coverage_plan.json.exists()`.
- `cmd_verify_coverage` reads both plans from `coverage.json` (`.final` and `.initial` sections) by default. Writes the verdict into `coverage.json.verify`. The `--coverage-plan` / `--coverage-plan-initial` args remain accepted as legacy explicit-path overrides; `--output` is removed (the canonical target is always the `verify` section). The missing-input BLOCKING semantics (v2.20.1) carry over — a missing section produces the same `input` check as a missing file did in earlier releases.
- `cmd_arbitrate_budget` reads the input plan from `coverage.json.final` and the verifier verdict from `coverage.json.verify` when `--cr-dir` is supplied; otherwise falls back to the legacy `--coverage-plan` / `--coverage-verify` explicit paths. Writes the arbitrated plan back into the same `.final` section (in-place mutation, mirroring the pre-Phase-C in-place overwrite of `coverage_plan.json`). `coverage_gaps.json` stays standalone — multi-writer append semantics don't fit the atomic-section pattern. New `_normalize_coverage_verify_doc` helper extracted from `_read_coverage_verify_verdict` so the section reader and the legacy file reader share the verdict-shape coercion.
- `cmd_derive_spawn_spec` reads the post-arbitrate plan from `coverage.json.final` by default; `--coverage-plan` becomes optional (legacy fallback). `cmd_finalize_result` reads `coverage.json.final` directly via `_read_coverage_state`.
- `stages.json`: stage_14, stage_15, stage_15b, stage_15c, stage_16, stage_19b updated. The legacy `--coverage-plan-initial` / `--coverage-plan` / `--manifest` / `--coverage-verify` / `--output` args are dropped from production stage args (defaults read/write `coverage.json` sections via `--cr-dir`). `expected_outputs` for each stage points at `<CR_DIR>/coverage.json`. The validation gate's `coverage_plan_well_formed` rule (in `code_review_helpers.py`'s `_build_validation_gates`) now checks `<CR_DIR>/coverage.json` instead of `<CR_DIR>/coverage_plan.json`.
- `cli.json`: help strings for `resolve-coverage`, `coverage-critic-prepare`, `coverage-critic-consolidate`, `verify-coverage`, `arbitrate-budget`, `derive-spawn-spec` updated to describe the section shape. The legacy `--coverage-plan-initial` / `--coverage-plan` / `--manifest` / `--coverage-verify` args are marked optional with help text explaining they remain as legacy fallbacks. `arbitrate-budget` gains a `--cr-dir` arg for the canonical Phase C entry point; `verify-coverage --output` is dropped.
- `start.md` stage notes (stage_14 / stage_15 / stage_15b / stage_15c / stage_16 / stage_19b) updated to reference `coverage.json` sections. The PLN-725 Single-Agent Dispatch protocol's manifest-path table now points operators at `<CR_DIR>/coverage.json` (`critic` section) for stage_15; the cache_hit / skipped status descriptions reference `coverage.json.final` instead of `coverage_plan.json`. The Section header at line 763 ("When to dispatch") similarly references the section.
- `SCHEMA.md` §6 stage-outputs table rows 14, 15, 15c, and 16 reference the `coverage.json` sections instead of standalone filenames. §6b's spawn-spec input reference updated from `coverage_plan.json` to `coverage.json.final`.

#### Added
- Existing coverage-critic prepare, consolidate, verify-coverage, arbitrate-budget, and stage-graph tests (~70 tests across `TestResolveCoverageCLI`, `TestPR124CmdResolveCoverageHandlesWriteFailure`, `TestCoverageCriticPrepareCLI`, `TestCoverageCriticConsolidateCLI`, `TestCoverageCriticConsolidateCacheHitAndSkippedNoOp`, `TestPLN725Phase6VerifyCoverageCommand`, `TestStage15Alignment`, `TestPLN725Phase4StageGraph`, `TestPLN725Phase6StageGraph`, `TestPrepareRun`) updated to seed `coverage.json` with `initial` / `critic` / `final` / `verify` sections via the new `_read_coverage_section` / `_coverage_section_present` test helpers and the production `_write_coverage_section` cmd-side helper. The Phase C stage-graph tests assert `coverage.json` in `expected_outputs` rather than per-stage standalone filenames. The disk-full regression test patches `_write_coverage_section` directly instead of monkey-patching `open` against the legacy filename.
- `run_plan_snapshots/cli_parser_resolved.json` regenerated (coverage-related args become optional, `arbitrate-budget` gains `--cr-dir`, `verify-coverage` loses `--output`). `run_plan_snapshots/local_no_pr_empty_flags.json` and `github_pr42_all_flags.json` regenerated (stages 14/15/15b/15c/16 expected_outputs and args updated).

### code-review v2.26.1

#### Fixed
- Phase D docstring/comment trailing cleanup. The v2.26.0 consolidation rewrote the code paths but missed several adjacent docstrings, block comments, and operator-facing prose that still named the pre-Phase-D standalone artifacts. Concretely: `cmd_derive_spawn_spec`, `cmd_verify_spawn`, and `cmd_render_fleet_summary` docstrings now reference `spawn.json` sections (`.route` / `.spec` / `.verification`) instead of standalone `route.json` / `spawn_spec.json` / `spawn_verification.json` filenames; the `derive-spawn-spec` section header block comment and `_spawn_resolve_models` / `_spawn_bha_model` helper docstrings track the same rename; `start.md`'s `stage_19b` and `stage_20` notes, the static-table fallback paragraph, and the `stage_16` note's Phase 8 reference all point at the consolidated file; `cli.json` help strings for `derive-spawn-spec`, `verify-spawn`, and `render-fleet-summary` describe the section shape; `code_review_schema.py`'s Phase 8 reviewer-spawn-spec preamble notes the consolidation; affected test class and method docstrings (`TestPLN725Phase8DeriveSpawnSpec`, `TestPLN725Phase8VerifySpawn`, `TestPLN725Phase9ModelRoutingFromSpec`, plus several individual `test_*` docstrings under `TestPLN725Phase9RenderFleetSummary*`) match current behavior.
- `cmd_route` docstring no longer claims stdout is suppressed when `--cr-dir` is supplied. The implementation always emits the routing block to stdout (the legacy `helpers route ... > route.json` shell idiom still works for callers that haven't switched); the pre-fix docstring read "the routing block is also emitted to stdout when `--cr-dir` is omitted," which a developer would reasonably interpret as "stdout is suppressed when `--cr-dir` is set." Now states the unconditional behavior directly.
- `_write_spawn_section` no longer accepts `payload=None`. The pre-fix signature had `payload: dict[str, Any] | None` with a docstring describing a "clear a section" use case driven by `cmd_verify_spawn`'s no-op paths, but no caller ever passes `None` — every path writes a populated dict. Type tightened to `dict[str, Any]` and the docstring trimmed accordingly.

#### Added
- `TestCmdRouteCrDir` — three regression tests pinning the canonical Phase D production path (`cmd_route --cr-dir`) that had zero coverage in v2.26.0. `test_writes_route_section_to_spawn_json` asserts the `.route` section materializes with the canonical key set; `test_stdout_still_emits_with_cr_dir` asserts the legacy stdout summary still fires unconditionally; `test_preserves_existing_sections` seeds a stale `.spec` section before running the cmd and confirms it survives the route write, exercising the atomic read-modify-write contract that the three-stage Phase D pipeline depends on.

### code-review v2.26.0

#### Changed
- Spawn decision artifacts consolidated. The pre-v2.26.0 pipeline produced three separate JSON files in `<CR_DIR>` to describe the reviewer fleet: `route.json` (model routing decision + fast-path flag, written by Gate B's `cmd_route`), `spawn_spec.json` (flat agent descriptor list, written by `stage_19b_derive_spawn_spec`), and `spawn_verification.json` (runtime tally, written by `stage_20b_verify_spawn`). All three are now sections of a single `spawn.json`: `state["route"]`, `state["spec"]`, and `state["verification"]`. The presenter (`cmd_render_fleet_summary`) reads one file with three section lookups instead of opening three separate paths. Net: 3 wire-format artifacts → 1.
- New `_read_spawn_state` and `_write_spawn_section` helpers in `code_review_helpers.py`. The section writer uses atomic read-modify-write (tmp + `os.replace`) so a crash mid-write leaves the prior state intact rather than a half-written file. Each of the three stages writes its own section without clobbering the others — `cmd_route` updates `.route`, `cmd_derive_spawn_spec` updates `.spec`, `cmd_verify_spawn` updates `.verification`. `_SPAWN_STATE_SECTIONS` is a frozenset closed-vocabulary check; passing an unknown section to `_write_spawn_section` raises `ValueError` at the call site rather than silently scribbling a typo into the aggregate.
- `cmd_route` gains a `--cr-dir` flag. When set, the routing block is written directly into `spawn.json.route` via atomic section update instead of streamed to stdout. The stdout summary still fires for operator visibility, but the canonical write target is no longer the orchestrator's shell-redirected stdout — eliminating the same race class fixed in v2.25.1 for `stage_14_resolve_coverage`. Without `--cr-dir` the cmd preserves the legacy `helpers route ... > route.json` shell idiom for callers (mostly tests) that haven't switched yet.
- `cmd_derive_spawn_spec` reads route from `spawn.json.route` by default and writes the spec into `spawn.json.spec`. The `--route` arg is now optional (legacy fallback for callers that pass an explicit route file); the `--output` arg is removed (the canonical target is always `<cr_dir>/spawn.json`). Stages.json's `stage_19b_derive_spawn_spec` entry drops the `--route` arg and updates `expected_outputs` from `spawn_spec.json` to `spawn.json`.
- `cmd_verify_spawn` reads spec from `spawn.json.spec` and writes verification into `spawn.json.verification`. The no-op paths (`spec_missing`, `spec_fallback`, `spec_empty`) still write a `verified: false` verification record — the section just lives inside `spawn.json` now. Stages.json's `stage_20b_verify_spawn` `expected_outputs` updates to `spawn.json`.
- `cmd_render_fleet_summary` reads `spawn.json` once and accesses `.route`, `.spec`, `.verification`. The degraded-output paths (no spec → "spawn-spec unavailable"; no verification → "runtime tally unavailable"; no route → omit Model Routing line) fire on the same shape — `state.get(section)` returning `None` is structurally indistinguishable from a missing file. Operator-facing strings that referenced `route.json` now point at `spawn.json.route` ("see `spawn.json.route`" instead of "see `route.json`").
- `start.md` Gate B updated to use `--cr-dir` instead of `> <CR_DIR>/route.json`; the orchestrator reads `<CR_DIR>/spawn.json.route` instead of opening `route.json`. The Reviewer Fleet section's spawn-spec consumption protocol references `<CR_DIR>/spawn.json` (spec section) instead of `spawn_spec.json`. Same for the Model Selection notes (BHA test-only routing, Premise model, Fast-path model, domain critics) which now reference `spawn.json.route` instead of `route.json`. `present-local` SKILL.md and `github-review.md` Step 8 reference the consolidated file in their renderer-input documentation.
- `SCHEMA.md` §6b (Reviewer spawn spec) and §6c (Spawn verification) updated to document the section-of-spawn.json shape instead of standalone files. The stage outputs table for rows 19b and 20b reflects the new artifact target.

#### Added
- Existing Phase 9 fleet-summary tests (`TestPLN725Phase9RenderFleetSummary*`, ~25 tests across happy-path / notes / fallbacks / output-contract / fast-path / model-routing / verify-spawn-scoping / malformed-telemetry classes) updated to seed `spawn.json` with `route` / `spec` / `verification` sections via the `_seed_phase9_inputs` helper instead of writing three separate files. The Phase 8 derive-spawn-spec and verify-spawn tests (~30 tests) updated to read the spec/verification sections from the consolidated file. The Phase 8 stage-graph tests assert `spawn.json` in `expected_outputs` rather than `spawn_spec.json` / `spawn_verification.json`.
- `run_plan_snapshots/cli_parser_resolved.json` regenerated (route gains `--cr-dir`, derive-spawn-spec loses `--output` and `--route` requiredness). `run_plan_snapshots/local_no_pr_empty_flags.json` and `github_pr42_all_flags.json` regenerated (stages 19b/20b expected_outputs updated, 19b args drop `--route`).

### code-review v2.25.2

#### Fixed
- `test_read_simple_cache_entry_returns_none_when_cache_dir_is_none` now seeds a valid, fresh cache entry on disk before asserting the read returns `None`. The pre-v2.25.2 test passed a `tmp_path / "anything.json"` that didn't exist, so both the `cache_dir is None` guard AND the `not path.exists()` guard fired together — a regression that dropped the `cache_dir is None` check would still pass the test because the file-missing branch would catch it. With a valid fresh entry on disk and `path.exists()` confirmed before the call, the assertion specifically pins the `cache_dir is None` short-circuit.
- `_write_cached_signals` and `_write_cached_coverage_critic` docstrings now restate the fail-open contract that the Phase B refactor (v2.25.0) collapsed into the shared `_write_simple_cache_entry`. Callers reading the wrapper docstring at the call site no longer have to chase the contract one indirection deeper; both wrappers now explicitly note that delegation to the shared helper preserves the OSError-logged-not-raised semantic, named alongside the canonical `<cr_dir>/<output>.json` that makes cache write failure a re-run cost issue rather than a pipeline halt.

### code-review v2.25.1

#### Fixed
- `stage_14_resolve_coverage` now has `stdout: null` in `config/stages.json`. The pre-v2.25.1 entry redirected stdout to `<cr_dir>/coverage_plan_initial.json` — the same path `cmd_resolve_coverage` writes the canonical plan to via `--cr-dir`. Two writers raced on the same file: the helper wrote the full plan, then the shell's `>` redirect overwrote the head with the 8-line summary, leaving trailing garbage from the longer plan. The next stage (`coverage-critic-prepare`) failed with `Extra data: line 9 column 6` when parsing the corrupted file. The bug class is the same one `start.md` already documents for setup ("Do NOT redirect setup's stdout..."); `stage_08_fetch_intent` also gets this treatment with explicit rationale. The bug predates the CRS refactor — it was carried over from the original `_build_run_plan_stages` Python literal into `config/stages.json` in v2.24.0 — but lives squarely in the run-plan config we now own.
- `stage_11_extract_signals`, `stage_15_coverage_critic`, and `stage_22b_verify_prepare` also have `stdout: null` now. Each uses `_write_and_emit_manifest` (introduced in v2.25.0), which writes the canonical manifest file directly AND prints the same manifest to stdout. With the stdout redirect active, the helper's file write and the shell-redirected stdout write produced the same bytes modulo trailing newline — so the file ended up correct by coincidence, not by design. A future edit that made one write differ from the other (different content, different `indent`, an added field on only one path) would have re-introduced the race. Removing the redirect makes the helper the sole writer for the canonical file across all four stages.

#### Added
- `TestRunPlanStdoutRedirectRaceClass` (2 tests) enforces the invariant: stages whose cmd writes the canonical output file directly via `--cr-dir` must have `stdout: null` in the run plan. The pinned list (`CMD_WRITES_OWN_FILE_STAGES`) is `stage_11_extract_signals`, `stage_14_resolve_coverage`, `stage_15_coverage_critic`, `stage_22b_verify_prepare`. `test_stage_08_fetch_intent_still_has_stdout_none` pins the canonical example for consistency. A future stage in the same class must be added to the list and given `stdout: null` simultaneously.

### code-review v2.25.0

#### Changed
- Five new shared helpers de-duplicate the boilerplate that the PLN-725 Phase 1 (`extract-signals`) and Phase 3 (`coverage-critic`) prepare/consolidate pairs replicated verbatim. The helpers are: `_read_manifest_dict` (manifest read with isinstance + fall-through to `{}` on any failure), `_emit_summary` (stdout-dump + newline + `return 0` triple collapsed to one call), `_read_agent_output_or_error` (JSON read returning `(value, None)` or `(None, error_msg)` so both consolidate paths route a read error into the fail-closed branch via the same diagnostic shape), `_write_and_emit_manifest` (manifest write + stdout dump that every prepare path did inline), and `_read_simple_cache_entry` + `_write_simple_cache_entry` (the `written_at`-stamped cache lifecycle that `_read_cached_signals` and `_read_cached_coverage_critic` previously implemented twice across ~115 lines). Behavior is preserved: manifest semantics, cache TTL with stale-entry sweep, fail-open cache writes, and stdout-summary shapes are byte-equivalent to v2.24.1.
- `_read_cached_signals` / `_write_cached_signals` / `_read_cached_coverage_critic` / `_write_cached_coverage_critic` are now thin wrappers (~10 LOC each) over the shared cache helpers. `_read_cached_verification` stays on its own implementation — the verifications namespace uses a different timestamp field (`cached_at` vs `written_at`), a payload envelope (`verdict_data` wrapped in a typed shell), and atomic tmp+rename writes, and forcing it into the same shape would have produced a wider interface than the savings justified.
- `cmd_extract_signals_consolidate` and `cmd_coverage_critic_consolidate` now share the same call-site structure: read manifest, cache-hit short-circuit, agent output read with error routing into a single `_fail_closed` closure, validate, write canonical, dump summary. The fail-closed read-error and validation-rejected branches in extract-signals previously duplicated the same `{status: fail_closed, signals: fail_closed_signal_set, errors, model, cache_key, ...}` build inline; both branches now route through a `_build_fail_closed_canonical` closure so the canonical shape lives in one place per cmd. Coverage-critic's existing `_fail_closed` closure pattern remains; the manifest read and stdout dumps now route through the shared helpers.
- `cmd_extract_signals_prepare`, `cmd_coverage_critic_prepare`, and `_emit_skipped_coverage_plan` route their manifest writes through `_write_and_emit_manifest`. Three writes-and-emits collapse from ~5 lines each (`with open(path, "w"): json.dump...; json.dump(sys.stdout); sys.stdout.write("\n"); return 0`) to a single helper call.

#### Added
- `TestCRSPhaseBSharedHelpers` (17 tests) covers the five new helpers' contracts at the unit level: `_read_manifest_dict` handles missing files, malformed JSON, non-dict roots, and valid dicts; `_emit_summary` returns 0 and emits indented JSON with a trailing newline; `_read_agent_output_or_error` covers success and the two read-error paths; `_write_and_emit_manifest` writes both the file and stdout; `_read_simple_cache_entry` covers `cache_dir=None`, missing path, missing/unparseable `written_at` (with stale-sweep), TTL-expired (with stale-sweep), and fresh-entry success; `_write_simple_cache_entry` covers `cache_dir=None` no-op, successful persistence with auto-stamped timestamp, and fail-open behavior on OSError (logs warning, does not raise). Future edits to any of the helpers fail the unit suite before the integration callers (extract-signals + coverage-critic) get hit.

#### Scope note
- The plan's original Phase B target ("collapse 4 prepare/consolidate pairs into a unified singleton-dispatch shape") was over-scoped. The 4 pairs split into 2 patterns, not 1: `extract-signals` + `coverage-critic` are singleton+cache (Pattern A; this PR's scope) while `verify` + `review-dismissed` are fleet-dispatch with per-finding inputs (Pattern B; no `cache_hit`/`needs_agent` manifest semantics). Forcing Pattern A and Pattern B into one shape would have produced a fat callback interface heavier than the duplication it removed. Verify and review-dismissed remain unchanged.

### code-review v2.24.1

#### Fixed
- `_build_run_plan_stages` now `copy.deepcopy`s each stage template instead of shallow-copying via `dict(template)`. The pre-v2.24.1 shallow copy left nested lists like `depends_on` and `agent_specs` aliased to the `@functools.lru_cache(maxsize=1)`'d `_load_stages_config()` result — a caller that did `stage["depends_on"].append(...)` on a returned stage would silently corrupt the cache for every subsequent call in the same process. The pre-refactor function (which built fresh list literals on every call) didn't have this hazard; the new test `test_returned_stage_lists_are_not_aliased_to_lru_cache` pins it by mutating a returned stage and confirming the next call is isolated.
- `_register_subparsers` now resolves `func` names through a static `_cli_cmd_registry()` (filters `globals()` for `cmd_*` callables) instead of doing a direct `globals()[parser_spec["func"]]` lookup. The previous lookup made every name in the module's namespace — imported modules, internal helpers, constants — reachable as a subcommand handler. The registry restricts resolution to the cmd_ convention, and a name not in the registry now raises a descriptive `ValueError(f"cli.json parser {name!r} references unknown command function {func_name!r}")` instead of escaping as an unhandled `KeyError` past `main()`'s narrow `except (CalledProcessError, JSONDecodeError, OSError)` clause.
- `_register_subparsers` now rejects `extra_defaults` dicts that contain a `func` key with a clear `ValueError`. Without this guard a malformed cli.json entry could override the parser-level `func` via `extra_defaults` and silently misroute a subcommand to a different handler.
- `_resolve_cli_constant` error message now reads `unknown CLI constant reference: $$NAME` (matching the encoding used in cli.json) instead of `${NAME}` (shell-variable syntax). The previous wording would have misled a developer debugging a cli.json typo about the actual `$$` prefix convention.

#### Added
- `_validate_stages_config` runs at load time inside the lru_cached loader and rejects template strings whose `{` braces aren't part of a known `{key}` pattern. The known key set lives in `_STAGES_TEMPLATE_KEYS` and includes `cr_dir`, `mode`, `schema_version`, and the four `flags_*` variants; `@pr_flag` is recognized as a splat marker rather than a template key. A future editor who introduces a literal `{` or `}` into a stages.json arg/expected_output/stdout, or who references an unknown `{token}`, now gets a clear `stages.json stage_id.field[index]: ...` diagnostic at first call instead of an opaque `KeyError`/`ValueError` from `str.format` deep in the loader.
- `tools/python/fixtures/run_plan_snapshots/cli_parser_resolved.json` captures the resolved CLI parser structure for all 44 subparsers (name, dest, default, type, choices, required, action, func, mutex groups) as a byte-equality baseline. `test_resolved_parser_spec_matches_snapshot` diffs the live loader output against it, catching the class of regression where a cli.json edit changes a default/type/choices/func value or misroutes a mutex member.
- `TestCRSPhaseACLIConfigLoader` (9 tests) covers the constant resolution (`$$DEFAULT_MAX_BHA_AGENTS`, `$$BUDGET_TOTAL_CAP_DEFAULT`, `$$CACHE_GC_TTL_DAYS_DEFAULT`, `$$CACHE_GC_MAX_PER_FILE_DEFAULT`, `$$_EXTRACT_PATCHES_BATCH_SIZE`, `$$COVERAGE_SCOPES_SORTED`), the mutex group success and failure paths (`migrate-critic-gates` with one destination vs both), the cmd_ allowlist (`_cli_cmd_registry` filters out imported modules and helper functions), the unknown-func error path, the func-in-extra_defaults rejection, and the `$$NAME` error wording.
- `TestCRSPhaseAStageTemplateValidator` (4 tests) covers the new load-time validator: unknown template key rejected, unbalanced braces rejected, known keys and `@pr_flag` accepted, and the diagnostic naming the stage id + field for fast editing.

### code-review v2.24.0

#### Changed
- The two largest config-as-code functions in `code_review_helpers.py` are now thin loaders over declarative JSON. `_build_run_plan_stages` (894 LOC) and `_register_subparsers` (706 LOC) collectively dropped from ~1,600 LOC of nested dict-and-`add_argument` literals to ~60 LOC of loader code; `code_review_helpers.py` shrinks by 1,431 LOC net. Stage definitions live at `tools/python/config/stages.json` (37 stages); CLI subparser definitions live at `tools/python/config/cli.json` (44 parsers, 199 args).
- Runtime behavior is preserved byte-for-byte. Template variables (`{cr_dir}`, `{mode}`, `{schema_version}`, `{flags_scope_args}`, `{flags_base_ref_override}`, `{flags_full_review}`, `{flags_since_last_review}`) and the `@pr_flag` splat marker are substituted by `_build_run_plan_stages` at call time. Angle-bracket walker tokens like `<CACHE_DIR>`, `<DIFF_TIP>`, `<PROMPT_HASH>` are passed through unchanged — they remain the orchestrator/walker's responsibility to resolve from prior-stage outputs.
- `$$NAME` references in `cli.json` resolve via `_resolve_cli_constant` to imported constants (`DEFAULT_MAX_BHA_AGENTS`, `BUDGET_TOTAL_CAP_DEFAULT`, `CACHE_GC_TTL_DAYS_DEFAULT`, `CACHE_GC_MAX_PER_FILE_DEFAULT`, `_EXTRACT_PATCHES_BATCH_SIZE`, `SIGNAL_EXTRACTION_MODEL_DEFAULT`, `COVERAGE_CRITIC_MODEL_DEFAULT`) and computed choices (`sorted(COVERAGE_SCOPES)`) at parser-build time. Constant edits at the import site propagate to argparse defaults without touching `cli.json`. The encoded slots are hand-curated against the source to avoid value-collision false positives (e.g. `--max-files default=20` collides with `BUDGET_TOTAL_CAP_DEFAULT=20` by value but is a literal, not a constant reference).
- The single mutually-exclusive group in the surface area (`migrate-critic-gates --output` vs `--in-place`) is declared via `mutex_groups[].actions` on the parser entry; the loader creates the group and routes the listed flags into it instead of the main parser.

#### Added
- `TestCRSPhaseADeclarativeStagesConfig` (5 tests) asserts the loader-based `_build_run_plan_stages` produces output equal to the captured pre-refactor snapshots across both conditional dimensions, pins the `@pr_flag` splat semantics (omitted when `pr_number is None`, inserted as `["--pr-number", str(pr_number)]` when truthy at the correct positions in stages 03/04/08/25), and pins that `{schema_version}` resolves to `SCHEMA_VERSION` from `code_review_schema` rather than a literal `"1"`.
- `tools/python/fixtures/run_plan_snapshots/local_no_pr_empty_flags.json` and `github_pr42_all_flags.json` capture the pre-refactor reference output for the two canonical configurations (every conditional in its "off" vs "on" state) and serve as the byte-equality baseline for the snapshot tests.

### code-review v2.23.3

#### Fixed
- `_render_fleet_notes` no longer under-reports the BHA dropped-partition count in the docs-only branch. `_derive_spawn_agents_from_plan` has two emission shapes for `budget_capped` skip entries: when `cap > 0` it emits one entry per dropped partition (each carrying `partition_id`); when `cap == 0` (docs-only post-arbitrate) it emits a single aggregate entry covering all N suppressed partitions (no `partition_id`, `partition_count` reflects the total). The pre-v2.23.3 renderer always used `len(capped_entries)` for the count, so a docs-only run that suppressed 5 BHA partitions reported `1 partition(s) ... (0/5)` instead of `5 partition(s) ... (0/5)`. The renderer now detects the aggregate shape via the absence of `partition_id` on the first entry and drives the count off `partition_count` instead.
- `cmd_render_fleet_summary` now binds `spec.get("stats")` into a local before the `isinstance(dict)` check so pyright's narrowing covers the subsequent `.get("agent_count")` access. The pre-v2.23.3 shape called `spec.get("stats")` twice in one expression (`if isinstance(spec.get("stats"), dict) else {}`), which the type narrower treats as two separate calls — the LHS still appears as `Any | None` at the `.get` call site. CI's stricter pyright settings flagged this as `reportOptionalMemberAccess`; the local environment had laxer settings and missed it. The runtime behavior was always safe (Python evaluates short-circuit), but the diagnostic was correct that the narrowing didn't carry. Binding via `raw_stats = spec.get("stats")` first makes the narrowing explicit.

#### Added
- `test_budget_capped_docs_only_aggregate_uses_partition_count` pins the v2.23.3 fix: a single aggregate `budget_capped` entry with `budget_cap: 0` and `partition_count: 5` renders as `5 partition(s) ... (0/5)`, not `1 partition(s) ... (0/5)`. The existing `test_budget_capped_partitions_emits_warning` (which seeded per-partition entries with `partition_id`) continues to exercise the `cap > 0` branch, so both emission shapes are covered.

### code-review v2.23.2

#### Fixed
- `cmd_render_fleet_summary` fast-path branch now falls through to the shared **Fleet** + **Notes** block instead of returning early after writing its Reviewers + Model Routing lines. Pre-v2.23.2 a fast-path run where `agent_fast.json` crashed at runtime still showed a clean-looking summary with no `1 intended | 0 ran` signal — the runtime tally was structurally absent from the fast-path branch. The Reviewers / Model Routing lines are still fast-path specific (the bucket/role logic doesn't apply when one agent runs every pass), but the runtime telemetry now consumes `spawn_verification.json` the same way the standard flow does.
- Model Routing summary is now built from `spawn_spec.agents[].model` (what actually dispatched) instead of `route.json` defaults. Three cases this matters: (1) a test-only BHA partition that ran on Sonnet used to show as `BHA=opus` because the route default still said Opus; (2) the plain-string form of `route.models.bug_hunter_a` (e.g. `"bug_hunter_a": "sonnet"`) was silently dropped because only the dict shape was consulted, so the BHA entry vanished from the summary; (3) domain critic models were omitted entirely because route.json never carried per-critic assignments. The new helper `_render_model_summary` walks the spec descriptors, falling back to route.json only when the spec has no entry for a slot. Mixed model assignments (e.g. one Opus BHA + one Sonnet test-only BHA in the same run) now render as `BHA=opus/sonnet` instead of just one value. Domain critics surface as a single `Critics=<model>` aggregate.
- `cmd_verify_spawn` now scopes `present_count` and `present_agents` to the intended spawn-spec agent IDs (the intersection of `spawn_spec.agents[].agent_id` and the on-disk `agent_*.json` glob). Pre-v2.23.2 the glob counted every match — including non-spec artifacts like `agent_coverage-verify-blocking.json` (system-marker from stage_15c), `agent_cached_bha.json` (cache replay), and future system-side files — so the verification artifact over-reported how many spawn-spec agents actually produced output. The runtime tally that the Phase 9 renderer surfaces in `**Fleet:** N intended | N ran` was correspondingly inflated. Missing-required detection was already correct (it walked the spec list looking for absent files); only the present-side counters were off.
- `_render_fast_path_fleet` now guards `route.models` with `isinstance(dict)` before subscripting, matching the guard `_spawn_resolve_models` already had for the standard flow. A malformed `route.models` shape (e.g. a list from a half-written file) would otherwise raise `AttributeError` mid-render and produce no Model Routing line at all. The renderer now falls back to the spec's per-agent model for the fast-path slot.
- Numeric telemetry fields consumed during rendering (`stats.agent_count`, `spawn_verification.present_count`) are now coerced through a new `_safe_int` helper that degrades to 0 on `TypeError`/`ValueError` rather than raising mid-output. A half-written artifact with a string or `None` in a numeric slot used to suppress the entire Fleet line; the line now still renders with `0 intended` or `0 ran` so the operator sees the malformed-input signal instead of a silently missing line.

#### Added
- `TestPLN725Phase9FastPathFleetTally` pins the v2.23.2 fast-path fall-through: a spec with `fast_path: true` + a runtime verification artifact showing the agent did not produce output renders `**Fleet:** 1 intended | 0 ran`, plus the pre-existing Fast Path Reviewer + routing lines.
- `TestPLN725Phase9ModelRoutingFromSpec` covers the four Model Routing fixes: mixed BHA assignments render as `BHA=opus/sonnet`; per-descriptor model overrides route's default (spec is the source of truth); plain-string `route.models.bug_hunter_a` is honored when the spec lacks a BHA descriptor (no longer silently dropped); domain critic models surface as a `Critics=<model>` aggregate.
- `TestPLN725Phase9VerifySpawnIntendedScoping` writes two spec-intended `agent_*.json` files plus three non-spec artifacts (`agent_coverage-verify-blocking.json`, `agent_cached_bha.json`, `agent_injection.json`) and asserts `present_count == 2` (not 5) and `present_agents == {bhb, auditor}` (the non-spec files are excluded).
- `TestPLN725Phase9MalformedTelemetry` exercises the safe-coercion paths: non-numeric `stats.agent_count` degrades to `0 intended`; non-numeric `present_count` degrades to `0 ran`; the fast-path branch survives a non-dict `route.models` (e.g. a list from a half-written file) and falls back to the spec descriptor model.

### code-review v2.23.1

#### Fixed
- `_write_fleet_summary` now writes to stdout OR `--output`, never both. The pre-v2.23.1 path always called `sys.stdout.write(text)` after the file-write branch, so a caller that passed `--output fleet.md` while capturing stdout (e.g. `content=$(python ... --output fleet.md)`) received the rendered block on both channels. The function docstring and the argparse help (`"Optional output file path; default stdout-only"`) both documented an exclusive-or contract that the implementation violated. Added an `else:` branch around the stdout write so the contract holds.
- `_run_render_fleet_summary` test helper now asserts the captured stdout is non-empty before returning. Pre-v2.23.1 a silent crash inside `cmd_render_fleet_summary` would surface as the opaque `AssertionError: assert 'Bug Hunter A' in ''` from every downstream test; the new guard says `cmd_render_fleet_summary produced no stdout — command may have failed silently` so the actual failure mode is identifiable. Mirrors the `_run_derive_spawn_spec` silent-failure guard from v2.22.1.
- `_render_fleet_breakdown` no longer returns an unused `tallies` dict. The pre-v2.23.1 docstring claimed "tallies are used by the caller to decide which note blocks to emit" but the sole caller discarded the second return value with the `_tallies` prefix — note selection is driven independently by `_render_fleet_notes` reading the spec directly. The half-completed return contract was misleading; the function now returns just `list[str]` and the docstring documents the actual responsibilities.
- `present-local` SKILL.md and the v2.23.0 CHANGELOG entry both claimed the renderer emits "a deterministic markdown block of 2–6 lines" but the standard-flow path with all conditional notes active can emit up to 9 lines (3 core + 1 blank separator + up to 5 conditional bullets). Corrected to "2–9 lines (2–4 for the core Reviewers / Model Routing / Fleet section, plus up to 5 conditional note bullets)" in both files so the documented bound matches the implementation.
- `_standard_spec` fixture in `TestPLN725Phase9*` test classes was claimed to be a "5-agent" baseline but contained only 4 agents (`bha_p0`, `bhb`, `auditor`, `premise`). The fixture was extended with one operator-configured `domain_0` rule-resolved critic so the canonical-fleet docstring matches the actual fixture; `test_canonical_5_agent_standard_flow` now asserts the inline-critic provenance suffix it always claimed to. `test_missing_required_at_runtime_emits_warning`, `test_rule_vs_critic_provenance_surfaced`, `test_single_domain_critic_named_inline`, and `test_missing_verification_omits_runtime_line` updated for the new baseline counts.
- `test_multiple_notes_compose` now asserts each substring is present before calling `str.index()` on it. The pre-v2.23.1 code went straight to `out.index("Arbitration bypassed")` etc., so a regression that suppressed a note surfaced as `ValueError: substring not found` with a confusing traceback instead of a clear `AssertionError`. Each `index()` call is now preceded by an `assert "..." in out` so wording regressions produce descriptive failures.

#### Added
- `TestPLN725Phase9RenderFleetSummaryOutputContract` pins the new mutex: `test_output_path_suppresses_stdout` writes a real `--output` file, asserts the file contains the rendered block, and asserts stdout is empty; `test_default_path_writes_to_stdout_only` asserts the no-`--output` path emits to stdout and creates no spurious file. The pre-v2.23.1 `_run_render_fleet_summary` test helper hardcoded `output=None` so the `--output` branch was entirely uncovered — the new test class restores coverage parity with the contract.

### code-review v2.23.0

#### Added
- New `render-fleet-summary` subcommand on `code_review_helpers.py`. Reads `<CR_DIR>/spawn_spec.json` (intended fleet from stage_19b), `<CR_DIR>/spawn_verification.json` (runtime tally from stage_20b), and `<CR_DIR>/route.json` (model assignments) and emits a deterministic markdown block of 2–9 lines (2–4 for the core **Reviewers** / **Model Routing** / **Fleet** section, plus up to 5 conditional note bullets): **Reviewers** (actual fleet that spawned, with the rule-resolved vs LLM-proposed split surfaced on domain critics), **Model Routing** (per-agent model assignments from route.json), **Fleet** (`N intended | N ran | N required missing`), and a conditional **Notes** block for non-default outcomes (BLOCKING sanitization, runtime missing required, BHA budget cap, PLN-723 deferral, malformed-plan required skips). The notes are bulleted in a documented order — sanitization first, then runtime, then derive-time skips — so the operator can scan the section without re-reading. Closes PLN-725 Phase 9 by giving the presenter a typed view of the spawn-spec instead of deriving fleet composition from `agent_*.json` filename heuristics plus a hardcoded static reviewer list.
- New `_FLEET_DISPLAY_NAMES` table mapping canonical snake_case reviewer labels (`bug_hunter_a`, `bug_hunter_b`, `unified_auditor`, `premise_reviewer`, `fast_path_reviewer`, `test_quality`) to operator-facing display names (`Bug Hunter A`, `Bug Hunter B`, ...). Reviewers not in the table render with their original `reviewer` string so operator-configured critic names (e.g. `ts-expert`, `graphql-architect`) appear verbatim — they're the names the operator wrote into `critic-gates.json`.
- `present-local` SKILL.md now invokes the renderer at the slot previously occupied by the hand-authored Reviewers + Model Routing block. The skill's prose explains the fallback contract: when the renderer reports `spawn-spec unavailable` or `spawn-spec fell back`, the orchestrator walked the static reviewer table in `start.md` for this run and the static `## Reviewer Fleet` section is the source of truth for fleet composition. Fast-path runs are handled by the renderer too — no branch needed in the skill.
- `prompts/github-review.md` Step 8 (Summary Format) replaces its hand-authored Reviewers / Model Routing branching with the same renderer invocation. The Notes block surfaces non-default fleet outcomes in the GitHub summary comment so PR reviewers see them without having to dig into `coverage_gaps.json` or `spawn_verification.json`.
- `TestPLN725Phase9RenderFleetSummaryHappyPath` covers the standard-flow shape: canonical 5-agent fleet renders the expected Reviewers / Model Routing / Fleet lines; multiple BHA partitions render with the `× N` multiplier; domain critics surface their rule vs critic provenance count; a single domain critic shows its name inline; fast-path branch collapses to the documented one-line block.
- `TestPLN725Phase9RenderFleetSummaryNotes` covers each conditional note: BLOCKING-sanitized arbitration emits the 🛡️ note with both suppressed reviewer names; runtime missing required emits the ⚠️ warning with display-name mapping (`Unified Auditor`, not `unified_auditor`); budget-capped partitions emit the cap/total summary; `test_quality` emits the informational PLN-723 deferral note; malformed-plan required skips (`unknown_reviewer`, `duplicate_agent_id`) emit a single count line. The compose test pins the documented ordering across all four note types in one run.
- `TestPLN725Phase9RenderFleetSummaryFallbacks` covers the degraded paths: missing `spawn_spec.json` emits the "spawn-spec unavailable" line without fabricating a reviewer list; fallback sentinel includes the `fallback_reason` verbatim; missing `spawn_verification.json` falls back to the intended-only fleet line with an explicit "runtime tally unavailable" annotation; missing `route.json` omits the Model Routing line rather than fabricating a model summary.

### code-review v2.22.3

#### Fixed
- `_derive_spawn_agents_from_plan` now caps BHA descriptors at `coverage_plan.budget.bha_partitions` (the post-arbitrate budget) instead of emitting one BHA agent per entry in `partitions.json`. The route-level `max_bha_agents` cap and the post-arbitrate cap are computed at different times and can diverge — when the partitioner emitted more partitions than the budget reserved (or when `bha_partitions: 0` set docs-only mode), the spawn-spec would over-spawn the BHA fleet and bypass the final coverage plan. The first `cap` partitions now spawn (prefix-take preserves the partitioner's bin-packed ordering); the rest land in `skipped[]` with `reason: "budget_capped"`, `partition_id`, `budget_cap`, and `partition_count` for operator visibility.
- `cmd_derive_spawn_spec` now synthesizes coverage-gap findings for non-benign required-bucket skips and appends them to `coverage_gaps.json`. Without this the spec-driven dispatch could silently drop a required reviewer (closed-vocab violation, malformed entry, duplicate AGENT_ID) and the finalize-result verdict would not see the gap. Benign reasons (`deferred_pln723`, `no_partitions`, `gated_by_verify`) are explicitly excluded — those are intentional omissions, not coverage gaps. The append-not-overwrite contract preserves the budget-exceeded findings that `arbitrate-budget` writes to the same file.
- Missing or malformed `partitions.json` now emits a fallback sentinel (`arbitrate_status: "fallback"`, `fallback_reason: "partitions_missing_or_malformed"`) instead of being collapsed into the same code path as a present-but-empty partitions list. A missing file usually means `stage_17_partition` crashed — silently skipping BHA would suppress coverage. Present-but-empty (all-files-cached / docs-only) still goes through the documented `no_partitions` skip path. The v2.22.1 test that pinned the old behavior was inverted to verify the new fallback semantics.
- `stage_19b_derive_spawn_spec` walker entry no longer carries a hard dependency on `stage_17_partition`. Gate B's fast-path branch (`route.fast_path == true`) skips `stage_17` entirely and drives a single fast-path reviewer in `stage_20` — listing `stage_17` as a hard dep would block stage_19b in fast-path mode and stage_20 would lose its spawn-spec. The cmd handles missing partitions.json internally (fast-path returns before reading; non-fast-path falls through to the new fallback sentinel).
- `cmd_derive_spawn_spec` now sanitizes the input plan under a BLOCKING verify verdict (`budget.gated_by_verify: true`): only `source: "core"` reviewers survive into `agents[]`; every `rule` and `critic` entry is moved to `skipped[]` with `reason: "gated_by_verify"` and the entry's original source preserved. The pre-v2.22.3 behavior let the verifier-rejected plan flow through to dispatch — a closed-vocabulary / shape / evidence / cap failure could still drive Task spawns. Sanitization keeps the canonical static fleet (BHB, Auditor, Premise, BHA per partition) running so review still produces output, while refusing to action the violations the verifier flagged. The canonical BLOCKING finding from `stage_15c` remains the operator-facing signal.

#### Added
- New `stage_20b_verify_spawn` walker stage + `verify-spawn` subcommand. Runs after `stage_20_spawn_reviewers`; reads `spawn_spec.json` + globs `agent_*.json`; appends coverage-gap findings to `coverage_gaps.json` for every required descriptor with no on-disk output (reason `spawn_missing_required_agent`). Writes `spawn_verification.json` with `present_count`, `intended_count`, `missing_agents`, and `missing_required` for telemetry. The runtime symmetric pair to stage_19b's required-skip findings: derive-spawn-spec catches required reviewers the spec couldn't describe; verify-spawn catches required agents that crashed at runtime. Together both make the "required reviewer missing" failure mode observable in the run summary instead of silently dropping coverage. Missing best-effort agents emit no finding (budget-driven omission). No-ops cleanly when the spec is missing, fallback, or empty. `stage_21_collect_findings` now depends on `stage_20b_verify_spawn` so the gap findings land before `cmd_finalize_result` reads them.
- `SCHEMA.md §6c` documents the `spawn_verification.json` envelope shape, the verified vs no-op forms, and the runtime gap invariant (one coverage_gaps.json finding per missing required agent; no finding for missing best-effort).
- `SCHEMA.md §6b` now documents the `budget_capped`, `gated_by_verify`, `budget_cap`, `partition_id`, `partition_count`, and per-skip `source` fields; the new `partitions_missing_or_malformed` fallback reason; the `required_coverage_gaps` stats counter; the BHA-budget-cap invariant; the BLOCKING-sanitization invariant; and the required-coverage-gap invariant.
- `code_review_schema.py` adds `budget_capped` and `gated_by_verify` to `SPAWN_SPEC_SKIP_REASONS` and introduces `SPAWN_SPEC_FALLBACK_REASONS` (`coverage_plan_missing_or_malformed`, `partitions_missing_or_malformed`) so producers and consumers share a single source of truth for the closed vocabularies.
- `TestPLN725Phase8DeriveSpawnSpecBudgetCap` pins the BHA cap behavior at three boundary cases: cap < partition count (prefix-take + budget_capped tail), cap == 0 (docs-only post-arbitrate suppresses all BHA), and cap == partition count (every partition spawns, no budget_capped entries).
- `TestPLN725Phase8DeriveSpawnSpecBlockingSanitization` pins the BLOCKING sanitization end-to-end (mixed core + rule + critic plan → only core spawns; rule/critic land in skipped[] with `reason: "gated_by_verify"` and source preserved) and verifies the no-op path (BLOCKING with only core reviewers → no spurious gated_by_verify skips).
- `TestPLN725Phase8RequiredCoverageGaps` covers the four required-bucket policies: `unknown_reviewer` → finding emitted; `deferred_pln723` → no finding; `gated_by_verify` → no finding (already surfaced via the BLOCKING canonical finding); append-not-overwrite preserves pre-existing arbitrate-budget gap findings.
- `TestPLN725Phase8VerifySpawn` exercises stage_20b: all-required-present (no gap), missing-required (gap appended), missing-best-effort (no gap), fallback spec (clean no-op), missing spec (clean no-op).
- `test_fast_path_reaches_stage_20_without_stage_17` pins the walker invariant — stage_19b precedes stage_20 in the array and does NOT carry a hard dep on stage_17, so dependency-aware walkers can run the fast-path branch end-to-end.
- `test_stage_20b_verify_spawn_present_and_wired` + `test_collect_findings_depends_on_verify_spawn` pin the new walker entries.

### code-review v2.22.2

#### Fixed
- `_derive_spawn_agents_from_plan` now rescues domain reviewers carrying `source: "rule"` from the dispatch path, not just `source: "critic"`. The pre-v2.22.2 spawner only treated `source == "critic"` as a domain critic, so any required or best-effort entry that came out of `_resolve_coverage` with `source: "rule"` (the value `_resolve_coverage` emits for every rule-matched entry — both canonical `coverage[]` rules in `critic-gates.json` and migrated legacy `moduleCritics[]` entries) silently landed in `skipped[]` with `reason: "unknown_reviewer"`. The orchestrator's spawn-spec contract then told `stage_20` not to re-add them, so for any repo with a critic-gates rule naming a non-core reviewer, the reviewer that used to run under the static-table path was now omitted from the fleet with no warning. The fix widens the dispatch to accept both `rule` and `critic`; the entry's source is preserved on the descriptor so presenters can still distinguish operator-configured rules from LLM-proposed additions.
- `domain_critic_count` telemetry now sums across both `source` values (`rule` + `critic`) — both spawn as `domain_<N>` and both belong in the counter. The pre-v2.22.2 counter would under-report any repo that drove its domain coverage through `critic-gates.json` rules instead of LLM proposals.
- `spawn_spec.json` `source` closed vocabulary in `SCHEMA.md` and `SPAWN_SPEC_SOURCES` in `code_review_schema.py` now include `"rule"` as a first-class value alongside `core`, `critic`, and `fast_path`. The omission was the same root cause as the dispatch bug — the spawner treated `rule` as out-of-vocabulary.
- `start.md` Reviewer Fleet two-level dispatch documentation now spells out that `source` of either `"rule"` or `"critic"` selects the Domain Critic suffix, with the distinction recorded for presenter use.
- `test_unknown_required_reviewer_lands_in_skipped` was renamed `test_unknown_source_lands_in_skipped` and rewritten — the previous fixture used `source: "rule"` for a reviewer it labeled "unrecognized," which pinned the regression. The new fixture uses an empty source so only the genuine defense-in-depth branch fires.

#### Added
- `test_rule_resolved_domain_reviewer_spawns_as_domain_critic` pins the new correct behavior: a `source: "rule"` entry naming a non-core reviewer spawns as `domain_<N>` with the source preserved, doesn't land in `skipped[]`, and counts toward `domain_critic_count`. Covers both the required[] path (canonical coverage[] rule) and the best_effort[] path (migrated legacy moduleCritics[]).

### code-review v2.22.1

#### Fixed
- `_derive_spawn_agents_from_plan` now tracks emitted AGENT_IDs in a `seen_agent_ids` set and refuses to append a second descriptor with the same ID. A malformed plan that listed the same non-partitioned reviewer in both `required[]` and `best_effort[]` (or shipped duplicate BHA partition IDs) would otherwise emit two agents with identical `agent_id`, racing on the same `agent_<id>.json` output file and silently losing one set of findings. The duplicate now records a `skipped[]` entry with `reason: "duplicate_agent_id"` and the offending `agent_id`. The closed-vocabulary check at `stage_15c_verify_coverage` should prevent this upstream — spawn-spec defense-in-depth means a single source-of-truth violation upstream doesn't silently lose review coverage.
- `_run_derive_spawn_spec` test helper now delegates stdout suppression to `run_with_stdout_capture` from `golden_fixture_harness` instead of re-inlining the `io.StringIO()` swap pattern. The previous inline form duplicated the helper that was extracted specifically to keep callers from drifting (and the same `_run_arbitrate_budget` helper is the canonical source of the pattern this version mirrors). Also asserts the produced `spawn_spec.json` exists before parsing it, so a `_write_spawn_spec` OSError surfaces as a clear "spawn_spec.json missing" assertion rather than a cryptic `JSONDecodeError` on an empty StringIO.
- `TestPLN725Phase8StageGraph._plan` test helper now delegates to `conftest.invoke_prepare_run` instead of constructing the argparse Namespace inline and calling `cmd_prepare_run` directly. The inline call leaked the prepare-run summary JSON into pytest stdout and the duplicate Namespace block was the exact drift `invoke_prepare_run` was extracted to prevent.
- `start.md` Reviewer Fleet section now documents the prompt-suffix dispatch as **two-level**: when `source == "core"` branch on the `reviewer` field (the four core roles all share `source: "core"`, so source alone is not enough); when `source == "critic"` or `"fast_path"` the source field uniquely selects the suffix. The previous single-bullet description conflated `reviewer` values and `source` values in one list, which an LLM orchestrator could plausibly mis-dispatch on.
- `start.md` per-stage annotations for `stage_15c_verify_coverage` and `stage_16_arbitrate_budget` now describe Phase 8 in past tense (the orchestrator rewire and the gate extension landed in v2.22.0). The previous "Phase 8 will extend the gate" / "The orchestrator rewire is Phase 8" clauses were stale forward references that mischaracterized the current state as "static spec list."
- `_SPAWN_CORE_ROLES` module-level comment now says the dict holds the *spawnable subset* of `COVERAGE_CORE_REQUIRED` and references `_SPAWN_DEFERRED_ROLES` as the home for the deferred entries (currently `test_quality`). The previous wording claimed the dict "matched" `COVERAGE_CORE_REQUIRED` while omitting one of its five entries — a future maintainer reading only the `_SPAWN_CORE_ROLES` comment would have missed that the deferred dict must also be consulted to cover the full set.

#### Added
- `spawn_spec.json` wire-format section in `SCHEMA.md` (§6b) documenting the envelope shape (`fast_path`, `gated_by_verify`, `arbitrate_status`, `cr_dir`, `generated_at`, `agents[]`, `skipped[]`, `stats{}`), the per-agent descriptor shape with the closed-vocabulary fields, the `skipped[].reason` enum, the fallback-sentinel invariant ("when `arbitrate_status == 'fallback'`, walk the static table"), and the BLOCKING-propagation invariant ("when `gated_by_verify == true`, agents still spawn from the unbudgeted plan; the canonical BLOCKING finding lives in `agent_coverage-verify-blocking.json`").
- New `code_review_schema.py` constants codifying the spawn-spec closed vocabularies: `SPAWN_SPEC_ARBITRATE_STATUSES` (`ok` / `blocked_by_verify` / `fallback`), `SPAWN_SPEC_SOURCES` (`core` / `critic` / `fast_path`), `SPAWN_SPEC_BUCKETS` (`required` / `best_effort` / `fast_path`), `SPAWN_SPEC_SKIP_REASONS` (`deferred_pln723` / `no_partitions` / `unknown_reviewer` / `missing_reviewer_name` / `duplicate_agent_id`). The constants live next to `COVERAGE_CORE_REQUIRED` so the two PLN-725 vocabulary sets are co-located.
- `test_missing_partitions_file_treated_as_no_partitions` exercises the file-absent partitions path (`_read_optional_json` returns `None`) and verifies the spec still emits with `arbitrate_status: "ok"`, BHA in `skipped[]`, and non-partitioned core roles spawned — distinct from the existing empty-list test that covers the dict-with-empty-inner path.
- `test_malformed_coverage_plan_emits_fallback_sentinel` writes a valid-JSON, wrong-shape coverage_plan.json (`[]` instead of a dict) and verifies the fallback sentinel fires identically to the missing-file path. Previously only the missing-file case was tested even though both flow through the same `if not isinstance(coverage_plan, dict)` guard.
- `test_empty_reviewer_name_lands_in_skipped` exercises the empty-`reviewer` defense path in `_emit_for_entry` — produces a `skipped[]` entry with `reason: "missing_reviewer_name"` and verifies a well-formed sibling entry in the same bucket still spawns.
- `test_duplicate_non_partitioned_reviewer_dedupes` pins the new dedup guard: same non-partitioned reviewer in both `required[]` and `best_effort[]` emits one agent (first-occurrence wins, so `required` is preserved) and records the loser in `skipped[]` with `reason: "duplicate_agent_id"`.
- Explicit `stats["from_required"]` and `stats["from_best_effort"]` assertions in `test_core_required_expands_to_canonical_agent_ids` (5 required, 0 best-effort) and `test_critic_best_effort_becomes_domain_critic` (5 required, 2 best-effort). The bucket counters were previously part of the output contract but never asserted.

### code-review v2.22.0

#### Added
- New `derive-spawn-spec` subcommand on `code_review_helpers.py`. Reads the post-arbitrate `coverage_plan.json` plus `partitions.json` and `route.json` and writes `spawn_spec.json` — a flat list of agent descriptors keyed by `agent_id` (canonical IDs `bha_p<N>`, `bhb`, `auditor`, `premise`, `domain_<N>`, `fast`) carrying `reviewer`, `model`, `partitioned`, `patches_file`, `source`, and (for BHA) `partition_id` + `is_test_only`. The orchestrator at `stage_20_spawn_reviewers` consumes this artifact to dispatch one Task per descriptor instead of walking the static reviewer table previously baked into `start.md`. Closes the PLN-725 deterministic-coverage loop: the rule-resolved + verified coverage plan now actually shapes the spawned fleet.
- New `stage_19b_derive_spawn_spec` walker entry between `stage_17_partition` and `stage_20_spawn_reviewers`. Declares `coverage_plan.json` + `partitions.json` + `route.json` as inputs, `spawn_spec.json` as the expected output, and `on_failure: continue` so a derive bug never blocks review — the stage emits a sentinel spec with `arbitrate_status: "fallback"` on any unreadable input, which the orchestrator interprets as "ignore the spec; walk the static table."
- `start.md` Reviewer Fleet section now opens with the spawn-spec consumption protocol — the orchestrator Reads `spawn_spec.json` first, dispatches per descriptor, and falls back to the static reviewer table only when the spec is missing or marks `arbitrate_status: "fallback"`. The fast-path `agent_id: "fast"` and the BLOCKING-verify `gated_by_verify` flag are surfaced to the orchestrator so the present step can warn when arbitration was bypassed.
- `SCHEMA.md` lists `stage_19b` and its `spawn_spec.json` artifact in the per-stage output table.
- `TestPLN725Phase8DeriveSpawnSpec` covers the bucket-to-spec mapping (the five `COVERAGE_CORE_REQUIRED` reviewers expand to canonical AGENT_IDs; BHA expands per partition with test-only model routing; the deferred `test_quality` slot surfaces in `skipped[]`), `best_effort[]` critic mapping to `domain_<N>`, fast-path passthrough (rich plan + `route.fast_path = true` collapses to one `fast` agent), gated-by-verify propagation (Phase 7 BLOCKING flag carries through without pruning), the "all files cached" branch (zero partitions → BHA in `skipped[]`, non-partitioned roles still spawn), the unknown-reviewer defense-in-depth branch (closed-vocabulary violation lands in `skipped[]` with `reason: "unknown_reviewer"` rather than fabricating an AGENT_ID), route-model overrides honored without re-derivation, and missing-route safe-default fallback.
- `TestPLN725Phase8StageGraph` pins the walker wiring: stage exists with the correct subcommand and `on_failure: continue`, `depends_on` includes both `stage_16_arbitrate_budget` and `stage_17_partition`, `stage_20_spawn_reviewers` lists `stage_19b_derive_spawn_spec` in its own `depends_on`, and the array ordering keeps stage_19b strictly after both inputs and strictly before the spawn stage.

#### Changed
- `stage_20_spawn_reviewers` walker entry now declares `stage_19b_derive_spawn_spec` in its `depends_on` so a partial run that skips the derive stage cannot reach the spawn stage with a stale or missing spec.
- Stage count expectation in `TestPrepareRun` bumped from 35 to 36 (renamed `test_emits_thirty_five_stages` → `test_emits_thirty_six_stages`) with the history comment updated.

### code-review v2.21.1

#### Fixed
- `_filter_scope_and_range` out-of-hunk comparison is now strictly greater-than (`confidence > floor`) instead of `>=`. The v2.21.0 docstring claimed `floor = 1.0` was a kill switch, but the inclusive comparison let confidence-exactly-1.0 findings through — and `_normalize_findings` defaults missing confidence to 1.0, so the kill switch was easy to trip into bypassing. Strict `>` makes the kill switch real because reviewer confidence is bounded at 1.0 (so `confidence > 1.0` is impossible). Boundary semantics are now operator-visible: `floor = 0.80` means confidence > 0.80 survives, confidence == 0.80 discards.
- `_needs_verification` always returns True for findings carrying `out_of_hunk_kept: True`. The v2.21.0 relaxation deliberately let MEDIUM out-of-hunk findings through with high confidence on the premise that they cite a real causal relationship to the diff, but the verifier's tier table skipped MEDIUM at confidence ≥ 0.85 — so the canonical 0.9-confidence companion-change finding (the exact case the v2.21.0 test pinned) never got a second-pass verdict. Cross-region causation claims are precisely what LLM reviewers are weakest on, so high confidence is the wrong signal to gate verification on. The backstop is placed after the deterministic-producer guards (Hygiene, injection-detector) so they remain absolute, and before the severity tiers so confidence-based skips don't apply.
- `_filter_scope_and_range` now pops any reviewer-supplied `out_of_hunk_kept` value on the in-hunk path and on the system/pr_metadata path. The validator OWNS the field — schema convention is that the tag is present (and True) IFF the finding is a companion-change survivor of the out-of-hunk filter. Without the pop, a reviewer that pre-populated `out_of_hunk_kept: true` would slip through untouched and inflate the `kept_out_of_hunk` telemetry counter plus any downstream presenter labels keying on the tag (low odds today since the field is brand new, but the telemetry and future presenter logic both trust it).
- `cmd_validate` counts `kept_out_of_hunk` from the post-filter `filtered` set instead of the post-grouping `validated` set. `_group_cross_file` absorbs similar-issue findings across files into the primary's `other_locations[]`, where only file/line/severity are carried — the `out_of_hunk_kept` tag is lost in the absorption. Counting post-grouping silently undercounted every companion-change finding that happened to be grouped with another. The counter is about how many findings survived the filter, not how many made it to the final presenter view, so pre-grouping is the semantically correct measurement point.
- Docstrings for the `OUT_OF_HUNK_CONFIDENCE_FLOOR` constant and the filter function now correctly describe the strict `>` semantics, the boundary behavior, and why `floor = 1.0` actually works as a kill switch. Same for the `start.md` per-stage note for `stage_22_validate`.

#### Added
- `test_out_of_hunk_kill_switch_blocks_confidence_1_0` exercises the specific boundary case the pre-v2.21.1 `>=` leaked — MEDIUM at confidence=1.0 with floor=1.0 must discard.
- `test_out_of_hunk_floor_boundary_is_strict` pins the documented "confidence > 0.80 survives, confidence == 0.80 discards" contract at the non-1.0 boundary.
- `test_validator_overrides_reviewer_supplied_out_of_hunk_kept` writes a reviewer-pre-populated `out_of_hunk_kept: true` on an in-hunk finding and asserts the validator strips it and the counter stays at 0.
- `test_kept_out_of_hunk_counts_grouped_companions` writes two cross-file companion-change findings with similar issue text — they group into one `validated` entry with `other_locations` populated, but BOTH count toward `kept_out_of_hunk` (pre-v2.21.1 the counter reported 1 instead of 2).
- `test_out_of_hunk_kept_always_verified_even_at_high_confidence` covers the verifier-tier backstop: a MEDIUM with confidence=0.9 and `out_of_hunk_kept: True` returns True from `_needs_verification` (without the backstop the existing 0.85 cliff for MEDIUM returns False).
- `test_out_of_hunk_kept_does_not_resurrect_hygiene_or_injection` pins the ordering — the deterministic-producer guards precede the backstop so Hygiene + injection-detector findings stay unverifiable even if they somehow carry the tag.

### code-review v2.21.0

#### Changed
- `_filter_scope_and_range` no longer unconditionally discards P2+ findings whose `line` is outside the file's changed range. The previous `DISCARD_LINE_NOT_CHANGED` rule was a pre-verification heuristic that predates PLN-722's per-finding verifier; modern reviewer agents legitimately surface companion-change findings — most commonly when a function signature change in the diff window leaves stale sibling call sites just outside it — and the unconditional drop was silently dropping them. The filter is now confidence-gated: out-of-hunk P2+ findings survive when `confidence ≥ out_of_hunk_confidence_floor` (new `OUT_OF_HUNK_CONFIDENCE_FLOOR` module constant, default `0.80`). P1 (BLOCKING/HIGH) findings are unaffected — they pass regardless of hunk membership, same as before.
- Survivors of the relaxed filter get tagged `out_of_hunk_kept: true` on the finding so presenters and downstream stages can distinguish in-hunk from companion-change findings without re-deriving hunk membership against `diff_data.changed_ranges`.
- `_load_code_review_settings` now reads `out_of_hunk_confidence_floor` from `.closedloop-ai/settings/code-review.json` with per-key validation: int or float in `[0.0, 1.0]` (bool rejected so a stray `true` in JSON doesn't quietly become `1.0`; out-of-range and wrong-type values fall back to the default). Setting `1.0` effectively restores pre-v2.21 strict behavior (only confidence-exactly-1.0 findings clear the floor); setting `0.0` lets every out-of-hunk P2+ through and leans on the PLN-722 verifier.
- `cmd_validate` reads the operator-tunable floor (via the same code-review.json that already hosts `bha_unified_threshold_loc`), threads it into the filter, and emits two new keys in the validate-stats block: `kept_out_of_hunk` (count of findings that survived the relaxation, for A/B observability against historical strict runs) and `discarded_out_of_hunk_low_confidence` (drops at the new gate). The retired `discarded_line_not_changed` key is preserved at `0` for one release so external telemetry dashboards see the transition without crashing on a missing key. The summary also echoes back `out_of_hunk_confidence_floor` for auditability.
- `start.md` per-stage note for `stage_22_validate` documents the new semantics: filter contract, settings key, telemetry counters, kill switch.

#### Added
- New `--settings` arg on `cmd_validate` for test isolation and explicit overrides. Defaults to `.closedloop-ai/settings/code-review.json` relative to cwd; absent file means built-in defaults apply.
- `TestValidate` cases pin the new contract end-to-end: `test_out_of_hunk_high_confidence_survives` (the canonical companion-change scenario: MEDIUM at line 100, hunk at `[10, 15]`, confidence 0.9 — survives with `out_of_hunk_kept: true` and `kept_out_of_hunk` counter ticked); `test_out_of_hunk_low_confidence_discarded` (confidence 0.6 < 0.80 → dropped with the new `DISCARD_OUT_OF_HUNK_LOW_CONFIDENCE` reason); `test_out_of_hunk_kill_switch_via_settings` (floor=1.0 → 0.999 confidence drops); `test_out_of_hunk_floor_operator_lowered` (floor=0.5 → 0.6 confidence survives); `test_in_hunk_finding_does_not_get_out_of_hunk_tag` (the tag is exclusively for relaxed-filter survivors so presenters can't mislabel ordinary findings).
- Seven new cases in `TestLoadCodeReviewSettings` cover the new key's validation surface: operator override honored, `0` and `1.0` boundary values accepted, above-range / negative / bool / wrong-type all fall back to the default. The existing `test_missing_file_returns_defaults` now expects the new canonical key alongside `bha_unified_threshold_loc`.

### code-review v2.20.3

#### Fixed
- `_load_available_reviewers` now returns `(None, diagnostic)` for present-but-wrong-shape rosters: dict missing the `available` key (e.g. the realistic operator hand-edit `{"reviewers": [...]}`), dict with `available` of the wrong inner type, list of non-strings, and dict-with-`available` whose entries are all non-strings. v2.20.1 added the roster BLOCK path in `cmd_verify_coverage`, but it keyed on `loaded is None` — which the loader only returned for top-level type errors. The wrong-key and non-string-list shapes silently fell through `raw.get("available", [])` to `([], None)`, the verifier treated that as "no roster", skipped closed-vocabulary, and emitted PASS on plans that should have been gated. Truly-empty rosters (`[]` or `{"available": []}`) still return `([], None)` and keep the no-roster skip semantics — only present-with-content-but-unusable shapes now BLOCK.
- Error messages are now type-specific so operators see exactly what shape they wrote (`"available_reviewers['available'] must be a list (got str)"`, `"available_reviewers dict missing required 'available' key (got keys: ['reviewers'])"`) instead of the generic `must be a list or {available: [...]}` envelope.

#### Added
- Five regression tests in `TestLoadAvailableReviewers`: `test_wrong_top_level_key_returns_none`, `test_list_of_non_strings_returns_none`, `test_inner_available_list_of_non_strings_returns_none`, plus `test_truly_empty_list_still_returns_success` and `test_truly_empty_inner_list_still_returns_success` to pin that intentional empty rosters keep the no-roster skip semantics (no over-rotation in the fix).
- End-to-end `test_wrong_key_roster_blocks_with_roster_check` in `TestPLN725Phase6VerifyCoverageCommand` writes `{"reviewers": [...]}` to `available_reviewers.json` and asserts the full pipeline emits BLOCKING with the `roster` check — the regression that would have caught the v2.20.1 gap.

### code-review v2.20.2

#### Changed
- Extracted module-level `_run_arbitrate_budget` helper in the test suite. `TestArbitrateBudget._run` and `TestPLN725Phase7ArbitrateBudgetGate._run` previously held nearly identical seed-files + invoke + read-outputs logic — the Phase 7 version just added optional `verify_doc` / `include_verify_flag` parameters. Both class-level methods now delegate to the shared helper, so a future `cmd_arbitrate_budget` Namespace surface change (a new `--foo` arg, schema-version bump, output-path rewire, etc.) edits one site instead of two. No behavior change for existing tests; call sites unchanged because the class methods preserve their signatures.
- Inline comment on `test_pln725_chain_enabled_through_stage_15b` no longer claims "Stage 16 stays disabled". Phase 7 (v2.20.0) enabled it; the comment now points at `test_stage_15c_enabled` and `test_stage_16_enablement_history` as the canonical enablement assertions.
- `start.md` per-stage note for `stage_15c_verify_coverage` rewritten to match v2.20.1 semantics. Documents BLOCKING-on-missing-inputs (was PASS-with-advisory), present-but-malformed roster BLOCKs with the new `roster` check (distinct from absent), the new bucket-aware `additive` check (`initial.required ⊆ final.required` enforced separately), the deeper `shape` check (per-entry dict + non-empty `reviewer` field; failures short-circuit other checks), and the canonical `coverage-verifier` source for the BLOCKING finding.

### code-review v2.20.1

#### Fixed
- `_emit_coverage_verify_blocking_finding` now emits `source: "coverage-verifier"` and `reviewer: "coverage-verifier"` — the canonical values registered in `code_review_schema.SOURCES`. The previous wrong value `"coverage-verify"` would be rejected by stage_22 schema validation exactly when the verifier needed to surface a BLOCKING result, silently dropping the system finding from the run summary.
- `verify_coverage_plan` shape check now rejects malformed bucket entries — non-dict entries and entries with missing or empty `reviewer` strings. The earlier check only validated that `required[]` and `best_effort[]` were lists; `_plan_reviewer_buckets` and `_reviewer_names` then silently dropped non-dict / missing-name entries downstream, so `{"required": [{}], "best_effort": []}` PASSED verification. Since this verifier is the last guard before downstream spawning reads the plan, the deeper shape check is now per-entry. Shape failures short-circuit all other checks (otherwise running additive / closed_vocabulary / critic_* on malformed entries would generate misleading cascading violations).
- `verify_coverage_plan` additive check is now bucket-aware. The earlier check unioned both buckets on each side, so an `initial.required` reviewer could move into `final.best_effort[]` and verification would PASS — silently demoting mandatory coverage to opportunistic. Phase 7 reads this artifact to gate arbitration, so a corrupted cached or manually-edited plan could have downgraded required coverage without operator-visible signal. Now `initial.required ⊆ final.required` is enforced separately from `initial.best_effort ⊆ final.required ∪ final.best_effort` — promotion (best_effort → required) stays additive; demotion (required → best_effort) and deletion both BLOCK with distinct error messages.
- `cmd_verify_coverage` now writes `verdict: "BLOCKING"` (not `"PASS"`) when `coverage_plan.json` or `coverage_plan_initial.json` is missing or unreadable. The earlier behavior — PASS with an advisory `input` violation — made "no plan was verified" indistinguishable from a real PASS in the artifact, and Phase 7's gate would have silently bypassed the cap on every upstream-aborted run. Exit code stays 0 so the walker's observational semantics are preserved; the verdict reflects what the artifact CONSUMER needs to know.
- `cmd_verify_coverage` distinguishes present-but-malformed roster from absent/empty roster. A corrupted `available_reviewers.json` previously was silently treated as absent, letting the closed-vocabulary check be bypassed and the verdict come back PASS on a plan that should have been gated. Now a malformed roster BLOCKs with a `roster` check (distinct from absent/empty which still PASS with no-roster semantics so projects with no `.claude/agents/` keep working).
- `_parse_agent_name` validates the unquoted YAML scalar value against the canonical agent-name grammar `^[a-z][a-z0-9_-]{0,62}$` after the permissive regex matches. The previous version accepted any quoted string — `name: "../x"`, `name: "bad reviewer"`, `name: "Foo.Bar"`, or a multi-kilobyte string in quotes — and wrote it to `available_reviewers.json` where the critic could propose it and the closed-vocabulary check would accept it (because it came from the roster). The grammar mirrors the downstream `_REVIEWER_ID_RE` requirement (which validates against `make_finding_id`'s pattern), so any name that survives the loader will also survive the collect-findings stage. 63-char cap mirrors DNS-label sizing.
- `_scan_agent_definitions` applies aggregate caps: `_AGENTS_DIR_MAX_FILES = 200` truncates the file scan, `_ROSTER_MAX_ENTRIES = 200` caps the resulting roster. Per-file read was already bounded but said nothing about aggregate scan time, roster-JSON size, or critic-input prompt size — a PR could otherwise add hundreds of small valid agent files to grow the surface area on all three axes. Excess files are surfaced as warnings so operators see why their roster is short.

#### Added
- `_AGENT_NAME_RE`, `_AGENTS_DIR_MAX_FILES`, `_ROSTER_MAX_ENTRIES` module-level constants expose the new hardening dimensions for tests and future tuning. `_AGENT_NAME_RE` is named distinctly from `_REVIEWER_ID_RE` (declared later in the same module for the collect-findings stage) to avoid the module-level identifier collision that the first draft hit.
- `TestPLN725Phase5LoaderGrammarAndCaps` covers each grammar gap (path traversal, whitespace, uppercase, dot, length cap above 63, length cap at 63 boundary, bare uppercase still rejected) plus the two aggregate caps (file-count cap, roster-size cap).
- Six new cases in `TestPLN725Phase6VerifyCoveragePure` lock the deeper-shape + bucket-aware additive contract: non-dict bucket entry rejected as shape, empty reviewer field rejected as shape, missing reviewer field rejected as shape, shape failure short-circuits other checks (no cascading critic_evidence violation on a `[{}]` bucket), additive blocks required-demoted-to-best_effort, additive allows best_effort-promoted-to-required.
- Three new cases in `TestPLN725Phase6VerifyCoverageCommand` cover the canonical source value (asserts `source in SOURCES` so a future SOURCES rename surfaces here), the BLOCKING-on-missing-initial-plan path, and the BLOCKING-on-corrupted-roster path with the new `roster` check name.

### code-review v2.20.0

#### Added
- `stage_16_arbitrate_budget` is now enabled in the run plan. The cost-arbitration step has shipped as a callable subcommand since v2.16.x but was held disabled until Phase 6 (coverage verifier) and an enablement gate were ready. With this version, every review applies the total-reviewer cap to the post-critic coverage plan, drops overflow `required` reviewers with `budget-exceeded` system findings, prunes lowest-priority best-effort entries, and computes the final `bha_partitions` count.
- `cmd_arbitrate_budget` accepts a new `--coverage-verify` argument. When the file at that path contains `verdict: "BLOCKING"`, arbitration short-circuits: the input plan flows through to `coverage_plan.json` unchanged (preserving the rule floor — no cap applied, no required dropped, no best-effort pruned), the `budget` block is annotated with `gated_by_verify: true` and `verify_violations: [...]`, and the top-level plan gets an `arbitrate_status: "blocked_by_verify"` field so finalize-result and the presenter can show why the cap wasn't applied. The summary stdout adds `status: "blocked_by_verify"` for the same purpose. No new finding is emitted by the gate — the canonical BLOCKING finding lives in `agent_coverage-verify-blocking.json` from `stage_15c_verify_coverage`, and double-counting would inflate the run summary. A missing or unparseable verifier file is treated as PASS (the verifier itself stays observational; an absent artifact must not silently bypass arbitration).
- `_read_coverage_verify_verdict` helper exposes the verdict-and-violations parse as a tested pure function, returning `(None, [])` for any unreadable / non-dict / missing-key shape so the caller can treat all failure modes as the PASS-equivalent path uniformly.
- `TestPLN725Phase7ArbitrateBudgetGate` (6 cases) pins the gate contract: BLOCKING preserves the full 25-required input despite a cap of 20 and surfaces `gated_by_verify: true`; PASS runs normal arbitration and drops 6 over the cap; missing-verify-file degrades to PASS; an old-style call without `--coverage-verify` keeps pre-Phase-7 behavior (backward compat); BLOCKING with empty violations still gates (signal is the verdict, not the violation count); a malformed verifier file falls through to PASS rather than silently bypassing the cap.

#### Changed
- `stage_16_arbitrate_budget.args` now includes `--coverage-verify <CR_DIR>/coverage_verify.json` so the BLOCKING gate is wired in by default. `depends_on: ["stage_15c_verify_coverage"]` was already set in Phase 6 (v2.19.0) — the dependency edge guarantees the verifier output exists before arbitration consults it. `on_failure: "abort"` is intentional: the BLOCKING short-circuit returns exit 0 (graceful), so any non-zero exit from arbitrate-budget represents a real I/O or shape error and should halt the pipeline rather than continue with stale/missing artifacts.
- `start.md` per-stage note for `stage_15c_verify_coverage` now states that the BLOCKING verdict gates `stage_16` as of v2.20.0. The accompanying new `stage_16_arbitrate_budget` per-stage note documents both verdict paths (PASS → normal arbitration; BLOCKING → short-circuit + `gated_by_verify: true`), explicitly notes that no duplicate finding is emitted, and flags that `stage_20_spawn_reviewers` still consumes the static reviewer table — the orchestrator rewire to read `coverage_plan.json` is Phase 8.
- `TestPLN725Phase4StageGraph.test_stage_16_stays_disabled_in_phase_4` is renamed to `test_stage_16_enablement_history` and now asserts `enabled is True`. The Phase 4 → Phase 7 transition is recorded in the docstring; the assertion mirrors the canonical enablement check in `TestPLN725Phase7ArbitrateBudgetGate`.

### code-review v2.19.2

#### Fixed
- `verify_coverage_plan` now scopes the `closed_vocabulary` check to `source: "critic"` entries only, matching the prepare-time semantics enforced by `validate_coverage_critic_output`. The previous check applied to ALL reviewers in the final plan including `source: "core"` and `source: "rule"` entries — but those reviewer labels (`bug_hunter_a`, `unified_auditor`, `premise_reviewer`, `test_quality`, `bug_hunter_b`) are plugin-internal identifiers that the `spawn_reviewers` stage translates to actual reviewer prompts. They are not project-configured agents in `.claude/agents/` and never have been. The over-broad check would have BLOCKED every consuming project on every review, because the rule-resolved initial plan always contains these labels by design. The check now computes `critic_names = {entry.reviewer for entry in best_effort if entry.source == "critic"}` and only validates that subset against the AVAILABLE roster. The violation message also updates from "reviewers not in AVAILABLE roster" to "critic-added reviewers not in AVAILABLE roster" so operators reading `coverage_verify.json` know exactly which population the check applies to.
- `cmd_verify_coverage` docstring updated from "PLN-725 Stage 4" to "PLN-725 Phase 6 / stage_15c_verify_coverage" so it matches the stage id used everywhere else in the run plan and per-stage notes.
- `TestPLN725Phase6VerifyCoverageCommand._run` fixture now writes the AVAILABLE roster as a flat JSON list, matching what `cmd_load_available_reviewers` produces in production and what `_load_available_reviewers` actually consumes. The previous fixture wrote `{"available_reviewers": [...]}`, but `_load_available_reviewers` reads `raw.get("available", [])` (not `"available_reviewers"`), so every test using `include_roster_file=True` was silently bypassing the closed-vocabulary check — the loader returned `[]`, `cmd_verify_coverage` mapped that to `None` via the existing falsy guard, and `verify_coverage_plan`'s closed_vocabulary branch was skipped. The bug masked the v2.19.0 scoping defect (above) end-to-end: a roster mismatch the verifier surfaced on its first real run had no test coverage because the fixture never delivered a roster the loader could see.

#### Added
- `test_blocking_when_critic_addition_not_in_roster` (renamed from `test_blocking_when_reviewer_not_in_roster`) asserts both that the check fires and that the message says "critic-added" — pinning the new wording so a future scope regression surfaces as a test failure rather than a silent message drift.
- `test_closed_vocabulary_ignores_core_reviewers_outside_roster` and `test_closed_vocabulary_ignores_rule_source_outside_roster` lock the v2.19.2 scoping contract: a plan whose `required[]` or `best_effort[]` contains `source: "core"` / `source: "rule"` entries with reviewer names that are NOT in the project roster must still PASS verification. Without these tests, restoring the over-broad check would not be caught.
- `test_closed_vocabulary_blocks_when_critic_addition_outside_roster` exercises the end-to-end pipeline with the correct fixture shape — writes a flat-list roster, constructs a plan with a critic addition outside the roster, and asserts `cmd_verify_coverage` writes `verdict: "BLOCKING"` with the `closed_vocabulary` violation AND emits `agent_coverage-verify-blocking.json`. This is the regression that would have caught both the fixture-key bug and any future code path that maps a non-None roster to `None` before the check runs.
- `test_core_reviewers_outside_roster_do_not_block` runs the v2.19.2 scoping fix through the same end-to-end pipeline so the scoping invariant is enforced at both the pure-function and command-envelope layers.

### code-review v2.19.1

#### Fixed
- `_parse_agent_name` now accepts all three YAML scalar forms operators actually write: bare (`name: foo`), double-quoted (`name: "foo"`), and single-quoted (`name: 'foo'`), and strips trailing inline comments (`name: foo  # primary`) from any form. Previously only unquoted bare scalars matched, so an agent file with `name: "security-reviewer"` or `name: security-reviewer # primary` silently dropped out of `available_reviewers.json` — the run could fall into `no-roster` or `no-candidates` even though the agent was configured. The regex now uses named alternation groups (`dq` / `sq` / `bare`) so the parser stays single-pass with no PyYAML dependency.
- `_scan_agent_definitions` skips symlinks and non-regular files via an `lstat()` check before opening anything, and reads through a bounded `_AGENT_FILE_READ_LIMIT_BYTES` (64 KiB) prefix instead of slurping each match to EOF. A PR that adds `.claude/agents/x.md` as a symlink to `/dev/zero`, a FIFO, or a multi-GB file can no longer hang or OOM the review runner before the no-roster fallback degrades safely. Oversized files surface as a warning and have their frontmatter prefix parsed; if the closing `---` boundary lies past the limit the agent is dropped (no partial-match against a truncated value).
- `_scan_agent_definitions` now decodes each agent file with `errors="replace"` instead of calling `Path.read_text()` and trusting the `except OSError` guard. `UnicodeDecodeError` is a `ValueError` subclass, not an `OSError` subclass — a single non-UTF8 file in `.claude/agents/` raised straight out of the for-loop and aborted the entire scan, contradicting the docstring's promise of per-file warnings.
- The walker-facing `start.md` per-stage note for `stage_15_coverage_critic` now enumerates all three `status: "skipped"` reasons the prepare step emits: `"no-critic"` (operator flag), `"no-roster"` (empty roster after load), and `"no-candidates"` (roster fully subscribed in the initial plan). The previous parenthetical only mentioned `--no-critic`, leaving a walker-implementation reader assuming the singleton critic should be dispatched for the other two reasons.
- The stale "not-yet-shipped Phase 5 stage" comment block above the `available_reviewers.json` exists() short-circuit in `cmd_coverage_critic_prepare` is replaced with prose that matches the current code path. Phase 5 (v2.18.0) ships `stage_14a`, so the exists() branch is now a safety net for the case where stage_14a's write was skipped or lost — not a dry-run tolerance for an absent stage.

#### Added
- `_AGENT_FILE_READ_LIMIT_BYTES` constant (64 KiB) exposes the bounded-read ceiling so tests and future tuning have a single source of truth.
- `TestPLN725Phase5LoaderHardening` covers each parser/scanner gap with positive + negative regression cases: quoted-name parsing (`"foo"`, `'foo'`, dashes/underscores in quoted forms), inline-comment stripping from bare and quoted forms, symlink skipping, oversized files (frontmatter-in-prefix parses + warns; frontmatter-past-limit drops + warns), and non-UTF8 byte handling (scan completes across the bad file, doesn't abort the loop).
- `TestPLN725Phase5StageGraphDefaults` pins the wire-level contract the walker actually relies on: `stage_14a_load_available_reviewers.args` must NOT contain `--agents-dir` (the default `.claude/agents` path is what gets resolved), and `cmd_load_available_reviewers` invoked without `--agents-dir` from a temp repo cwd round-trips through `_load_available_reviewers` to the expected roster. Prior tests passed an explicit `agents_dir`, so the default-path code path the walker actually exercises was untested.

### code-review v2.19.0

#### Added
- `verify-coverage` subcommand and `stage_15c_verify_coverage` stage — a deterministic post-LLM verifier that runs immediately after `stage_15b_coverage_critic_consolidate` and validates the final `coverage_plan.json` against the closed-vocabulary, additive-only, best-effort-only-critic, evidence-required, 5-cap, and no-duplicates contracts. Emits `coverage_verify.json` with `verdict: "PASS" | "BLOCKING"` and a `violations[]` list keyed by check name. On `BLOCKING` also emits a HIGH system-marker finding to `agent_coverage-verify-blocking.json` so the run summary surfaces the failure. The closed-vocabulary check is bypassed when `available_reviewers.json` is missing or empty, preserving the no-roster skip semantics introduced in v2.18.0/v2.18.2. Missing-input cases degrade to `PASS` with an advisory `input` violation rather than vacuously blocking, so the verifier stays observational when an upstream stage didn't produce its artifact.
- `coverage-verify-blocking` value added to `SYSTEM_MARKERS_FIXED` and mapped to `system` scope in `SYSTEM_MARKER_SCOPES`, so verifier-emitted findings pass schema validation alongside `coverage-critic-failed`.
- New `verify_coverage_plan` pure function exposes the per-check contract independent of I/O, with unit tests covering each violation mode (shape, additive, closed_vocabulary, critic_best_effort_only, critic_evidence, critic_cap, no_duplicates) and the no-roster bypass paths.
- New `TestPLN725Phase6VerifyCoverageCommand` end-to-end tests cover the artifact contents on PASS, the BLOCKING finding emission, the observational exit semantics (exit 0 on both verdicts), the missing-plan input-advisory fallback, and the empty/missing roster bypass.
- New `TestPLN725Phase6StageGraph` tests pin `stage_15c_verify_coverage` shape, adjacency to `stage_15b`, the `--coverage-plan` / `--coverage-plan-initial` / `--available-reviewers` argument set, `enabled: True`, and `on_failure: continue`.

#### Changed
- `stage_16_arbitrate_budget.depends_on` re-anchored from `stage_15b_coverage_critic_consolidate` to `stage_15c_verify_coverage`. The producer chain still flows correctly (`stage_15c` itself depends on `stage_15b`), and when Phase 7 enables `stage_16` it can read `coverage_verify.json` from the same dependency edge without adding another.
- `stage_15c_verify_coverage` ships observational in this version — `on_failure: continue` and exit code 0 on both PASS and BLOCKING. The verdict is encoded in the artifact and finding shape so downstream stages can gate on a PASS read without the verifier itself halting the walker.
- `SCHEMA.md` updated to list `verify-coverage` under stage row 15c with output `coverage_verify.json` and remove the stale stage 24 placeholder row.

#### Removed
- Stale `stage_24_verify_coverage` placeholder removed from the run plan. Its original shape (no `--coverage-plan-initial` or `--available-reviewers` args, output `coverage_verification.json`, dependency on `stage_23_verify_findings`) targeted a different verifier surface than what ships in this version. Coverage verification now lives next to where `coverage_plan.json` is produced, not after the findings verifier.

### code-review v2.18.2

#### Fixed
- `cmd_coverage_critic_prepare` now short-circuits to the "skipped" semantics when the loaded roster is empty, restoring the documented no-roster fallback that v2.18.0's Phase 5 change broke. Previously, `stage_14a_load_available_reviewers` always wrote `available_reviewers.json` (an empty `[]` when `.claude/agents/` was missing or empty), so the earlier `not available_path.exists()` no-roster guard never fired for empty-roster projects — prepare would proceed to dispatch the Sonnet critic against an empty AVAILABLE list the validator could never accept from. Two new short-circuits cover the two empty-roster paths: empty-after-load → `reason: "no-roster"`, and empty-after-dedup-against-existing-plan → `reason: "no-candidates"` (distinct telemetry so operators can tell "no agents configured" from "rules already cover every configured agent"). Both produce the same `status: "skipped"` outcome, so `cmd_coverage_critic_consolidate`'s existing skipped-status no-op fires unchanged.
- `_scan_agent_definitions` now sorts the returned reviewer list by NAME, not by source filename. The walk itself stays filename-sorted for deterministic duplicate handling (lexicographically-first filename wins on a name collision), but the final output is name-sorted so the contract is independent of the on-disk file-naming scheme and matches the cache-key sort applied by `_available_reviewers_hash`. Without this, the docstring claim of "sorted dedup'd list of names" was inaccurate — a project where filenames and names disagreed (e.g. `a-reviewer.md` declaring `name: z-reviewer`) would produce filename-ordered output.

#### Added
- `test_scan_sorts_by_name_not_filename`: counterexample with mismatched filename/name ordering (`a-agent.md` → `z-reviewer`, `z-agent.md` → `a-reviewer`, etc.) that fails under filename-sort and passes only under name-sort. The previous `test_scan_returns_sorted_dedup_list` used data where the two orderings coincided, so it could not distinguish between them.
- `test_empty_roster_file_short_circuits_to_skipped_no_roster`: end-to-end regression for the empty-list fallback (file present, contents `[]` from a Phase 5 stage_14a run in a project with no `.claude/agents/`) — must produce `status: "skipped"`, `reason: "no-roster"`, and MUST NOT write `coverage_critic_input.json` (no dispatch path started).
- `test_fully_subscribed_plan_short_circuits_to_skipped_no_candidates`: end-to-end regression for the adjacent skip case where the roster is non-empty but every reviewer is already in the initial plan — must produce `reason: "no-candidates"`, same `status: "skipped"`.

### code-review v2.18.1

#### Changed
- PLN-725 singleton dispatch outputs renamed out of the `agent_*.json` namespace to `pln725_*.json` — `agent_extract_signals.json` → `pln725_extract_signals.json`, `agent_coverage_critic.json` → `pln725_coverage_critic.json`. The `agent_*.json` glob is used by `stage_20_spawn_reviewers.expected_outputs` (the reviewer-fleet "at least one match" success check) AND by `cmd_collect_findings` (the findings glob). A successful pln725 protocol output under the old namespace would satisfy stage_20's success check even on total reviewer-fleet failure, and any top-level `findings[]` the LLM happened to emit in its protocol output would get ingested into the final review. The `pln725_*` prefix keeps protocol outputs out of both globs. `stage_11b` / `stage_15b` `--agent-output` args, the `start.md` dispatch-protocol convention table, the `{OUTPUT_PATH}` placeholder binding, the per-stage notes, and the failure-semantics section all use the new prefix.
- `stage_11_extract_signals` and `stage_15_coverage_critic` prepare args now use the walker-resolved `<DIFF_TIP>` token instead of a literal `"HEAD"`, and both stages now declare `--cache-dir <CACHE_DIR>`. The literal `HEAD` collapsed every review's cache key to a constant `diff_tip` component — the documented `cache_hit` path was unreachable through the walker and entries were written under a degenerate key. Missing `--cache-dir` made prepare run cache-blind, so the singleton dispatch fired on every review even when the same diff had already been processed.
- `stage_12_hygiene` reordered from after `stage_11_extract_signals` to immediately after `stage_10_classify_intent`. Gate A (the `--hygiene-only` early exit) fires immediately after `stage_12`, and `stage_11` is the first LLM-capable stage in the pipeline. With Phase 4 enabling `stage_11`, hygiene-only reviews would spend a Haiku call on signal extraction before Gate A fired, violating the documented "zero-LLM deterministic check" contract on hygiene-only runs. `stage_12.depends_on` is `stage_05_parse_diff` only, so moving it earlier is safe — execution order follows array position, the `_12_` prefix is a stable label not an ordinal.
- `start.md` PLN-725 Single-Agent Dispatch protocol switched from "foreground Task + `TaskOutput` with block-true" to "synchronous Task, no `TaskOutput`". The previous wording mixed the two protocols — `TaskOutput` is for background tasks (the reviewer/verifier fleets), and a foreground/synchronous Task completes before control returns to the walker so there's no task handle to wait on. A literal walker following the previous wording could spawn the dispatch and still fail to collect the singleton output before the sibling consolidate stage fail-closed. The new contract picks one protocol explicitly: spawn synchronously, no `run_in_background`, no `TaskOutput`.

#### Added
- Regression tests pinning each of the four fixes: stage_count alignment now also checks that `--agent-output` values for `stage_11b` / `stage_15b` end with `pln725_*` (not `agent_*`) AND that the basename does not start with `agent_` (belt-and-braces); stage_11 / stage_15 prepare args carry `<DIFF_TIP>` (not `"HEAD"`) and `<CACHE_DIR>`; stage_12_hygiene appears before every PLN-725 LLM-capable stage in the array; stage_12 still slots after stage_10_classify_intent.

### code-review v2.18.0

#### Added
- PLN-725 Phase 5 (Agent-Definition Loading): produces the AVAILABLE roster the coverage-critic enforces against, so the critic is no longer permanently stuck in the Phase 4 no-roster skipped fallback. Pipeline stage_count: 34 → 35.
- `load-available-reviewers` subcommand: scans `--agents-dir` (default `.claude/agents`) for `*.md` agent definitions, parses YAML frontmatter for each file's `name` field, and writes a flat sorted+dedup JSON list to `<cr_dir>/available_reviewers.json`. The file shape is the same flat list `_load_available_reviewers` (used by `cmd_coverage_critic_prepare` and `cmd_coverage_critic_consolidate`) already accepts, so the writer/reader contract is locked. An empty `.claude/agents/` (no project agents) or a missing directory produces an empty list + exit 0 — stage_15 then falls through to its Phase 4 no-roster skipped semantics rather than aborting the pipeline.
- `_parse_agent_name` helper: regex-based frontmatter parser that pulls the `name:` field out of the `---…---` fence at the start of an agent markdown file. Tolerant by design — returns `None` for missing/unclosed frontmatter, missing `name`, or any unparseable shape; the caller drops Nones from the roster.
- `_scan_agent_definitions` helper: walks the agents directory in sorted order (so cache keys that hash the roster stay stable across filesystem traversal order), dedups names, and surfaces per-file warnings (unreadable files, missing frontmatter, duplicate names) for stderr telemetry without aborting the scan.
- `stage_14a_load_available_reviewers` helper stage: inserted between `stage_14_resolve_coverage` and `stage_15_coverage_critic` in the prepare-run pipeline manifest. `depends_on: []` (no shared data with stage_14 — the roster is statically derived from `.claude/agents/`); `on_failure: continue_with_coverage_gap` so a roster write failure degrades to the Phase 4 no-roster fallback rather than aborting the review.
- `stage_15_coverage_critic.depends_on` adds `stage_14a_load_available_reviewers`. The data dependency on the roster is now explicit on the wire — a future walker reorder cannot let stage_15 run before the roster lands on disk.
- `start.md` Per-Stage Note for `stage_14a_load_available_reviewers` documenting scan behaviour, empty-roster semantics, and the on_failure rationale.
- Regression tests pinning the Phase 5 contract: frontmatter parsing (extracts name from valid frontmatter; returns None for missing/unclosed frontmatter, missing name, prose-only files; first-name-wins on multiple names); directory scan (sorted+dedup output; missing-dir warning; duplicate-name warning + first-wins; ignores non-`.md` files); CLI envelope (writes the flat-list shape `_load_available_reviewers` accepts, returns 0 with empty list on missing agents dir so stage_15 falls through to no-roster, summary stdout carries reviewer_count); and stage graph (subcommand name, expected_outputs, position between stage_14 and stage_15, stage_15 depends_on, enabled, on_failure).

### code-review v2.17.2

#### Changed
- `cmd_coverage_critic_prepare` extracts a private `_emit_skipped_coverage_plan` helper shared by both the `--no-critic` operator-flag path and the missing-roster configuration path. The two branches were ~95% identical (same `merge_critic_additions` + `generated_at` stamp + `critic_status="skipped"` + manifest shape + stdout dump); the only caller-varying field was the manifest `reason`. Single edit site now for any future shape changes (e.g. adding an OSError guard to the manifest write).
- `present-local` skill Summary section restructured so the Output directory line actually renders. The previous form mixed render-template content with instructional prose ("Append this line verbatim", "Always include this line") inside the template body, which the orchestrator read as scaffolding instructions rather than a line to emit. The Summary template now lives in a fenced markdown block following the skill's own header convention ("Fenced code blocks are card/footer templates"), with `[CR_DIR_PATH]` as a `[bracketed]` substitution placeholder matching the `[action based on findings]` form already used on the same template. Meta-instructions live above the block.

#### Fixed
- `test_malformed_roster_still_returns_one` replaces a vacuously-true guarded assertion (`if manifest_path.exists(): assert manifest.get("reason") != "no-roster"` — the guard never fired because `cmd_coverage_critic_prepare` returns 1 before any manifest write on malformed input) with an unconditional `assert not (cr_dir / "coverage_critic_manifest.json").exists()` plus the same check for `coverage_plan.json`. Positively asserts the skipped/no-roster path did not fire, and would catch a regression where exit-1 also wrote a manifest.

### code-review v2.17.1

#### Fixed
- `start.md` PLN-725 Single-Agent Dispatch placeholder substitution is now unambiguous. The previous "Substitute the resolved paths from the manifest" instruction implied every placeholder in the spawn prompt template — including `{OUTPUT_PATH}` — came from the manifest, but `manifest.output_path` is the canonical sibling consolidate target (`extract_signals.json` / `coverage_plan.json`), not where the agent writes. An orchestrator following the literal instruction would have the agent write to the consolidate target, and the sibling consolidate stage would then fail closed reading the (now-missing) `agent_*.json` — silently clobbering the canonical file with the default signal set / unchanged initial plan on every `needs_agent` run. The spawn contract now carries an explicit per-placeholder mapping table that binds `{OUTPUT_PATH}` to the by-convention agent write target (`<CR_DIR>/agent_extract_signals.json` / `<CR_DIR>/agent_coverage_critic.json`) and explicitly notes "NOT `manifest.output_path`".
- `cmd_coverage_critic_prepare` now tolerates a missing `available_reviewers.json` instead of crashing. When the file does not exist (the producer is a not-yet-shipped Phase 5 stage), prepare falls back to "skipped" semantics — writes the initial plan as the final `coverage_plan.json` with `critic_status: "skipped"` and a manifest with `status: "skipped"` + `reason: "no-roster"`. Mirrors the existing `--no-critic` flow but reachable by configuration. A present-but-malformed roster still returns 1 — that's an operator config error worth surfacing loudly.

#### Changed
- `present-local` skill renders an "Output directory" line in the final Summary so operators can locate the run's CR dir (artifacts, manifests, agent outputs, WIP files from in-progress pipeline phases) without scanning the filesystem.

#### Added
- PLN-725 Phase 4 (Orchestrator Wiring): the previously-deferred prepare/agent/consolidate chain for signal-extraction and coverage-critic now runs end-to-end on every review. Stages 11/11b/14/15/15b are enabled in dry-run mode — `coverage_plan.json` is produced on every run but no routing decisions yet consume it (`stage_16_arbitrate_budget` stays disabled — Phase 7).
- `stage_11b_extract_signals_consolidate`: helper stage that runs `extract-signals-consolidate` against `<CR_DIR>/agent_extract_signals.json` and writes the canonical `<CR_DIR>/extract_signals.json`. Depends on `stage_11_extract_signals`; `on_failure: continue_with_coverage_gap`.
- `stage_15b_coverage_critic_consolidate`: helper stage that runs `coverage-critic-consolidate` against `<CR_DIR>/agent_coverage_critic.json` and writes the canonical `<CR_DIR>/coverage_plan.json`. Depends on `stage_15_coverage_critic`; `on_failure: continue`.
- `start.md` walker contract step 6: after `stage_11_extract_signals` or `stage_15_coverage_critic`, read the prepare manifest and dispatch the PLN-725 Single-Agent Dispatch protocol before advancing to the sibling consolidate stage. Manifest `status` field decides — `cache_hit`/`skipped` skips the spawn, `needs_agent` spawns the singleton agent.
- `start.md` "PLN-725 Single-Agent Dispatch" section: codifies the singleton-agent spawn contract used by stages 11 and 15. Uses the same `code-review:code-review-worker` subagent type as the verifier fleet (Read/Write/Grep/Glob allowlist). Documents manifest fields (`prompt_path`, `input_path`, `model`) and the agent's by-convention write target (`agent_extract_signals.json` / `agent_coverage_critic.json`) — distinct from the manifest's `output_path` field, which names the canonical sibling consolidate output. Failure semantics: missing agent output is not fatal; the sibling consolidate stage detects it and fails closed via the existing `signal-extraction-failed` / `coverage-critic-failed` paths.
- `start.md` Per-Stage Notes: entries for `stage_11`, `stage_11b`, `stage_14`, `stage_15`, `stage_15b` documenting Phase 4 wiring (manifest status branching, fail-closed semantics, depends_on chains).
- Regression tests pinning the Phase 4 stage graph: `stage_11b` / `stage_15b` shape (subcommand, args, expected_outputs, depends_on, enabled); the `--agent-output` arg matches the dispatch-protocol convention so the agent's write target and the consolidate read target are the same file; `stage_14` now depends on `stage_11b` (not `stage_11`) and `stage_16` now depends on `stage_15b` (not `stage_15`) so a future "tidy the deps" edit can't silently revert; the PLN-725 chain is enabled through `stage_15b` while `stage_16` stays disabled; stage_count is now 34 (was 32) and each consolidate sibling appears immediately after its prepare sibling so the walker dispatch protocol fires between them.
- Regression tests for the consolidate cache_hit/skipped no-op paths: `cmd_extract_signals_consolidate` returns 0 without touching the canonical output or emitting a fail-closed finding when the prepare manifest is `cache_hit`; `cmd_coverage_critic_consolidate` does the same for both `cache_hit` and `skipped`. A `needs_agent` manifest with no agent output on disk still routes through the fail_closed path so the no-op short-circuit cannot mask a real dispatch failure.

#### Changed
- `cmd_extract_signals_consolidate` reads `manifest.status` and no-ops when it is `cache_hit` (prepare already wrote the canonical `extract_signals.json` directly; re-reading from cache would duplicate prepare's work and require an agent output file that doesn't exist on cache hit). On a no-op the cmd writes a one-line `{"status": "cache_hit", "output_path": "<path>", "cache_key": "<key>"}` JSON to stdout and returns 0.
- `cmd_coverage_critic_consolidate` reads `manifest.status` and no-ops when it is `cache_hit` or `skipped` (the `--no-critic` flag produces the latter; both write `coverage_plan.json` from inside prepare). Same one-line stdout shape as above, with `status` echoing the manifest value.
- `stage_14_resolve_coverage.depends_on` now points at `stage_11b_extract_signals_consolidate` instead of `stage_11_extract_signals`. The signals file resolve-coverage consumes is produced by the consolidate sibling, not by prepare; the prior wiring would have let `stage_14` run before the signals file landed on disk if both stages had ever been enabled together.
- `stage_14_resolve_coverage.on_failure` softened from `abort` to `continue_with_coverage_gap`. Phase 4 runs the chain for telemetry only; a resolve-coverage failure surfaces as a coverage-gap finding rather than aborting the whole review. Will reharden when Phase 6/7 turn on coverage-plan consumption.
- `stage_16_arbitrate_budget.depends_on` now points at `stage_15b_coverage_critic_consolidate` instead of `stage_15_coverage_critic`. Same correctness contract as the `stage_14` rewire: stage_15b is the actual writer of `coverage_plan.json`. `stage_16.args --coverage-plan` is also updated from `coverage_plan_initial.json` to `coverage_plan.json` so that when Phase 7 enables this stage it reads the consolidated plan (with critic additions merged) rather than the pre-critic initial plan.

### code-review v2.16.3

#### Fixed
- `_load_available_reviewers` now returns `(roster, error_message)` instead of a bare `list | None`. An operator with a missing or malformed `available_reviewers.json` previously saw `Error: available_reviewers must be a list or {available: [...]}` regardless of the actual cause; both callers (`cmd_coverage_critic_prepare`, `cmd_coverage_critic_consolidate`) now surface a path-specific diagnostic — `Error reading available_reviewers: [Errno 2] No such file or directory: …` for IO/parse failures, and the shape-error message only when the JSON parses but the top-level value is neither a list nor `{available: [...]}`. Restores the IO/parse diagnostic the pre-helper prepare code emitted via `f"Error reading available_reviewers: {exc}"`.

#### Added
- Regression tests pinning the loader's three diagnostic paths: flat-list / wrapped-object success, missing-file IO diagnostic (asserts the IO message and that the shape-error string is absent), malformed-JSON parse diagnostic, unrecognized-top-level-shape shape diagnostic, and inner-`available`-wrong-type shape diagnostic.

### code-review v2.16.2

#### Fixed
- `coverage_critic_cache_key` now takes a 5-tuple `(coverage_plan_initial_hash, signals_hash, diff_tip, prompt_hash, available_reviewers_hash)` instead of a 4-tuple. The roster the validator enforces against is now part of the key, so a cache hit on the prior key can no longer serve a stale `coverage_plan.json` whose `best_effort[]` proposes a reviewer that has since been removed from the AVAILABLE roster — on hit consolidate never re-runs to catch it. The new `available_reviewers_hash` dimension is content-addressed over the sorted, dedup'd post-filter roster the agent actually sees, so list ordering and duplicates do not flip the key.

#### Added
- `_available_reviewers_hash` helper: deterministic hash of the AVAILABLE roster (sorts and dedups before hashing, drops non-string entries).
- `available_reviewers_hash` field on the `coverage-critic-prepare` manifest, sibling to the existing `coverage_plan_initial_hash`, `signals_hash`, and `prompt_hash` debuggability fields.
- Regression tests pinning the new cache-key dimension: `available_reviewers_hash` flips the key end-to-end; ordering and duplicates and non-string garbage do not flip the roster hash; and a roster-shrink miss test exercises the concrete failure mode — same plan, same signals, same prompt, same diff, but one reviewer retired between runs — and asserts the prior cache entry is not served (`manifest["status"] == "needs_agent"`, not `"cache_hit"`).

### code-review v2.16.1

#### Fixed
- The `coverage-critic-failed` system marker is now registered in `SYSTEM_MARKERS_FIXED` and `SYSTEM_MARKER_SCOPES` (mapped to the `system` scope). Without this registration, `is_valid_system_marker("coverage-critic-failed")` returned `False` and `validate_finding` silently discarded every fail-closed coverage-critic finding, dropping the operator-visible degradation signal that the rest of the Phase 3 fail-closed flow exists to surface. Mirrors the existing `signal-extraction-failed` registration.
- `coverage-critic-prepare --no-critic` now stamps `critic_status: "skipped"` and `critic_errors: []` onto the final `coverage_plan.json`, matching the field shape produced by `coverage-critic-consolidate` (`ok` / `fail_closed`). Downstream consumers can now distinguish a skipped run from a healthy run with zero additions without special-casing field absence.
- `available_reviewers.json` parsing is extracted to a shared `_load_available_reviewers` helper used by both `coverage-critic-prepare` and `coverage-critic-consolidate`. Previously the two callers had divergent error handling for unrecognized JSON shape — `prepare` returned an error, `consolidate` silently fell back to an empty list, which caused every LLM-proposed reviewer to be rejected as "not in available_reviewers" with no diagnostic. Both callers now fail consistently with a clear error.

#### Added
- Regression tests pinning the `coverage-critic-failed` system-marker contract: `SYSTEM_MARKERS_FIXED` membership, `system_marker_scope` returns `"system"`, `is_valid_system_marker` returns `True`, and the emitted fail-closed finding passes `validate_finding` after the same normalize + priority-fill pipeline `cmd_collect_findings` applies on every `agent_*.json`. Also pins the `--no-critic` path's `critic_status: "skipped"` / `critic_errors: []` assertion.

### code-review v2.16.0

#### Added
- PLN-725 Phase 3 (Coverage Critic): the `coverage-critic-prepare` and `coverage-critic-consolidate` subcommands, plus a new prompt asset and a constraint-enforcing validator that produces the final `coverage_plan.json`. Foundation only — no orchestrator wiring yet (Phase 4 will replace the placeholder `stage_15_coverage_critic` and add a sibling consolidate stage).
- `plugins/code-review/tools/prompts/coverage_critic_prompt.txt`: adversarial prompt for the Sonnet critic agent. Codifies the closed-vocabulary contract (only names from `available_reviewers.json`), the evidence requirement (`<file>:<line> — rationale` or `signal:<name>@<conf> — rationale`), the additive-only rule, the best-effort-only rule (the critic cannot promote to required), the 5-addition hard cap, and the dedup-vs-existing-plan rule. Includes a calibration ladder telling the agent that "more is not better" — phantom additions cost the budget and dilute signal.
- `coverage-critic-prepare` subcommand: reads `coverage_plan_initial.json` (from `resolve-coverage`), `extract_signals.json` (from `extract-signals-consolidate`), `diff_data.json`, and an `available_reviewers.json` (flat list OR `{available: [...]}` object). Filters the AVAILABLE list to remove anything already in the initial plan, computes the `coverage_critic/` namespace cache key from `(coverage_plan_initial_hash, signals_hash, diff_tip, prompt_hash)` (all content-addressed), serves a cache hit straight to `coverage_plan.json` and exits, or writes a bounded agent-input bundle plus a per-run diff summary on miss.
- `coverage-critic-consolidate` subcommand: validates LLM output against the constraint contract and either merges accepted additions into the initial plan or fails closed. Successful runs cache to the `coverage_critic/` namespace (7-day TTL); fail-closed outputs are not cached.
- `--no-critic` flag on `coverage-critic-prepare`: skips the LLM critic entirely, writing the initial plan straight through as the final `coverage_plan.json`. Manifest reports `status: "skipped"`, `reason: "no-critic"`. Useful for cost-sensitive runs.
- `_stable_json_hash` helper: deterministic JSON serialization (`sort_keys=True`, compact separators) for content-addressing the plan-initial and signals inputs to the cache key.
- `coverage-critic` added to the canonical `SOURCES` allowlist in `code_review_schema.py` so the fail-closed system-marker finding emitted by `_emit_coverage_critic_failed_finding` passes `validate_finding`. Matches the architectural pattern already used by `signal-extractor` (PLN-725 Phase 1) and `coverage-verifier` (PLN-725 Phase 6 placeholder).
- Fail-closed coverage-critic behavior: any structural extraction failure (unreadable agent output, every addition rejected) leaves the initial plan as the final plan (no critic additions merged) and emits a MEDIUM `Coverage` finding with `system_marker: "coverage-critic-failed"` to `agent_coverage-critic-failed.json` so the operator footer surfaces the skipped stage.
- `critic_status` (`ok` / `fail_closed`) and `critic_errors` fields on the final `coverage_plan.json` so downstream consumers can distinguish a healthy run with zero critic additions from a fail-closed run.
- `stats.critic_additions` counter on the final `coverage_plan.json` recording how many critic additions were merged.
- 35 regression tests across 9 new classes pinning the `SOURCES` membership, the prompt-hash content-addressing, the 4-tuple cache-key invariants (each of the four components flips the key), the deterministic `_stable_json_hash`, the validator's accept/reject paths for every constraint (invented reviewer, reviewer already in plan, empty/missing evidence, duplicate within additions, hard cap, optional model_override, malformed top-level shape), the merger's append-to-best-effort behavior, the required-floor-unchanged invariant, the CLI prepare cache-miss + cache-hit + `--no-critic` paths, the consolidate happy / fail-closed / unreadable / partial-validity paths, and the prepare-run pipeline manifest's `stage_15_coverage_critic` alignment with the shipped CLI (subcommand name, argument set, and expected_outputs).

#### Changed
- The prepare-run pipeline manifest's `stage_15_coverage_critic` entry now invokes the actually-shipped `coverage-critic-prepare` subcommand with the full argument set (`--coverage-plan-initial`, `--diff-data`, `--available-reviewers`, `--extract-signals`, `--diff-tip`). The stage's `expected_outputs` declares only `coverage_critic_manifest.json`; the final `coverage_plan.json` will be declared on a sibling consolidate stage added in Phase 4.

### code-review v2.15.2

#### Added
- `ignore_case` field on `path_pattern` triggers in `coverage[]` rules. Default `False`; canonical rules retain explicit case-sensitive semantics. The legacy `moduleCritics[]` migration sets `ignore_case: True` so migrated rules preserve the legacy case-insensitive substring-match behavior.
- `prior_migrated_pruned` field in the `migrate-critic-gates` summary output. Counts the `_migrated_from="moduleCritics"` entries pruned from `coverage[]` before the freshly-migrated set is appended.
- Regression tests for the prepare-run pipeline manifest's PLN-725 stages: `stage_11_extract_signals` (subcommand name + expected_outputs), `stage_14_resolve_coverage` (flag name + canonical file path), `stage_15_coverage_critic` (flag name + canonical file path).
- Regression tests for case-insensitive migrated `path_pattern` triggers (both via `_trigger_fires` directly and end-to-end through `resolve_coverage`).
- Regression tests for the `change_class` value validator, downgrade-warning emission timing, `cmd_resolve_coverage` write-failure handling, the argparse mutually-exclusive group, and migration idempotency.

#### Changed
- The `prepare-run` pipeline manifest now reflects the actually-shipped PLN-725 Phase 1 and Phase 2 CLI surfaces. `stage_11_extract_signals` invokes `extract-signals-prepare` (Phase 1 ships a two-step prep/consolidate flow rather than a single subcommand) and declares only the manifest file it produces in `expected_outputs`; the consolidate half (and the `extract_signals.json` file it writes) will be declared on a sibling stage when Phase 4 wiring lands. `stage_14_resolve_coverage` and `stage_15_coverage_critic` use `--extract-signals` matching the Phase 2 CLI.
- `_validate_coverage_rule` now also rejects unknown `change_class.class` values, emitting a warning that enumerates valid values from `COVERAGE_CHANGE_CLASSES`. Previously a typo like `scheme_change` would have passed structural validation and silently never fired at runtime.
- The determinism downgrade for required-with-only-LLM-signal rules is now surfaced as a warning only after the rule actually matches a trigger. Rules whose triggers never fire no longer generate misleading "downgraded" noise.
- `_validate_coverage_rule` docstring updated to reflect what the function actually checks (structural edit-time problems) and to explicitly defer the required-with-only-LLM-signal runtime invariant to `resolve_coverage`.
- `migrate-critic-gates` is now idempotent. Repeat `--in-place` runs prune any prior `_migrated_from="moduleCritics"` entries from `coverage[]` before appending the freshly-migrated set, so running the migration N times produces the same result as running it once. Operator-edited canonical entries (no `_migrated_from` marker) are preserved untouched.
- `migrate-critic-gates` argparse now declares `--in-place` and `--output` as a mutually exclusive group; argparse rejects the combination directly instead of relying on internal precedence resolution.

#### Fixed
- The migration legacy soft-compat now preserves case-insensitive substring semantics. The previous wrapping (`**<sub>**` evaluated through `_glob_to_regex` with no `IGNORECASE`) compiled a case-sensitive regex that would silently drop reviewers whose migrated patterns didn't match the file path's case. The migration now emits `ignore_case: True` on every migrated trigger, and `_trigger_fires` recompiles the regex with `re.IGNORECASE` when the flag is set.
- `cmd_resolve_coverage` now wraps its `coverage_plan_initial.json` write in `try/except OSError` and returns exit code 1 on write failure, matching the contract the docstring already promised. Previously an unwritable output path would have propagated `OSError`.
- The dead `TestTriggerFires._empty()` helper was removed.

### code-review v2.15.0

#### Added
- PLN-725 Phase 2 (Coverage Resolution): the `coverage[]` rule schema, `resolve-coverage` deterministic subcommand, and `migrate-critic-gates` legacy soft-compat rewriter. Foundation only — no orchestrator wiring yet (Phase 4 will replace the `route` subcommand's domain-critic selection). Closes the second of ten planned rollout steps for deterministic coverage routing.
- **`coverage[]` rule schema** in `critic-gates.json`. Each entry: `reviewer` (string), `triggers[]` (six trigger types — see below), `required` (bool), `scope` (`code-review` / `plan-review` / `both`), optional `model_override` and `priority`. Triggers use **OR semantics** — the first trigger that fires selects the reviewer. Documented in `code_review_schema.py` via new public frozensets (`COVERAGE_TRIGGER_TYPES`, `COVERAGE_DETERMINISTIC_TRIGGERS`, `COVERAGE_LLM_TRIGGERS`, `COVERAGE_SCOPES`, `COVERAGE_CHANGE_CLASSES`) and tuple (`COVERAGE_CORE_REQUIRED`).
- **Six trigger types**: `always` (always fires); `extension` (`extensions[]` + optional `min_files`); `path_pattern` (glob list, evaluated via existing `_glob_to_regex`); `content_signal` (regex on added lines only, optional `max_scan_lines` cap); `change_class` (one of `schema_change`, `infrastructure_change`, `build_config_change`, `dependency_change`); `signal` (taxonomy name + optional `min_confidence` against PLN-725 Phase 1's `extract_signals.json`).
- **Determinism enforcement (architectural invariant from PLN-725 §1):** triggers split into deterministic (`always`/`extension`/`path_pattern`/`content_signal`/`change_class`) and LLM (`signal`). A rule with `required: true` whose triggers are **only** LLM-signal is automatically **downgraded to best-effort** with an audit warning emitted in the Coverage Plan. LLM signals can ADD reviewers but never solely DRIVE required selection. The deterministic floor for auto-merge survives signal-extraction failure.
- **Always-add core required reviewers** are always present in the Coverage Plan regardless of rule matches: `bug_hunter_a`, `bug_hunter_b`, `unified_auditor`, `premise_reviewer`, `test_quality` (reserved slot for PLN-723). Entries are labeled `source: "core"` so downstream tooling can distinguish them from rule-matched additions.
- **Deterministic file → change_class classifier** (`classify_file_changes`). New `CHANGE_CLASS_PATH_PATTERNS` maps each canonical class to a tuple of globs: `schema_change` (`**/migrations/**`, `**/schema/**`, `**/*.sql`), `infrastructure_change` (Terraform / CloudFormation / k8s / Helm), `build_config_change` (webpack/vite/tsconfig/babel/esbuild/Makefile/Dockerfile/.github/workflows), `dependency_change` (package.json / requirements*.txt / Cargo / go.mod / Gemfile / pyproject / poetry / yarn / pnpm). Extensible.
- **`resolve-coverage` subcommand**: reads `diff_data.json` + `critic-gates.json` + optional `extract_signals.json`, runs the pure `resolve_coverage()` function, writes `<cr_dir>/coverage_plan_initial.json` with `required[]`, `best_effort[]`, `warnings[]`, `stats` (`required_count`, `best_effort_count`, `rules_evaluated`, `rules_matched`, `detected_change_classes`, `signal_count`). Stdout summary for the orchestrator.
- **`migrate-critic-gates` subcommand**: one-time legacy rewriter that translates `moduleCritics[]` substring rules into canonical `coverage[]` `path_pattern` rules. Substrings wrap as `**<sub>**` globs (the `_glob_to_regex` middle-`**` form translates to `^.*<sub>.*$` — matches the substring anywhere in the path, preserving the legacy `"sub" in path.lower()` semantics). Supports `--dry-run`, `--in-place`, and explicit `--output`. The legacy `moduleCritics[]` block is preserved on disk for a one-release back-out window.
- **Soft-compat without a file rewrite**: `resolve_coverage` reads BOTH `coverage[]` and `moduleCritics[]`, auto-migrating the latter at evaluation time. A `critic-gates.json` with **only** legacy entries continues to route reviewers (as best-effort) without any manual upgrade. The `[DEPRECATED]` warning is emitted into the Coverage Plan so operators see the call-to-migrate.
- **Dedup with required-wins-over-best-effort promotion**: a reviewer hit by a best-effort rule first and a required rule second ends up in `required[]`, not `best_effort[]`. A reviewer hit by two best-effort rules appears once.
- **Rule-validation lint**: `_validate_coverage_rule` rejects rules with missing/invalid `reviewer`, missing/empty `triggers`, unknown trigger types, or unknown scopes. The resolver emits each violation as a warning rather than crashing — operators can lint `critic-gates.json` at edit time by running `resolve-coverage` against an empty diff.
- 51 regression tests across 7 new classes pinning every contract above (`TestClassifyFileChanges`, `TestSignalsToConfidenceMap`, `TestTriggerFires` — 16 tests covering every trigger type's positive/negative/boundary case, `TestMigrateLegacyModuleCritics`, `TestResolveCoverage` — 13 tests covering core-always-added, determinism downgrade, mixed-trigger-required-stays-required, scope filter, dedup-promotion, legacy soft-compat, signal-trigger-without-extract_signals; `TestResolveCoverageCLI`, `TestMigrateCriticGatesCLI`).

### code-review v2.14.1

#### Added
- `signal-extractor` added to the canonical `SOURCES` allowlist in `code_review_schema.py`. Mirrors the architectural pattern used by `injection-detector` and `coverage-verifier` (system-marker emitters live in the allowlist). Without this, the failure finding emitted by `_emit_signal_extraction_failed_finding` would be rejected by `validate_finding`, `cmd_finalize_result` would return exit code 1, and signal-extraction failure would break the pipeline — the opposite of the intended fail-open observability.
- `_signal_extraction_prompt_hash` helper. The `signals/` cache key is now content-addressed on the actual prompt asset bytes (alongside the taxonomy bytes already hashed via `_taxonomy_hash`). Reads the prompt file inside `cmd_extract_signals_prepare` rather than trusting a caller-supplied `--prompt-hash` value. The `--prompt-hash` flag is retained as an orchestrator override but is no longer required for correctness. Prevents a Phase-4 wiring that forgets the flag from serving stale extractions across prompt edits.
- 12 PR #121 regression tests across 5 new classes pinning every fix below.

#### Fixed
- **`source: "signal-extractor"` was not in `SOURCES` allowlist (PR #121, Unified Auditor HIGH).** The failure finding emitted on extraction failure carried a source string that `validate_finding` would reject. The finalize-result exit code 1 would then cascade through the pipeline. Two halves to the fix: the source name is now in `SOURCES` (above), and a regression test exercises `normalize_legacy_finding` on the failure finding to pin the contract.
- **`_read_cached_signals` bypassed TTL when `written_at` was missing or non-string (PR #121, Bug Hunter B MED).** The verifier's `_read_cached_verification` treats missing/unparseable timestamps as a miss and unlinks the stale entry. The signals reader did neither; a manually seeded or externally written cache file would have been served indefinitely. Now mirrors the verifier exactly — missing/non-parseable `written_at` → miss + unlink.
- **Signal-extraction prompt bytes were never hashed (PR #121, Bug Hunter B + devops-architect MED, duplicated by thadeusb's PR comment).** The cache-key docstring claimed any prompt-asset edit busts the key, but `cmd_extract_signals_prepare` never read the prompt file's bytes; `prompt_hash` came from `args.prompt_hash`, defaulting to `""`. The prompt asset is now hashed at the same level of rigor as the taxonomy — both are content-addressed inside the namespace.
- **`change_classes` field promised but never populated (PR #121, thadeusb).** `parse-diff` does not emit `change_classes` in `diff_data.json`, yet `_build_signal_input` defaulted it into the agent's bundle and the prompt advertised it. Both removed. When Phase 2's `resolve-coverage` lands, it can re-add the field as part of a deterministic file-classification stage; until then the agent isn't told a field exists that it never receives.
- **`file_loc` misannotated as `dict[str, int]` and `loc` redundant (PR #121, thadeusb).** The canonical `parse-diff` shape is `dict[str, dict[str, int]]` (`{"added": int, "removed": int}`). The bundle's per-file `loc` field would have been a dict where the annotation said int, and `lines_added` / `lines_removed` already carry the same churn information. Annotation removed; redundant field dropped.
- **Taxonomy comment referenced a bootstrap mirror that does not exist (PR #121, Bug Hunter B MED, also flagged by Premise reviewer).** A developer adding a signal would have looked for the (nonexistent) bootstrap mirror, found nothing, and either skipped the step or been confused. Comment now defers the mirror to Phase 9 explicitly.

### code-review v2.14.0

#### Added
- PLN-725 Phase 1 (Foundation): signal extraction stage for deterministic coverage routing. Lays the groundwork for specialized reviewers (e.g. `auth-security-expert`, `typescript-expert`) to be dispatched deterministically based on the contents of a diff rather than relying on a single reviewer to recall every concern. Shipped as foundation only — coverage routing remains unchanged on this version (matches the plan's Rollout Phase A: Shadow).
- `plugins/code-review/tools/python/signal_taxonomy.json`: canonical v1 taxonomy with 48 fixed signal names across 4 categories — `language` (14), `framework` (12), `concern` (18), `quality` (4). Each signal entry carries a `category`, `description`, and `recommended_min_confidence`. Adding a signal requires editing this checked-in asset; signal-extraction agents cannot invent new names.
- `plugins/code-review/tools/prompts/signal_extraction_prompt.txt`: prompt asset for the Haiku signal-extraction agent. Codifies the closed-vocabulary contract (rejection on invented names), evidence requirement (`<file>:<line> — <rationale>` form), the `0.7` confidence floor, the calibration ladder (`0.95+` direct evidence, `0.85–0.94` clearly inferred, `0.70–0.84` contextual inference), and the bias-toward-emission rule (a missed signal is much costlier than a false signal).
- `extract-signals-prepare` subcommand: reads `diff_data.json` + optional intent context, loads the taxonomy, computes the `signals` namespace cache key from `(diff_tip, taxonomy_hash, prompt_hash)`. On cache hit, writes the cached extraction straight to `<cr_dir>/extract_signals.json` and short-circuits the agent spawn. On miss, writes a bounded agent-input bundle (`extract_signals_input.json` capped at 25 files and 20 added/removed lines per file) plus a per-run taxonomy snapshot and a manifest describing the spawn contract.
- `extract-signals-consolidate` subcommand: validates LLM agent output against the taxonomy contract (closed vocabulary, evidence required, confidence in `[0.7, 1.0]`, no duplicate names) and writes the canonical `extract_signals.json`. Successful extractions are cached to the `signals/` namespace (7-day TTL per PLN-719); fail-closed outputs are not cached (next run gets a fresh attempt).
- `signals/` cache-namespace integration: uses the namespace and TTL already declared in `code_review_schema.py` (PLN-719 Section 9). Same TTL semantics, same content-addressed key contract as `verifications/`.
- Fail-closed coverage behavior per PLN-725 §2: any structural extraction failure (unreadable agent output, malformed JSON, every signal rejected) emits the full taxonomy at `0.5` confidence so best-effort routing over-triggers. Required reviewers are unaffected because the architecture forbids required rules from keying solely on LLM signals (Phase 2 work). A MEDIUM `Coverage` finding with `system_marker: "signal-extraction-failed"` is written to `agent_signal-extraction-failed.json` so the operator footer surfaces the degraded mode.
- 28 regression tests across 6 new test classes pinning the taxonomy structural contract, cache-key tuple invariants, validator rejection paths (invented name, empty evidence, missing evidence, sub-floor confidence, super-1.0 confidence, non-numeric confidence, duplicate names, non-object output, missing `signals` list), fail-closed set composition, CLI cache-hit / cache-miss paths, and consolidate ok / fail-closed / unreadable / partial-validity paths.

### code-review v2.13.2

#### Added
- PLN-727 Phase 1: restructured `/code-review:fix` skill from a uniform verify-and-edit flow into a category-dispatch system. Findings route to one of four buckets — `auto-fix`, `callsite-fix` (deferred to PLN-726), `specialized-fix` (deferred to PLN-723), or `manual-surface` — based on `category` / `subcategory`. Premise, `Hygiene/sensitive_files`, `InjectionAttempt`, `CompanionChange`, and `Coverage` findings route to manual-surface and never auto-apply.
- 14 manual-action templates under `plugins/code-review/skills/fix/templates/`: `premise_necessity.md`, `premise_cohesion.md`, `premise_workaround.md`, `premise_complexity.md`, `testquality_bug_locking.md`, `testquality_test_deletion.md`, `testquality_specialized.md`, `impact_semantic_change.md`, `companion_change.md`, `coverage_gap.md`, `injection_attempt.md`, `hygiene_sensitive.md`, `pending_verification.md`, and `_generic.md` (fallback). Each substitutes placeholders from the finding's `reasoning_certificate` and offers a `re-assert` escape hatch with the correct `--cache-dir` argument.
- `/code-review:fix` now writes `<CR_DIR>/fix_result.json` summarizing bucket counts (`auto_fixed`, `manual_surface`, `stale_findings`, `pending_verification_routes`, `deferred_callsite`, `deferred_specialized`, `build_validator_status`, `manual_action_required`, `duration_seconds`). Lets non-interactive callers act on the outcome without parsing stdout.
- 4 regression tests under `TestHygieneSubcategories` in `test_code_review_helpers.py` pinning the `subcategory` field on each of `_check_ci_artifacts`, `_check_path_leakage`, `_check_gitignore_drift`, and `_check_sensitive_files`. The sensitive-files test carries an explicit reference to the PR #120 review thread that surfaced the regression so the contract documentation lives next to its enforcement.

#### Changed
- `/code-review:fix` source is now `<CR_DIR>/review_result.json` only. The legacy `validate_output.json` fallback is removed; the canonical envelope has shipped on every full review run since PLN-719 Foundation Phase B (`stage_25_finalize_result` writes it; see `code_review_helpers.py:1599` / `start.md:293`).
- Removed the per-finding verification subagent from `/code-review:fix`. The skill now trusts `envelope.verified[]` as audited upstream by the verifier (PLN-722) and routes `envelope.pending_verification[]` entries to manual-surface with the `pending_verification.md` template.
- Default behavior in non-interactive contexts is now print-plan-and-exit; explicit `--apply` required for code modification. Replaces the prior auto-yes-after-5s timeout.
- Mandatory `code_snippet` drift check before any code-modifying fix. Mismatch tags the finding `STALE_FINDING` and routes it to manual-surface.
- New `/code-review:fix` flags: `--include-medium`, `--include-tentative`, `--include-justified`, `--dry-run`, `--apply`, `--category-only <name>`, `--skip-verification`.
- `/code-review:fix` exit-code contract is now three-valued: `0` (made automated progress or no findings), `1` (runtime error), `2` (manual action required — zero auto-fixes ran AND ≥1 manual-surface entry remains). Exit 2 is the new halt-the-loop signal for closed-loop callers.
- `cmd_hygiene`'s four producers (`_check_ci_artifacts`, `_check_path_leakage`, `_check_gitignore_drift`, `_check_sensitive_files`) now emit the corresponding `subcategory` field. This is the contract `/code-review:fix`'s dispatch table reads to distinguish safe-auto-fix Hygiene from sensitive-file manual-surface.

#### Fixed
- **Sensitive-file auto-edit regression (PR #120 review, thadeusb).** The Hygiene dispatch row for `subcategory == "sensitive_files"` never fired because the hygiene producers did not populate `subcategory` — `normalize_legacy_finding` defaulted it to `None`, so committed `.env`/`.pem`/`.key` findings (rated HIGH by `_severity_for_hygiene_file`) fell through to the catch-all row, which routed to auto-fix. The fix has two halves: producers now emit `subcategory` (see Changed above), and the Hygiene dispatch catch-all is flipped from auto-fix to manual-surface so any unrecognized subcategory fails safe.
- **`code_snippet` drift-check no-op for Hygiene (PR #120 review, thadeusb).** Hygiene producers do not populate `code_snippet`; the schema permits empty values and `normalize_legacy_finding` defaults to `""`. The drift check `grep -Fn "<first line of code_snippet>"` degenerated to `grep -Fn ""` which matches every line and trivially passed for the entire Hygiene auto-fix bucket. Stacked on the dispatch bug, nothing guarded a sensitive-file auto-edit. The drift check now applies an empty-snippet guard BEFORE the grep — empty/whitespace-only `code_snippet` tags the finding `MISSING_SNIPPET` and routes it to manual-surface.
- **`--include-justified` flag was a no-op (PR #120 review, thadeusb).** The flag was documented in the args table but never wired into Step 1's candidate set. Step 1 now adds `envelope.justified[]` to the candidate set when `--include-justified` is set; JUSTIFIED-VALID findings render manual-surface only and never opt into auto-fix.
- **Template `re-assert` command examples were missing the required `--cache-dir` flag (PR #120 review, thadeusb).** Following the example commands in any of the 9 templates that referenced `re-assert` produced an argparse error. Every template's `re-assert` example now includes `--cache-dir <CACHE_DIR>` with the resolution hint `<CR_DIR>/cache_config.json:cache_dir`.
- **`pending_verification.md` header concatenated `{category}` and `{subcategory}` with no separator (PR #120 review, shafty023).** A finding with category `Correctness` and subcategory `null-deref` rendered as `HIGH/Correctnessnull-deref`. Header now uses ` / ` consistent with `_generic.md`.
- **Closed-loop cycle regression for manual-surface-only outcomes.** With the new dispatch, manual-surface findings emit no code edits; the previous always-exit-0 contract caused `run-loop.sh` to burn its full `POST_LOOP_REVIEW_CYCLES` budget re-detecting the same findings every cycle without signalling that human action was pending. Exit 2 + `fix_result.json` give the harness an explicit halt signal (paired with `code` v1.12.4).

### code v1.12.4

#### Changed
- `run-loop.sh` now invokes `/code-review:fix $cr_dir --apply`. Required to preserve auto-apply behavior under `code-review` v2.13.2's new default-dry-run-in-non-interactive policy.

#### Fixed
- `run-loop.sh` `post_loop_review_fix` now branches on `code-review:fix` exit code 2 and halts the review-fix cycle with a clear "manual action required — N finding(s)" log message, sourcing the count from `<CR_DIR>/fix_result.json`. Previously the loop continued re-running review+fix on manual-surface-only outcomes, wasting cycles. Requires `code-review` v2.13.2+; coordinated cross-plugin release.

### code-review v2.12.2

#### Fixed
- **PLN-779 scope de-restriction now propagates to the prompt-template wrapper in `commands/start.md` (PR #118 post-merge review, thadeusb).** PLN-779 v2.12.1 edited `shared_prompt.txt` / `premise_prompt.txt` / `bha_suffix.txt` to reframe the diff as the trigger (not a hard boundary), but the orchestrator's per-agent template wrapper at `start.md:378` still emitted `Review ONLY the changed code. ... You may ONLY report findings for files in <files_assigned> below — no exceptions.` directly in every Task call. For partitioned BHA (`>5K LOC` PRs), `<files_assigned>` is a strict subset of the diff and the wrapper's "no exceptions" directly contradicted shared_prompt.txt's new "diff is the TRIGGER, findings on unchanged code the diff demonstrably broke are in scope" framing. Wrapper now defers to `shared_prompt.txt`'s FILE SCOPE rules and references the CAUSATION step explicitly. For unified-mode BHA (`≤5K LOC`) and BHB/Auditor/Premise/Domain/fast-path (which receive ALL diff files in `<files_assigned>`), wrapper semantics are unchanged in practice — the fix removes the textual contradiction that confused reviewers in partitioned mode.
- **BHB suffix `start.md:423` and fast-path PASS 2 `start.md:576` "discard a bug in an unassigned file while exploring" directives reworded to align with shared_prompt.txt FILE SCOPE.** New wording: findings must concern code AFFECTED by this change — files in `<files_assigned>` including unchanged lines the diff demonstrably broke; bugs in entirely unrelated files (outside `<files_assigned>`) remain out of scope and should surface in a separate PR. Semantics identical to before for BHB and fast-path (their `<files_assigned>` is always the full PR file set), but the phrasing no longer fights the per-reviewer FILE SCOPE block.

### code-review v2.12.1

#### Changed
- **Reviewer prompt scope reframed: the diff is now the trigger for review, not a hard boundary on what can be reported.** `shared_prompt.txt` FILE RESTRICTION block becomes a FILE SCOPE block; the seven-gate FLAG list collapses to six gates by deleting "The line exists in the diff (added or modified line)" and reframing the file-restriction gate to allow findings on unchanged files/lines that the diff demonstrably broke; the seventh-gate evidence requirement updates from "from the diff" to "from the changeset OR the code it affects".
- `shared_prompt.txt` Do-NOT-flag bullet "Issues in files not listed in <files_assigned> — even if real" reframed to "Issues in entirely unrelated files not affected by this change — even if real". All four precision gates (pre-existing-bug filter, linter-catchable filter, general-quality-concerns filter, hypothetical-edge-case filter) are unchanged.
- `shared_prompt.txt` example block: `<example name="bad-out-of-scope">` (which trained the model to "discard — even though the bug is real" when a real bug was found outside `<files_assigned>`) replaced with a contrasting pair: `<example name="good-finding-on-unchanged-line">` (a finding on an unchanged line that the diff demonstrably broke — emit) and `<example name="bad-finding-on-unrelated-file">` (a real bug in a file entirely unrelated to the PR — discard). The original example's "Another agent partition covers that file" framing is also factually wrong under PLN-774 unified mode.
- `shared_prompt.txt` chain-of-thought reasoning sequence: deleted "Is the line in the diff (added or modified)? (If NO -> discard)" (the most damaging gate, because it ran every time the model considered a finding); reframed "Is the file in my <files_assigned> list?" to allow broken-but-unchanged files; added a new CAUSATION step that requires the model to cite the specific diff change that caused the finding when the finding line is not in the diff (the new precision control that replaces the deleted line-in-diff gate).
- `premise_prompt.txt` knock-on phrasing: "All other shared prompt constraints (file in scope, discrete and actionable, concrete evidence cited from the diff) still apply" → "All other shared prompt constraints (file scope, discrete and actionable, concrete evidence cited from the changeset or the code it affects) still apply". Keeps the premise reviewer's inherited-constraints recap in sync with the new `shared_prompt.txt` wording.
- `bha_suffix.txt` role identity: "You are Bug Hunter A — a diff-only reviewer focused on correctness" → "You are Bug Hunter A — a correctness reviewer triggered by this diff. The diff is your attention trigger, not a boundary on what you can report: surface bugs in unchanged code that the diff demonstrably broke. See the FILE SCOPE rules in the shared prompt above for the full contract." Removes the "diff-only reviewer" framing at the role-identity level. All BHA reasoning-certificate methodology (PREMISE / TRACE / DIVERGENCE / GUARD CHECK / CONCLUSION) is untouched.

### code-review v2.12.0

#### Added
- New `bha_unified_threshold_loc` operator knob in `.closedloop-ai/settings/code-review.json`. PRs with total changed LOC at or below the threshold (default 5000) get a single BHA partition; PRs above continue to bin-pack at `REBALANCE_LOC_BUDGET` (1200). Setting the value to `0` disables unified mode (always-partition). Invalid entries fall back to the default.
- New `BHA_UNIFIED_THRESHOLD_LOC` constant + `_load_code_review_settings` helper in `code_review_helpers.py`.
- New `_emit_partitions` helper in `code_review_helpers.py` shared between the unified-mode early-return path and the standard bin-pack path.
- `partitions.json` top-level keys: `partition_mode` (`"unified"` | `"partitioned"`), `partition_count`, `total_changed_loc`, `unified_threshold_loc`.
- `verify_manifest.json` keys: `partition_mode`, `partition_count`. `cmd_verify_prepare` reads `partitions.json` and propagates the two fields; absent/malformed → `partition_mode="unknown"`, `partition_count=0` (back-compatible with hygiene-only runs and pre-PLN-774 caches).
- "Partition mode" line in local-mode Verifier Stats footer (`skills/present-local/SKILL.md`) and GitHub Step 6e (`prompts/github-review.md`). Both presenters omit the line when `verify_manifest.json` is absent.
- `commands/start.md` `stage_17_partition` per-stage note documents the new partitions.json keys and threshold semantics.
- README Configuration section documents the new `.closedloop-ai/settings/code-review.json` file and the `bha_unified_threshold_loc` knob.
- 18 new tests under `TestUnifiedPartitionThreshold`, `TestLoadCodeReviewSettings`, `TestVerifyManifestPartitionPropagation`, and `TestPartitionAwareReviewerLabeling` covering: threshold inclusive boundary, above-threshold bin-pack, kill switch (0), empty-diff guard, partitions.json telemetry fields, settings loader (default / operator override / zero / negative / wrong-type / bool rejected), manifest propagation (unified / partitioned / missing→unknown), and the by-reviewer labeling contract.

#### Changed
- `TestPartition._run_partition` and `TestPartitionPostProcessing._run_partition` test helpers default `bha_unified_threshold_loc=0` so existing bin-pack tests preserve their semantics. The new `TestUnifiedPartitionThreshold` class flips the threshold on to exercise the unified-mode branch.
- `TestUnifiedPartitionThreshold._run` delegates to `TestPartition._run_partition` rather than duplicating the stdin/stdout/Namespace fixture.
- `test_partitions_json_is_top_level_dict_not_list` regression test now pins the expanded top-level key set so future drift surfaces in the same commit.

### code-review v2.11.1

#### Fixed
- **Unbalanced code fence in `skills/present-local/SKILL.md`.** A stray closing fence after the Summary section (inherited from the original inline `start.md` block) left an odd fence count, causing CommonMark parsers to swallow the **Consolidated Finding Format** template as code-block content. Removed the orphan fence; fences now pair cleanly.
- **Template-vs-instruction ambiguity in the presenter.** Added a 3-line convention legend (`##` headers = report structure, fenced blocks = emit-verbatim card templates, `[bracketed]`/`{BRACED}` = instructions) and fenced the Repo Hygiene and BLOCKING finding-card templates so they match the style already used by the Justified/Dismissed/Verifier Stats sections.
- **Severity-normalization warning relocated.** Moved the `normalization_warnings > 0` note from the top of the skill into the Validation Summary section, where its "append after the summary list" placement instruction is self-evident.

### code-review v2.11.0

#### Added
- **New `code-review:present-local` skill.** Local-mode presenter content (BLOCKING/HIGH/MEDIUM section templates, Justified Findings (PLN-721), Dismissed Findings (PLN-722), Verifier Stats footer (PLN-773), operator-flag descriptions, override precedence rule, Validation Summary, final Summary) moved out of `commands/start.md` into `skills/present-local/SKILL.md`. The orchestrator explicitly invokes the skill at `stage_29_present` when `MODE=local`. Establishes the decomposition pattern for the rest of the start.md monolith (operator-flag skills, fast-path skill, agent-prompts skill — pending follow-up work).

#### Changed
- **`commands/start.md` reduced from 1014 → ~775 lines (~24% smaller).** Pointer block at the former local-mode presenter location scopes the skill invocation to `MODE=local` only. The Gate A hygiene presentation format stays inline in start.md (mode-agnostic — fires in both `MODE=local` and `MODE=github`); only the local-mode `stage_29_present` pipeline is delegated to the skill. No behavior change for operators — the orchestrator still produces the same output.
- **GitHub-mode Validation Stats expanded to mirror local-mode parity.** `prompts/github-review.md` Step 8 previously surfaced only `Agent failures` and `Cross-file grouped` to PR reviewers; the local mode's full discard-reason breakdown (Total / Validated / Discarded by file/line/confidence/validation reason / Duplicates merged / Cross-file grouped / Downgraded to MEDIUM / Hygiene findings) is now also rendered in the GitHub Summary. Operators auditing reviewer accuracy from a PR no longer have to read local logs. Pre-PLN-722 runs (no `findings_validated.json`) fall back to the original two-line stats so back-compat holds.
- **Walker dispatch references updated to point at the new skill (PR #115 review, thadeusb).** The skill extraction renamed the headings the walker contract dispatches to, but four references in start.md still pointed at the old "Local Mode: Present Results" heading: the Execution Model bullet (~line 45), the `kind: present` dispatch rule (~line 183), Gate A step 3's "Hygiene Findings" format reference (~line 206), and the stage_29_present per-stage note (~line 296). An orchestrator following the walker contract literally would never have been told to invoke the new skill — "no behavior change" was not actually true. All four references now point at `code-review:present-local` or the exact new heading "Hygiene Findings Format (Gate A render target)".
- **GitHub-mode `--no-verify` audit banner now also prepended to `code-review-summary.md`.** Previously the banner only landed in `code-review-verifier-stats.md` (Step 6e), which the workflow posts as a separate comment with collapsible `<details>`. A PR reviewer reading only the Summary comment could miss that the verifier was bypassed. Step 8 now duplicates the banner onto the Summary file so the audit signal rides the most-visible comment — same content as the verifier-stats banner; intentional duplication.

### code-review v2.10.1

#### Fixed
- **Override hits now reach `verified[]` with `verifier_verdict == "RE_ASSERTED"` end-to-end (PR #114 review, thadeusb — HIGH).** `cmd_verify_prepare` recorded the fid in `override_hits[]` and wrote the synthesized stub on disk, but `cmd_verify_consolidate` only read `agent_verifier_<fid>.json` when the fid was in `to_verify_ids` or `cache_hit_ids`. Override fids matched neither set and fell through as tier-skips with `verifier_verdict=None`. Net effect: every override silently dropped its `RE_ASSERTED` verdict on the integration path, so `stats.verification.by_reviewer[*].re_asserted` always reported 0 even while the footer's `override_hits` line reported N honored — the two numbers openly disagreed in the same report. Consolidate now extracts `override_hit_ids` from the manifest and folds them into the same read-back branch as `cache_hit_ids` (no special-case branch). Cache write-back skips both `cache_hit_ids` AND `override_hit_ids` so a synthesized stub never corrupts the verifications/ cache. Same fix repairs the `--review-dismissed` path since `REVIEW_DISMISSED` overrides ride the same prepare→consolidate channel.
- **`CACHE_TTL_DAYS["overrides"]` (90 days) is now enforced (PR #114 review, thadeusb — MED).** Constant was declared in `code_review_schema.py` but neither `_load_override` nor `_override_is_valid` checked `asserted_at` against it. New `_override_is_expired` helper sweeps on read; both the content-hash and system-scope branches now run through it. Defensive: missing/unparseable `asserted_at` returns "not expired" so pre-fix overrides written without enforcement do not silently drop after upgrade.
- **`cmd_re_assert` no longer silently no-ops on system-scoped findings (PR #114 review, local HIGH).** When a finding had no `file` / `line` (system-scoped reviewer output — e.g. injection-detector, agent-auditor), `_file_content_hash` returned `""` and the resulting override was rejected at promotion time by `_override_is_valid`'s "no hash anchor" guard. New `_OVERRIDE_SYSTEM_SCOPE_SENTINEL = "SYSTEM_SCOPE"` is written for system-scoped findings; `_override_is_valid` honors the sentinel as long as the finding ALSO lacks file/line (defensive — refuses to promote a file-scoped finding via a system-scope override).
- **`cmd_re_assert` now reports `already_dismissed[]` for findings in `justified[]` (PR #114 review, local MED).** Re-asserting a JUSTIFIED-VALID finding silently re-routed it through `verified[]` on the next run, erasing the justification record. New explicit bucket alongside `already_verified[]` so the operator sees the no-op rather than getting a success summary that doesn't match observed behavior.
- **Documented re-assert's best-effort behavior against finding_id drift (PR #114 review, thadeusb — MED).** Finding IDs are `<reviewer>_f<index>` where `<index>` is the reviewer's emission position; across re-runs the LLM may reorder/drop findings so an override written for `bha_f3` on run N may map to a different finding on run N+1. README `Override Flow (PLN-773)` section now spells out the caveat and points operators to inspect `override_hits` / `override_invalidated` in the verify-prepare manifest to confirm the override landed. (No code change — anchoring on a content-stable id would require a wider schema change; mitigations documented inline.)
- **`commands/start.md:889` schema field name (`tentative` → `tentative_count`).** Render template referenced the wrong field name (`stats.verification.tentative` does not exist — the schema's key is `tentative_count`). Now matches `github-review.md:272`.

#### Changed
- **Test helpers `_run_verify_prepare` / `_run_verify_consolidate` accept an optional `cr_dir`.** End-to-end tests that share a `cr` directory between prepare and consolidate can pass the same path to both helpers; defaults preserved for single-phase callers. `_run_verify_prepare` also gains `no_verify` / `no_verify_reason` params so `TestNoVerifyBypass` and `TestOverrideCache` no longer duplicate the per-test stdout-capture + Namespace dance.

#### Added
- **6 new regression tests under `TestPR114ReviewFixes`** covering: end-to-end prepare+consolidate routing override to `verified[]`; per-reviewer `re_asserted` counter increments correctly through both phases; `already_dismissed` no-op against `justified[]` bucket; system-scoped re-assert writes the SYSTEM_SCOPE sentinel and `_override_is_valid` honors it; over-TTL overrides are invalidated; within-TTL overrides still honor (negative control).

### code-review v2.10.0

#### Added
- **PLN-773 — Verifier Override Flow + Premise/Verification Telemetry.** Consolidates the deferred scope from PLN-721 (Phase 7 — Premise telemetry, `--justified-only`) and PLN-722 (Phase 5 — Override Flow, Phase 8 — Verifier Telemetry). Closes the operator-facing surface gaps both prior plans left open: the override flow (so an operator can falsify a wrong dismissal) and the telemetry surface (so the operator can see when the verifier or the justification hatch is misbehaving). Together these are the last orchestrator-side work before 2-round auto-merge is mechanically defensible.
- **`RE_ASSERTED` canonical verdict.** New additive value in `VERIFIER_VERDICTS` (`code_review_schema.py`). A finding with `verifier_verdict: "RE_ASSERTED"` lives in `verified[]` and was promoted there by an operator override (`--re-assert` or `--review-dismissed`), bypassing fresh verification. The override is keyed on file-content hash so content drift auto-invalidates. Schema validator accepts the new verdict via `validate_result_envelope`; envelope round-trip test pins the contract.
- **Override cache namespace (`<CACHE_DIR>/overrides/<finding_id>.json`).** New `_load_override` / `_write_override` / `_override_is_valid` / `_file_content_hash` helpers (`code_review_helpers.py`). `cmd_verify_prepare` checks the overrides namespace BEFORE the verifications/ cache so an operator override short-circuits both the cache check and the agent spawn. Hash drift on the cited line ±20 (matching the verifier prompt's EXISTENCE-check window) auto-invalidates the override; verifier runs normally and the manifest's new `override_invalidated[]` field records the event. Manifest gains `override_hits[]` / `override_invalidated[]` telemetry fields and `total_eligible` now includes override hits.
- **`cmd_re_assert` subcommand (`re-assert`).** `--cr-dir`, `--cache-dir`, `--finding-ids <id>[,<id>...]`, optional `--reason`, optional `--asserted-by`. Reads prior `review_result.json`, locates each finding (in `rejected[]` / `pending_verification[]` / `verified[]`), computes the current file-content hash, and writes an override file. Stdout summary documents which ids were promoted (`re_asserted`), which were no-ops (`already_verified`), and which were not found (`not_found`). Synthesizes a `RE_ASSERTED` verifier output stub so `cmd_verify_consolidate` treats the override as a fresh verdict without a special-case branch.
- **`cmd_review_dismissed_prepare` + `cmd_review_dismissed_consolidate` subcommands.** Two-phase second-opinion flow: prepare writes per-finding inputs at `<CR_DIR>/review_dismissed_inputs/<finding_id>.json` and a manifest pinned to the haiku model (cross-model independence — different from the default sonnet verifier so the second pass gives an independent vote). Consolidate reads the haiku-verifier outputs, auto-promotes any non-`REJECTED` verdict via a `REVIEW_DISMISSED` override (same shape as `--re-assert`, distinguishable by the `override` field), and writes a side-by-side diff to `<CR_DIR>/review_dismissed_diff.json` with `{promoted, no_change, missing_output}` stats. Sensitive-path tags still apply on the new verdict — `mandatory_human_review_paths` still forces TENTATIVE regardless.
- **`--no-verify` emergency-bypass flag on `cmd_verify_prepare`.** Every eligible finding lands in `skipped_no_verification[]` so `cmd_verify_consolidate` routes the whole set to `verified[]` with `verifier_verdict: null`. **Requires `--no-verify-reason='<why>'`** — emergency bypass is never silent; the reason is recorded in the manifest and echoed in the operator-facing footer's audit banner. Manifest gains `no_verify: bool` and `no_verify_reason: str` fields downstream consumers can key on without a missing-key check.
- **Premise telemetry sub-blocks in `review_result.json.stats`** (closes PLN-721 Phase 7):
  - `stats.justification` — `rate` (justified / total Premise), `rejection_rate` (JUSTIFIED-INVALID / total justified), `total_premise`, `justified_emitted`, `justified_valid`, `justified_invalid`, `threshold_alert` (true when `rate > justification_rate_alert`). NaN-safe: empty inputs return zeros. JUSTIFIED-VALID in `justified[]` AND JUSTIFIED-INVALID in `verified[]` both count for the denominator.
  - `stats.by_subcategory` — counts of Premise findings in `verified[]` partitioned by `subcategory`. Pinned to the canonical four (`necessity`, `cohesion`, `workaround`, `complexity`); typos in reviewer output are silently dropped so a single misspelling cannot pollute the bucket set.
  - `stats.verification.by_reviewer` — per-reviewer `{verified, rejected, re_asserted, fp_rate}` where `fp_rate = rejected / (verified + rejected)` and `re_asserted` counts overrides honored on this run. The inverse health metric: a high `fp_rate` AND high `re_asserted` flags reviewers operators are correcting back.
- **`justification_rate_alert` config knob in `verdict-thresholds.json`.** Default `0.30` (PLN-721 §Telemetry — "if > ~30%, authors likely gaming the hatch"). Float in `[0.0, 1.0]`; values outside the range or wrong type fall back to the default. `_load_verdict_thresholds` gains polymorphic per-key validation (int with `≥ 1` floor for `premise_cumulative_medium`, float with range for `justification_rate_alert`).
- **Pending-learnings jsonl writers with `fcntl.flock`.** New `_pending_learnings_append` helper serializes appends so N concurrent runs each get exactly one well-formed JSON line per event — no corruption, no interleaving. `cmd_verify_consolidate` appends to `.closedloop-ai/pending-learnings/premise-justifications.jsonl` for every JUSTIFIED-INVALID verdict so `self-learning:process-learnings` can tune the verifier's J2 (responsiveness) threshold over time. `cmd_re_assert` appends to `.closedloop-ai/pending-learnings/verifier-overrides.jsonl` for every override so over-rejection patterns per reviewer become observable. Best-effort: failure to write does not affect the verdict path. Tests pin concurrent-write safety with 10 threading.Thread writers and assert all 10 thread_ids land exactly once with no JSON corruption.
- **Verifier Stats footer in local-mode presenter** (`commands/start.md`). New section below Dismissed Findings rendering per-reviewer FP rate + override counters, the justification rate + rejection rate, and the Premise MEDIUM cumulative count vs threshold. Audit banner for `--no-verify` runs (with the operator-supplied reason). One-line override telemetry summary when `override_hits` or `override_invalidated` are non-empty.
- **Operator-flag documentation in `commands/start.md`.** New subsection documenting `--justified-only` (presenter filter), `--re-assert` (calls `re-assert` subcommand), `--review-dismissed` (two-phase haiku second-opinion), `--no-verify` + `--no-verify-reason` (emergency bypass), plus mutual-exclusion enforcement and the override precedence rule for stage_22b (overrides/ checked BEFORE verifications/).
- **Step 6e in `prompts/github-review.md`.** Writes `.closedloop-ai/code-review-verifier-stats.md` with a collapsible `<details>` block carrying the same stats as the local-mode footer. Posted as a single comment so the metrics are visible to PR reviewers without polluting inline comments. Audit banner for `--no-verify` runs prepended outside the `<details>` for visibility.
- **README Configuration + Override Flow sections** documenting `justification_rate_alert` and the three new operator flags. Cross-references to `verification-gates.json` (PLN-722) so all operator-tunable knobs live under one section.
- **Autouse pytest fixture `_isolate_pending_learnings` (conftest.py)** redirects the module-level pending-learnings base dir to `tmp_path` for every test so the suite cannot pollute the real repo's `.closedloop-ai/pending-learnings/` directory. Caught during Phase 6 by an integration test that accidentally wrote a real event file; the fixture prevents the regression class entirely.
- **40+ new tests** across schema (RE_ASSERTED enum + sub-block round-trip), telemetry stats (NaN-safe edge cases, threshold toggle, by_subcategory canonical-only buckets, per-reviewer FP rate + RE_ASSERTED counting), override cache (file-hash stability + drift, write/load round-trip, valid-vs-drift, verify-prepare short-circuit + fall-through), `--no-verify` (reason-required gate, all-skipped routing, false-flag default-empty audit fields), `re-assert` (promote from rejected, no-op when verified, not-found, empty-id error, multi-id batch), `--review-dismissed` (haiku manifest, auto-promote, no_change, missing_output), pending-learnings (single-line append, multi-call, parent-dir creation, concurrent safety, end-to-end JUSTIFIED-INVALID wiring).

#### Fixed
- **Rule 4 (cumulative Premise MEDIUM) no longer excludes `JUSTIFIED-INVALID` findings (PR #113 review, thadeusb).** v2.9.0 and v2.9.1 treated `JUSTIFIED-VALID` and `JUSTIFIED-INVALID` symmetrically — both excluded from the gate's count. That was backwards: `JUSTIFIED-VALID` means the verifier *accepted* the author's defense and the finding is dismissed (correctly excluded — lives in `justified[]`, not `verified[]`); `JUSTIFIED-INVALID` means the verifier *refused* the defense and the original concern survives, so it must count toward the gate the same way a plain `CONFIRMED` would. As shipped in v2.9.0/v2.9.1, three MEDIUM Premise findings the author tried to wave off — and the verifier then refused — would not trip the cumulative gate, while three plain MEDIUM findings would. `_count_gateable_premise_medium` now excludes only `JUSTIFIED-VALID`; the docstring spells out the asymmetry. The previous `test_justified_invalid_excluded_from_count` is renamed to `test_justified_invalid_counts_concern_survived` and asserts `NEEDS_ATTENTION`; new `test_valid_vs_invalid_are_asymmetric` pins the per-helper count delta directly. The shared-counter telemetry invariant still holds (Rule 4 and `premise_cumulative_medium_count` agree on the new policy).

### code-review v2.9.1

#### Fixed
- **`verifier_prompt.txt` J1/J2 vs fall-through emission contradiction (PR #113 review MED, CONFIRMED 0.88).** v2.9.0's justification audit instructed the verifier to emit `JUSTIFIED-INVALID` and fall through to the six-check protocol on J1 / J2 failures, but the "After the justification audit" block stated the opposite: on the fall-through path the final verdict is whatever the six checks produce (CONFIRMED / DOWNGRADE / TENTATIVE / REJECTED) — **not** `JUSTIFIED-INVALID`. Same contradiction on the Premise subcategory-specific check ("→ JUSTIFIED-INVALID even if J2 looked plausible"). Rewrote J1 / J2 and the Premise subcategory bullet to describe the audit failure state (`J1 fails` / `J2 fails`) without naming a verdict to emit; the "After the justification audit — verdict emission rules" block is now the single source of truth for emission. `JUSTIFIED-INVALID` is reserved in the enum for a future extension; no current code path emits it. Updated the top-of-file role description and the Output Rules block to match.
- **`premise_cumulative_medium_count` telemetry now matches the count Rule 4 fires on (PR #113 review MED, CONFIRMED 0.9).** v2.9.0's Rule 4 verdict gate excluded `verifier_verdict in {JUSTIFIED-VALID, JUSTIFIED-INVALID}` from its count, but the telemetry stat in `_stats_from_findings` did not — operator-reported `premise_cumulative_medium_count` could overcount by 1+ relative to the value Rule 4 actually triggered on, especially in any future scenario where JUSTIFIED-INVALID lands in `verified[]`. Extracted the counting policy into a new module-level `_count_gateable_premise_medium(verified)` helper that owns the exclusion logic; both `_compute_canonical_verdict` Rule 4 and `_stats_from_findings` now delegate to it. New parametrized regression `test_telemetry_count_matches_rule_4_count` pins the invariant across the five `verdicts` shapes (all-CONFIRMED, JUSTIFIED-VALID leak, JUSTIFIED-INVALID leak, DOWNGRADE mix, all-justified) that triggered the divergence.
- **`cmd_verify_consolidate` docstring output-shape no longer omits the `justified[]` bucket (PR #113 review HIGH, CONFIRMED 0.97).** v2.9.0 added the `justified[]` bucket and `justified_count` stat to `findings_verified.json` but did not update the docstring at lines 2007–2024 that documents the output shape. The CLAUDE.md Learned Pattern explicitly flags this: "audit adjacent comments and docstrings for accuracy — remove or update references to non-existent files, incomplete field lists, or scope descriptions narrower than actual behavior." Added `justified` and `justified_count` to the documented shape; clarified that `verified[]` may also carry the reserved (currently unemitted) `JUSTIFIED-INVALID` verdict for future extensions.
- **DRY: extracted `_load_optional_settings_dict` shared frame for operator-settings loaders (PR #113 review MED, CONFIRMED 0.88).** `_load_verdict_thresholds` and `_load_verification_gates` shared ~70% structural similarity — both checked `if path is None: return defaults`, called `_read_optional_json(path, None)`, gated on `isinstance(data, dict)`, built a fresh defaults copy, then iterated canonical keys. The new helper owns "open optional operator JSON, return `(data_or_None, fresh_defaults_copy)`"; each loader layers per-key validation on top. No behavior change — the v2.9.0 contract is preserved byte-identically.

### code-review v2.9.0

#### Added
- **PLN-721 — Premise Reviewer Hardening (Option B slice).** Restructures the Premise Reviewer around four well-defined subcategories — `necessity` (non-existent bug fix / fictional threat model / regressive fix), `cohesion` (duplicate abstraction / naming drift / layering violation), `workaround` (symptom suppression / caller-side normalization with an identifiable in-repo root cause), and `complexity` (machinery whose use-site count cannot justify it). Every Premise finding must now emit a `reasoning_certificate` whose `kind` matches its `subcategory` and whose fields document the claim chain (e.g., `necessity.counter_evidence[]`, `cohesion.prevailing_pattern.examples[]` ≥ 5 (≥ 1 for duplicate-abstraction), `workaround.root_cause_location`, `complexity.use_site_count` + `sites[]`). Findings without a populated certificate matching the subcategory are rejected by the verifier as malformed.
- **New `premise_prompt.txt` per-run asset.** The Premise Reviewer's prompt is now an external asset on the same contract as `verifier_prompt.txt` — `cmd_prep_assets` copies it from `tools/prompts/premise_prompt.txt` to `<CR_DIR>/premise_prompt.txt`, and `cmd_compute_hashes` gains an optional `--premise-prompt` flag that folds its bytes into `<PROMPT_HASH>` so prompt edits bust both the BHA cache and the `verifications/` cache namespace. Back-compatible: callers that omit the flag produce a hash byte-identical to v2.8.1. `start.md` Reviewers table and both Premise prompt blocks (standard flow and Fast Path) now delegate to the asset instead of inlining the prose. `shared_prompt.txt` advertises the optional `subcategory`, `reasoning_certificate`, `justified`, and `justification` canonical fields with a note that the validator preserves them through the pipeline.
- **MEDIUM allowance + cumulative-3 verdict gate (Rule 4).** Premise findings may now be emitted at MEDIUM (P2) in addition to BLOCKING/HIGH — a single MEDIUM does not block, but ≥ 3 verified MEDIUM Premise findings on the same PR trigger `NEEDS_ATTENTION` even when no individual finding is HIGH. The threshold is operator-tunable via the new `.closedloop-ai/settings/verdict-thresholds.json` config (key: `premise_cumulative_medium`, default `3`). `_compute_canonical_verdict` gains an optional `thresholds` kwarg; both `cmd_finalize_result` and `cmd_verdict`'s fallback path load thresholds via the same default-or-override pattern as `verification-gates.json`, so the gate behaves consistently across both entry points. The gate counts only `verified[]` findings and excludes any whose `verifier_verdict` is `JUSTIFIED-VALID` / `JUSTIFIED-INVALID`; DOWNGRADE findings count at their corrected severity (consistent with v2.8.1's `_merge_verifier_fields` reconciliation).
- **Justification Escape Hatch + verifier justification audit.** Reviewers (Premise and any other category) may flag a finding with `justified: true` and a populated `justification` object when the author left an inline comment, PR body paragraph, or commit message that directly addresses the specific concern. Findings carrying a justification are NOT discarded by the reviewer — instead, the verifier runs a dedicated audit pass BEFORE the six standard checks: J1 (existence — the cited source actually contains the claimed comment) and J2 (responsiveness — the justification engages with the specific failure mode, not a generic disclaimer). Premise findings get extra subcategory-specific strictness (e.g., a `complexity` justification must cite expected near-term use-site growth). Two new verifier verdicts: `JUSTIFIED-VALID` (audit passed; finding lands in `envelope.justified[]` for transparency but does not block or escalate) and `JUSTIFIED-INVALID` (audit failed; finding stays in `verified[]` with original severity — or the verifier may fall through to the six-check protocol and emit whatever it produces). `cmd_verify_consolidate` routes `JUSTIFIED-VALID` into a new `justified[]` bucket at the consolidate boundary; `cmd_finalize_result` populates `envelope.justified[]` from that bucket; the `stats.by_reviewer` aggregation gains a `justified` counter; the consolidate stats block gains `justified_count`. Sensitive-path tags (`mandatory_human_review_paths` etc.) outrank both JUSTIFIED-* verdicts — the operator's "always-tentative" tag wins and the finding is escalated to TENTATIVE regardless.
- **Justified Findings output surface.** `start.md` gains a `## Justified Findings (PLN-721)` presenter section in local mode, rendered verbose-by-design (operator must see what the verifier let through on the author's defense), capped at 20 displayed with a pointer to `review_result.json.justified[]` for overflow. `github-review.md` gains Step 6d that writes `.closedloop-ai/code-review-justified.json` and `.closedloop-ai/code-review-justified-summary.md` with collapsible `<details>` blocks per finding; the workflow posts these as a separate "ℹ️ N findings justified by author" PR comment so they do not pollute inline review comments. Both surfaces note the sensitive-path interaction explicitly: a finding lifted from `JUSTIFIED-VALID` to `TENTATIVE` by a sensitive-path tag appears in the primary BLOCKING/HIGH/MEDIUM sections with a `[verifier uncertain — sensitive path]` annotation, NOT in the Justified Findings section.
- **README Configuration section.** `plugins/code-review/README.md` gains a `## Configuration` section documenting `verdict-thresholds.json` (PLN-721 key + effect + default + disable trick) and a cross-reference to `verification-gates.json` (PLN-722). All operator-tunable knobs now live under `.closedloop-ai/settings/`; absent or malformed files fall back to built-in defaults.

### code-review v2.8.1

#### Fixed
- **Sensitive-path BLOCKING severity cap is no longer dead code (PR #111 review HIGH #1, bha_p0).** `cmd_verify_consolidate`'s sensitive-path escalation set `finding["verifier_severity"] = "HIGH"` on a REJECTED-BLOCKING-then-escalated finding but left `finding["severity"]` as `"BLOCKING"`. `_compute_canonical_verdict` reads `severity` (not `verifier_severity`) for Rule 2's BLOCKING short-circuit, so the escalated finding still routed to `CHANGES_REQUESTED` — much stronger than a REJECTED-then-escalated finding should ever produce, and the documented HIGH cap had no effect on the verdict. Now lowers both canonical `severity` and `verifier_severity` on escalation. New verdict-level assertion in `test_sensitive_path_escalates_rejected_blocking_to_tentative` pins that the escalated finding produces `NEEDS_ATTENTION`, not `CHANGES_REQUESTED`.
- **DOWNGRADE verdict now reconciles canonical severity (PR #111 review HIGH #1 broader scope, bha_p0).** The same `severity` vs `verifier_severity` asymmetry made DOWNGRADE inert at the verdict layer: a verifier knocking BLOCKING down to MEDIUM still left `severity="BLOCKING"`, so Rule 2 short-circuited to `CHANGES_REQUESTED` regardless. The verifier prompt explicitly promises "the finding still counts toward verdict — at the corrected severity"; v2.8.0 broke that promise. `_merge_verifier_fields` now overwrites `severity` when the verdict is DOWNGRADE and `verifier_severity` is in the canonical `SEVERITIES` enum (defense: an invalid `verifier_severity` leaves the original untouched). Two regressions: `test_downgrade_reconciles_canonical_severity` and `test_downgrade_with_invalid_severity_does_not_rewrite`.
- **`tentative_on_paths` gate now handles REJECTED (PR #111 review HIGH #2, bhb).** v2.8.0's inner condition was `verifier_verdict in (None, "CONFIRMED", "DOWNGRADE")` — REJECTED was omitted. A REJECTED finding on a path the operator had flagged for "always-tentative" treatment landed in `verified[]` with `verifier_verdict="REJECTED"` and `rejection_class` intact: simultaneously "disproved" and in the legitimate bucket, triggering `NEEDS_ATTENTION` via Rule 3 while being absent from the Dismissed Findings presenter section. Now treats REJECTED the same way the `sensitive_paths` gate does — converts to TENTATIVE and clears `rejection_class`. New regression test `test_rejected_on_tentative_on_paths_lifts_to_verified`. The doc comment on `_VERIFICATION_GATE_KEYS` was also misleading ("any finding → TENTATIVE") and now spells out the actual per-gate semantics.
- **Verifier cache key now invalidates on `verifier_prompt.txt` edits (PR #111 review HIGH #3, bhb).** v2.8.0's CHANGELOG promised "a prompt rev invalidates everything globally", but `cmd_compute_hashes` only hashed `shared_prompt.txt` + `bha_suffix.txt` — editing `verifier_prompt.txt` left `<PROMPT_HASH>` unchanged, so stale verifier verdicts were served from the `verifications/` cache namespace. Added an optional `--verifier-prompt` flag to `cmd_compute_hashes`; when supplied (always, in the run plan after this fix), the verifier prompt bytes fold into the canonical `prompt_hash`. Back-compatible: callers that omit the flag produce a hash byte-identical to v2.8.0, so existing cache entries stay valid across the upgrade. Run plan now passes `--verifier-prompt <CR_DIR>/verifier_prompt.txt` to `stage_18_compute_hashes`. Two new regressions: `test_verifier_prompt_changes_hash` and `test_omitting_verifier_prompt_matches_pre_v2_8_1_hash`.
- `cmd_finalize_result` docstring referenced a non-existent `--no-verify` flag (PR #111 review MED #4, auditor). Replaced with "verify-prepare/consolidate infrastructure failure". The `--no-verify` override is planned for v2.9.0, not v2.8.x.
- `start.md` § stage_22b note mis-named the verification cap constant (PR #111 review MED #5, auditor). `MAX_VERIFICATIONS = 50` → `VERIFY_MAX_VERIFICATIONS = 50` so the prose matches the actual symbol in `code_review_helpers.py`.
- `test_max_verifications_cap_keeps_highest_priority` comment inverted which IDs get deferred (PR #111 review MED #6 + #9, auditor + bha_p0_p2). The sort key `(-priority_score, finding_id)` is ascending on `finding_id` when priorities tie, so the 10 with the highest IDs get deferred — not the lowest. Comment corrected; added explicit ID-set assertions pinning that `f000–f049` are retained and `f050–f059` are deferred so a future sort change breaks the test loudly instead of silently changing which findings get verified.
- `_make_validated_finding` test factory now delegates to `conftest.minimal_diff_finding` (PR #111 review MED #8, bhb). v2.8.0 rebuilt the same 14+ fields locally, violating the CLAUDE.md learned pattern on delegating to adjacent helpers. The new wrapper only carries the PLN-722-specific overrides (`evidence`, `reasoning_certificate`, severity/confidence/category/source parametrization).
- CHANGELOG v2.8.0 entry referenced the wrong subagent type slug (PR #111 review MED #10, bha_p0_p4). `code:code-review-worker` → `code-review:code-review-worker`. The worker lives in the `code-review` plugin and every authoritative reference (including `start.md:738`) uses the fully-qualified `code-review:` namespace.

### code-review v2.8.0

#### Added
- **PLN-722 — Finding-Verification Pass (Option B slice).** New verifier pipeline between `stage_22_validate` and `stage_25_finalize_result`. Each finding emitted by reviewers gets an independent second opinion from a verifier agent prompted to *falsify* (not confirm) the underlying claim — `REJECTED` requires positive disconfirming evidence; ambiguity defaults to `TENTATIVE`. Findings dismissed by the verifier are never silently dropped; they surface in a `Dismissed Findings` section so humans can falsify the dismissal.
- **`cmd_verify_prepare` helper (stage_22b).** Tier-selects findings per the canonical "What gets verified" table — BLOCKING/HIGH always; MEDIUM with confidence < 0.85 yes; MEDIUM with confidence ≥ 0.85 no; LOW (P3) no; `category: "Hygiene"` no (deterministic producer); `source: "injection-detector"` no (deterministic producer); `category: "Premise"` always (strict adversarial framing). Ranks the eligible set by `severity_weight × confidence`, caps at `VERIFY_MAX_VERIFICATIONS = 50` (≈ $2/PR at current Sonnet pricing) with a deterministic secondary sort by `finding_id`, defers overflow into `pending_verification[]`, and writes (a) `<CR_DIR>/verify_manifest.json` and (b) per-finding input files at `<CR_DIR>/verifier_inputs/<finding_id>.json`. The Verifier Fleet walker section in `start.md` reads the manifest and spawns one `code-review:code-review-worker` Task per `to_verify[]` entry.
- **`cmd_verify_consolidate` helper (stage_24a).** Reads the per-finding `agent_verifier_<id>.json` outputs the Verifier Fleet wrote, applies sensitive-path escalation from `.closedloop-ai/settings/verification-gates.json` (REJECTED on `sensitive_paths` + BLOCKING/HIGH → TENTATIVE with severity capped at HIGH; any finding on `tentative_on_paths` → TENTATIVE; any finding on `mandatory_human_review_paths` → TENTATIVE + `force_human_review: true`), and writes `<CR_DIR>/findings_verified.json` with the bucket-split shape `{verified[], rejected[], pending_verification[], force_human_review, stats}`. Missing fleet outputs degrade to `pending_verification[]` — never silently confirmed.
- **`verifier_prompt.txt` asset.** New top-level prompt asset copied by `stage_02_prep_assets` from `tools/prompts/verifier_prompt.txt` to `<CR_DIR>/verifier_prompt.txt`. Implements the six-check falsification protocol from PLN-722 §Verifier prompt: EXISTENCE / EVIDENCE / GUARD / REACHABILITY / SEVERITY / UNCERTAINTY. Includes the canonical output JSON shape, the `REJECTED requires positive evidence` rule, the rejection_class enum (`evidence_not_found` / `evidence_contradicted` / `guard_exists` / `unreachable`), and the extra-strictness path for Premise findings (re-execute the embedded `reasoning_certificate`'s claim chain independently). `cmd_prep_assets` now copies three assets instead of two; the `prep_assets` stdout summary gains a `verifier_prompt` key.
- **Sensitive-path config (Phase 6).** `.closedloop-ai/settings/verification-gates.json` schema with three keys: `sensitive_paths`, `tentative_on_paths`, `mandatory_human_review_paths`. Bootstrap does NOT auto-generate the file (per `00-discovery.md`); projects create it by hand when they want path-aware verifier escalation. Absent file → empty gates, no escalation, identical to pre-PLN-722 behavior. Glob matching supports `**` recursive segments (`lib/auth/**`, `**/migrations/**`, `**/credentials.*`), `*` non-segment wildcards, and `?` single-char matches; non-string entries in any gate list are dropped silently.
- **`verifications/` cache namespace (Phase 7).** PLN-719 pre-registered the namespace and TTL (30 days); PLN-722 wires it up end-to-end. `cmd_verify_prepare` checks the cache before declaring a finding eligible — on hit, materializes the cached verdict at the canonical `agent_verifier_<id>.json` path and skips fleet spawn, logging the id under `cache_hits[]`. `cmd_verify_consolidate` writes fresh verifier outputs back to the cache (atomic via tmp + rename). Key tuple: `(finding_id, sha256(code_snippet), verifier_model, verifier_prompt_hash)` — so a code change at the cited location invalidates the cached verdict via the snippet hash, and a prompt rev invalidates everything globally. Coarse but correct: false-misses cost a verifier re-spend; false-hits would be a correctness bug.
- **Three-state canonical verdict.** `_compute_canonical_verdict` gains two rules per PLN-722: (rule 2.5) `force_human_review` → `NEEDS_ATTENTION` (sits between BLOCKING and HIGH — BLOCKING still trumps, but HIGH does NOT escalate a force-review-path PR past NEEDS_ATTENTION); (rule 3.5) any verified finding with `verifier_verdict == "TENTATIVE"` → `NEEDS_ATTENTION` (the verifier could not confirm or disprove; the plan calls this out explicitly: "TENTATIVE counts toward NEEDS_ATTENTION (not CHANGES_REQUESTED)"). REJECTED findings live in `envelope.rejected[]` and don't count toward verdict math at all.
- **`cmd_finalize_result` reshuffle.** Prefers `<CR_DIR>/findings_verified.json` (the verify-consolidate output) when present and honors its `force_human_review` flag in the canonical verdict computation; falls back to `findings_validated.json` (everything to `verified[]`, no verifier) when consolidate didn't run (stage_23 disabled, infrastructure failure, or pre-PLN-722 cache hit). The stdout summary gains `rejected_count`, `pending_verification_count`, `force_human_review`, and `used_verifier` keys so operators can see at a glance whether the verifier engaged on a given run.
- **Run plan wiring.** `stage_22b_verify_prepare`, `stage_23_verify_findings` (flipped enabled), and `stage_24a_verify_consolidate` all enabled with `on_failure: continue`. Stage_25_finalize_result depends on stage_24a (was: stage_22_validate). New `test_pln_722_verify_pipeline_enabled_with_pinned_args` pins the wiring; `test_emits_thirty_two_stages` (was: thirty) covers the count change. The `_<NN>_` prefix is a stable label, not a strict ordinal; `_22b_` and `_24a_` mark stages inserted between original ordinals without renumbering downstream.
- **Output surface (Phase 4).** `start.md` gains a `Verifier Fleet (stage_23_verify_findings)` walker dispatch section (mirrors `Reviewer Fleet`) and a `Dismissed Findings` presenter section in local mode. `github-review.md` gains a Step 6c that writes `code-review-dismissed.json` and `code-review-dismissed-summary.md` with collapsible `<details>` blocks per finding, plus a `force_human_review` banner when the gate fires.
- **58 new tests** covering: validate-preserves-evidence + reasoning_certificate (2); `_needs_verification` tier table parametrized × 8 + 4 category/source edges; `_verification_priority` ranking + missing-confidence defense (3); `cmd_verify_prepare` empty/tier/cap/per-finding-inputs/manifest-on-disk/cache-hit (6); `cmd_verify_consolidate` no-manifest/CONFIRMED/REJECTED/TENTATIVE/missing-output/deferred-budget + three sensitive-path gates + cache-writeback (10); `_load_verification_gates` absent/malformed/non-string-dropped/None-path (4) + `_glob_to_regex` parametrized × 12; `_compute_canonical_verdict` PLN-722 rules (4); `cmd_finalize_result` fallback / preference / force_human_review propagation (3).

### code-review v2.7.3

#### Fixed
- `_score_text_for_injection` — capped `html_comment_exfil` (weight 25) at a single match's contribution per scan. Before the fix, `finditer` counted every long `<!-- ... -->` block in the body; GitHub's default PR template ships three instructional comment blocks past 50 chars, which accumulated to 3 × 25 = 75 ≥ `_INJECTION_SCORE_HIGH`, quarantining the PR and emitting a BLOCKING `InjectionAttempt` finding on template boilerplate alone. Introduced `_INJECTION_CLASS_MAX_MATCHES: dict[str, int]`, a per-class cap on how many matches contribute to the score; classes where *presence* is signal but count is not proportionally more dangerous get capped at 1. Classes absent from the map (e.g. `instruction_override`, `system_prompt_forgery`) still accumulate unbounded — multiple `<system>` forgery tokens or repeated "ignore previous instructions" are genuinely more dangerous in proportion. New regression tests `test_github_pr_template_does_not_quarantine` (mimics the default GitHub PR template, asserts severity ≤ low) and `test_html_comment_class_capped_at_single_match` (asserts ten long HTML comments yield exactly one reported match). Surfaced by thadeusb on PR #109 (comment 3325330078).
- `role_reversal` pattern narrowed to require an actor-noun after `act as`. Previous pattern `act\s+as\s+\S` matched any following non-whitespace token — including common PR-description phrasings like "act as a thin wrapper" or "act as the source of truth" — contributing 40 points toward quarantine on benign wording. Replaced with `\bact\s+as\s+(?:an?\s+|the\s+)?(?:AI|LLM|model|assistant|chatbot|agent|expert|admin|root|sysop|sudoer|developer|maintainer|reviewer|approver|owner|operator|moderator|user|hacker|attacker)\b`. The other branches of the alternation (`you are now`, `pretend to be`, `roleplay as`, `from now on you are`) were already specific enough and are unchanged. New regression tests `test_role_reversal_skips_benign_act_as_phrasing` (three benign payloads must not match) and `test_role_reversal_still_matches_persona_injection` (three adversarial payloads must still match). Surfaced by thadeusb on PR #109 (comment 3325332843).
- `_append_injection_audit_log` docstring + constant comment corrected to match implementation. The function was documented as "append-only … sweep-on-read" but actually does read-modify-write on every call (loads all existing lines, filters by TTL, writes them all back along with the new entry) and sweeps on write (the log has no reader — operators read it manually for triage). Two concurrent runs in the same workdir can clobber each other's new entries; this is accepted because the log is observational, not a source of truth. Rewrote the docstring and the constant comment at `_INJECTION_AUDIT_LOG` to spell out the read-modify-write semantics, the sweep-on-write timing, and the concurrent-clobber caveat. No behavior change — implementation was correct, only the docs lied. Surfaced by thadeusb on PR #109 (comment 3325333665).

### code-review v2.7.2

#### Fixed
- `start.md` § Reviewer Fleet — removed the fabricated `partition_patches: { "p0": "...patch text...", ... }` line from the inlined `partitions.json` shape hint. `cmd_partition` writes `partition_patches` as a list of patch filenames (e.g. `["patches_p0.txt", ...]`) emitted by `_write_per_partition_patches`, not a dict keyed by partition id, and it's only present when `--cr-dir` is set. The PR #110 hint that was meant to keep the walker model from guessing wrong instead invented a fourth key with a fabricated shape — a model trusting it would hit a fresh `KeyError` on `data["partition_patches"]["p0"]`. Surfaced by thadeusb in post-merge review of PR #110.
- `test_partitions_json_is_top_level_dict_not_list` now asserts the **exact** top-level key set (`partitions` / `test_file_paths` / `force_merged_count`) instead of just per-key membership. The previous shape (`assert "x" in result` × 3) couldn't catch a new key being added to the inlined shape hint that the producer never writes — which is exactly how the fabricated `partition_patches` dict slipped past the contract test in PR #110. The test harness `_run_partition` constructs the `argparse.Namespace` without `cr_dir`/`workdir`, so the optional `partition_patches` is never produced in this fixture and exact-set equality on the three core keys is safe. Surfaced by thadeusb in post-merge review of PR #110.

### code-review v2.7.1

#### Fixed
- `_append_injection_audit_log` no longer crashes with `AttributeError` when a pre-existing log line is valid JSON but not a dict (e.g. a list, string, number, or `null`). The inner exception tuple was `(ValueError, KeyError, TypeError)` — `obj.get("timestamp")` on a non-dict surfaced `AttributeError` which propagated past it, then past the outer `OSError` guard, then past `cmd_detect_injection`'s own `OSError`-only catch — exiting with an uncaught traceback that contradicted the docstring's "malformed lines are dropped silently" promise. The pipeline's `on_failure: continue` absorbed the crash but the audit-log feature stayed broken on every subsequent run until the file was removed. Added an explicit `isinstance(obj, dict)` guard before the `.get` call. New regression test `test_sweep_handles_non_dict_json_lines` verifies four pathological non-dict JSON values (list, string, number, null) are dropped and the fresh run still appends.
- Selective-redaction comment in `cmd_detect_injection` aligned with actual behavior. Comment had claimed "preserve original title/commits if they were clean — only redact what triggered" but `body` is unconditionally redacted on quarantine regardless of `body_score`. Rewrote to make the asymmetry explicit: `title` and `commits` are preserved when their per-section score is 0; `body` is always redacted because it's the highest-risk surface (longest free-form attacker-controlled text), and a sub-threshold score may still carry signals the catalogue missed. Surfaced via the CLAUDE.md "scope descriptions narrower than actual behavior" mistake pattern.
- `test_malformed_intent_context_returns_empty_report` now actually asserts the contract it promises. Previously the only assertion was `assert rc == 0` — a regression where `cmd_detect_injection` returned 0 but printed nothing (or garbage) would still let the test pass. Now mirrors the sibling `test_missing_intent_context_returns_empty_report` assertions on `report['score'] == 0` and `report['severity'] == 'none'`. While there, replaced ~12 lines of duplicated stdout-capture / cwd-swap boilerplate with the existing `_run_detect_injection` helper (CLAUDE.md "delegate instead of duplicating" pattern).
- `golden_injection_quarantine` fixture's `README.md` listed `intent_context.json` as a pre-baked input, but no such file existed under `inputs/`. Added the file as concrete documentation of the post-quarantine field shape (`title` preserved when clean, `body` redacted, `quarantine: true`, `injection_score`, `injection_severity`). The post-collection harness pipeline doesn't read it, so the existing expected envelope still passes byte-identical — the file is documentation-only, but a fixture reader studying the post-quarantine state will now see the actual JSON instead of a missing-file reference.

### code-review v2.7.0

#### Added
- **PLN-720 — Prompt-Injection Defense.** The first feature plan downstream of the PLN-719 foundation. New `cmd_detect_injection` subcommand scores PR-author-controlled content (PR title, body, commit messages) against a 9-class deterministic regex catalogue — instruction override, role reversal, system-prompt forgery, directive injection, output coercion, tool coercion, encoded payloads, Unicode tag chars (U+E0000–U+E007F), HTML-comment exfiltration. Each pattern carries a weight; matches accumulate to a section score; the total maps through severity tiers `none` (0) / `low` (1–29) / `medium` (30–69) / `high` (70+). Position-aware weighting downweights `>`-quoted lines (citing, not commanding) by 0.5× and content buried past the first 500 chars by 0.75×, matching the imperative-context heuristic from the plan. Foundation pre-stubbed `stage_09_detect_injection` with `enabled: False`; this release flips it to `True` and pins the runtime-args contract (`--cr-dir`, `--intent-context`) via `test_stage_09_detect_injection_enabled_with_pinned_args`.
- **Quarantine semantics.** On severity ≥ Medium, `cmd_detect_injection` rewrites `<CR_DIR>/intent_context.json` in place with `quarantine: true`, `injection_score`, `injection_severity`, and redacted fields using the *real* field names from `cmd_fetch_intent` (`title`, `body`, `commits` — not the v1-draft `description`, `commits: []` shape). `cmd_classify_intent` short-circuits on `quarantine == true` to `{"intent": "mixed", "source": "quarantine"}`, skipping the LLM-classification path entirely so the redacted body never reaches the classifier. On severity ≥ High, the helper writes a canonical `InjectionAttempt` finding to `<CR_DIR>/agent_injection-detector.json`; the `agent_*` naming makes `cmd_collect_findings` pick it up via the standard glob with no new merge wiring required. The finding flows through `normalize_legacy_finding` (which preserves the canonical `source: "injection-detector"` via setdefault) into `review_result.envelope.verified[]`, and the existing canonical verdict precedence routes any BLOCKING `InjectionAttempt` to `CHANGES_REQUESTED`.
- **Audit log.** Append-only JSONL at `.closedloop-ai/injection-log.jsonl`, one entry per `detect-injection` run. Each entry records `timestamp`, `score`, `severity`, `matches` (pattern class names only — *never* the raw payload, to avoid re-amplifying injection content into the log itself), `quarantined`, and `stripped_token_count`. Sweep-on-read TTL of 90 days mirrors PLN-719 Phase 7's cache TTL pattern; malformed pre-existing lines are dropped silently since the log is observational.
- **Reviewer prompt hardening.** `shared_prompt.txt` gains a top-level `<untrusted_content_policy>` block before `<constraints>` that tells every reviewer (BHA, BHB, Auditor, Premise, Domain Critic) to treat `<untrusted_input>`-wrapped content and source-file content as data — never instructions — and to report adversarial-looking comments as `InjectionAttempt` findings rather than complying. The block is referenced in the Premise dispatch in `start.md`: when `intent_context.json.quarantine == true`, a quarantine preamble is prepended verbatim, telling Premise to infer intent from the diff only and capping severity at HIGH unless evidence is from source-file diffs.
- **Golden fixture.** `golden_injection_quarantine` (deferred since PLN-719 Phase 8) now ships with `config.yaml`, `inputs/` (including a pre-baked `agent_injection-detector.json` simulating the post-detect-injection state), and `expected/review_result.json`. Verifies the BLOCKING `InjectionAttempt` finding flows through the standard collect → validate → finalize pipeline and produces `verdict: CHANGES_REQUESTED` with one `verified[]` entry. Round-trips through `validate_result_envelope` end-to-end. The `_DEFERRED_FIXTURES` registry shrinks from 6 to 5 entries; the remaining 5 stay deferred until plans 02/03/05/06 land.
- **27 new tests** covering the 9 pattern classes (one parametrized test per class plus Unicode-tag and zero-width edge cases), severity-threshold scoring, quote-prefix downweighting, score accumulation across PR sections, the quarantine rewrite shape (real field names, preserved-when-clean title), end-to-end canonical-finding round-trip through `normalize_legacy_finding` + `validate_finding`, literal-forgery-token stripping, audit-log append + TTL sweep, `on_failure: continue` resilience (missing / malformed intent_context returns empty report instead of crashing), and the `cmd_classify_intent` quarantine short-circuit.

#### Fixed
- Pre-existing `test_plan_dependent_stages_disabled` no longer asserts `stage_09_detect_injection.enabled is False` (plan 01 is no longer deferred). The stage's contract is now guarded by the new `test_stage_09_detect_injection_enabled_with_pinned_args` instead. Other still-deferred plan stubs (stages 11, 13, 14, 23) keep their disabled-state assertions.

### code-review v2.6.5

#### Fixed
- `start.md` § Reviewer Fleet — the prose at line ~328 previously said only "do NOT run ad-hoc Python one-liners against `partitions.json`". Real `/start` runs showed the walker model ignoring that directive, indexing `data[0]` against the top-level dict, and crashing with `KeyError: 0`. The same systemic pattern that drove the rest of the PLN-719 follow-ups — prose alone doesn't beat the model's default behavior. Sharpened the section to (a) prescribe the canonical access path (`cat` / `Read`, then key-mapping; `python` is allowed *if* it indexes `data["partitions"][N]` not `data[N]`) and (b) inline the actual top-level shape so even an ignored directive lands on the right indexing. A new contract test `test_partitions_json_is_top_level_dict_not_list` in `TestPartitionPostProcessing` pins `cmd_partition`'s output as a top-level dict with `partitions` / `test_file_paths` / `force_merged_count` keys, so if anyone restructures the producer the prose breaks first instead of a real /start crash surfacing it.

### code-review v2.6.4

#### Fixed
- `cmd_post_comments` line-handling regression caught in PR #107 review. The previous `isinstance(line_raw, int) and not isinstance(line_raw, bool)` guard fixed the null-line crash but silently dropped legacy reviewers' string-typed lines (e.g. `"line": "42"`) into the `failed` bucket — the original `int(finding.get("line", 0))` would have coerced them. New shape: explicit `bool` check (still rejects `True`/`False`), then `int(line_raw)` wrapped in `try/except (TypeError, ValueError)`. This preserves the bool guard, fixes the null crash, and restores string coercion. Two new regression tests: `test_string_line_is_coerced_to_int` (locks in the string → int path) and `test_garbage_string_line_does_not_crash` (non-numeric strings degrade gracefully to `failed` rather than crashing on `ValueError`).
- `test_every_documented_runtime_token_is_resolvable` was a hardcoded subset that had already drifted (PR #107 added `<GLOBAL_CACHE>` and `<INTENT>` to start.md's table but never added them to the test's list). The test name claimed "every documented" but the hardcoded list couldn't catch a new token getting added to start.md or removed from it. Replaced with `test_runtime_tokens_in_start_md_match_helper_stage_args`, which parses start.md's Walker Contract placeholder table directly with a regex and enforces sync in both directions: every documented token must be referenced by at least one helper stage's args (or appear in the `GATE_OR_WALKER_TOKENS` allowlist for `<PLUGIN_ROOT>`/`<START_TIME>`/`<INTENT>`, which are walker- or gate-consumed by design), and every `<TOKEN>` placeholder in helper stage args must appear in the documented table. Drift in either direction now fails the test.

### code-review v2.6.3

#### Fixed
- `PRIORITIES` enum now includes `3`. `shared_prompt.txt` §"SEVERITY + PRIORITY" explicitly teaches a `P3` tier ("MEDIUM (P3): Suggestions, nice-to-haves"), and reviewers (Bug Hunter B in particular) correctly emit `priority: 3` for nice-to-haves — but the schema rejected those findings because `PRIORITIES` was hard-coded to `{0, 1, 2}`. A pure prompt ↔ schema contradiction: the reviewer was doing exactly what the prompt said, and the schema killed the finding. New `test_priorities_include_p3` + `test_p3_finding_passes_validation` guard against future drift.
- `shared_prompt.txt` `<output_format>` section now enumerates every canonical `CATEGORIES` value explicitly with a one-line description per category. Previously the prompt showed only `category: "Correctness"` as a single example, so reviewers naturally invented categories like "Code Style" (Auditor), "API Validation" (api-architect), or "Documentation Quality" — none of which were in the canonical enum. Reviewers now see the complete list and can map their findings to one of the 12 documented categories. The prompt also explicitly tells reviewers `priority` must be `0`, `1`, `2`, or `3` to prevent invented priority values.
- `test_shared_prompt_enumerates_every_canonical_category` locks in the prompt ↔ schema sync in both directions: every entry in `CATEGORIES` must appear in `shared_prompt.txt`, and every capitalized category-like token in the prompt's `<output_format>` must be in `CATEGORIES`. If either side adds or removes a category without updating the other, the test fails — making schema/prompt drift structurally impossible. This addresses the broader class of contract gap (reviewer-emitted enum values) rather than just the two specific categories from this run.

### code-review v2.6.2

#### Fixed
- `Documentation` added to the canonical `CATEGORIES` enum in `code_review_schema.py`. Reviewers naturally emit `category: "Documentation"` for README / docstring / comment findings, and the fast-path reviewer in particular produces this category on real runs. Previously such findings caused `cmd_finalize_result` to exit non-zero with `category 'Documentation' not in [...]`, which collided with `stage_25_finalize_result.on_failure: "abort"` and would have killed the pipeline. `Documentation` is now accepted alongside `Code Quality` rather than forcing reviewers to misclassify documentation findings. `SCHEMA.md` updated to list the new category in the finding schema.
- `stage_25_finalize_result.on_failure` relaxed from `"abort"` to `"continue"`. `cmd_finalize_result` writes `review_result.json` BEFORE running schema validation (line 4717 — explicit), so a non-zero exit indicates reviewer category/field drift, not a missing envelope. `stage_28_verdict` can read the structurally complete envelope and produce a verdict; the stderr text remains for operators to correct prompts/schema. This resolves a long-standing prose ↔ plan contradiction in `start.md` (per-stage notes claimed verdict would "fall back to findings_validated.json" while the plan said `abort`). The corrected prose now matches the relaxed behavior.
- `stage_30_footer.stdout` redirects to `<CR_DIR>/footer.json` (was `None`). `cmd_footer` writes its `{"footer_line": "..."}` JSON payload to stdout, and the `Review Footer` prose in `start.md` tells the walker to read `<CR_DIR>/footer.json` after the stage runs. With `stdout: None`, the file was never written; the walker read a missing file and reported the helper as exiting non-zero. The redirect now produces the file the prose expects, and `footer.json` is listed in `expected_outputs` so the gate system can confirm production.
- Three contract tests added in `TestPrepareRun` lock in the fixes against regression: `test_documentation_is_valid_category` (schema enum), `test_stage_25_finalize_result_on_failure_is_continue` (run-plan vs reviewer drift), `test_stage_30_footer_stdout_redirects_to_footer_json` (run-plan vs prose).

### code v1.12.0

#### Removed
- `code-review-worker` agent. The agent's only consumer was the `code-review` plugin's `/start` command (6 references), and the agent's definition was a 24-line generic worker (`tools: Read, Write, Grep, Glob`) with no logic specific to the `code` plugin's orchestration. Moved into `code-review/agents/code-review-worker.md` so the code-review plugin is self-contained and runs without requiring the `code` plugin to be enabled. External callers referencing `code:code-review-worker` should update to `code-review:code-review-worker`. The `code-reviewer` and `code-review-guidelines` agents remain in the `code` plugin (they're consumed by the `/code-review` command and the broader `code` workflow).

### code-review v2.6.0

#### Changed
- PLN-719 Phase 4b — `/start` rewritten from a 14-task prose workflow into a declarative orchestrator that invokes `prepare-run` to emit `<CR_DIR>/run_plan.json` and then walks the 30-stage plan stage-by-stage. Helper stages are dispatched by `subcommand` after runtime placeholder substitution (`<DIFF_SCOPE>`, `<CACHE_DIR>`, `<PROMPT_HASH>`, `<CONTEXT_KEY>`, `<MODEL_ID>`, `<STATE_KEY>`, `<GLOBAL_CACHE>`, `<INTENT>`, etc.); `agent_fleet` stages dispatch to the per-stage prompt templates kept in `start.md`; the `present` stage dispatches to the rendering format. Four runtime gates modify walker default behavior: Gate A (hygiene-only short-circuit after `stage_12_hygiene` — presents findings and exits cleanly), Gate B (`route` + `fast_path` decision between `stage_19_cache_check` and `stage_17_partition`), Gate C (skip `stage_26_cache_update` when `fast_path` is true or no cache), Gate D (skip `stage_27_review_state_write` unless local mode, cache active, and all agents succeeded). The `start.md` file drops from 1278 → 858 lines (~33% reduction) without changing review behavior. The deletions are the prose-driven helper invocations now derived from `run_plan.json`; the agent fleet prompt templates and presentation prose are preserved verbatim.
- Reordered `stage_17_partition` to execute after `stage_19_cache_check` (its array position now matches Gate B's runtime route invocation). The stage id retains its `_17_` prefix as a stable label; execution follows array position, not the numeric suffix. Removed the spurious `stage_17_partition` entry from `stage_18_compute_hashes.depends_on` (compute-hashes does not consume partition output; the real deps are `stage_02_prep_assets` and `stage_03_resolve_scope`). `stage_20_spawn_reviewers.depends_on` now points at `stage_17_partition` (the actual data producer) and adds `partitions.json` to its `expected_outputs`.
- `code-review` is standalone — moved the `code-review-worker` agent from the `code` plugin into `code-review/agents/code-review-worker.md`. All 6 `subagent_type: "code:code-review-worker"` references in `commands/start.md` updated to `code-review:code-review-worker`. There is no `## Prerequisites` section anymore. Stale `code-review → judges` dependency (a `test_validate_judge_report.py` import — the test file no longer exists) removed from `docs/dependencies.md` and `CLAUDE.md`. After this PR, `code-review` has zero cross-plugin runtime dependencies.
- `cmd_prepare_run` docstring updated to identify the consumer as the live `/start` walker (was "a future rewrite of start.md").

#### Added
- Five contract tests in `TestPrepareRun` lock in the walker dispatch surface so future plan changes can't silently break the orchestrator: `test_stage_kind_is_documented_enum` (kind ∈ {helper, agent_fleet, present}), `test_on_failure_is_documented_enum` (on_failure ∈ {abort, continue, continue_with_coverage_gap}), `test_every_documented_runtime_token_is_resolvable` (every runtime token in the start.md placeholder table is referenced by at least one helper stage's args), plus a rewritten `test_enabled_helper_stages_include_all_required_argparse_args` that derives required flags from argparse itself via `_register_subparsers` introspection instead of a hand-maintained dict. The introspection-based check makes argparse-contract drift structurally impossible.

#### Fixed
- `_build_run_plan_stages` was missing six required/behavior-affecting argparse flags that the prior prose orchestrator passed: `stage_03_resolve_scope` lacked the required `--setup-json` (argparse would have crashed `/start` on stage 3 before any review reached the agents); `stage_08_fetch_intent` lacked the required `--cr-dir` (same crash on stage 8); `stage_19_cache_check` and `stage_26_cache_update` both lacked `--global-cache <GLOBAL_CACHE>` (silent fallback from V2 to V1 cache mode for users with global cache enabled); `stage_26_cache_update` also lacked `--partitions-file`; `stage_30_footer` lacked `--cache-result` (footer silently showed `"Cache: disabled"` even when cache was active). All flags now declared in the run plan; the introspection-based contract test added in this release prevents the class of drift from recurring.
- `--pr-number` is now omitted entirely from `stage_03_resolve_scope`, `stage_04_finalize_cache`, `stage_08_fetch_intent`, and `stage_25_finalize_result` args when no PR is active. Previously the flag was emitted as `--pr-number ""`, which argparse rejected (`--pr-number` is `type=int`) with `invalid int value: ''` — crashing every non-PR review on stage 3. Introduced a stronger contract test (`test_enabled_helper_stages_parse_via_argparse_after_token_substitution`) that substitutes realistic placeholder values and runs `parse_args` on each enabled stage's args; this catches type/value mismatches that the existing required-flag-presence check missed.
- `stage_07_auto_incremental` moved to execute **before** `stage_05_parse_diff` (its array position now sits between `stage_04_finalize_cache` and `stage_05_parse_diff`). Previously it ran after parse-diff and extract-patches had already materialized `diff_data.json` and `patches_all.txt` with the wider scope, so any `diff_scope` override the stage emitted was applied to the cached `<DIFF_SCOPE>` token but ignored by every downstream stage. Removed `stage_05_parse_diff` from `stage_07.depends_on` (spurious — auto-incremental never consumed diff_data); `stage_05_parse_diff.depends_on` now includes `stage_07_auto_incremental` so the array order is enforced by the dependency graph too.
- `stage_08_fetch_intent.stdout` is now `None` instead of `<CR_DIR>/intent_context.json`. The helper writes `intent_context.json` to `cr_dir` itself; the stdout output is a small `{path, source}` summary. Redirecting stdout into `intent_context.json` produced a corrupt file (the summary clobbered the structured payload).
- `stage_01_setup.stdout` is now `None`. `setup` creates `cr_dir` as a side effect and prints its result JSON to stdout; a shell-style `> <CR_DIR>/setup.json` redirect cannot work because `cr_dir` does not exist until `setup` runs. The walker captures setup's stdout in-memory during stage 0b, parses `cr_dir`, then writes `setup.json` to the newly-created directory via the `Write` tool. The per-stage note and `start.md` Stage 0b prose now document this explicitly.
- Gate A no longer routes hygiene-only runs to `stage_28_verdict` and `stage_30_footer`. `cmd_verdict` requires `review_result.json` OR `findings_validated.json` to exist; neither is produced in hygiene-only mode, so the verdict call would have failed and `stage_28_verdict.on_failure == "abort"` would have crashed the walker. Hygiene-only runs now present hygiene findings and exit cleanly without a verdict tag, matching the pre-Phase-4b "EXIT — do not proceed to Step 3 or beyond" semantics.
- `cmd_post_comments` no longer crashes on findings whose `line` field is `null` and no longer accepts `bool` values (Python's `bool` is a subclass of `int`, so the original `isinstance(line_raw, int)` guard let `"line": true` post to line 1). Findings with `null`, missing, or `bool` `line` values are now counted under `failed` (no inline anchor) instead of crashing or posting to a nonsense line. Adds three regression tests: `test_null_line_does_not_crash`, `test_missing_line_key_does_not_crash`, `test_bool_line_does_not_post`. Original null-line crash was flagged in PR #100 review and never addressed.
- "Two decisions live outside the run plan" / "Three runtime-driven branching gates" undercount in `start.md` corrected to "Four runtime gates modify walker default behavior" (Gate A/B/C/D).
- `stage_20_spawn_reviewers.expected_outputs` no longer lists `partitions.json`. The file is produced by `stage_17_partition` (a prerequisite) and consumed by `stage_20`, not produced by it. Including it would have masked total-agent-failure via the walker's "at-least-one-exists" check, since `partitions.json` already exists from the prior stage when `stage_20` runs.
- Documented a workaround in the Walker Contract for sessions whose hooks intercept the `Read` tool on generated artifacts (e.g. a code-discovery gate that demands codebase-memory-mcp lookups): fall back to `cat` via `Bash` — pipeline artifacts under `<CR_DIR>` are not source code.

### code-review v2.4.0

#### Added
- PLN-719 Phase 8 (Golden Fixture Harness): a parametrized pytest harness at `tools/python/test_golden_fixtures.py` + supporting `golden_fixture_harness.py` that pins the post-collection contract end-to-end. Each fixture lives at `tools/python/fixtures/<name>/` with `config.yaml`, `inputs/` (canned upstream artifacts: `setup.json`, `scope.json`, `intent.json`, `diff_data.json`, one or more `agent_*.json`, optionally `hygiene.json` + `coverage_plan.json`), and `expected/review_result.json`. The runner stages inputs into a tmp `cr_dir`, runs `collect-findings` → `validate` → `finalize-result`, normalizes non-deterministic fields (`review_id` uuid, `emitted_at` timestamps, the wall-clock telemetry block), and diffs against `expected/`. Every fixture also doubles as a schema round-trip check — `validate_result_envelope` runs on the produced envelope and fails the test on any errors (PLN-719 Section 10 acceptance: "every fixture round-trips emit → write → read → validate").
- `--update-golden` pytest CLI option (registered in `tools/python/conftest.py`) rewrites every fixture's `expected/review_result.json` through the same normalization path the assertion uses, so a subsequent no-flag run sees byte-identical output. Intended workflow: update via flag, review the diff in the commit, ship.
- Three fixtures shipped end-to-end: `golden_minimal_correctness` (single HIGH Correctness finding, verdict NEEDS_ATTENTION), `golden_all_categories` (four findings spanning Correctness / Code Quality / Security / TestQuality; verifies the post-PR-#103 CATEGORIES enum flows through finalize's `by_category` stats), `golden_schema_v1_round_trip` (single Security finding with every optional schema field populated — `evidence[]`, `reasoning_certificate`, `other_locations`, `subcategory` — the maximal v1 envelope shape).
- Six deferred fixtures with reserved directories + `README.md` placeholders: `golden_premise_justified` / `golden_premise_rejected` (plan 02), `golden_impact_with_callsites` (plan 06), `golden_coverage_gap` (plans 03 + 05), `golden_injection_quarantine` (plan 01), `golden_budget_exceeded` (arbitrate-budget integration). Skipped via a `_DEFERRED_FIXTURES` map in the test module until their dependent plans land.
- `test_prepare_run_produces_byte_identical_output_modulo_review_id` pins PLN-719 Section 6 determinism: two `prepare-run` invocations differ only in `review_id`. Any drift in stage args, validation gates, or telemetry projections fails the test.
- SCHEMA.md §12 documents the harness contract: fixture layout, the `--update-golden` workflow, Phase 8 vs deferred scope, and the note that Phase 4b will extend the harness to walk `run_plan.json` end-to-end through a declarative stage runner.
- `expected_verdict`, `expected_verified_count`, `expected_coverage_gap_count` keys in fixture `config.yaml` drive hard assertions against the produced envelope, run even in `--update-golden` mode so the rewriter cannot silently pin a verdict that contradicts config intent. SCHEMA.md §12 documents this contract.

#### Changed
- Hoisted `run_with_stdout_capture(fn, ns, *, stdout_to=None)` to module level in `golden_fixture_harness.py` (was inline) and added `invoke_prepare_run(cr_dir, *, output=None, ...)` to `tools/python/conftest.py`. Both centralize the `argparse.Namespace` + stdout-capture pattern previously duplicated across `test_code_review_helpers.py::TestPrepareRun._run` and `test_golden_fixtures.py::_invoke`; both callers now delegate.

#### Fixed
- `setup.json.current_branch` aligned with `scope.json.review_branch` (`"feature/x"`) in `golden_minimal_correctness` and `golden_all_categories`. The prior `"main"` value contradicted `diff_scope` because `cmd_finalize_result` resolves `setup.current_branch` before falling back to `scope.review_branch`.
- `golden_all_categories/config.yaml` header comment + `description` no longer claim "every CATEGORIES value"; the fixture covers a representative 4-category subset, not all 11. Remaining categories belong to the deferred fixtures.
- `diff_envelope_against_expected` docstring corrected to state only `actual` is normalized; the expected file is compared as-is (already written through `update_expected`'s normalization path).
- Removed dead `scope_kind=fixture.config.get("scope_kind")` from `validate_ns` construction in `golden_fixture_harness.py`. `cmd_validate` reads only `--findings` and `--diff-data`.

### code-review v2.3.0

#### Added
- PLN-719 Phase 7 (Cache uniformity): `CACHE_TTL_DAYS` constant on `code_review_schema.py` declares the per-namespace TTLs from PLN-719 §9 (`bha`=30d, `signals`=7d, `coverage_critic`=7d, `verifications`=30d, `overrides`=90d), plus a `cache_ttl_days(namespace)` lookup helper that returns `None` for unknown namespaces. The whitelist is pinned to the canonical 5 cache namespaces via a new `test_cache_ttl_days_covers_every_namespace` regression test.
- `_is_entry_fresh(entry, namespace, *, now=None)` helper in `code_review_helpers.py` enforces **sweep-on-read** TTL eviction. Stale `cached_at` → cache miss → next review regenerates fresh findings. Missing/malformed `cached_at` values and unknown namespaces count as fresh (caller handles its own corruption fallback). Wired into both the v1 and v2 cache-check paths after `_entry_matches`, so existing miss reasons (schema_version, model_id, prompt_hash, patch_hash) short-circuit before the TTL check.
- `_extract_bha_cache_hit_rate(cr_dir)` reads `<cr_dir>/cache_result.json` (written by `cache-check`) and normalizes `stats.hit_rate_pct` (0–100) into the canonical `[0, 1]` range enforced by `validate_telemetry`. `_build_telemetry_block` populates `telemetry.cache_hit_rate["bha"]` when a cache_result.json exists — this is the first end-to-end producer for the `cache_hit_rate` field that Phase 9 declared. Hygiene-only and no-cache runs leave the field empty (legal under the open-additionalProperties schema).
- 13 new tests covering: `_is_entry_fresh` unit semantics (within/past TTL, missing/malformed timestamps, unknown namespaces), end-to-end TTL eviction for both v1 and v2 cache-check paths, `telemetry.cache_hit_rate["bha"]` population (present when cache_result.json exists; absent otherwise; defensively dropped when `hit_rate_pct` is out of `[0, 100]`), and schema-level whitelist coverage tests.

#### Changed
- Cache test fixtures: hardcoded `cached_at: "2026-01-01T..."` timestamps replaced with a module-level `_FRESH_CACHED_AT` constant computed at collection time, so hit-expecting tests stay within the BHA 30-day TTL window indefinitely. Added a `_stale_cached_at(days_ago=N)` helper for the new eviction tests. Miss-expecting tests are unchanged — they short-circuit on `_entry_matches` before the TTL check.
- SCHEMA.md §9: gains a paragraph documenting sweep-on-read TTL enforcement and Phase 7's BHA-only end-to-end status; notes that the canonical per-file path layout (`<CACHE_DIR>/bha/<file_hash>.json`) is a future migration — the current implementation still uses a single `<CACHE_DIR>/manifest.json` with per-file entries sharing the same key inputs and invalidation contract.

### code-review v2.2.0

#### Added
- PLN-719 Phase 9 (telemetry): canonical `Telemetry` schema on `code_review_schema.py` with `empty_telemetry()` factory, `validate_telemetry()` validator, and `merge_telemetry(base, overlay)` deep-merger. The deep-merge is gated on an explicit `TELEMETRY_DEEP_MERGE_KEYS` whitelist (`duration_by_stage_ms`, `tokens`, `cache_hit_rate`, `schema_versions_seen`, `findings_counts`, `verification_stats`, `coverage_stats`); every other key — including dict-typed fields not on the whitelist — is overwritten wholesale by the overlay, so callers can populate `tokens.input_uncached` without overriding the whole `tokens` block while future schema additions get safe replace-semantics by default. Required keys: `duration_ms`, `duration_by_stage_ms`, `estimated_cost_usd`, `tokens.{input_uncached,input_cached,output,by_model}`, `cache_hit_rate`, `agent_failures`, `schema_versions_seen`. Optional: `findings_counts`, `verification_stats`, `coverage_stats`. Unknown keys permitted for forward-compat.
- Canonical cache namespace constants (`CACHE_NAMESPACES = {bha, signals, coverage_critic, verifications, overrides}`) matching PLN-719 §9 — used as the keyspace for `cache_hit_rate` and as forward-looking constants for plans 03/05.
- `_build_telemetry_block(cr_dir)` helper in `code_review_helpers.py` reads optional `<cr_dir>/telemetry.json`, deep-merges over the zero-valued base, and always overwrites `schema_versions_seen` so an upstream file cannot spoof the version stamp.
- SCHEMA.md Section 11 documents the telemetry contract: field table, producer recipe (write `<cr_dir>/telemetry.json` before `finalize-result`), deep-merge semantics, forward-compat policy.
- 16 new schema + finalize-result integration tests (`test_empty_telemetry_*`, `test_validate_telemetry_*`, `test_merge_telemetry_*`, `test_telemetry_json_schema_*`, `test_telemetry_defaults_when_no_telemetry_json`, `test_telemetry_json_is_deep_merged_into_envelope`, `test_telemetry_schema_versions_seen_cannot_be_spoofed`, `test_malformed_telemetry_json_is_ignored`).

#### Changed
- `result_envelope_json_schema()` declares `telemetry` as a typed object with required keys + nested types (was: open `{type: "object"}`). `validate_result_envelope()` now recurses into `validate_telemetry()` when the block is present.
- `cmd_finalize_result` uses `_build_telemetry_block(cr_dir)` instead of an inline stub. Existing finalize-result output continues to validate without any orchestrator changes — the actual per-stage timestamps + cache hit/miss plumbing land in Phase 4b/7.
- `validate_result_envelope()` refactored into focused per-section helpers (`_validate_envelope_scalars`, `_validate_envelope_buckets`, `_validate_coverage_plan`, `_validate_envelope_findings`) to reduce cognitive complexity. Same coverage; flatter call graph.
- `conftest.minimal_envelope()` now seeds the envelope with `empty_telemetry()` so existing tests stay valid by construction under the strict validator.

#### Fixed
- `"Code Quality"` is now in the canonical `CATEGORIES` enum. The shared reviewer prompt at `tools/prompts/shared_prompt.txt` documents it as the example category for MEDIUM-tier DRY/maintainability findings, but the schema enum at `code_review_schema.py` omitted it. Reviewer-emitted Code Quality findings caused `finalize-result` to reject the canonical envelope; verdict fell back to `validate_output.json` as designed, but the envelope path silently dropped those findings. `SCHEMA.md` Section 1 (category enum line) is updated to match. Adds three regression tests (`test_categories_include_code_quality`, `test_code_quality_finding_passes_validation`, `test_code_quality_finding_in_envelope_passes_validation`).

### code-review v2.1.0

#### Changed
- PLN-719 Phase 5 (pipeline reordering): `extract-patches` moves from after-partition to immediately after `parse-diff`. In its new position it produces only `patches_all.txt`, making the full diff available on disk before every downstream stage (hygiene, route, partition, BHB/Auditor/Premise reviewers, plus the plan-05-gated extract-signals + coverage chain). The `--partitions-file` flag is removed from `cmd_extract_patches`.
- `partition` becomes the canonical producer of `patches_p<N>.txt`. New optional `--diff-scope`, `--cr-dir`, `--workdir` arguments trigger the per-partition `git diff`; when both `--diff-scope` and `--cr-dir` are supplied, partition emits `patches_p0.txt`, `patches_p1.txt`, … alongside `partitions.json`. Without them the call stays a pure partition-assignment helper, preserving backward compat for callers that only want the assignment.
- `prepare-run` (run_plan.json generator): `stage_17_partition` now passes `--diff-scope` and `--cr-dir`, and its `expected_outputs` list includes `patches_p<N>.txt` alongside `partitions.json`. `stage_06_extract_patches` already matched the new contract.
- `/start` command rewires Task 5 to call `extract-patches` right after `parse-diff` and Task 8 to call `partition` with the new patch-generation args. The "Pre-Extract Patches to Disk" section is renamed and explicitly documents the two-stage materialization.

### code-review v2.0.0

#### Added
- `code_review_schema.py` defines the canonical Finding + ResultEnvelope schema (PLN-719 Foundation, schema_version 1). Three finding scopes (`diff`, `system`, `pr_metadata`), the canonical `system_marker` enum (`budget-exceeded`, `agent-failure`, `signal-extraction-failed`, `schema-version`, templated `coverage:{reviewer}`, `pr_description`, templated `commit:{sha}`), deterministic finding ids (`<reviewer>_f<index>`), and producer-side validators for both findings and the result envelope. Includes JSON Schema dicts for documentation and machine validation, and `normalize_legacy_finding` for upgrading pre-foundation findings in-flight.
- `finalize-result` subcommand consolidates validated findings, coverage state, and the canonical verdict (`APPROVED` | `NEEDS_ATTENTION` | `CHANGES_REQUESTED`) into a single `review_result.json` envelope. Buckets findings into `verified[]` / `justified[]` / `rejected[]` / `pending_verification[]` per the foundation spec; populates run context (pr_number, head_sha, diff_tip, base_ref, mode, intent), stats (by_severity, by_category, by_reviewer, by_finding_scope, verification, premise_cumulative_medium_count), and a telemetry block (duration, tokens, schema_versions_seen). Cross-validates the envelope before writing.
- `arbitrate-budget` subcommand is the single owner of "which reviewers run, against what cap" (PLN-719 Section 5). Defaults: `total_cap=20`, `bha_floor=1` (waived for docs-only PRs), `required_overflow_policy=fail_closed`, best-effort pruned by ascending priority. Emits canonical coverage-gap findings (`finding_scope: "system"`, `system_marker: "budget-exceeded"`, `severity: "HIGH"`, `required: true`) for every required reviewer that overflows the cap, gating the verdict to `CHANGES_REQUESTED` via rule 1.
- `prepare-run` subcommand emits a declarative `run_plan.json` describing the canonical 30-stage pipeline (PLN-719 Section 6). Stages from plans 01/03/05/06 (`detect-injection`, `extract-signals`, `validate-companions`, `resolve-coverage`, `coverage-critic`, `verify-findings`, `verify-coverage`) are present but marked `enabled: false` until those plans land. Validation gates anchor at `parse-diff`, `arbitrate-budget`, `spawn-reviewers`, `validate`, and `finalize-result`. Output is byte-identical across runs modulo the `review_id` uuid.
- `compute_canonical_prompt_hash` (PLN-719 Section 9): NUL-separated parts + NUL + `schema_version` folded into the hash. A MAJOR schema bump now invalidates every cache namespace at once.
- Determinism tier vocabulary (`deterministic` / `reproducible_via_cache` / `llm_driven`) and a `STAGE_DETERMINISM_TIERS` mapping in `code_review_schema.py` (PLN-719 Section 8). Required-reviewer selection cannot depend on `llm_driven` outputs; plans 03/05 extend the mapping when they ship.
- `SCHEMA.md` is the canonical reference for the Finding + ResultEnvelope schema, the `system_marker` enum, verdict precedence, budget arbitration policy, pipeline ordering, determinism tiers, cache key derivation, and the schema migration policy.
- New tests: `test_code_review_schema.py` (47 schema + round-trip + determinism-tier tests) and 31 new integration tests in `test_code_review_helpers.py` (`TestCanonicalSchemaIntegration`, `TestFinalizeResult`, `TestVerdictReadsEnvelope`, `TestArbitrateBudget`, `TestArbitrateBudgetVerdict`, `TestPrepareRun`, `TestCanonicalPromptHash`). Total: 368 passing tests (282 pre-existing untouched).

#### Changed
- `cmd_hygiene` now emits canonical schema fields (`schema_version`, `finding_scope: "diff"`, `system_marker: null`, `source: "hygiene"`, `reviewer: "hygiene"`, `reviewer_trigger: {"type": "always", "evidence": "deterministic-hygiene"}`, `emitted_at`, `evidence: []`, deterministic id). Existing finding shape preserved for backward compat (`category: "Repo Hygiene"` remains a canonical category alias).
- `cmd_collect_findings` assigns deterministic finding ids (`<reviewer>_f<index>`) derived from `agent_<reviewer>.json` filenames; preserves any pre-assigned id; passes every finding through `normalize_legacy_finding` so the merged `findings.json` is uniformly canonical.
- `cmd_validate` honors `finding_scope`. Diff-scoped findings keep the existing file-in-diff and line-in-changed-range filters; system- and pr_metadata-scoped findings bypass those checks but require a canonical `system_marker` (validator rejects unknown markers and rejects markers that don't belong to the declared scope). Dedup is by `(system_marker, category)` for non-diff findings; cross-file Jaccard grouping is gated to diff scope.
- `cmd_verdict` reads `review_result.json` when provided (canonical verdict APPROVED|NEEDS_ATTENTION|CHANGES_REQUESTED) and maps to the legacy `approve|needs_attention|decline` tag for backward compat with `run-loop.sh` and the github-review presenter. Falls back to `validate_output.json` when the envelope is absent. Emits both fields in the output JSON.
- `cmd_compute_hashes` uses the canonical prompt_hash recipe and emits `schema_version` alongside `prompt_hash` and `context_key`. Pre-2.0.0 caches are invalidated by the MAJOR schema bump (cache regeneration is cheap; migration logic is bug-prone).
- `/fix` skill prefers `review_result.json` when present and explicitly surfaces system-scoped findings (coverage gaps, budget overflows) as "manual surface" items that cannot be auto-fixed in code.
- README documents the new foundation architecture, references `SCHEMA.md`, and adds `finalize-result`, `arbitrate-budget`, and `prepare-run` to the subcommand table.

### code v1.11.20

#### Changed
- README installation guidance now states the installer installs and verifies the five Symphony runtime plugins at user scope, with `bootstrap` excluded from the default runtime install.

#### Fixed
- `install.sh` now refreshes the configured `closedloop-ai` marketplace, installs the five Symphony runtime plugins at user scope, then verifies those runtime plugins have existing install paths and enabled user-scoped `claude plugin list --json` entries. Disabled user-scoped runtime plugins are re-enabled once and re-read before the installer reports success.
- Project-scoped ClosedLoop plugin duplicates are repaired before user-scope install/update when Claude reports a usable `projectPath`; entries without a usable project path now produce a manual project-directory uninstall command while user-scope repair continues.

### code v1.11.19

#### Changed
- `test_write_runs_log_entry_uses_workdir_root` in `test_run_loop_failure_marker.py` now `unset`s `CLOSEDLOOP_COMMAND` and `LAST_CLAUDE_COMMAND` inside the bash heredoc before invoking `write_runs_log_entry`, so the default-command path is exercised deterministically regardless of the caller's ambient environment. Test-only change isolating the existing behavior — no production code paths altered.

### judges v1.7.0

#### Added
- `validate_agent_registry.py` pre-flight tool at `plugins/judges/tools/python/` validates every agent markdown file in the judges agent directory before a judge batch runs. Discovers `.md` files, validates frontmatter (`name`, `description`, `model`, `tools`, `skills`), checks `model` against `VALID_MODELS`, flags hallucinated tools, and — when `--artifact-type {plan,code,prd,feature}` is passed — verifies every judge required by `JUDGE_REGISTRY` for that artifact is present and valid. Fails fast (exit 1) before the batch is dispatched, surfacing the failures via the structured `RegistryValidationResult` shape. CLI accepts `--artifact-type` and `--workdir` flags so the documented `run-judges` SKILL invocation actually runs.
- `error_reason: Optional[str]` field on `CaseScore` schema. Judges that terminate via the error path (`final_status=3`) now record their failure context on the case score itself, enabling downstream aggregation to distinguish "judge had no opinion" from "judge said 0". The field is additive with `None` default, so existing report consumers ignore it safely.
- `compute_average_excluding_errors` helper in `validate_judge_report.py` averages `MetricStatistics.score` across `CaseScore` entries whose `final_status != 3`, returning the average score as `Optional[float]`. Callers separately compute the N/M count of contributing judges for display (e.g. "avg of N/M judges"). Errored judges are excluded from the mean rather than dragged into it.
- `run-judges` SKILL.md documents the pre-flight validation step, the `ERR` marker rendering on summary tables, and the new "avg of N/M judges" annotation that surfaces when one or more judges errored.
- `test_validate_agent_registry.py` covers frontmatter parsing, missing/extra fields, invalid model values, hallucinated tools, valid agents, directory-level aggregation (including non-existent / empty / partially-invalid directories), and the CLI entrypoint.
- `TestValidateAgentRegistry::test_unknown_artifact_type_returns_structured_error` covers the new `artifact_type` guard.
- `TestJudgeRegistrySync::test_judge_registry_matches_validate_judge_report` asserts the two `JUDGE_REGISTRY` definitions (in `plugins/judges/tools/python/validate_agent_registry.py` and `plugins/judges/skills/run-judges/scripts/validate_judge_report.py`) stay byte-for-byte equal. If a judge is added to one registry but not the other, the pre-flight check would pass while post-run validation would fail — exactly the drift scenario the pre-flight check exists to prevent. The test uses the existing `sys.path` manipulation pattern (per CLAUDE.md's "Standalone scripts with no cross-tool imports within a plugin" rule) rather than extracting the registry to a shared module.

#### Changed
- `run-judges/SKILL.md` summary-table prose now spells out the `ERR` marker convention, the "avg of N/M judges" wording when at least one judge errored, and the placement of the pre-flight `validate_agent_registry.py` step ahead of judge execution. Path in the documented invocation corrected from `skills/run-judges/scripts/` to `tools/python/` so the example resolves to the real script.
- `validate_judge_report.py` consumes the new `error_reason` field, propagates it through aggregation, and skips errored case scores when computing the per-judge / per-metric average rather than coercing their ordinal status into the mean.
- `validate_agent_registry.py` extracts the duplicated `RegistryValidationResult` finalization logic into a private `_populate_result` helper. Both the `Unknown artifact_type` early-return path and the normal completion path now share a single field-assignment site, so future additions to `RegistryValidationResult` cannot silently miss the error branch. DRY refactor — no behavior change.

#### Fixed
- `validate_agent_registry()` now returns a structured `RegistryValidationResult` with an `Unknown artifact_type '<value>'. Valid values: [...]` error when called with an `artifact_type` outside `JUDGE_REGISTRY`, instead of raising an uncaught `KeyError`. The CLI was already safe via argparse `choices`, but programmatic callers (and the soon-to-be agent-registry tests) now get the same structured failure shape as the existing "directory does not exist" and "path is not a directory" early-returns. Counters (`total_agents` / `valid_agents` / `invalid_agents`) are populated before the early return so the result shape stays consistent across error paths.
- `test_validate_judge_report.py::_make_minimal_casescore` no longer re-imports `MetricStatistics` inside the function body — it was already imported at module level via `from validate_judge_report import (..., MetricStatistics, ...)`, so the in-function import shadowed the module-level name and carried a redundant `# type: ignore` comment. One-line removal, no behavior change.
- Test fixture for `error_reason` now matches the documented contract (set only when `final_status=3`), preventing tests from accidentally encoding a non-contract-compliant shape into the regression suite.

### code v1.11.18

#### Added
- `decision-table` skill `references/edge-cases.md` gains six new edge-case categories with mandatory test requirements: External contract literal binding, Cross-surface propagation and reconciliation, Data visibility versus side effects, Cached capability drift, Backward-compatible persisted defaults and promotion, and Distributed lifecycle coverage.
- `decision-table` `references/artifact-format.md` adds a `Contract Literal Inventory` table schema (Literal / Contract Type / Source of Truth / Producers / Consumers / Compatibility / Failure Behavior) and expands the behavioral edge-case checklist and `Required Tests` guidance with exact contract-literal binding tests whose mocks fail closed.
- `decision-table` `references/review-prevention.md` adds seven new anti-patterns: external contract literal collision, permissive mock hiding wrong external key, cross-surface write with no reconciliation path, visible data mistaken for fired side effect, stale cached capability false negative/positive, legacy persisted record promoted or deleted without evidence, and distributed lifecycle gap. Contract-Heavy Review Surface section gains parallel coverage bullets.

#### Changed
- `decision-table` `SKILL.md` steps 6, 8, and 12 require classifying external contract literals (feature flag keys, query parameters, cache segments, headers, event names, command names, plugin identifiers, URL schemes, reason/status strings, etc.) by semantic purpose and source of truth before treating similar-looking strings as aliases; require treating web/backend/Electron/local-store/notification/cache/peer as separate surfaces unless proven shared; require test oracles that fail closed for wrong literals.

### self-learning v1.2.5

#### Added
- `perf_summary.py` now reports token usage from `agent` perf rows. Agent and phase tables include total, input, output, cache, and peak-context token columns; JSON output includes granular token fields plus a new `phase_agents` table keyed by derived phase and `agent_name`.
- Phase token attribution now joins `agent` events into completed phase windows by `run_id`, `iteration`, `command`, and `agent.started_at`. Phase timeline output includes per-phase-instance token totals and peak context. Legacy perf rows without token fields remain compatible; when an adjacent `claude-output.jsonl` / `claude-output-*.jsonl` file has matching `tool_use_result.agentId` usage, the summary backfills token totals from that archive.

### code v1.11.17

#### Added
- `/plan-validate` skill auto-syncs answered questions from markdown plans into `plan.json`. `validate_plan.py` gains an `--auto-sync` flag (passed by default from the skill) that extracts answers in bold, italic, and plain formats from the markdown, migrates entries from `openQuestions` to `answeredQuestions`, and falls back to `recommendedAnswer` when no answer text is found. Covered by `test_auto_sync_answers.py` and `test_validate_plan_sync.py`.

### code v1.11.16

#### Added
- `run-loop.sh` honors a pre-set `CLOSEDLOOP_COMMAND` from the parent process (e.g. the Electron app's websocket-derived command). New `resolve_closedloop_command()` helper applies the precedence pre-set `CLOSEDLOOP_COMMAND` → `--prompt` value → `"interactive"` fallback and persists the resolved command in `state.json` for correct Datadog per-command attribution and manual-resume recovery. On resume, the persisted command overrides any stale ambient `CLOSEDLOOP_COMMAND`.

#### Fixed
- `write_runs_log_entry` default chain changes from `LAST_CLAUDE_COMMAND → self_learning` to `LAST_CLAUDE_COMMAND → CLOSEDLOOP_COMMAND → plan_execute`, removing the over-attribution of fresh-start Loops to `self_learning` in Datadog (FEA-936).
- `emit_perf_event` empty-input guard treats an empty `json_line` as a silent no-op, preventing Loop-wide kills under older jq + `set -euo pipefail` and corrupt blank perf.jsonl lines under modern jq 1.8+ (FEA-936).
- Legacy state-file read path hardened with `|| echo ""` so older state files lacking the `command:` field do not abort the script under `set -euo pipefail`.
### code v1.11.15

#### Changed
- `pre-tool-use-hook.sh` now falls back to `tool_input.description` when `subagent_type` is empty, so every Agent spawn gets a meaningful label in Datadog telemetry instead of a blank `plannedSubagentType`.
- Orchestrator prompt (`prompt.md`) annotates all unnamed haiku/sonnet subagent spawns with consistent `description` labels: `plan-editor`, `critic:{critic_name}`, `build-fixer`, `dt-telemetry-writer`, `visual-qa-support`.

#### Added
- Tests for the description-fallback behavior (Test 5: fallback when subagent_type is empty, Test 6: subagent_type takes precedence over description).

### code v1.11.14

#### Fixed
- `rate_limit_signal` in `run-loop.sh`'s `detect_claude_terminal_failure` now fires only when `rate_limit_info.status == "rejected"` (or `overageStatus == "rejected"` with `isUsingOverage == true`), replacing the prior "any non-`allowed` value" denylist. Benign heartbeats with `status` of `allowed_warning`, `paused`, `throttled`, or informational `exceeded` no longer abort the loop. The `status_429` and error-string match paths remain unchanged, so genuine rate-limit failures continue to be marked. (PLN-530)

#### Changed
- Expanded `test_rate_limit_event_predicate` parametrization with RL-18..RL-31 covering `allowed_warning`, the rejected-only fatal path, overage-branch regression guards, and cross-branch interactions. Pre-existing rows for `paused`, `throttled`, `exceeded` (with overage on), and bare `rejected` (with `isUsingOverage` false) flip from `CLAUDE_RATE_LIMIT` to no-signal to encode the new gating. Adds Group E (RL-32..RL-35) malformed-payload coverage exercising jq's string-equality and object type guards, plus a Group G end-to-end test feeding a realistic Claude JSONL stream with `allowed_warning` heartbeats and asserting no signal fires.

### code v1.11.13

#### Fixed
- `rate_limit_signal` in `run-loop.sh`'s `detect_claude_terminal_failure` now requires `rate_limit_info.isUsingOverage == true` before a non-`allowed` `overageStatus` counts as a rate-limit failure. Prevents false positives when the org is not actually consuming overage capacity but `overageStatus` is still populated. The `status != allowed`, `status_429`, and error-string match paths remain unchanged, so existing true-positive detection is preserved.

#### Changed
- Refactored repeated `is_error` / `isApiErrorMessage` envelope-string matching across `rate_limit_signal`, `context_limit_signal`, and `auth_challenge_signal` into a single shared `envelope_text_match(pat)` jq helper. Three near-identical predicate definitions collapse to one helper invocation each — same behavior, less duplication.
- Removed dead jq helpers (`user_texts`, `error_texts`, `text_blob`, `first_user_text`, `first_error_text`, `error_shaped`) left over from the wider matching scheme that was scoped down in the v1.11.11 source-attribution fix.
- Expanded `test_rate_limit_event_predicate` parametrization to cover `isUsingOverage` true/false/missing variants, malformed payloads, and bug-reproduction cases (RL-01..RL-17, RL-X2, RL-X4) so the new gating condition is exercised end-to-end.

### code v1.11.12

#### Fixed
- `run-loop.sh` now fails the loop when `max_iterations` is reached with zero successful iterations, emitting a `RUNNER_ERROR/MAX_ITERATIONS_NO_PROGRESS` user-visible failure and exiting with code 4. A new `successful_iterations` counter is incremented on non-empty results or `COMPLETE` promise detection, and `runs.log` entries gain an optional 8th field (`successful_iterations`) appended only on the max-iterations exit path — older readers that parse the leading 7 fields stay compatible. Covered by new `test_run_loop_failure_marker.py` cases for the no-progress failure path. Also isolates `test_reduce_failures_reads_runs_log_from_workdir_root` from the ambient `CLOSEDLOOP_ITERATION` env var so the test no longer depends on the caller's environment.

#### Changed
- `verification-subagent` now includes `SendMessage` in its allowed tools so verification flows can send follow-up messages while preserving the existing `Read`, `Glob`, and `Grep` inspection access.
- Decision-table guidance now includes durable finalization and replay eligibility coverage for flows that persist local terminal state before external acknowledgement. The artifact-format, edge-case, and review-prevention references call out retryable finalization failures, acknowledgement cleanup, restart replay, and retained credential or marker data requirements.

### code v1.11.11

#### Fixed
- `detect_claude_terminal_failure` in `run-loop.sh` no longer treats benign Claude `rate_limit_event` heartbeats as terminal failures. The `rate_limit_signal` jq predicate now requires `rate_limit_info.status` or `overageStatus` to be a non-`allowed` value before a `rate_limit_event` entry counts as a failure, so successful runs that emit allowed-status heartbeats stop creating false `loop-error.json` markers. Failure messages are now sourced from the triggering entry's own `result`/`error` string rather than scanning unrelated assistant prose, and `auth_challenge_signal` only fires inside `is_error` / `isApiErrorMessage` envelopes so plain assistant text mentioning auth never trips the auth-challenge classifier.
- `rename_orphan_output_on_start` in `run-loop.sh` now requires `state.json`'s recorded `workdir` to match the current workdir before reusing its `prev_run_id` to rename an orphan `claude-output.jsonl`. Prevents cross-workdir RUN_ID reuse when a stale `state.json` from another workdir is reachable.

#### Changed
- `test_run_loop_failure_marker.py` consolidates the PLN-502 heartbeat-false-positive cases behind a shared `run_detect` helper that centralizes the bash-source boilerplate for invoking `detect_claude_terminal_failure`. Cuts duplicated fixture setup across the rate-limit-signal, message-sourcing, auth-challenge-envelope, and workdir-mismatch test groups so each case focuses on fixture data and assertions.

### code v1.11.10

#### Added
- New `pre-tool-use-hook.sh` writes a per-tool-call sentinel JSON file at `$CLOSEDLOOP_WORKDIR/.closedloop-ai/.tool-calls/{TOOL_USE_ID}` capturing `started_at`, `tool_name`, `agent_id`, `run_id`, `command`, and `iteration`. Designed to be non-blocking: fails open (`trap 'exit 0' ERR`) on any internal error so the caller is unaffected. Emits a `spawn` perf event when `tool_name` is `Agent`, recording `parent_session_id`, `parent_agent_id`, and `planned_subagent_type` from the hook payload. Stdin parsed via a single `jq` `@sh` invocation matching the post-hook idiom. Safety comes from the additive event schema — perf.jsonl readers ignore unknown events, so emitting an extra `tool`/`spawn` row never breaks downstream consumers — and the fail-open contract above.
- New `post-tool-use-hook.sh` reads the sentinel written by the pre-hook, computes tool-call duration, and appends a `tool` event to `perf.jsonl` with `event`, `run_id`, `command`, `iteration`, `agent_id`, `tool_name`, `started_at`, `ended_at`, `duration_s`, and `ok` fields. Attribution (run_id/command/iteration) is taken from the sentinel rather than the post-hook environment so concurrent runs do not cross-attribute. Emits an additional `skill` event when `tool_name` is `Skill`, sourcing `skill_name` from `tool_input.skill` and falling back to `tool_input.command`. Same fail-open trap and additive-schema safety contract as the pre-hook.
- New `plugins/code/hooks/tests/` bash suite covering the new perf hooks: `test_helpers.sh` (shared pass/fail counters, `assert_field_present`, `assert_field_equals`, `setup_temp_env`, `create_sentinel`); `test_tool_event.sh` (post-hook emits a complete `tool` event with all required fields and honors sentinel-based attribution overrides); `test_skill_event.sh` (post-hook emits both `tool` and `skill` events for `Skill` tool calls, with skill-name fallback); `test_spawn_event.sh` (pre-hook emits a `spawn` event for `Agent` tool calls and writes a sentinel for non-Agent tools); `test_fail_open.sh` (both hooks exit 0 and do not corrupt `perf.jsonl` when an internal step fatally errors, including read-only sentinel directories, missing/corrupted sentinels, and exit-1 stub replacements); `test_correlation.sh` (end-to-end pre→post run, sentinel-attribution-wins regression for PR #70 review findings).

#### Changed
- `plugins/code/hooks/hooks.json` registers the new `pre-tool-use-hook.sh` alongside the existing `pretooluse-hook.sh` under `PreToolUse`, and adds a new `PostToolUse` entry pointing at `post-tool-use-hook.sh`. The legacy pre-hook is preserved so existing JIT-pattern injection behavior is unchanged.

### code v1.11.9

#### Added
- `subagent-stop-hook.sh` agent perf event extended with token aggregation and routing metadata. The hook now parses the agent transcript JSONL, sums `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens` across assistant turns, and tracks `total_context_tokens` as the per-turn high-water mark (max of any single turn's full usage) rather than a cumulative running total — preserving a peak-pressure signal instead of collapsing to the final sum. The event also carries `model` and `parent_session_id` from the hook payload (emitted as `null` when absent) and a `command` field that defaults to `"interactive"` when `CLOSEDLOOP_COMMAND` is unset, matching `record_phase.sh` and `run-loop.sh`'s `emit_perf_event` so phase, iteration, pipeline_step, and agent rows can be joined by command in Datadog. Transcript selection keys on top-level `type == "assistant"` reading `.message.usage` (mirroring `stream_formatter._accumulate_usage`); a malformed or missing transcript fails open and emits zero-token fields without aborting the hook. Every numeric field defaults to `0` on missing or malformed input, and existing `perf.jsonl` consumers ignore unknown fields, so the additive shape is safe. New tests in `test_subagent_stop_hook.py` cover token sums with cache reads, per-turn HWM, missing/malformed transcripts, model/parent_session_id null handling, and the command-default join contract.

#### Changed
- `command:` field is now populated on every `perf.jsonl` event row produced by the orchestrator and producer scripts. `run-loop.sh::emit_perf_event()` adds `command:` (defaulting to `"interactive"` when `CLOSEDLOOP_COMMAND` is unset) so every `phase`, `iteration`, and `pipeline_step` event carries it; `record_run.sh` emits its singular `run` event on every fresh-start Loop; `record_phase.sh` always includes `command:` in the emitted JSON. The fail-open `trap 'exit 0' ERR` contract on the producer scripts is preserved. `test_record_run.py` and `test_record_phase.py` are updated to assert the `command:` field is present on every event; `plugins/code/README.md`'s `record_run.sh` description now reads "Emitted unconditionally and fails open".

### code v1.11.8

#### Fixed
- `run-loop.sh` now classifies known Claude terminal failures before generic exit-code retry handling. Structured JSONL/stderr rate-limit, context-limit, and auth/account challenge signals write signed `loop-error.json` markers with stable subcodes, archive `claude-output.jsonl` through the existing `claude-output.name.txt` sidecar, release lock/state, and stop retrying. Unknown or malformed failures remain generic, and successful prose mentioning rate limits no longer creates false markers. Marker messages derived from Claude JSONL are clamped before reaching the existing 1000-character marker writer limit. New tests in `test_run_loop_failure_marker.py` cover observed rate-limit JSONL, camelCase API status, stderr context limits, auth/account challenges, oversized messages, false-positive prose, and rate/context marker finalization.

#### Changed
- Decision-table review guidance now calls out adapter-variant ORM/database error metadata and existing-data migration blockers for new uniqueness constraints or stricter persisted invariants. The edge-case and review-prevention references require rows and tests for constraint-name strings, field/column arrays, missing or unrelated metadata, duplicate/invalid existing rows, cleanup/backfill paths, explicit preflight failures, and migration races.

### code v1.11.7

#### Added
- Per-run `claude-output.jsonl` archival in `run-loop.sh`. New helpers `sanitize_output_run_id`, `rename_orphan_output_on_start`, and `rename_output_on_exit` rename the live JSONL to `claude-output-<run_id>.jsonl` on every loop exit (including spurious-complete, interrupt, and error paths) and write a `claude-output.name.txt` sidecar pointing at the latest archived file. On startup, any orphaned `claude-output.jsonl` left from a prior run is renamed using the previous `RUN_ID` from `state.json` or the last entry in `runs.log` (or an `orphan-<timestamp>` fallback), and the sidecar is cleared so consumers do not read stale prior-run pointers. Run id values are sanitized (`[^A-Za-z0-9._-]` collapsed to `_`) before being interpolated into the destination filename. New tests in `test_run_loop_failure_marker.py` cover the rename-on-exit, orphan-rename-from-runs.log, and workdir-root `runs.log` paths.
- Claude session-id capture in `run-loop.sh`. New helpers `extract_claude_session_id` (jq-based extraction across `session_id`/`sessionId`/`message.*`/`item.*` shapes), `record_claude_session_id` (sets `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID`, exports `CLOSEDLOOP_SESSION_ID`), and `sanitize_runs_log_field` (strips `\r`/`\n` and replaces `|` with `_`). `record_claude_session_id` writes `$workdir/session-id.txt` only for the `plan_execute` command so post-loop `code_review` and fix sessions do not overwrite the operation-level correlation id consumed by desktop finalization. Plan/execute, post-loop review, and fix invocations now capture session ids and route them into the runs.log entry for that step. New tests cover the primary plan/execute write, the code-review preservation of the primary session, and the runs.log workdir-root location with sanitized command/session fields.

#### Changed
- `write_runs_log_entry` in `run-loop.sh` now writes to `$workdir/runs.log` instead of `$workdir/.learnings/runs.log`, matching the new `self-learning` `prune-learnings.sh` and `evaluate_goal.py` location. Keeps the runs ledger at the workdir root next to `state.json` and `plan.json` rather than nested inside `.learnings/`.
- `runs.log` row format extended to `run_id|timestamp|goal|iteration|status|command|last_session_id`. The first five fields are the legacy contract; `command` (e.g. `plan_execute`, `code_review`, `self_learning`) and `last_session_id` are append-only so older self-learning readers stay compatible. `write_runs_log_entry` accepts optional 4th/5th arguments for explicit command/session overrides and falls back to `LAST_CLAUDE_COMMAND`/`LAST_CLAUDE_SESSION_ID` (or `session-id.txt`) otherwise.
- `--codex-model` default in the `/code:plan-with-codex` README documentation updated from `gpt-5.4` to `gpt-5.3-codex` to match the actual command default.

### self-learning v1.2.4

#### Fixed
- `evaluate_reduce_failures` in `self-learning/tools/python/evaluate_goal.py` only consults the `CLOSEDLOOP_ITERATION` environment variable as a fallback when the current `run_id` is not found in `runs.log`. Previously the env var unconditionally overwrote the iteration count parsed from `runs.log`, which could mis-score goals when an outer loop exported a stale `CLOSEDLOOP_ITERATION` value.

### self-learning v1.2.3

#### Changed
- `perf_summary.py` agent-event schema docstring promotes `command` to a required field on both `agent` and `phase` events, matching the producer behavior in `subagent-stop-hook.sh`, `record_phase.sh`, `record_run.sh`, and `run-loop.sh::emit_perf_event()`. `model`, `parent_session_id`, and the four token-count fields (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) plus `total_context_tokens` remain marked optional because they fall back to `null`/`0` when the SubagentStop payload or transcript is missing or unparseable. Coordination version bump alongside `code` v1.11.9 so the two plugins ship together as a matched set.

### self-learning v1.2.2

#### Changed
- `prune-learnings.sh` and `evaluate_goal.py` now read and rotate `runs.log` from `$WORKDIR/runs.log` instead of `$LEARNINGS_DIR/runs.log` (`<workdir>/.learnings/runs.log`). The runs ledger now lives at the workdir root alongside `state.json` and `plan.json`, matching where `run-loop.sh` writes it. New tests `test_prune_learnings.py` and a `test_reduce_failures_reads_runs_log_from_workdir_root` case in `test_evaluate_goal.py` lock in the new location.
- `goal-stats` command documentation (`commands/goal-stats.md`) now describes the pipe-delimited `runs.log` row format `run_id|timestamp|goal|iteration|status[|command|last_session_id]` and notes that `command` and `last_session_id` are optional append-only fields so legacy 4+ field rows remain valid. The `runs.log` data-source description was updated to mention the optional command/session correlation columns.
- `evaluate_goal.py` comment on `RUNS_LOG_MIN_FIELDS` clarifies that reduce-failures only needs `run_id` and `iteration`, so legacy 4+ field rows and newer session-correlated rows are both accepted.

#### Fixed
- `prune-learnings.sh` session enumeration in `prune_sessions()` no longer relies on `mapfile` piped through `tac`. Replaced `mapfile -t all_sessions < <(ls -1t "$sessions_dir" | tac)` with a `while IFS= read -r ... done < <(ls -1tr ...)` loop, which avoids the `tac` external dependency (not present on default macOS) and keeps the oldest-first ordering needed for FIFO pruning.

### code v1.11.6

#### Added
- New `record_run.sh` script emits exactly one `run` event per Loop to `perf.jsonl` carrying `command`, `repo`, `branch`, and `started_at`, so every perf record can be attributed to the slash-command that launched the Loop. Fails open on any unexpected error (`trap 'exit 0' ERR`). Invoked synchronously from `run-loop.sh:main()` with `|| true` and only on fresh-start invocations (resumed Loops do not re-emit), so the `run` event is appended before the first `phase` event without ever changing the Loop's exit code and without violating PRD-254 AC-1's "exactly one `run` event per Loop" guarantee.
- New `CLOSEDLOOP_COMMAND` environment variable exported by `run-loop.sh` next to `CLOSEDLOOP_RUN_ID`, derived from `PROMPT_NAME` and defaulting to `interactive` for bare `/code:code` invocations. The launching command is also persisted in `state.json` (`command:` field in the YAML frontmatter) and restored on resume so `CLOSEDLOOP_COMMAND` keeps its original value instead of degrading to `"interactive"` when the `--prompt` CLI flag isn't re-passed. Older state files lacking the `command` field preserve prior behavior. Hooks and child processes inherit the variable automatically.
- New `command` field on every `phase`, `iteration`, `pipeline_step`, and `agent` perf event. Implemented in `record_phase.sh`, `subagent-stop-hook.sh`, and the `emit_perf_event` helper in `run-loop.sh` (single `jq -n -c` filter per event — no extra `jq` invocation cost).
- `record_run.sh` captures `repo` and `branch` via `git -C` with GNU `timeout` as a hang guard when available, falling back to bare `git -C ...` when `timeout` isn't on `PATH` (default macOS without `coreutils`) so dev machines never silently emit empty `repo`/`branch` fields.
- New `plugins/code/tools/python/test_record_run.py` (covering JSON shape, fail-open paths, repo/branch capture under a fake-`git` PATH shim, and a no-`timeout`-on-PATH regression case) and `plugins/code/tools/python/test_record_phase.py` (covering field correctness and missing-state fail-open). Both files run under `pytest` with no extra fixtures.
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

### code v1.11.0

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
