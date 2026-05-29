---
description: Run comprehensive code review — locally or on GitHub PRs with inline comments
argument-hint: "[scope] [--github] [--hygiene-only] [--base <ref>] [--since-last-review] [--full-review]"
---

# Comprehensive Code Review

Run a multi-agent code review with partitioned deep review, deterministic hygiene checks, model routing, and validated findings. Supports two modes:

- **Local mode** (default): Reviews changes and presents findings in the terminal
- **GitHub mode** (`--github`): Reviews a PR, posts inline comments, and writes a summary file

## Usage

```
/start                              # Review open PR diff for current branch, or main...HEAD if no PR
/start staged                       # Review only staged changes
/start file1 file2                  # Review specific files
/start 123                          # Review PR #123 diff locally (no posting)
/start --github                     # GitHub CI: auto-detect PR from branch, post inline comments
/start --github 123                 # GitHub CI: review PR #123, post inline comments
/start --hygiene-only               # Fast hygiene-only check (zero LLM tokens)
/start --base develop               # Diff against a specific base branch
/start --since-last-review          # Review only changes since last successful review
/start --full-review                # Force full diff (disable auto-incremental)
```

## GitHub Mode Constraints

**If MODE=github**, read the GitHub-specific instructions:
```
Read ${CLAUDE_PLUGIN_ROOT}/prompts/github-review.md
```
This file contains posting constraints, PR metadata resolution, and output steps. Local mode does not need this file.

---

## Execution Model (PLN-719 Phase 4b)

The review pipeline is driven by a **declarative run plan** emitted by the `prepare-run` helper. The plan is the single source of truth for stage ordering, helper invocations, and on-failure semantics — this command's job is to walk it.

The walk is hybrid:
- **Deterministic helper stages** (most of the plan) — invoke the named `code_review_helpers.py` subcommand with the plan's args after token substitution. No prose decisions.
- **Agent fleet stages** (`stage_20_spawn_reviewers`, `stage_23_verify_findings`) — spawn parallel sub-agent Tasks using the per-agent prompt templates in this file.
- **Present stage** (`stage_29_present`) — render results using the format in this file.

Four runtime gates modify walker default behavior (they are runtime-driven and either replace the default walk or add a condition on top of a plan stage):
1. **Gate A** — after `stage_12_hygiene`, if `flags.hygiene_only` is true: present hygiene findings and **EXIT** (no further stages, no verdict, no footer).
2. **Gate B** — after `stage_19_cache_check`, invoke `route` (model routing) to compute `fast_path` and `max_bha_agents`. `fast_path == true` skips `stage_17_partition` entirely and drives a single fast-path reviewer in `stage_20`.
3. **Gate C** — before `stage_26_cache_update`, skip if `fast_path == true` OR `CACHE_DIR` is empty.
4. **Gate D** — before `stage_27_review_state_write`, skip unless `MODE == "local"`, `CACHE_DIR` is set, AND all reviewer agents succeeded.

Read this entire file before starting. The agent templates and present format are referenced by stage id below.

**CRITICAL — No shell variables in Bash commands.** Claude Code prompts for manual approval on every `$VAR` expansion in paths. Substitute all resolved values directly into every Bash command. The only real env var is `${CLAUDE_PLUGIN_ROOT}` (resolved once in stage 0).

Throughout this document, bash code blocks use `<ANGLE_BRACKET>` placeholders (`<HELPERS>`, `<CR_DIR>`, `<CACHE_DIR>`, `<DIFF_SCOPE>`, etc.) to mark values you must replace with the resolved literal string before running the command. These are template tokens, NOT shell variables.

---

## Stage 0 — Initialize Run Plan

Run before the walker. Three substeps:

**0a. Parse flags from `$ARGUMENTS`** and remove them from the remaining args:

```
MODE = "local"
HYGIENE_ONLY = false
BASE_REF_OVERRIDE = ""
SINCE_LAST_REVIEW = false
FULL_REVIEW = false

If "--github" present:           MODE = "github"; remove
If "--hygiene-only" present:     HYGIENE_ONLY = true; remove
If "--base <ref>" present:       BASE_REF_OVERRIDE = <ref>; remove both tokens
If "--since-last-review" present: SINCE_LAST_REVIEW = true; remove
If "--full-review" present:       FULL_REVIEW = true; remove
```

Flag incompatibility checks (emit error and exit immediately):
- `--base` with `staged` scope — staged has no base ref
- `--since-last-review` with `staged` — requires branch scope
- `--since-last-review` with `--github` — local-only flag
- `--since-last-review` with `--full-review` — contradictory

The remaining `$ARGUMENTS` (after flag removal) is `SCOPE_ARGS`. Detect `PR_NUMBER` if `SCOPE_ARGS` is a single integer.

**0b. Resolve plugin paths and create the CR_DIR via prepare-run.** Run one Bash command to discover the plugin root:

```bash
echo "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py"
```

Track that resolved path as `HELPERS` and `PLUGIN_ROOT = ${CLAUDE_PLUGIN_ROOT}`. Then create a session-scoped `CR_DIR` and emit the run plan.

**Do NOT redirect `setup`'s stdout to a file with `>`.** `setup` creates the `cr_dir` directory as a side effect AND prints its result JSON to stdout. A shell-style redirect would try to open `<CR_DIR>/setup.json` for writing before `cr_dir` exists, racing on directory creation. Capture stdout in-memory instead:

```bash
python3 <HELPERS> setup --mode <MODE> --cr-dir-prefix .closedloop-ai/code-review/cr-
```

Read stdout JSON. Extract `cr_dir` → `CR_DIR`, `start_time` → `CR_START_TIME`, `repo_name` → `REPO_NAME`, `current_branch` → `CURRENT_BRANCH`, `global_cache` → `GLOBAL_CACHE`. **Then** (now that `CR_DIR` exists on disk because `setup` created it) write the captured JSON to `<CR_DIR>/setup.json` for downstream helpers — use the Write tool, not a shell redirect.

```bash
python3 <HELPERS> prepare-run \
  --cr-dir <CR_DIR> \
  --mode <MODE> \
  --hygiene-only <HYGIENE_ONLY> \
  --since-last-review <SINCE_LAST_REVIEW> \
  --full-review <FULL_REVIEW> \
  --base-ref-override "<BASE_REF_OVERRIDE>" \
  --scope-args "<SCOPE_ARGS>" \
  [--pr-number <PR_NUMBER>]
```

Reads `<CR_DIR>/setup.json` and writes `<CR_DIR>/run_plan.json` containing `review_id`, `flags`, `stages` (the 30-stage pipeline), and `validation_gates`. Read the run plan with the Read tool. Cache `STAGES`, `GATES`, `FLAGS` from the JSON.

**0c. Create the TodoWrite list.** Depends on MODE and HYGIENE_ONLY:

**If HYGIENE_ONLY is true** (either mode):
```
{ content: "Parse scope and get diff data", status: "pending", activeForm: "Parsing scope" }
{ content: "Run deterministic hygiene checks", status: "pending", activeForm: "Running hygiene checks" }
{ content: "Present hygiene findings", status: "pending", activeForm: "Presenting results" }
```

**Otherwise** (shared base):
```
{ content: "Parse scope and get diff data", status: "pending", activeForm: "Parsing scope" }
{ content: "Run deterministic hygiene checks", status: "pending", activeForm: "Running hygiene checks" }
{ content: "Assess scope and route models", status: "pending", activeForm: "Assessing risk" }
{ content: "Spawn reviewer agents in parallel", status: "pending", activeForm: "Spawning agents" }
{ content: "Collect, normalize, and validate findings", status: "pending", activeForm: "Validating findings" }
```

**GitHub mode adds:**
```
{ content: "Write findings and thread data to files", status: "pending", activeForm: "Writing review data" }
{ content: "Write summary to .closedloop-ai/code-review-summary.md", status: "pending", activeForm: "Writing summary" }
```

**Local mode adds:**
```
{ content: "Present findings by severity", status: "pending", activeForm: "Presenting results" }
```

If MODE=github, also Read `${CLAUDE_PLUGIN_ROOT}/prompts/github-review.md` now.

---

## Walker Contract

**Reading `<CR_DIR>/*.json` artifacts.** The walker reads run-plan output JSON to resolve placeholder tokens (`<DIFF_SCOPE>`, `<CACHE_DIR>`, etc.). If your session has a hook that intercepts the `Read` tool on generated artifacts (e.g. a code-discovery gate that demands codebase-memory-mcp lookups), fall back to `cat` via `Bash` — these are pipeline artifacts, not source code.

Walk `STAGES` in array order. For each stage:

1. **Skip if disabled.** If `stage.enabled` is `false`, skip silently — these stages are gated on sibling plans (01/03/05/06).
2. **Resolve depends_on.** If any stage in `depends_on` was disabled or aborted, skip this stage too.
3. **Resolve placeholder tokens** in `stage.args`. The token table is:

| Token              | Source                                                          |
|--------------------|-----------------------------------------------------------------|
| `<PLUGIN_ROOT>`    | `${CLAUDE_PLUGIN_ROOT}` resolved in stage 0                     |
| `<DIFF_SCOPE>`     | `<CR_DIR>/scope.json` → `diff_scope`                            |
| `<BASE_REF>`       | `<CR_DIR>/scope.json` → `base_ref`                              |
| `<DIFF_TIP>`       | `<CR_DIR>/scope.json` → `diff_tip`                              |
| `<SCOPE_KIND>`     | `<CR_DIR>/scope.json` → `scope_kind`                            |
| `<CACHE_DIR>`      | `<CR_DIR>/cache_config.json` → `cache_dir` (empty when no cache)|
| `<GLOBAL_CACHE>`   | `<CR_DIR>/setup.json` → `global_cache` (string "0" or "1")      |
| `<PROMPT_HASH>`    | `<CR_DIR>/hashes.json` → `prompt_hash`                          |
| `<CONTEXT_KEY>`    | `<CR_DIR>/hashes.json` → `context_key`                          |
| `<MODEL_ID>`       | `"opus"` (BHA's default; the orchestrator-chosen reviewer model)|
| `<INTENT>`         | `<CR_DIR>/intent.json` → `intent` (one of feature/fix/refactor/mixed) |
| `<START_TIME>`     | `CR_START_TIME` from stage 0                                    |
| `<STATE_KEY>`      | `"<review_branch>:<base_ref>"` from `<CR_DIR>/scope.json`       |

If a token's source file does not exist yet (a prior stage that produces it was skipped/disabled), pass an empty string. The helper subcommands accept empty values and degrade safely.

4. **Dispatch by `stage.kind`.**
   - **`helper`**: invoke `python3 <HELPERS> <stage.subcommand> <resolved args>`. If `stage.stdout` is set, redirect stdout to that file (`> <stage.stdout>`). If `stage.expected_outputs` is non-empty after the call, confirm at least one of those paths exists.
   - **`agent_fleet`**: dispatch to the per-stage agent fleet section below (`stage_20` → "Reviewer Fleet"; `stage_23` → reserved for plan 03).
   - **`present`**: dispatch to "Local Mode: Present Results" (MODE=local) or follow `github-review.md` Steps 6 and 8 (MODE=github).

5. **Honor `on_failure`** when the dispatched call fails or `expected_outputs` is missing:
   - `abort` — stop the walk and surface the error.
   - `continue` — log a warning and proceed to the next stage.
   - `continue_with_coverage_gap` — emit a `system_marker: "agent-failure"` finding (see "Agent Failure Recovery" below) and proceed.

6. **Run gates.** After completing a stage, scan `GATES` for any entry whose `after_stage` matches the stage just finished. Each gate checks `outputs` exist and are well-formed; `on_failure_action` follows the same `abort | continue | emit_coverage_gap` semantics.

7. **Branching gates** (see next section) fire at specific stage boundaries.

---

## Branching Gates

Four runtime gates modify walker default behavior. Each is documented below with the exact stage boundary it fires at.

### Gate A — After `stage_12_hygiene`: Hygiene-only early exit

If `FLAGS.hygiene_only` is true (or the equivalent `--hygiene-only` was passed):

1. If `CACHE_DIR` is set and `cache_result.json` produced a non-empty `status_message`, print it.
2. Mark "Present hygiene findings" `in_progress`.
3. Parse `<CR_DIR>/hygiene.json` and render using the "Hygiene Findings" format below.
4. If MODE=github, write hygiene findings to `.closedloop-ai/code-review-summary.md` and `.closedloop-ai/code-review-findings.json`; the workflow handles posting.
5. **EXIT.** Do not run any remaining stages — not route, partition, agents, validate, finalize, cache-update, review-state-write, verdict, or footer. Hygiene-only runs do not emit a `<pr_verdict>` tag (there is no findings_validated.json or review_result.json for verdict to read; invoking it would crash the walker via `on_failure: abort`). This matches the pre-Phase-4b orchestrator behavior.

### Gate B — After `stage_19_cache_check`: Route + fast_path decision

`route` (model selection) is not a canonical PLN-719 stage but the orchestrator needs `fast_path` and `max_bha_agents` before `stage_17_partition` actually runs. The run plan's array order places `stage_17_partition` after `stage_19_cache_check` (the stage id is a stable label; the execution order follows array position). So this gate fires between the two adjacent stages — the walker simply pauses after cache-check, invokes `route`, then resumes with partition.

Run `route`:

```bash
python3 <HELPERS> route \
  --diff-data <CR_DIR>/diff_data.json \
  --critic-gates .closedloop-ai/settings/critic-gates.json \
  --intent <INTENT> \
  > <CR_DIR>/route.json
```

Read `<CR_DIR>/route.json`. Cache `FAST_PATH` (bool), `MAX_BHA_AGENTS`, `MODELS`, `DOMAIN_CRITICS`, `HIGH_RISK_FILES`, `SIZE_CATEGORY` from the JSON.

3. If `CACHE_DIR` is set, print `cache_result.json`'s `status_message` now (before `stage_17_partition` runs).
4. If `FAST_PATH == false` (standard flow), proceed: walker continues to `stage_17_partition`, passing `--loc-budget 500 --max-files 25 --max-bha-agents <MAX_BHA_AGENTS>` in addition to the args declared in the run plan. When `CACHE_DIR` is set, swap `--diff-data` to `<CR_DIR>/uncached_diff_data.json` so partitions only contain uncached files.
5. If `FAST_PATH == true`, skip `stage_17_partition` (no `partitions.json` or `patches_p<N>.txt`; the fast-path reviewer consumes `patches_all.txt` directly). Print:
   - `"Fast path selected: 1 reviewer (<MODELS.fast_path_reviewer>)."`
   - If `CACHE_DIR` is set: `"BHA Cache: bypassed in fast-path mode."` and delete `<CR_DIR>/agent_cached_bha.json` if it exists.
   - Update the todo list: replace "Spawn reviewer agents in parallel" with "Run fast-path review".

### Gate C — Between `stage_25_finalize_result` and `stage_26_cache_update`

Skip `stage_26_cache_update` when `FAST_PATH == true` OR `CACHE_DIR` is empty. The cache update is only meaningful for the partitioned BHA flow.

When the stage does run, the walker adds `--exclude-test-partitions` to its args (test-only partitions reviewed by Sonnet must not poison the Opus cache).

### Gate D — Before `stage_27_review_state_write`: Runtime conditions

Skip `stage_27_review_state_write` unless **all** of these hold:

- `MODE == "local"` — review state is only meaningful for repeated local runs against the same branch; GitHub CI runs don't need it.
- `CACHE_DIR` is non-empty — review state is stored in the cache directory.
- Every reviewer agent succeeded (no failed/skipped partitions, no recovery retries that exhausted). On any agent failure, skip — the next `--since-last-review` run cannot rely on partial state.

These conditions mirror the cache-update gate (Gate C) and the pre-Phase-4b "Review State Write" prose. The walker honors `on_failure: continue` for this stage, so a skipped run never aborts the pipeline.

---

## Per-Stage Notes

These notes annotate the run-plan stages with anything not obvious from the plan itself. Stages not listed here have no special handling beyond the walker contract.

- **stage_01_setup**: already executed in stage 0b (which captured stdout and wrote `setup.json` itself). The walker treats this as a no-op; the run plan's `stdout` field is `None` for this stage because no shell redirect is correct here.
- **stage_02_prep_assets**: copies `shared_prompt.txt` and `bha_suffix.txt` from `<PLUGIN_ROOT>/tools/prompts/` to `<CR_DIR>`. Both cache and non-cache paths use these assets.
- **stage_03_resolve_scope**: writes `<CR_DIR>/scope.json` with `diff_scope`, `base_ref`, `head_ref`, `review_branch`, `diff_tip`, `pr_number`, `path_filter`, `scope_kind`, `pr_auto_detected`. After this stage, run `finalize-cache` to populate `<CR_DIR>/cache_config.json`. The walker uses these for token resolution downstream.
- **stage_07_auto_incremental**: runs **before** `stage_05_parse_diff` (its array position is between `stage_04_finalize_cache` and `stage_05_parse_diff`). This ordering matters: any `diff_scope` override must be applied to the cached `<DIFF_SCOPE>` token BEFORE parse-diff and extract-patches materialize `diff_data.json` and `patches_all.txt`, otherwise downstream stages see full-PR diff data alongside a narrowed token. The stage retains its `_07_` id as a stable label; execution order follows array position. Writes `<CR_DIR>/auto_incremental.json` with optional `diff_scope` (override) and `review_mode_line`. If `diff_scope` is non-null, update the cached `<DIFF_SCOPE>` token. Print `review_mode_line` (always) and, if `pr_auto_detected` was true in `scope.json`, print `"Auto-detected PR #<PR_NUMBER> for branch <REVIEW_BRANCH>."`.
- **stage_08_fetch_intent**: the helper writes `intent_context.json` into `cr_dir` itself; its stdout is a small `{path, source}` summary that the walker discards. The run plan's `stdout` field is `None` here because redirecting stdout to `intent_context.json` would corrupt the file by overwriting the helper's structured payload with the summary.
- **stage_12_hygiene**: writes `<CR_DIR>/hygiene.json` with hygiene findings. Triggers **Gate A** (hygiene-only exit) immediately after.
- **stage_17_partition**: positioned in the run plan array after `stage_19_cache_check` so Gate B's `route` invocation runs first and supplies `--max-bha-agents`. The stage id retains its `_17_` prefix as a stable label (stage ids are not strict ordinals; execution order follows array position). Reads `partitions.json` afterward; entries shape `{id, files, total_loc, is_test_only}` with `files[].file` (NOT `path`), `files[].loc`, `files[].is_test`, optional `files[].line_range`.
- **stage_19_cache_check**: writes `<CR_DIR>/cache_result.json` (stats), `<CR_DIR>/agent_cached_bha.json` (cached BHA findings, glob-compatible with `agent_*`), `<CR_DIR>/uncached_diff_data.json` (filtered diff_data for uncached files). Do NOT print the cache status here — it is printed in Gate A (hygiene exit) or Gate B (after route).
- **stage_20_spawn_reviewers**: agent_fleet stage. Dispatch to the "Reviewer Fleet" section below.
- **stage_22_validate**: writes `<CR_DIR>/findings_validated.json` via `> <CR_DIR>/findings_validated.json` redirection. Phase B will retire this file; it remains during the transition.
- **stage_25_finalize_result**: writes `<CR_DIR>/review_result.json` (the canonical envelope) BEFORE running schema validation. A non-zero exit signals reviewer-emitted category/field drift (e.g. a category not in the canonical enum) but does not block the pipeline — `on_failure: continue` lets `stage_28_verdict` read the structurally complete envelope. Surface the stderr text in the present step so operators can correct prompts/schema; do not abort.
- **stage_26_cache_update**: gated by **Gate C**.
- **stage_27_review_state_write**: gated by **Gate D**.
- **stage_29_present**: present stage. Dispatch to "Local Mode: Present Results" or the GitHub steps in `github-review.md`.

---

## Reviewer Fleet (stage_20_spawn_reviewers)

This stage runs when the walker reaches `stage_20`. It branches on `FAST_PATH` from Gate B.

### Context Budget Constraints (apply to both branches)

The orchestrator must NOT read source files or fetch patches itself. All file reading and patch fetching is delegated to sub-agents. The orchestrator's context should contain ONLY: file lists, statuses, LOC counts, risk scores, and agent results (small JSON). If the orchestrator reads source files or fetches diffs, it will exhaust its context window on large PRs and fail.

Context-heavy operations that cause "Prompt is too long" failures:
- **Do NOT** perform LOC arithmetic or partition bin-packing in prose — use Bash (a short Python/Node one-liner).
- **Do NOT** manually sort or enumerate file lists — use Bash to sort and partition.
- **Do NOT** load CLAUDE.md into orchestrator context — pass the file path to Bug Hunter B and let it read the file itself.
- **Do NOT** include CHANGED_RANGES data in agent prompts — agents read ranges from pre-extracted patch files.
- **Do NOT** capture `git diff` output into shell variables — pipe directly to files on disk.
- Only the summary fields (file list, statuses, LOC counts) should be in orchestrator context — patches and findings stay on disk.

**Agent type (CRITICAL — prevents context overflow AND permission issues):** ALL agents spawned by this command MUST use `subagent_type: "code-review:code-review-worker"` in the Task tool call. This agent ships with the code-review plugin and declares `tools: Read, Write, Grep, Glob`, which grants background sub-agents file access permissions regardless of the user's `settings.json` allowlist. Do NOT use `subagent_type: "general-purpose"` — background agents with that type inherit only the session's `permissions.allow` list, which often lacks bare Read/Write/Grep/Glob, causing silent permission denials. Do NOT omit `subagent_type` — without an explicit type Claude Code auto-selects an unrelated agent whose larger system prompt and additional file loads bloat context.

### Standard Flow (FAST_PATH == false)

Mark "Spawn reviewer agents in parallel" `in_progress`.

| Agent              | Instances        | Model                                | Partitioned? | Focus                                                                  |
|--------------------|------------------|--------------------------------------|--------------|------------------------------------------------------------------------|
| **Bug Hunter A**   | 1 per partition  | Opus (impl) / Sonnet (test-only)     | Yes          | Diff-only: correctness, security, logic bugs, error handling           |
| **Bug Hunter B**   | 1 total          | Sonnet                               | No           | Cross-file: DRY, API contracts, pattern consistency, imports           |
| **Unified Auditor**| 1 total          | Sonnet                               | No           | CLAUDE.md rules + architectural conventions                            |
| **Domain Critic**  | 0-1              | Sonnet                               | No           | From `critic-gates.json` (capped at 1)                                 |
| **Premise Reviewer**| 1 total         | Per `route.json -> models.premise_reviewer` | No    | Questions whether changes were necessary at all                        |

`partition`'s `--max-bha-agents` flag enforces the cap; the orchestrator spawns one BHA agent per partition entry.

**Partition-to-agent mapping:**
- Bug Hunter A: one instance per partition (partitioned).
- Bug Hunter B: single instance with ALL files (not partitioned).
- Unified Auditor: single instance with ALL files (not partitioned).
- Domain Critic: single instance with ALL files if triggered (not partitioned).
- Premise Reviewer: single instance with ALL files (not partitioned). Reads `patches_all.txt` and `intent_context.json`.

For BHB, Auditor, Premise, and Domain Critic, the `<files_assigned>` in their prompt lists ALL `files_to_review` (not a partition subset). They read the full diff from `<CR_DIR>/patches_all.txt`.

**BHA model selection per partition:**
- `partition.is_test_only == true`: use `route.json -> models.bug_hunter_a.test_only` (Sonnet).
- Otherwise: use `route.json -> models.bug_hunter_a.default` (Opus).

**Skip BHA when all files are cached.** If `uncached_diff_data.json` has an empty `files_to_review`, `partitions.json` will have zero partitions. Skip spawning BHA agents entirely — all BHA findings come from cache. BHB, Auditor, Domain Critic still run against the full `diff_data.json` and `patches_all.txt`.

### Per-Agent Prompt Template

Each agent's prompt is ONLY the lightweight per-agent parts. The shared instructions are read from disk by the agent itself.

The orchestrator assigns each agent a unique `AGENT_ID` (e.g., `bha_p0`, `bhb`, `auditor`, `premise`, `domain_0`). The agent writes findings to `{CR_DIR}/agent_{AGENT_ID}.json`.

**Important:** When constructing agent prompts, substitute the resolved `CR_DIR` path (e.g., `.closedloop-ai/code-review/cr-38291`) into `{CR_DIR}` — agents run in separate processes and do not have access to the orchestrator's shell variables.

**Reading `partitions.json` (read the file once with `cat` or `Read`, then map keys; do NOT reach for `python -c "json.load(...)[0]"`).**

The shape is a **top-level dict**, not a list:

```
{
  "partitions": [ {id, files: [...], total_loc, is_test_only}, ... ],
  "test_file_paths": ["test/foo.ts", ...],
  "force_merged_count": 0,
  "partition_patches": { "p0": "...patch text...", ... }   // optional
}
```

So `data["partitions"]` is the list. `data[0]` is a `KeyError`. If you do reach for Python anyway, use `data["partitions"][N]["files"]` — never `data[N]`. (A regression test in `TestPartitionPostProcessing` pins this top-level shape so the prose above can't silently drift away from reality.)

**Placeholder source mapping** (each key resolves from the partition entry):
- `{filepath_N}` ← `partition["files"][N]["file"]` (key is `file`, NOT `path`)
- `{loc_N}` ← `partition["files"][N]["loc"]`
- `{status_N}` ← `diff_data["file_statuses"][filepath]` (added/modified/removed)
- `{start_N}-{end_N}` ← `partition["files"][N]["line_range"]` (only emit the `[lines X-Y]` segment if `line_range` is present)

```
mode: standalone

Review ONLY the changed code. Write findings to a file (not stdout).
You may ONLY report findings for files in <files_assigned> below — no exceptions.
If a file includes `[lines X-Y]` in <files_assigned>, report findings for that file only
within `X..Y` (allow ±3 line tolerance for hunk boundaries).

<output_file>{CR_DIR}/agent_{AGENT_ID}.json</output_file>

<data>
<patches_file>{CR_DIR}/patches_{PARTITION_OR_ALL}.txt</patches_file>

<files_assigned count="{N}" total="{TOTAL}">
- {filepath_1} ({status_1}, ~{loc_1} LOC) [lines {start_1}-{end_1} if provided]
- {filepath_2} ({status_2}, ~{loc_2} LOC) [lines {start_2}-{end_2} if provided]
...
</files_assigned>
</data>

FIRST, Read the patches file above. Parse the patches to identify changed lines
(lines starting with `+`, using `@@ ... +start,count @@` hunk headers for absolute line numbers).

Read {CR_DIR}/shared_prompt.txt for review constraints, severity guidelines, examples, and output format. Follow those instructions exactly.

{AGENT_SPECIFIC_SUFFIX}
```

For BHA agents, `{PARTITION_OR_ALL}` is `p{N}` (e.g., `patches_p0.txt`). For BHB, Auditor, Premise, and Domain Critic, it is `all` (`patches_all.txt`).

**Do NOT inline the shared prompt.** If you copy-paste the shared prompt into each agent's Task call instead of referencing the file, you will overflow the orchestrator's context on any PR with 10+ agents.

### Agent-Specific Suffixes

**Bug Hunter A** (diff-only, model per routing table):
```
Read <CR_DIR>/bha_suffix.txt for your role and focus areas.

Use Read, Grep, and Glob for codebase context. Do NOT use Bash.
```

The BHA suffix text is written ONCE in `stage_02_prep_assets` (`<CR_DIR>/bha_suffix.txt`) as the single source of truth. The prompt hash covers this file so prompt changes invalidate the cache.

**Bug Hunter B** (codebase-aware, model per routing table):
```
You are Bug Hunter B — a codebase-aware reviewer focused on cross-file issues.

You will explore files outside your assigned list for CONTEXT — but every finding you report
must be filed against a file in your <files_assigned> list. If you discover a bug in an
unassigned file while exploring, discard it.

Focus areas:
- DRY: Use Grep to search for similar function/component names. Flag >60% structural
  similarity with existing code. Cite the existing file path. The finding goes on YOUR assigned file (the new duplicate), not the existing one.
- API contracts: Read service implementations to verify call correctness.
  Check that parameters match (undefined vs null vs empty string matters).
- Pattern consistency: Find existing examples of similar code, verify new code matches.
- Import validation: Verify imports resolve to real modules.

For DRY claims, one concrete example of prior art is sufficient (cite file path + function name).

IMPORTANT: Read the repository root CLAUDE.md file before starting your review. Use it for
DRY detection (check Learned Patterns for known conventions) and pattern consistency checks.
```

Do NOT embed the full CLAUDE.md in Bug Hunter B's prompt — it consumes orchestrator context. The agent reads the file itself via the Read tool.

**Unified Auditor** (Sonnet):
```
You are the Unified Auditor — you check changes against project rules and architectural conventions.

Read all applicable CLAUDE.md files:
- Repository root CLAUDE.md
- Any directory-level CLAUDE.md files relevant to changed file paths

For each changed file, check against:
1. Rules tagged [mistake] in CLAUDE.md Learned Patterns — these are HIGH severity
2. Rules tagged [convention] — these are MEDIUM severity
3. Rules tagged [pattern] — these are MEDIUM severity (verify pattern is followed)
4. Explicit rules in the main CLAUDE.md sections (Architecture, Type Definitions, etc.)
5. Architectural conventions: data access patterns, type locations, service layer responsibilities, code organization

For every finding, cite the exact rule text from CLAUDE.md.
Use Grep and Glob to verify claims. Do NOT flag issues without searching first.
```

**Domain Critics** (from `critic-gates.json`, if selected by route):

All domain critics use `subagent_type: "code-review:code-review-worker"` and `model: "sonnet"`. For each selected critic:

```
You are a domain expert reviewer: {critic_name}.
Review the assigned files for issues within your domain expertise.
Read the repository CLAUDE.md for project context.
Return findings in the standard JSON format.
```

**Guard:** If `critic-gates.json` references a critic name that doesn't map to a known subagent type, use `subagent_type: "code-review:code-review-worker"`.

**Premise Reviewer** (always runs, model per `route.json -> models.premise_reviewer`, `AGENT_ID: "premise"`):
```
You are the Premise Reviewer — you question whether the changes in this diff were necessary at all.

FIRST, Read {CR_DIR}/intent_context.json to understand the author's stated motivation (PR title/body
or commit messages). If the file has empty fields, infer intent from the diff content instead.

Then Read the patches file and use Read, Grep, and Glob to investigate the EXISTING codebase.
Your job is to find evidence that contradicts the stated motivation for these changes.

Focus areas — flag ONLY when you have concrete proof:
- Non-existent bug "fix": The author claims to fix a bug, but the original code was correct.
  Verify the bug can actually trigger: trace the input source — is the "untrusted" input
  actually self-authored config, a constant, or data the process itself writes? For security
  claims specifically, evaluate the threat model: if an attacker must already have write access
  to the input source, the vulnerability doesn't exist. Also flag internal contradictions where
  the fix undermines its own premise (e.g., sanitizing "untrusted" input then passing it to
  os.path.expandvars() — which re-introduces the exact exposure it claimed to prevent).
- Redundant workaround: The problem the code works around is already handled by the framework,
  library, or upstream code — verify by reading the relevant source
- Phantom dead-code removal: Code was removed as "unused" but is still imported, referenced,
  or dynamically invoked elsewhere — verify with Grep
- Duplicate abstraction: A new helper/utility/wrapper was added, but an existing one with
  equivalent functionality already exists — cite the existing implementation
- Unnecessary perf optimization: The code adds caching, memoization, or batching for a path
  that is not a bottleneck (e.g., called once at startup, processes <100 items)
- Regressive fix: A change removes or restricts intentional behavior in the name of safety
  or correctness, but the removed behavior was necessary for the feature to work. Check
  whether the original code's behavior (e.g., shell pipelines, environment expansion, broad
  permissions) was documented or relied upon by callers — if so, the fix introduces a
  functional regression that outweighs any theoretical benefit.

REASONING PROTOCOL -- complete for each potential finding:
Before reporting that a change's premise is wrong, explicitly check the alternative:

AUTHOR'S CLAIM: [What the author says this change does, from intent_context.json or diff]
COUNTER-EVIDENCE: [Specific codebase evidence that contradicts the claim -- cite file:line]
ALTERNATIVE CHECK: If the change IS justified, what evidence would support it?
  - Searched for: [what you looked for to validate the author's premise]
  - Found: [what you found -- cite file:line, or "no supporting evidence found"]
CONCLUSION: [PREMISE REFUTED -- counter-evidence outweighs] or [PREMISE SUPPORTED -- discard finding]

Only report findings where CONCLUSION = PREMISE REFUTED.

Do NOT flag: correctness issues, style violations, DRY problems, CLAUDE.md compliance,
naming conventions, or missing tests. Other agents cover those areas.

IMPORTANT — Overrides to shared prompt constraints for the "Premise" category:
The shared prompt requires findings to be "Introduced in this changeset" (constraint 3) and
"The original author would likely fix it if aware" (constraint 4). For Premise findings,
replace these with:
  3. The changeset's stated motivation is contradicted by evidence you found in the codebase
  4. The change is net-negative: it adds complexity, removes working code, or introduces risk
     for a problem that does not exist
All other shared prompt constraints (file in scope, discrete and actionable, concrete evidence)
still apply.

Severity rules (MANDATORY):
- Use ONLY priority 0 (BLOCKING) or priority 1 (HIGH). Never use priority 2 or 3.
  Premise findings are inherently about overall intent, not specific lines — P2+ findings
  would be discarded by the line-range validation gate.
- Confidence must be >= 0.7. If you are not confident the premise is wrong, do not report it.
- category MUST be "Premise" for every finding.
- For the `line` field, use the first added line in the primary file's changed range.
- The `recommendation` field must state the actionable outcome plainly — e.g., "Revert this
  change; the original code was correct" or "Decline — the security threat model is fictional
  and the fix breaks shell pipeline support." Do not leave the reader to infer whether the PR
  should be accepted or rejected.

Use Read, Grep, and Glob for codebase context. Do NOT use Bash.
```

### Spawn + Collection Contract (standard flow)

**Spawn ALL agents at once.** Use `run_in_background: true` on every agent. You can spawn all agents in a single message or across a few messages.

**Agents write findings to files — NOT to their response.** Each agent writes its findings JSON to `<CR_DIR>/agent_{AGENT_ID}.json` and returns only a one-line status (`DONE findings=N file=...`). `TaskOutput` responses are ~50 tokens each instead of 2-5K tokens, so you can collect ALL agents at once without context overflow.

**Write-denied fallback:** If an agent's Write tool is denied (restrictive project permissions), the agent outputs findings in `<findings_json>` tags in its response with `DONE findings=N file=WRITE_DENIED`. When collecting, if a response contains `WRITE_DENIED`, extract the JSON from `<findings_json>` tags and write it to `<CR_DIR>/agent_{AGENT_ID}.json` yourself.

**Collect all agents (MANDATORY):** Call `TaskOutput` (block: true) for every spawned agent. You MUST collect ALL agents before the walker proceeds past `stage_20`. Do NOT read disk files or start validation until every `TaskOutput` call has returned.

Call all `TaskOutput` calls in a **single message** (parallel) so they resolve together. Check each response:
1. `DONE findings=N file=...` (not WRITE_DENIED) — output file is on disk, nothing to do.
2. `DONE findings=N file=WRITE_DENIED` — extract JSON from `<findings_json>` tags and write to `<CR_DIR>/agent_{AGENT_ID}.json`.
3. Agent didn't report `DONE` — check if its output file exists on disk using Bash.

### Agent Failure Recovery

If any agent failed (context overflow, subscription limits, timeout) or its output file is missing:

1. **Log the failure**: Record which agent failed and why (e.g., `"Bug Hunter A partition 2: context overflow"`).
2. **If failed agent is BHA (partitioned)**: halve the failed partition (LOC budget ÷ 2) and re-spawn with `model: "haiku"` and `subagent_type: "code-review:code-review-worker"`. The re-spawned agent writes to a new output file.
3. **If failed agent is non-partitioned (BHB / Unified Auditor / Domain Critic)**: re-spawn the same role once with `model: "haiku"` and the same file assignment.
4. **Second failure → skip with warning**: if the recovery attempt fails, log a warning (`"⚠️ {agent_name} skipped — {N} files not reviewed due to agent failures"`) and continue. Do NOT fall back to reviewing in the main conversation — this would load patches into the orchestrator's context and recreate the overflow problem on large PRs. Skipped scope must be listed in the output for manual follow-up.
5. **Continue collecting**: do not block the pipeline on a single agent failure. The walker's `on_failure: continue_with_coverage_gap` for `stage_20` ensures the run completes even if some partitions are unreviewed.

### Fast Path (FAST_PATH == true)

Mark "Run fast-path review" `in_progress`.

The fast-path spawns a single agent that performs all review passes in one run. Use the per-agent prompt wrapper above unchanged (`mode: standalone`, `<output_file>`, `<patches_file>`, `<files_assigned>`), with the fast-path-specific suffix below.

**Fast-Path Agent settings:**
- `subagent_type`: `"code-review:code-review-worker"`
- `model`: from `route.json -> models.fast_path_reviewer` (NOT hardcoded)
- `run_in_background`: `true`
- `AGENT_ID`: `"fast"`
- `<output_file>`: `{CR_DIR}/agent_fast.json`
- `<patches_file>`: `{CR_DIR}/patches_all.txt`
- `<files_assigned>`: ALL `files_to_review`

The agent MUST read: `<CR_DIR>/patches_all.txt`, `<CR_DIR>/shared_prompt.txt`, `<CR_DIR>/bha_suffix.txt`, `<CR_DIR>/intent_context.json`, repository root `CLAUDE.md`, and any directory-level `CLAUDE.md` files relevant to changed paths.

**Fast-Path Agent Suffix** — replace `{AGENT_SPECIFIC_SUFFIX}` with:

```
You are the Fast Path Reviewer — a single agent performing all review passes for a small diff.

Perform three scoped passes against the patches file, writing ALL findings to a single output file:

=== PASS 1: Bug Hunter ===
Read <CR_DIR>/bha_suffix.txt for your role and focus areas.
Standard severity/priority rules apply.
Use Read, Grep, and Glob for codebase context. Do NOT use Bash.

=== PASS 2: Bug Hunter B / Unified Auditor ===
You are Bug Hunter B — a codebase-aware reviewer focused on cross-file issues.

You will explore files outside your assigned list for CONTEXT — but every finding you report
must be filed against a file in your <files_assigned> list. If you discover a bug in an
unassigned file while exploring, discard it.

Focus areas:
- DRY: Use Grep to search for similar function/component names. Flag >60% structural
  similarity with existing code. Cite the existing file path. The finding goes on YOUR assigned file (the new duplicate), not the existing one.
- API contracts: Read service implementations to verify call correctness.
  Check that parameters match (undefined vs null vs empty string matters).
- Pattern consistency: Find existing examples of similar code, verify new code matches.
- Import validation: Verify imports resolve to real modules.

For DRY claims, one concrete example of prior art is sufficient (cite file path + function name).

IMPORTANT: Read the repository root CLAUDE.md file before starting your review. Use it for
DRY detection (check Learned Patterns for known conventions) and pattern consistency checks.

Then as the Unified Auditor — check changes against project rules and architectural conventions.

Read all applicable CLAUDE.md files:
- Repository root CLAUDE.md
- Any directory-level CLAUDE.md files relevant to changed file paths

For each changed file, check against:
1. Rules tagged [mistake] in CLAUDE.md Learned Patterns — these are HIGH severity
2. Rules tagged [convention] — these are MEDIUM severity
3. Rules tagged [pattern] — these are MEDIUM severity (verify pattern is followed)
4. Explicit rules in the main CLAUDE.md sections (Architecture, Type Definitions, etc.)
5. Architectural conventions: data access patterns, type locations, service layer responsibilities, code organization

For every finding, cite the exact rule text from CLAUDE.md.
Use Grep and Glob to verify claims. Do NOT flag issues without searching first.

Standard severity/priority rules apply for all pass 2 findings.

=== PASS 3: Premise Reviewer ===
You are the Premise Reviewer — you question whether the changes in this diff were necessary at all.

FIRST, Read {CR_DIR}/intent_context.json to understand the author's stated motivation (PR title/body
or commit messages). If the file has empty fields, infer intent from the diff content instead.

Then Read the patches file and use Read, Grep, and Glob to investigate the EXISTING codebase.
Your job is to find evidence that contradicts the stated motivation for these changes.

Focus areas — flag ONLY when you have concrete proof:
- Non-existent bug "fix": The author claims to fix a bug, but the original code was correct.
  Verify the bug can actually trigger: trace the input source — is the "untrusted" input
  actually self-authored config, a constant, or data the process itself writes? For security
  claims specifically, evaluate the threat model: if an attacker must already have write access
  to the input source, the vulnerability doesn't exist. Also flag internal contradictions where
  the fix undermines its own premise (e.g., sanitizing "untrusted" input then passing it to
  os.path.expandvars() — which re-introduces the exact exposure it claimed to prevent).
- Redundant workaround: The problem the code works around is already handled by the framework,
  library, or upstream code — verify by reading the relevant source
- Phantom dead-code removal: Code was removed as "unused" but is still imported, referenced,
  or dynamically invoked elsewhere — verify with Grep
- Duplicate abstraction: A new helper/utility/wrapper was added, but an existing one with
  equivalent functionality already exists — cite the existing implementation
- Unnecessary perf optimization: The code adds caching, memoization, or batching for a path
  that is not a bottleneck (e.g., called once at startup, processes <100 items)
- Regressive fix: A change removes or restricts intentional behavior in the name of safety
  or correctness, but the removed behavior was necessary for the feature to work. Check
  whether the original code's behavior (e.g., shell pipelines, environment expansion, broad
  permissions) was documented or relied upon by callers — if so, the fix introduces a
  functional regression that outweighs any theoretical benefit.

REASONING PROTOCOL -- complete for each potential finding:
Before reporting that a change's premise is wrong, explicitly check the alternative:

AUTHOR'S CLAIM: [What the author says this change does, from intent_context.json or diff]
COUNTER-EVIDENCE: [Specific codebase evidence that contradicts the claim -- cite file:line]
ALTERNATIVE CHECK: If the change IS justified, what evidence would support it?
  - Searched for: [what you looked for to validate the author's premise]
  - Found: [what you found -- cite file:line, or "no supporting evidence found"]
CONCLUSION: [PREMISE REFUTED -- counter-evidence outweighs] or [PREMISE SUPPORTED -- discard finding]

Only report findings where CONCLUSION = PREMISE REFUTED.

Do NOT flag: correctness issues, style violations, DRY problems, CLAUDE.md compliance,
naming conventions, or missing tests. Other agents cover those areas.

IMPORTANT — The following constraints apply ONLY to findings emitted in this pass 3:
- Overrides to shared prompt constraints for the "Premise" category:
  The shared prompt requires findings to be "Introduced in this changeset" (constraint 3) and
  "The original author would likely fix it if aware" (constraint 4). For Premise findings,
  replace these with:
    3. The changeset's stated motivation is contradicted by evidence you found in the codebase
    4. The change is net-negative: it adds complexity, removes working code, or introduces risk
       for a problem that does not exist
  All other shared prompt constraints (file in scope, discrete and actionable, concrete evidence)
  still apply.
- Use ONLY priority 0 (BLOCKING) or priority 1 (HIGH). Never use priority 2 or 3.
- Confidence must be >= 0.7. If you are not confident the premise is wrong, do not report it.
- category MUST be "Premise" for every finding in this pass.
- For the `line` field, use the first added line in the primary file's changed range.
- The `recommendation` field must state the actionable outcome plainly.

These Premise constraints do NOT apply to findings from passes 1 and 2.

{DOMAIN_CRITIC_PASS}

Use Read, Grep, and Glob for codebase context. Do NOT use Bash.
```

**Domain critic pass injection:** If `route.json -> domain_critics` is non-empty, replace `{DOMAIN_CRITIC_PASS}` with:

```
=== PASS 4: Domain Expert ({critic_name}) ===
You are a domain expert reviewer: {critic_name}.
Review the assigned files for issues within your domain expertise.
Read the repository CLAUDE.md for project context.
Standard severity/priority rules apply.
```

If `domain_critics` is empty, remove the `{DOMAIN_CRITIC_PASS}` placeholder entirely.

**Fast-Path Spawn + Collection:**
- Spawn exactly one background task (`AGENT_ID: "fast"`).
- `DONE ... file=WRITE_DENIED` is a success path, not a failure. Extract `<findings_json>` from `TaskOutput` and write it to `<CR_DIR>/agent_fast.json`. Retry only when the task fails to return `DONE`, times out/crashes, or returns malformed findings with no usable output file.
- On failure (not WRITE_DENIED): retry once with `model: "haiku"`, same `AGENT_ID: "fast"`, same output file `<CR_DIR>/agent_fast.json`. Delete any existing `agent_fast.json` before retrying. Do NOT create `agent_fast_retry.json`.
- If retry also fails: warn and continue with zero fast-path findings.

---

## Hygiene Findings (Gate A presentation)

Reached only when `flags.hygiene_only == true`. Parse `<CR_DIR>/hygiene.json` and present:

```markdown
# Hygiene Check Results

**Scope:** [staged/branch/files]
**Files Checked:** [count]
**Mode:** Hygiene-only (no LLM review)

---

## Repo Hygiene ([count])

[List hygiene findings — same format as Local Mode: Present Results hygiene section]

---

**Summary:** [count] hygiene issues found. No LLM-based review was performed.
```

If MODE=github, write the hygiene findings to `.closedloop-ai/code-review-summary.md` (same summary file path) and `.closedloop-ai/code-review-findings.json` (findings only contain hygiene items). No inline comments are posted for hygiene-only runs unless findings exist.

Mark "Present hygiene findings" `completed` and **EXIT**. Do NOT run footer or verdict — both depend on artifacts (`findings_validated.json`, `review_result.json`) that hygiene-only never produces, and `stage_28_verdict.on_failure == "abort"` would crash the walker.

---

## Local Mode: Present Results (stage_29_present, MODE=local)

Mark "Present findings by severity" `in_progress`.

If `normalization_warnings > 0` in `findings_validated.json`, include after the validation summary:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
```

**Reviewers and Model Routing lines are conditional on `FAST_PATH`:**

- **If `FAST_PATH == false`:**
```markdown
**Reviewers:** Bug Hunter A, Bug Hunter B, Unified Auditor, Premise Reviewer
[+ domain specialist if triggered]
**Model Routing:** [Small/Medium/Large] — [model assignments summary]
```

- **If `FAST_PATH == true`:**
```markdown
**Reviewers:** Fast Path Reviewer (single-agent mode)
**Model Routing:** Fast path — <MODEL> single reviewer
```

Then continue with:

---

## Repo Hygiene ([count])

[List any hygiene findings from deterministic checks]

### Finding Title
**File:** `path/file.ts:line`
**Issue:** [description]
**Recommendation:** [fix]

---

## BLOCKING ([count])

[List all blocking issues]

### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]
**Recommendation:** [fix]

---

## HIGH ([count])

[List all high priority issues — same format]

---

## MEDIUM ([count])

[List all medium priority issues — same format]

---

## Validation Summary

- **Total findings from agents:** X
- **Hygiene findings:** H
- **Validated (confirmed):** A
- **Discarded — file not changed:** B
- **Discarded — line not changed:** C
- **Discarded — low confidence:** D
- **Discarded — rejected by validation:** E
- **Duplicates merged:** F
- **Cross-file grouped:** G (findings with `other_locations`)
- **Downgraded to MEDIUM:** H

### Discarded Findings
[List discarded findings grouped by discard reason — helps track agent accuracy]

---

## Summary

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

**Recommendation:** [action based on findings]
```

**Consolidated Finding Format** (when multiple findings share root cause):

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]

**Other Locations** (N more):
- `path/file.ts:87` — same pattern in `functionName()`
- `path/file.ts:124` — same pattern in `otherFunction()`

**Recommendation:** [fix]
```

Mark todo as `completed`.

---

## GitHub Mode: Present (stage_29_present, MODE=github)

Follow Steps 6 and 8 in `github-review.md` (loaded in stage 0c for GitHub mode). The workflow handles inline comment posting from `.closedloop-ai/code-review-findings.json` and summary rendering from `.closedloop-ai/code-review-summary.md`.

---

## Review Footer (stage_30_footer)

The footer prints elapsed time, cache stats, and token usage. Stage 30's helper is `footer`; the walker calls it with the args declared in the run plan. The plan includes `--cache-result <CR_DIR>/cache_result.json` unconditionally — when cache was inactive or fast-path bypassed it, the file simply does not exist and the helper falls back to `"Cache: disabled"` via its existing OSError handling.

Read `<CR_DIR>/footer.json` for `footer_line` and print:

```markdown
---
**Review complete** — 8m 59s | Cache: 5/10 files (50%) | Full review | Tokens: ~281K effective (613 in, 5.6K out, 225K cache-write, 2.5M cache-read)
```

---

## PR Verdict (stage_28_verdict — printed last)

`stage_28_verdict` runs as a normal helper in the walker; its output JSON has a `tag` field. After the footer prints, output the `tag` value on a final line. The ClosedLoop UI parses this tag to render a verdict banner.

---

## Arguments

$ARGUMENTS
