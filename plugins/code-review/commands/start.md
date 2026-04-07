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
This file contains posting constraints, PR metadata resolution (Step 5b), and output steps (Steps 6+8).
Local mode does not need this file.

---

## Execution Workflow

Follow these tasks **exactly in order**. Each task references a section below with full details. Do NOT skip tasks, reorder them, or improvise new steps. Use the exact Bash commands and output strings specified in each section — do NOT paraphrase or construct your own.

When a task says "Run Bash:", execute the command in a single Bash tool call.

**CRITICAL — No shell variables in Bash commands.** Claude Code prompts for manual approval on every `$VAR` expansion in paths. To avoid prompts, substitute all resolved values directly into every Bash command. Do NOT use `$HELPERS`, `$CR_DIR`, `$CACHE_DIR`, or any other session variable — inline the actual paths.

Throughout this document, bash code blocks use `<ANGLE_BRACKET>` placeholders (e.g., `<HELPERS>`, `<CR_DIR>`, `<CACHE_DIR>`, `<DIFF_SCOPE>`) to mark values you must replace with the resolved literal string before running the command. These are NOT shell variables — they are template tokens. The only real env var is `${CLAUDE_PLUGIN_ROOT}` (resolved once in session setup).

### Task 1: Parse flags and detect mode
- Parse `$ARGUMENTS` for `--github`, `--hygiene-only`, `--base <ref>`, `--since-last-review`, `--full-review`
- Check flag incompatibilities — exit with error if any
- See: [Step 1 — Mode Detection + Flag Parsing](#step-1-create-todo-list--mode-detection--session-setup)

### Task 2: Create TodoWrite + session setup
- Create the TodoWrite task list (depends on MODE and HYGIENE_ONLY)
- If MODE=github: Read `${CLAUDE_PLUGIN_ROOT}/prompts/github-review.md` for GitHub-specific constraints and steps
- Resolve HELPERS path: `echo "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py"` — track the resolved path internally
- Run setup with CR_DIR creation: `python <HELPERS> setup --mode <MODE> --cr-dir-prefix .closedloop-ai/code-review/cr-` -- read stdout JSON for `cr_dir`, `start_time`, `repo_name`, `current_branch`, `global_cache`. Then write the JSON to `<CR_DIR>/setup.json` for downstream helpers.
- Initialize `CACHE_DIR=""` (final cache path is resolved after scope parsing)
- Run prep-assets: `python <HELPERS> prep-assets --plugin-root <PLUGIN_ROOT> --cr-dir <CR_DIR>`
- See: [Session Setup](#session-setup)

### Task 3: Parse scope and resolve diff
- Mark todo "Parse scope and get diff data" as `in_progress`
- Run Bash: `python <HELPERS> resolve-scope --mode <MODE> --setup-json <CR_DIR>/setup.json [--pr-number <N>] [--scope-args "<REMAINING_ARGS>"] [--base-ref-override <REF>] > <CR_DIR>/scope.json`
- Read `<CR_DIR>/scope.json` for `DIFF_SCOPE`, `BASE_REF`, `HEAD_REF`, `REVIEW_BRANCH`, `DIFF_TIP`, `PR_NUMBER`, `PATH_FILTER`, `SCOPE_KIND`, `PR_AUTO_DETECTED`
- Finalize `CACHE_DIR` now that scope/PR context is known (must happen before auto-incremental)
- See: [Step 2 — Parse Arguments](#parse-arguments-remaining-after-flag-removal)

### Task 4: Auto-incremental mode check (local only)
- Evaluate auto-incremental eligibility using `REVIEW_BRANCH:BASE_REF` as the state key and `DIFF_TIP` as the ref
- Set `REVIEW_MODE_LINE` to one of the **exact** prescribed strings — do NOT improvise
- Print `<REVIEW_MODE_LINE>`
- If `PR_AUTO_DETECTED` is true, print `"Auto-detected PR #<PR_NUMBER> for branch <REVIEW_BRANCH>."`
- See: [Auto Incremental Mode](#auto-incremental-mode-phase-4--local-only)

### Task 5: Get diff data + fetch intent (GitHub: also get PR metadata)
- GitHub mode: follow PR Metadata section from `github-review.md`
- Run Bash: `python <HELPERS> parse-diff --scope=<DIFF_SCOPE> > <CR_DIR>/diff_data.json`
- Run Bash: `python <HELPERS> fetch-intent --scope-kind <SCOPE_KIND> --cr-dir <CR_DIR> [--pr-number <N>] [--base-ref <BASE_REF>] [--diff-tip <DIFF_TIP>]`
- Run Bash: `python <HELPERS> classify-intent --intent-context <CR_DIR>/intent_context.json --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/intent.json`
- Read `<CR_DIR>/intent.json` for `INTENT` value
- Mark todo "Parse scope and get diff data" as `completed`
- See: [Get Diff Data](#get-diff-data-both-modes), [GitHub Mode: Get PR Metadata](#github-mode-get-pr-metadata)

### Task 6: Compute prompt hash + cache check (if CACHE_DIR set)
- Prompt assets already copied in Task 2 (prep-assets)
- Compute `PROMPT_HASH` and `CONTEXT_KEY` using `<DIFF_TIP>`
- Run cache-check via `python <HELPERS> cache-check ... > /dev/null` (redirect stdout to suppress inline print)
- Read `<CR_DIR>/cache_result.json` and store `status_message` as `CACHE_STATUS_MESSAGE`
- Do NOT print cache status here — it is printed later in Task 7 (hygiene exit) or Task 8 (after routing)
- If `CACHE_DIR` is empty, set `CACHE_STATUS_MESSAGE=""`
- Skip if `CACHE_DIR` is empty
- See: [Step 2.1](#step-21-compute-prompt-hash--context-key-when-caching-is-active), [Step 2.2](#step-22-bha-cache-check-when-caching-is-active)

### Task 7: Hygiene checks
- Mark todo "Run deterministic hygiene checks" as `in_progress`
- Run Bash: `python <HELPERS> hygiene --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/hygiene.json`
- Mark todo as `completed`
- **If HYGIENE_ONLY**: if `CACHE_DIR` is set and `CACHE_STATUS_MESSAGE` is non-empty, print `CACHE_STATUS_MESSAGE`. Then present hygiene findings and EXIT — skip all remaining tasks
- See: [Step 2.5](#step-25-deterministic-hygiene-checks)

### Task 8: Route models + partition + extract patches
- Mark todo "Assess scope and route models" as `in_progress`
- Run Bash: `python <HELPERS> route --diff-data <CR_DIR>/diff_data.json --critic-gates .closedloop-ai/settings/critic-gates.json --intent <INTENT> > <CR_DIR>/route.json`
- Read `<CR_DIR>/route.json` for `models`, `domain_critics`, `max_bha_agents`, `fast_path`
- **If `fast_path` is false (standard flow):**
  - Print `CACHE_STATUS_MESSAGE` if non-empty
  - Run Bash: `python <HELPERS> partition --diff-data <CR_DIR>/diff_data.json --loc-budget 500 --max-files 25 --max-bha-agents <MAX_BHA_AGENTS> > <CR_DIR>/partitions.json` (use `uncached_diff_data.json` when caching is active)
  - Run Bash: `python <HELPERS> extract-patches --partitions-file <CR_DIR>/partitions.json --diff-scope "<DIFF_SCOPE>" --diff-data <CR_DIR>/diff_data.json --cr-dir <CR_DIR>`
- **If `fast_path` is true:**
  - Print `"Fast path selected: 1 reviewer (<MODEL>)."` where `<MODEL>` = `route.json -> models.fast_path_reviewer`
  - If `CACHE_DIR` is set, print `"BHA Cache: bypassed in fast-path mode."` and delete `<CR_DIR>/agent_cached_bha.json` if it exists
  - Skip partition entirely (no `partitions.json` created)
  - Run Bash: `python <HELPERS> extract-patches --diff-scope "<DIFF_SCOPE>" --diff-data <CR_DIR>/diff_data.json --cr-dir <CR_DIR>` (no `--partitions-file` -- only `patches_all.txt` is created)
  - Update TodoWrite: replace "Spawn reviewer agents in parallel" with "Run fast-path review"
- Mark todo as `completed`
- See: [Step 3](#step-3-assess-scope-and-route-models), [Step 4A](#step-4a-spawn-reviewer-agents-fast_path--false), [Step 4B](#step-4b-fast-path-single-agent-review-fast_path--true)

### Task 9: Spawn agents
- Mark todo as `in_progress` (text depends on `fast_path` -- either "Spawn reviewer agents in parallel" or "Run fast-path review")
- Prompt assets already in `<CR_DIR>` from Task 2 (prep-assets)
- **If `fast_path == false`**: Spawn the standard reviewer fleet using `subagent_type: "code:code-review-worker"` with `run_in_background: true`. See [Step 4A](#step-4a-spawn-reviewer-agents-fast_path--false)
- **If `fast_path == true`**: Spawn exactly one fast-path reviewer task using `subagent_type: "code:code-review-worker"` with `run_in_background: true`. See [Step 4B](#step-4b-fast-path-single-agent-review-fast_path--true)
- Task 9 spawns background task(s) ONLY. Do NOT call `TaskOutput` here -- collection happens in Task 10

### Task 10: Collect + validate findings
- Mark todo "Collect, normalize, and validate findings" as `in_progress`
- Collect the task(s) spawned by Task 9 via `TaskOutput` (block=true for each). Perform one initial parallel `TaskOutput` sweep. If any retry task is spawned (WRITE_DENIED fallback or failure recovery), perform an additional `TaskOutput` sweep for those retry tasks
- Run Bash: `python <HELPERS> collect-findings --cr-dir <CR_DIR> --hygiene <CR_DIR>/hygiene.json`
- Run Bash: `python <HELPERS> validate --findings <CR_DIR>/findings.json --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/validate_output.json`
- Run `cache-update` only when `fast_path == false` AND `CACHE_DIR` is set (add `--exclude-test-partitions` flag)
- Mark todo as `completed`
- See: [Step 5](#step-5-collect-normalize-and-validate-findings), [Step 5.5 (fast_path == false AND CACHE_DIR set)](#step-55-bha-cache-update-fast_path--false-and-cache_dir-set)

### Task 11: Present results
- **GitHub mode**: follow Steps 6 and 8 in `github-review.md` — write findings JSON, threads JSON, and summary.md to `.closedloop-ai/`
- **Local mode**: present findings by severity in terminal — see [Local Mode: Present Results](#local-mode-present-results)
- Mark remaining todos as `completed`

### Task 12: Review state + footer
- Write review state if local mode and all agents succeeded — see [Review State Write](#review-state-write-end-of-pipeline--local-mode-only)
- Compute elapsed time, collect token stats, print the review footer using the **exact** prescribed format
- See: [Review Footer](#review-footer-final-output)

### Task 13: PR verdict tag
- Run Bash: `python <HELPERS> verdict --validate-output <CR_DIR>/validate_output.json > <CR_DIR>/verdict.json`
- Read `<CR_DIR>/verdict.json` and print the `tag` value as the last line of output
- See: [PR Verdict](#pr-verdict)

---

## Step 1: Create Todo List + Mode Detection + Session Setup

### Mode Detection + Flag Parsing

Parse all flags from `$ARGUMENTS` first, then remove them from the remaining args:

```
MODE = "local"
HYGIENE_ONLY = false
BASE_REF_OVERRIDE = ""
SINCE_LAST_REVIEW = false
FULL_REVIEW = false

If $ARGUMENTS contains "--github":
  MODE = "github"
  Remove "--github" from $ARGUMENTS

If $ARGUMENTS contains "--hygiene-only":
  HYGIENE_ONLY = true
  Remove "--hygiene-only" from $ARGUMENTS

If $ARGUMENTS contains "--base <ref>" (where <ref> is the next word after --base):
  BASE_REF_OVERRIDE = <ref>
  Remove "--base <ref>" from $ARGUMENTS

If $ARGUMENTS contains "--since-last-review":
  SINCE_LAST_REVIEW = true
  Remove "--since-last-review" from $ARGUMENTS

If $ARGUMENTS contains "--full-review":
  FULL_REVIEW = true
  Remove "--full-review" from $ARGUMENTS
```

### Flag Incompatibility Checks

Check these BEFORE any work begins. Emit an error and exit immediately:

```
If BASE_REF_OVERRIDE != "" AND remaining $ARGUMENTS == "staged":
  ERROR: "--base and staged are incompatible (staged has no base ref)"

If SINCE_LAST_REVIEW AND remaining $ARGUMENTS == "staged":
  ERROR: "--since-last-review requires branch scope, not staged"

If SINCE_LAST_REVIEW AND MODE == "github":
  ERROR: "--since-last-review is local-only"

If SINCE_LAST_REVIEW AND FULL_REVIEW:
  ERROR: "--since-last-review and --full-review are contradictory"
```

### Todo List

**IMMEDIATELY use TodoWrite** — base todos depend on MODE and HYGIENE_ONLY:

**If HYGIENE_ONLY is true** (either mode):
```
{ content: "Parse scope and get diff data", status: "pending", activeForm: "Parsing scope" }
{ content: "Run deterministic hygiene checks", status: "pending", activeForm: "Running hygiene checks" }
{ content: "Present hygiene findings", status: "pending", activeForm: "Presenting results" }
```

**Otherwise**, base todos depend on MODE:

**Shared todos (both modes):**
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

### Session Setup

Resolve the helpers path and create a session-scoped working directory.

**Step 1 -- Resolve HELPERS path.** Run this single Bash command to discover the plugin root:
```bash
echo "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py"
```
Read the output. This is the resolved HELPERS path. Track it internally -- **all subsequent Bash commands must inline this resolved path, NOT `$HELPERS`**. Also track `PLUGIN_ROOT` = resolved `${CLAUDE_PLUGIN_ROOT}`.

**Step 2 -- Run setup subcommand (creates CR_DIR):**
```bash
python <HELPERS> setup --mode <MODE> --cr-dir-prefix .closedloop-ai/code-review/cr-
```
Read stdout JSON. It contains:
```json
{ "start_time": 1700000000, "repo_name": "my-repo", "current_branch": "feature-x", "global_cache": "1", "cr_dir": ".closedloop-ai/code-review/cr-38291" }
```

Assign from the JSON:
- `CR_START_TIME` = `start_time`
- `REPO_NAME` = `repo_name`
- `GLOBAL_CACHE` = `global_cache`
- `CR_DIR` = `cr_dir` (the setup helper creates this directory with a random suffix)

Write the JSON to `<CR_DIR>/setup.json` so downstream helpers can read it.

**Step 3 -- Copy prompt assets to CR_DIR:**
```bash
python <HELPERS> prep-assets --plugin-root <PLUGIN_ROOT> --cr-dir <CR_DIR>
```
This copies `shared_prompt.txt` and `bha_suffix.txt` from the plugin to `<CR_DIR>`. Both cache and non-cache paths use these assets.

Initialize `CACHE_DIR=""` -- final cache path is resolved after scope parsing.

---

## Step 2: Parse Scope and Get Diff Data

Mark todo "Parse scope and get diff data" as `in_progress`.

### Resolve Scope (via Python helper)

Run the `resolve-scope` subcommand to handle all scope resolution deterministically:

```bash
python <HELPERS> resolve-scope --mode <MODE> --setup-json <CR_DIR>/setup.json [--pr-number <N>] [--scope-args "<REMAINING_ARGS>"] [--base-ref-override <REF>] > <CR_DIR>/scope.json
```

Read `<CR_DIR>/scope.json` for: `DIFF_SCOPE`, `BASE_REF`, `HEAD_REF`, `REVIEW_BRANCH`, `DIFF_TIP`, `PR_NUMBER`, `PATH_FILTER`, `SCOPE_KIND`, `PR_AUTO_DETECTED`.

The helper handles PR branch lookup (`gh pr view`), `git fetch`, `origin/` prefixes, `--base` overrides, path filter preservation, and scope kind classification.

### Finalize Cache Path (must run here, after scope parsing)

Now that `PR_NUMBER` and `MODE` are known, resolve the final `CACHE_DIR` using the `finalize-cache` subcommand:

```bash
python <HELPERS> finalize-cache --setup-json <CR_DIR>/setup.json --mode <MODE> --pr-number <PR_NUMBER> > <CR_DIR>/cache_config.json
```

Omit `--pr-number` if no PR number is set. Read `<CR_DIR>/cache_config.json` — it contains `{"cache_dir": "..."}`. Set `CACHE_DIR` from the `cache_dir` value (empty string means no cache). The subcommand handles global cache logic, `RUNNER_TEMP`, and `mkdir -p` internally.

### Auto Incremental Mode (Phase 4 — local only)

**After scope parsing and before `parse-diff`**, check for auto-incremental eligibility:

Use `DIFF_TIP` from `scope.json` (set by `resolve-scope` based on scope kind). Do not re-derive it here.

Store `PR_AUTO_DETECTED` from `scope.json` but do not print anything yet.

Run the `auto-incremental` subcommand to evaluate eligibility:

```bash
python <HELPERS> auto-incremental \
  --cache-dir <CACHE_DIR> \
  --key "<REVIEW_BRANCH>:<BASE_REF>" \
  --diff-tip <DIFF_TIP> \
  --original-scope <DIFF_SCOPE> \
  --full-review <FULL_REVIEW> \
  --since-last-review <SINCE_LAST_REVIEW> \
  --mode <MODE> \
  > <CR_DIR>/auto_incremental.json
```

**If the command exits non-zero**, read stderr and print the error message, then exit. Non-zero means a hard error (e.g., `--since-last-review` with no prior state, rebase detected with `--since-last-review`).

**If exit code 0**, read `<CR_DIR>/auto_incremental.json` with the Read tool. It contains:
```json
{ "diff_scope": "abc123...HEAD" | null, "review_mode_line": "Review mode: ..." }
```

- If `diff_scope` is non-null: update `DIFF_SCOPE` to this value (incremental narrowing)
- If `diff_scope` is null: keep `DIFF_SCOPE` unchanged (full review)
- Set `REVIEW_MODE_LINE` from `review_mode_line`

Print `<REVIEW_MODE_LINE>` (always, at the start of every run). Use the EXACT string from the JSON — do NOT improvise or rephrase.

If `PR_AUTO_DETECTED` is true, print `"Auto-detected PR #<PR_NUMBER> for branch <REVIEW_BRANCH>."` immediately after `REVIEW_MODE_LINE`.

### GitHub Mode: Get PR Metadata

**Skip this section entirely if MODE=local.**

Follow the "PR Metadata Resolution" section in `github-review.md` (already loaded in Task 2 for GitHub mode). It sets: `PR_NUMBER`, `HEAD_SHA`, `BASE_REF`, `HEAD_REF`, `OWNER`, `REPO_NAME`, `DIFF_SCOPE`, `DIFF_TIP`, and writes `<CR_DIR>/github_pr.json`.

### Get Diff Data (Both Modes)

Run the `parse-diff` subcommand to execute all git diff commands and produce structured JSON:

```bash
python <HELPERS> parse-diff --scope=<DIFF_SCOPE> > <CR_DIR>/diff_data.json
```

This runs `--name-only`, `--name-status`, `--numstat`, and `-U0` internally (batching `-U0` if >200 files), and writes a single JSON object to `<CR_DIR>/diff_data.json` with:
- **files_to_review**: Array of changed file paths
- **file_statuses**: `{ "path/file.ts": "added" | "modified" | "removed", ... }`
- **file_loc**: `{ "path/file.ts": { "added": N, "removed": M }, ... }`
- **total_loc**: Sum of all added + removed across all files
- **changed_ranges**: `{ "path/file.ts": { "added": [[10,15]], "removed": [[20,22]] }, ... }`
- **patch_lines**: Added/removed line content keyed by line number

Read `<CR_DIR>/diff_data.json` with the Read tool and extract only the lightweight summary fields into orchestrator context (keeps `patch_lines` and `changed_ranges` out of context):
- `files_to_review`: Array of changed file paths
- `file_statuses`: Status per file
- `file_loc`: LOC per file
- `total_loc`: Sum of all added + removed

Use these values for `total_loc` and file count reporting. The full diff data (including `patch_lines` and `changed_ranges`) remains in `<CR_DIR>/diff_data.json` for downstream scripts.

Mark todo as `completed`.

### Fetch Intent Context + Classify Intent (for Premise Reviewer)

After `parse-diff` completes, fetch the stated motivation and classify intent:

```bash
python <HELPERS> fetch-intent --scope-kind <SCOPE_KIND> --cr-dir <CR_DIR> [--pr-number <PR_NUMBER>] [--base-ref <BASE_REF>] [--diff-tip <DIFF_TIP>]
python <HELPERS> classify-intent --intent-context <CR_DIR>/intent_context.json --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/intent.json
```

Read `<CR_DIR>/intent.json` for the `INTENT` value (`feature`, `fix`, `refactor`, or `mixed`). This is passed to the `route` subcommand for Premise Reviewer model routing.

The `fetch-intent` helper handles PR description retrieval (`gh pr view`), local branch commit messages (`git log`), and empty context for staged/file-path scopes. The Premise Reviewer reads `intent_context.json` directly.

---

## Step 2.1: Compute Prompt Hash + Context Key (when caching is active)

**Skip this step if `CACHE_DIR` is empty.**

Prompt assets (`shared_prompt.txt` and `bha_suffix.txt`) were already copied to `<CR_DIR>` by `prep-assets` in Task 2. Compute the prompt hash:

```bash
python <HELPERS> compute-hashes \
  --shared-prompt <CR_DIR>/shared_prompt.txt \
  --bha-suffix <CR_DIR>/bha_suffix.txt \
  --diff-tip <DIFF_TIP> \
  --base-ref "<BASE_REF>" \
  > <CR_DIR>/hashes.json
```

Read `<CR_DIR>/hashes.json` with the Read tool. It contains:
```json
{ "prompt_hash": "abc...", "context_key": "def..." }
```
Assign `PROMPT_HASH` and `CONTEXT_KEY` from the JSON.

**Important:** The shared prompt is copied from the plugin in this step. Step 4a skips the copy if the file already exists (caching was active). If caching is NOT active, Step 4a copies the file instead.

---

## Step 2.2: BHA Cache Check (when caching is active)

**Skip this step if `CACHE_DIR` is empty.**

Check the BHA findings cache for files that haven't changed since the last review:

```bash
python <HELPERS> cache-check \
  --cache-dir <CACHE_DIR> \
  --diff-data <CR_DIR>/diff_data.json" \
  --prompt-hash <PROMPT_HASH> \
  --model-id "opus" \
  --schema-version 1 \
  --output-dir <CR_DIR> \
  --global-cache <GLOBAL_CACHE> \
  --context-key <CONTEXT_KEY> \
  > /dev/null
```

This produces three files:
- `<CR_DIR>/cache_result.json` — stats on cache hits/misses
- `<CR_DIR>/agent_cached_bha.json` — cached BHA findings (glob-compatible with `agent_*`)
- `<CR_DIR>/uncached_diff_data.json` — filtered diff_data with only uncached files

Read `<CR_DIR>/cache_result.json` and store the `status_message` field as `CACHE_STATUS_MESSAGE`. Do NOT print it here -- it is printed later in Task 7 (hygiene-only exit) or Task 8 (after reading `route.json` and determining `fast_path`).

If `CACHE_DIR` is empty, set `CACHE_STATUS_MESSAGE=""`.

---

## Step 2.5: Deterministic Hygiene Checks

Mark todo "Run deterministic hygiene checks" as `in_progress`.

Run the `hygiene` subcommand to perform deterministic checks for CI artifacts, path leakage, gitignore drift, and sensitive files:

```bash
python <HELPERS> hygiene --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/hygiene.json
```

The script handles all 4 checks (CI artifacts, path leakage, gitignore drift, sensitive files), severity routing (skip test/fixture/docs, auto-upgrade to HIGH for code/config files), and outputs findings in standard format. Store findings on disk at `<CR_DIR>/hygiene.json` for Step 5 merge/validation.

Mark todo as `completed`.

### Hygiene-Only Early Exit

**If `HYGIENE_ONLY` is true**, skip all agent spawning and validation. Output hygiene findings directly and exit:

```
If CACHE_DIR is set and CACHE_STATUS_MESSAGE is non-empty, print CACHE_STATUS_MESSAGE.

Mark todo "Present hygiene findings" as in_progress.

Parse `<CR_DIR>/hygiene.json` and present findings in the local presentation format:

# Hygiene Check Results

**Scope:** [staged/branch/files]
**Files Checked:** [count]
**Mode:** Hygiene-only (no LLM review)

---

## Repo Hygiene ([count])

[List hygiene findings — same format as Local Mode: Present Results hygiene section]

---

**Summary:** [count] hygiene issues found. No LLM-based review was performed.

If MODE=github, write the hygiene findings to .closedloop-ai/code-review-summary.md
(same summary file path) and .closedloop-ai/code-review-findings.json (findings only
contain hygiene items). No inline comments are posted for hygiene-only runs
unless findings exist.

Mark todo as completed. EXIT — do not proceed to Step 3 or beyond.
```

---

## Step 3: Assess Scope and Route Models

Mark todo "Assess scope and route models" as `in_progress`.

Run the `route` subcommand to compute risk scores and model routing. Pass the `INTENT` value from `<CR_DIR>/intent.json` (classified in Task 5):

```bash
python <HELPERS> route --diff-data <CR_DIR>/diff_data.json --critic-gates .closedloop-ai/settings/critic-gates.json --intent <INTENT> > <CR_DIR>/route.json
```

Read `<CR_DIR>/route.json` with the Read tool.

The script outputs:
- **fast_path**: `true` when `total_loc <= 200`; `false` otherwise. Domain critics are folded into the fast-path agent as an additional pass rather than forcing standard flow.
- **size_category**: "Small" (<=500), "Medium" (501-2000), or "Large" (2001+)
- **models**: Model assignments for each agent role. `bug_hunter_a` is `{"default": "opus", "test_only": "sonnet"}`. `premise_reviewer` is "opus" (fix/refactor/mixed) or "sonnet" (feature). `fast_path_reviewer` is "sonnet".
- **high_risk_files**: Top 5 files by risk score
- **domain_critics**: Selected domain critics from critic-gates.json (max 1)
- **max_bha_agents**: Maximum BHA partitions (9 minus non-BHA agents). Pass this to `--max-bha-agents` on the partition call.

After reading `route.json`, branch on `fast_path`. See Task 8 summary for branching logic.

Mark todo as `completed`.

---

## Step 4A: Spawn Reviewer Agents (fast_path == false)

**Skip this section if `fast_path` is true -- see [Step 4B](#step-4b-fast-path-single-agent-review-fast_path--true) instead.**

Mark todo "Spawn reviewer agents in parallel" as `in_progress`.

**CONTEXT BUDGET WARNING:** The orchestrator must NOT read source files or fetch patches itself. All file reading and patch fetching is delegated to sub-agents. The orchestrator's context should contain ONLY: file lists, statuses, LOC counts, risk scores, and agent results (small JSON). If the orchestrator reads source files or fetches diffs, it will exhaust its context window on large PRs and fail.

**Orchestrator context management:** The orchestrator's context window must have enough headroom to construct ALL sub-agent prompts. Context-heavy operations that cause "Prompt is too long" failures:
- **Do NOT** perform LOC arithmetic or partition bin-packing in prose — use Bash (a short Python/Node one-liner)
- **Do NOT** manually sort or enumerate file lists — use Bash to sort and partition
- **Do NOT** load CLAUDE.md into orchestrator context — pass the file path to Bug Hunter B and let it read the file itself
- **Do NOT** include CHANGED_RANGES data in agent prompts — agents read ranges from pre-extracted patch files
- **Do NOT** capture `git diff` output into shell variables — pipe directly to files on disk (e.g., `git diff ... > <CR_DIR>/patches_p0.txt`)
- Only the summary fields (file list, statuses, LOC counts) should be in orchestrator context — patches and findings stay on disk

### Agent Type (CRITICAL — prevents context overflow AND permission issues)

**ALL agents spawned by this command MUST use `subagent_type: "code:code-review-worker"` in the Task tool call.** This agent has `tools: Read, Write, Grep, Glob` in its definition, which grants background sub-agents file access permissions regardless of the user's `settings.json` allowlist. Do NOT use `subagent_type: "general-purpose"` — background agents with that type inherit only the session's `permissions.allow` list, which often lacks bare Read/Write/Grep/Glob, causing silent permission denials. Do NOT omit the subagent_type parameter — Claude Code will auto-select `code:code-reviewer`, which has a 130+ line system prompt and loads additional files at startup, bloating context by ~50K+ tokens.

### Review Architecture

| Agent | Instances | Model | Partitioned? | Focus |
|-------|-----------|-------|-------------|-------|
| **Bug Hunter A** | 1 per partition | Opus (impl) / Sonnet (test-only) | Yes | Diff-only: correctness, security, logic bugs, error handling |
| **Bug Hunter B** | 1 total | Sonnet | No (full file list) | Cross-file: DRY, API contracts, pattern consistency, imports |
| **Unified Auditor** | 1 total | Sonnet | No (full file list) | CLAUDE.md rules + architectural conventions |
| **Domain Critic** | 0-1 | Sonnet | No (full file list) | From critic-gates.json (capped at 1) |
| **Premise Reviewer** | 1 total | Per route.json | No (full file list) | Questions whether changes were necessary at all |

**Cap enforcement is handled by the `partition` subcommand via `--max-bha-agents`.** The orchestrator reads the partition count from `partitions.json` and spawns one BHA agent per partition -- no further merging needed.

### File Partitioning (Critical for Large Diffs)

**Orchestrator pre-extracts patches to disk files.** Agents Read patch files instead of running `git diff` themselves. This eliminates sub-agent Bash dependencies (many projects have restrictive permission allowlists that block `Bash(git diff:*)`).

**Partition files using the `partition` subcommand:**

When caching is active (`CACHE_DIR` is set), partition only uncached files. Otherwise, partition all files:

```bash
# Caching active: use uncached_diff_data.json (from cache-check)
python <HELPERS> partition --diff-data <CR_DIR>/uncached_diff_data.json --loc-budget 500 --max-files 25 --max-bha-agents <MAX_BHA_AGENTS> > <CR_DIR>/partitions.json

# No caching: use full diff_data.json
python <HELPERS> partition --diff-data <CR_DIR>/diff_data.json --loc-budget 500 --max-files 25 --max-bha-agents <MAX_BHA_AGENTS> > <CR_DIR>/partitions.json
```

Read `<CR_DIR>/partitions.json` with the Read tool.

**Skip BHA when all files are cached.** If `uncached_diff_data.json` has an empty `files_to_review`, the partition output will have zero partitions. In that case, skip spawning BHA agents entirely — all BHA findings come from cache. BHB, Unified Auditor, and Domain Critic still run against the full `diff_data.json` and `patches_all.txt` — they are unaffected by caching.

The script performs greedy bin-packing (sorted by LOC descending), splits oversized single files by hunks, and detects test files. It outputs:
- **partitions**: Array of `{id, files, total_loc, is_test_only}` objects
- Each `files[]` entry may include optional `line_range: [start, end]` when a large file is split by hunks
- **test_file_paths**: Array of detected test file paths

### Pre-Extract Patches to Disk (CRITICAL -- eliminates sub-agent Bash dependency)

After partitioning, extract patches to disk files so agents can Read them without needing Bash permissions. Run this BEFORE spawning any agents:

```bash
python <HELPERS> extract-patches --partitions-file <CR_DIR>/partitions.json --diff-scope "<DIFF_SCOPE>" --diff-data <CR_DIR>/diff_data.json --cr-dir <CR_DIR>
```

This creates `patches_p{N}.txt` (one per partition) and `patches_all.txt` (full diff from all files in `diff_data.json`). When caching is active, partitions contain only uncached files, but `patches_all.txt` includes ALL files since BHB/Auditor/Premise review the full diff.

If a partition file entry has `line_range`, include that range in `<files_assigned>` for the agent and treat it as a hard scope fence.

### Partition-to-Agent Mapping

Partitions are computed ONCE. Agents are mapped as follows:

- **Bug Hunter A**: one instance per partition (partitioned)
- **Bug Hunter B**: single instance with ALL files (not partitioned)
- **Unified Auditor**: single instance with ALL files (not partitioned)
- **Domain Critic**: single instance with ALL files if triggered (not partitioned)
- **Premise Reviewer**: single instance with ALL files (not partitioned), reads `patches_all.txt` and `intent_context.json`

For BHB, Unified Auditor, Premise Reviewer, and Domain Critic, the `<files_assigned>` in their prompt lists ALL `files_to_review` (not a partition subset). They read the full diff from `<CR_DIR>/patches_all.txt`.

**Total agents** = BHA instances (one per partition) + BHB (1) + Unified Auditor (1) + Premise Reviewer (1) + Domain Critic (0-1). Cap enforcement is handled by the `partition` subcommand.

**BHA model selection per partition:**
- If `partition.is_test_only` is true: use `route.json -> models.bug_hunter_a.test_only` (sonnet)
- Otherwise: use `route.json -> models.bug_hunter_a.default` (opus)

### Shared Prompt — Write to File (CRITICAL for context budget)

The shared prompt is ~130 lines of static instructions (constraints, severity guidelines, examples, output format). Embedding it in every agent prompt would duplicate it 10-16× in the orchestrator's context (~40-50K wasted tokens). Instead, write it to a temp file ONCE, and have each agent read it.

**CRITICAL**: The `mode: standalone` line MUST be present in every agent prompt (not in the shared file — it goes in the per-agent prompt). If missing, the code-reviewer agent defaults to loop mode which suppresses Critical/High findings.

**CRITICAL**: Do NOT embed patch content in the agent prompt. Agents read pre-extracted patch files from disk. The orchestrator only passes the file list, statuses, and patch file path.

**Step 4a:** Prompt assets (`shared_prompt.txt`, `bha_suffix.txt`) are already in `<CR_DIR>` from Task 2 (`prep-assets`). No copy needed.

### Per-Agent Prompt Template (what the orchestrator embeds in each Task call)

Each agent's prompt is ONLY the lightweight per-agent parts. The shared instructions are read from the temp file by the agent itself. This keeps the orchestrator's per-agent prompt to ~20 lines instead of ~155.

The orchestrator assigns each agent a unique `AGENT_ID` (e.g., `bha_p0`, `bhb`, `auditor`, `premise`, `domain_0`). The agent writes its findings to `{CR_DIR}/agent_{AGENT_ID}.json`.

**Important:** When constructing agent prompts, substitute the resolved `CR_DIR` path (e.g., `.closedloop-ai/code-review/cr-38291`) into `{CR_DIR}` — agents run in separate processes and do not have access to the orchestrator's shell variables.

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

For BHA agents, `{PARTITION_OR_ALL}` is `p{N}` (e.g., `patches_p0.txt`). For BHB, Unified Auditor, and Domain Critic, it is `all` (`patches_all.txt`).

**Do NOT inline the shared prompt.** If you copy-paste the shared prompt into each agent's Task call instead of referencing the file, you will overflow the orchestrator's context on any PR with 10+ agents.

### Agent-Specific Suffixes

Append the appropriate suffix to the per-agent template above:

**Bug Hunter A** (diff-only, model per routing table):
```
Read <CR_DIR>/bha_suffix.txt for your role and focus areas.

Use Read, Grep, and Glob for codebase context. Do NOT use Bash.
```

The BHA suffix text is written ONCE in Step 2.1 (`<CR_DIR>/bha_suffix.txt`) as the single source of truth. The prompt hash covers this file so prompt changes invalidate the cache.

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

**Unified Auditor** (sonnet):
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

**Domain Critics** (from critic-gates.json, if selected in Step 3):

All domain critics use `subagent_type: "code:code-review-worker"` and `model: "sonnet"`.

For each selected domain critic, create a prompt:
```
You are a domain expert reviewer: {critic_name}.
Review the assigned files for issues within your domain expertise.
Read the repository CLAUDE.md for project context.
Return findings in the standard JSON format.
```

**Guard:** If critic-gates.json references a critic name that doesn't map to a known
subagent type, use `subagent_type: "code:code-review-worker"` (the default for all domain critics).

**Premise Reviewer** (always runs, model per routing table `route.json -> models.premise_reviewer`, AGENT_ID `premise`):
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

**Agent spawning and collection:**

**Spawn ALL agents at once.** Use `run_in_background: true` on every agent. You can spawn all agents in a single message or across a few messages.

**Agents write findings to files — NOT to their response.** Each agent writes its findings JSON to `<CR_DIR>/agent_{AGENT_ID}.json` and returns only a one-line status (`DONE findings=N file=...`). This means `TaskOutput` responses are ~50 tokens each instead of 2-5K tokens, so you can collect ALL agents at once without context overflow.

**Write-denied fallback:** If an agent's Write tool is denied (restrictive project permissions), the agent outputs findings in `<findings_json>` tags in its response with `DONE findings=N file=WRITE_DENIED`. When collecting, if a response contains `WRITE_DENIED`, extract the JSON from the `<findings_json>` tags and write it to `<CR_DIR>/agent_{AGENT_ID}.json` yourself.

**Collect all agents (MANDATORY — do NOT skip):** Call `TaskOutput` (block: true) for **every** spawned agent. You MUST collect ALL agents before proceeding to Step 5. Do NOT read disk files or start validation until every `TaskOutput` call has returned. Uncollected background tasks produce trailing "Agent completed" messages after you've already presented results.

Call all `TaskOutput` calls in a **single message** (parallel) so they resolve together. Check each response:
1. If `DONE findings=N file=...` (not WRITE_DENIED) — output file is on disk, nothing to do
2. If `DONE findings=N file=WRITE_DENIED` — extract JSON from `<findings_json>` tags in the response and write to `<CR_DIR>/agent_{AGENT_ID}.json`
3. If agent didn't report `DONE` — check if its output file exists on disk using Bash

**Gate:** Only after ALL `TaskOutput` calls have returned may you mark this todo as `completed` and proceed to Step 5.

---

## Step 4B: Fast-Path Single-Agent Review (fast_path == true)

**Skip this section if `fast_path` is false -- see [Step 4A](#step-4a-spawn-reviewer-agents-fast_path--false) instead.**

Mark todo "Run fast-path review" as `in_progress`.

The fast-path spawns a single agent that performs all review passes in one run. Use the standard per-agent prompt wrapper from Step 4A unchanged (`mode: standalone`, `<output_file>`, `<patches_file>`, `<files_assigned>`), with the fast-path-specific suffix below.

### Fast-Path Agent

- **`subagent_type`**: `"code:code-review-worker"`
- **`model`**: from `route.json -> models.fast_path_reviewer` (not hardcoded)
- **`run_in_background`**: `true`
- **`AGENT_ID`**: `"fast"`
- **`<output_file>`**: `{CR_DIR}/agent_fast.json`
- **`<patches_file>`**: `{CR_DIR}/patches_all.txt`
- **`<files_assigned>`**: ALL `files_to_review`

The agent MUST read: `<CR_DIR>/patches_all.txt`, `<CR_DIR>/shared_prompt.txt`, `<CR_DIR>/bha_suffix.txt`, `<CR_DIR>/intent_context.json`, repository root `CLAUDE.md`, and any directory-level `CLAUDE.md` files relevant to changed paths.

### Fast-Path Agent Suffix

Replace `{AGENT_SPECIFIC_SUFFIX}` with:

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

### Fast-Path Spawn + Collection Contract

- Spawn exactly one background task (`AGENT_ID: "fast"`). Task 10 collects it.
- `DONE ... file=WRITE_DENIED` is a success path, not a failure. Extract `<findings_json>` from `TaskOutput` and write it to `<CR_DIR>/agent_fast.json`. Retry only when the task fails to return `DONE`, times out/crashes, or returns malformed findings with no usable output file.
- On failure (not WRITE_DENIED): retry once with `model: "haiku"`, same `AGENT_ID: "fast"`, same output file `<CR_DIR>/agent_fast.json`. Delete any existing `agent_fast.json` before retrying. Do NOT create `agent_fast_retry.json`.
- If retry also fails: warn and continue with zero fast-path findings.

---

## Step 5: Collect, Normalize, and Validate Findings

Mark todo "Collect, normalize, and validate findings" as `in_progress`.

**All agent findings are on disk** in `<CR_DIR>/agent_*.json` files (each agent wrote its own file). Use the `collect-findings` helper to merge them.

### Agent Failure Recovery

If any agent failed (context overflow, subscription limits, timeout) or its output file is missing:

1. **Log the failure**: Record which agent failed and why (e.g., `"Bug Hunter A partition 2: context overflow"`)
2. **If failed agent is BHA (partitioned)**: halve the failed partition (LOC budget ÷ 2) and re-spawn with `model: "haiku"` and `subagent_type: "code:code-review-worker"` (smallest context footprint for recovery). The re-spawned agent writes to a new output file.
3. **If failed agent is non-partitioned (BHB / Unified Auditor / Domain Critic)**: re-spawn the same role once with `model: "haiku"` and the same file assignment.
4. **Second failure → skip with warning**: if the recovery attempt fails, log a warning (`"⚠️ {agent_name} skipped — {N} files not reviewed due to agent failures"`) and continue. Do NOT fall back to reviewing in the main conversation — this would load patches into the orchestrator's context and recreate the overflow problem on large PRs. Skipped scope must be listed in the output for manual follow-up.
5. **Continue collecting**: do not block the pipeline on a single agent failure.

### Steps 5.1-5.3: Mechanical Validation (Deterministic)

**Merge all agent findings from disk.** Build a single JSON array by combining:
1. **Agent findings** — on disk in `<CR_DIR>/agent_*.json` files (one per agent)
2. **Hygiene findings** — extract the `"findings"` array from `<CR_DIR>/hygiene.json` (written in Step 2.5)

Merge and validate:

```bash
python <HELPERS> collect-findings --cr-dir <CR_DIR> --hygiene <CR_DIR>/hygiene.json
python <HELPERS> validate --findings <CR_DIR>/findings.json --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/validate_output.json
```

The `collect-findings` helper merges all `agent_*.json` files + hygiene findings into `<CR_DIR>/findings.json`. Malformed agent files are skipped with a warning.

The script performs all mechanical validation in one pass:
1. **Severity normalization**: Critical→BLOCKING, High→HIGH, Low→discard, unknown→MEDIUM+warning
2. **Default filling**: Priority from severity, confidence defaults to 1.0
3. **File-in-scope check**: Discard findings for files not in the changeset
4. **Line-in-changed-range ±3**: Check both added AND removed ranges (catches removed-guard bugs)
5. **Confidence threshold**: P0/P1 never discard; P2/P3 discard if confidence < 0.5
6. **Duplicate merge**: Same file + line ±3 + same category or recommendation
7. **Root-cause dedup**: Jaccard similarity on issue text for same file + nearby lines
8. **Cross-file grouping**: Findings in different files with same category + similar issue text are grouped — the highest-severity finding becomes primary with an `other_locations` array listing the secondary occurrences

Output includes `validated` findings (some with `other_locations` for cross-file groups), `discarded` findings with reasons, `normalization_warnings`, and `stats` (including `cross_file_grouped` count).

### Step 5.4: Final Consolidation

The `validate` subcommand already handles deduplication and root-cause grouping. Use the `validated` findings from the validate output for the presentation/posting steps. Use `stats` and `discarded` for the validation summary.

If `normalization_warnings > 0` in the validate output, include in the report:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

Mark todo as `completed`.

---

## Step 5.5: BHA Cache Update (fast_path == false AND CACHE_DIR set)

**Skip this step if `fast_path` is true OR `CACHE_DIR` is empty.**

After collecting all BHA findings, update the cache manifest so the next push/re-review can reuse results for unchanged files:

```bash
python <HELPERS> cache-update \
  --cache-dir <CACHE_DIR> \
  --diff-data <CR_DIR>/diff_data.json" \
  --bha-dir <CR_DIR> \
  --prompt-hash <PROMPT_HASH> \
  --model-id "opus" \
  --schema-version 1 \
  --global-cache <GLOBAL_CACHE> \
  --context-key <CONTEXT_KEY> \
  --partitions-file <CR_DIR>/partitions.json" \
  --exclude-test-partitions
```

This writes the updated manifest to `<CACHE_DIR>/manifest.json`. The `--exclude-test-partitions` flag skips caching files from `is_test_only=True` partitions (which were reviewed by Sonnet, not Opus). In GitHub mode, the `actions/cache` post-action saves this directory for subsequent workflow runs. In local mode, the `~/.claude/cr-cache-*` directory persists on disk across CLI sessions.

**Important:** Use `diff_data.json` (full diff), NOT `uncached_diff_data.json`, so the update has patch hashes for all files.

---

## GitHub Mode: Steps 6-8

**If MODE=local, skip to "Local Mode: Present Results" below.**

Follow Steps 6 and 8 in `github-review.md` (already loaded in Task 2 for GitHub mode).

---

## Local Mode: Present Results

**If MODE=github, skip (results posted as inline comments above).**

Mark todo "Present findings by severity" as `in_progress`.

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
```

**Reviewers and Model Routing lines are conditional on `fast_path`:**

- **If `fast_path == false`:**
```markdown
**Reviewers:** Bug Hunter A, Bug Hunter B, Unified Auditor, Premise Reviewer
[+ domain specialist if triggered]
**Model Routing:** [Small/Medium/Large] — [model assignments summary]
```

- **If `fast_path == true`:**
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

If `normalization_warnings > 0`, append after the validation summary:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

Mark todo as `completed`.

---

## Review State Write (end of pipeline — local mode only)

**After all agents complete successfully** (no skipped partitions, all findings collected), update the review state so the next run can use auto-incremental mode:

```bash
if [ <MODE> = "local" ] && [ -n <CACHE_DIR> ] && [ <DIFF_SCOPE> != "--cached" ]; then
  # Use REVIEW_BRANCH (PR head branch or local branch) and DIFF_TIP (origin/HEAD_REF or HEAD)
  python <HELPERS> review-state-write \
    --cache-dir <CACHE_DIR> \
    --key "<REVIEW_BRANCH>:<BASE_REF>" \
    --ref <DIFF_TIP>
fi
```

Only on fully successful runs. If agents failed or partitions were skipped, do NOT update the state.

**Key:** `REVIEW_BRANCH` is the PR's head branch (when a PR number is given) or the local branch (when no PR). This ensures the state key matches the actual code being reviewed, not whatever branch the user happens to have checked out locally.

---

## Review Footer (final output)

As the very last output of the review, print a footer with timing, cache stats, and token usage.

### Compute footer (timing + cache + tokens)

Run the `footer` subcommand to compute elapsed time, cache stats, and token usage in one call:

```bash
python <HELPERS> footer \
  --start-time <CR_START_TIME> \
  --cache-result <CR_DIR>/cache_result.json \
  --cr-dir <CR_DIR> \
  > <CR_DIR>/footer.json
```

**Note:** Omit `--cache-result` if `CACHE_DIR` is empty (no caching active) OR if `fast_path` is true (cache was intentionally bypassed). The footer will show `"Cache: disabled"` as the existing fallback when `--cache-result` is absent. The `--cr-dir` flag lets footer read `review_mode_line` from `auto_incremental.json` automatically — no need to pass `--review-mode-line` explicitly.

Read `<CR_DIR>/footer.json` with the Read tool. It contains:
```json
{ "footer_line": "**Review complete** — 8m 59s | Cache: 5/10 files (50%) | Full review | Tokens: ~281K effective (613 in, 5.6K out, 225K cache-write, 2.5M cache-read)" }
```

### Print the footer

Print a markdown horizontal rule (`---`) followed by the `footer_line` value from the JSON. Example:

```markdown
---
**Review complete** — 8m 59s | Cache: 5/10 files (50%) | Full review | Tokens: ~281K effective (613 in, 5.6K out, 225K cache-write, 2.5M cache-read)
```

## PR Verdict

Run the verdict helper to compute the deterministic verdict:

```bash
python <HELPERS> verdict --validate-output <CR_DIR>/validate_output.json > <CR_DIR>/verdict.json
```

Read `<CR_DIR>/verdict.json` and print the `tag` value as the absolute last line of output. This tag is parsed by the ClosedLoop UI to render a verdict banner.

---

## Arguments

$ARGUMENTS
