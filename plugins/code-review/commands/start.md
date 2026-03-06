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
/start                              # Review all changes on current branch vs main (default)
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
- Create CR_DIR: `mkdir -p .closedloop-ai/code-review/cr-<RANDOM>` — generate a unique suffix, track the resolved path internally
- Run setup: `python <HELPERS> setup --mode <MODE> > <CR_DIR>/setup.json` — inline all resolved paths, NO shell variables
- Read `<CR_DIR>/setup.json` for `CR_START_TIME`, `REPO_NAME`, `GLOBAL_CACHE`, and default `REVIEW_BRANCH`; initialize `CACHE_DIR=""` (final cache path is resolved after scope parsing)
- See: [Session Setup](#session-setup)

### Task 3: Parse scope and resolve diff
- Mark todo "Parse scope and get diff data" as `in_progress`
- If PR number: resolve `BASE_REF`, `HEAD_REF` via `gh pr view`, fetch `origin/<HEAD_REF>`, set `DIFF_SCOPE="origin/<BASE_REF>...origin/<HEAD_REF>"`, `REVIEW_BRANCH=<HEAD_REF>`, `DIFF_TIP="origin/<HEAD_REF>"`
- If no PR number + local mode: set `DIFF_SCOPE`, `REVIEW_BRANCH` from local branch, `DIFF_TIP="HEAD"`
- If no PR number + GitHub mode: leave `DIFF_SCOPE` unset (resolved in GitHub metadata step)
- Apply `--base <ref>` override if set
- Finalize `CACHE_DIR` now that scope/PR context is known (must happen before auto-incremental)
- See: [Step 2 — Parse Arguments](#parse-arguments-remaining-after-flag-removal)

### Task 4: Auto-incremental mode check (local only)
- Evaluate auto-incremental eligibility using `REVIEW_BRANCH:BASE_REF` as the state key and `DIFF_TIP` as the ref
- Set `REVIEW_MODE_LINE` to one of the **exact** prescribed strings — do NOT improvise
- Print `<REVIEW_MODE_LINE>`
- See: [Auto Incremental Mode](#auto-incremental-mode-phase-4--local-only)

### Task 5: Get diff data (GitHub: also get PR metadata)
- GitHub mode: follow PR Metadata section from `github-review.md`
- Run Bash: `python <HELPERS> parse-diff --scope=<DIFF_SCOPE> > <CR_DIR>/diff_data.json`
- Mark todo "Parse scope and get diff data" as `completed`
- See: [Get Diff Data](#get-diff-data-both-modes), [GitHub Mode: Get PR Metadata](#github-mode-get-pr-metadata)

### Task 6: Compute prompt hash + cache check (if CACHE_DIR set)
- Copy `shared_prompt.txt` from plugin to `<CR_DIR>`, write `bha_suffix.txt` to `<CR_DIR>`
- Compute `PROMPT_HASH` and `CONTEXT_KEY` using `<DIFF_TIP>`
- Run cache-check via `python <HELPERS> cache-check ...`
- Report cache status to user using the **exact** prescribed format
- Skip if `CACHE_DIR` is empty
- See: [Step 2.1](#step-21-compute-prompt-hash--context-key-when-caching-is-active), [Step 2.2](#step-22-bha-cache-check-when-caching-is-active)

### Task 7: Hygiene checks
- Mark todo "Run deterministic hygiene checks" as `in_progress`
- Run Bash: `python <HELPERS> hygiene --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/hygiene.json`
- Mark todo as `completed`
- **If HYGIENE_ONLY**: present hygiene findings and EXIT — skip all remaining tasks
- See: [Step 2.5](#step-25-deterministic-hygiene-checks)

### Task 8: Route models + partition + extract patches
- Mark todo "Assess scope and route models" as `in_progress`
- Run route and partition subcommands
- Pre-extract patches to `<CR_DIR>/patches_p{N}.txt` and `<CR_DIR>/patches_all.txt`
- Mark todo as `completed`
- See: [Step 3](#step-3-assess-scope-and-route-models), [Step 4 — Partitioning](#file-partitioning-critical-for-large-diffs), [Pre-Extract Patches](#pre-extract-patches-to-disk-critical--eliminates-sub-agent-bash-dependency)

### Task 9: Spawn agents
- Mark todo "Spawn reviewer agents in parallel" as `in_progress`
- Copy `shared_prompt.txt` from plugin to `<CR_DIR>` if not already copied in Task 6
- Spawn ALL agents using `subagent_type: "code:code-review-worker"` with `run_in_background: true`
- Use the exact per-agent prompt template from the reference section
- See: [Step 4 — Spawn Reviewer Agents](#step-4-spawn-reviewer-agents)

### Task 10: Collect + validate findings
- Mark todo "Collect, normalize, and validate findings" as `in_progress`
- Collect ALL agent outputs via `TaskOutput` (block=true for each)
- Merge agent JSON files + hygiene findings, then run `python <HELPERS> validate ...`
- Run cache-update if `CACHE_DIR` is set
- Mark todo as `completed`
- See: [Step 5](#step-5-collect-normalize-and-validate-findings), [Step 5.5](#step-55-bha-cache-update-when-caching-is-active)

### Task 11: Present results
- **GitHub mode**: follow Steps 6 and 8 in `github-review.md` — write findings JSON, threads JSON, and summary.md to `.claude/`
- **Local mode**: present findings by severity in terminal — see [Local Mode: Present Results](#local-mode-present-results)
- Mark remaining todos as `completed`

### Task 12: Review state + footer
- Write review state if local mode and all agents succeeded — see [Review State Write](#review-state-write-end-of-pipeline--local-mode-only)
- Compute elapsed time, collect token stats, print the review footer using the **exact** prescribed format
- See: [Review Footer](#review-footer-final-output)

### Task 13: PR verdict tag
- Compute the deterministic verdict from validated findings and emit the `<pr_verdict>` tag
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
{ content: "Write summary to .claude/code-review-summary.md", status: "pending", activeForm: "Writing summary" }
```

**Local mode adds:**
```
{ content: "Present findings by severity", status: "pending", activeForm: "Presenting results" }
```

### Session Setup

Resolve the helpers path and create a session-scoped working directory.

**Step 1 — Resolve HELPERS path.** Run this single Bash command to discover the plugin root:
```bash
echo "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py"
```
Read the output. This is the resolved HELPERS path (e.g., `/Users/me/.claude/plugins/cache/closedloop-ai/code-review/1.24.0/tools/python/code_review_helpers.py`). Track it internally — **all subsequent Bash commands must inline this resolved path, NOT `$HELPERS`**.

**Step 2 — Create CR_DIR.** Generate a random 5-digit number as a suffix and create the directory:
```bash
mkdir -p .closedloop-ai/code-review/cr-38291
```
Track the CR_DIR value internally (e.g., `.closedloop-ai/code-review/cr-38291`). **All subsequent commands must inline this resolved path, NOT `$CR_DIR`**. Generate a unique suffix yourself (e.g., a 5-digit random number) — do NOT use `$$` (it changes per shell invocation). Use this same `.closedloop-ai/code-review/cr-<RANDOM>` path in **all modes** including GitHub CI — do NOT use `$RUNNER_TEMP` or any shell variables.

**Step 3 — Run setup subcommand:**
```bash
python <HELPERS> setup --mode <MODE> > <CR_DIR>/setup.json
```
Where `<HELPERS>`, `<MODE>`, and `<CR_DIR>` are the resolved literal values (no shell variables).

Read `<CR_DIR>/setup.json` with the Read tool. It contains:
```json
{ "start_time": 1700000000, "repo_name": "my-repo", "current_branch": "feature-x", "global_cache": "1" }
```

Assign from the JSON:
- `CR_START_TIME` = `start_time`
- `REPO_NAME` = `repo_name`
- `GLOBAL_CACHE` = `global_cache`

The `current_branch` value is used as the default `REVIEW_BRANCH` in Step 2 (overridden when a PR number is provided).

Initialize cache path as empty in session setup. Final cache selection happens in Step 2
after scope parsing (so PR-based legacy cache can use `PR_NUMBER` when available):
```bash
CACHE_DIR=""
```

`CACHE_DIR` stays empty until finalized in Step 2 after scope parsing (so `PR_NUMBER` is available for legacy cache paths).

`CR_DIR` isolates temp files. All intermediate data (shared prompt, agent findings, PR metadata) goes here.

---

## Step 2: Parse Scope and Get Diff Data

Mark todo "Parse scope and get diff data" as `in_progress`.

### Parse Arguments (remaining after flag removal)

**If a PR number is provided (either mode)** — remaining arg is a bare integer:
- Store as `PR_NUMBER`
- Resolve both branches: `gh pr view <PR_NUMBER> --json baseRefName,headRefName -q '.baseRefName,.headRefName'`
  - `BASE_REF` = base branch (e.g. `main`)
  - `HEAD_REF` = PR head branch (e.g. `feature-xyz`)
- Fetch the PR head ref to ensure it's available locally: `git fetch origin <HEAD_REF> 2>/dev/null || true`
- Set `DIFF_SCOPE="origin/${BASE_REF}...origin/${HEAD_REF}"`
- Set `REVIEW_BRANCH=<HEAD_REF>` (used for auto-incremental state key — NOT the local checked-out branch)

**Important:** When a PR number is given, always diff `origin/BASE...origin/HEAD_REF`. Do NOT use bare `HEAD` — the user may be on a different local branch than the PR's head branch.

**Otherwise:**
- If MODE=local and empty or "branch": `DIFF_SCOPE="main...HEAD"`, `BASE_REF="main"`, `PATH_FILTER=""`
- If "staged": `DIFF_SCOPE="--cached"`
- If MODE=local and file paths: `PATH_FILTER="-- <files>"`, `DIFF_SCOPE="main...HEAD ${PATH_FILTER}"`, `BASE_REF="main"`
- If MODE=github and no PR number: leave `DIFF_SCOPE` unset (GitHub metadata step resolves PR and sets it)
- Set `REVIEW_BRANCH` from `current_branch` in `<CR_DIR>/setup.json` (already read in Task 2)

**`--base <ref>` override** (Phase 3):
If `BASE_REF_OVERRIDE` is set:
- `BASE_REF = BASE_REF_OVERRIDE`
- If PR number: `DIFF_SCOPE="origin/${BASE_REF_OVERRIDE}...origin/${HEAD_REF}"`
- Otherwise (non-staged local scopes): `DIFF_SCOPE="origin/${BASE_REF_OVERRIDE}...HEAD ${PATH_FILTER}"`

**Important:** Do NOT drop the file filter when `--base` is used with file-path scope.
Preserve `PATH_FILTER` in the final `DIFF_SCOPE`.

### Finalize Cache Path (must run here, after scope parsing)

Now that `PR_NUMBER` and `MODE` are known, resolve the final `CACHE_DIR` using the `finalize-cache` subcommand:

```bash
python <HELPERS> finalize-cache --setup-json <CR_DIR>/setup.json --mode <MODE> --pr-number <PR_NUMBER> > <CR_DIR>/cache_config.json
```

Omit `--pr-number` if no PR number is set. Read `<CR_DIR>/cache_config.json` — it contains `{"cache_dir": "..."}`. Set `CACHE_DIR` from the `cache_dir` value (empty string means no cache). The subcommand handles global cache logic, `RUNNER_TEMP`, and `mkdir -p` internally.

### Auto Incremental Mode (Phase 4 — local only)

**After scope parsing and before `parse-diff`**, check for auto-incremental eligibility:

Determine `DIFF_TIP` based on scope:
- PR number provided: `DIFF_TIP="origin/${HEAD_REF}"` (remote ref)
- No PR number: `DIFF_TIP="HEAD"` (local ref)

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

### Fetch Intent Context (for Premise Reviewer)

After `parse-diff` completes, fetch the stated motivation for the changes so the Premise Reviewer can evaluate whether they were necessary. Write the result to `<CR_DIR>/intent_context.json`.

**If a PR number is set:**
```bash
gh pr view <PR_NUMBER> --json title,body -q '{title: .title, body: .body, commits: ""}' > <CR_DIR>/intent_context.json 2>/dev/null || echo '{"title":"","body":"","commits":""}' > <CR_DIR>/intent_context.json
```

**If local branch (no PR number) and DIFF_SCOPE is not `--cached`:**
```bash
echo "{\"title\":\"\",\"body\":\"\",\"commits\":$(git log <BASE_REF>..<DIFF_TIP> --oneline --no-merges --format='%s' | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))')}" > <CR_DIR>/intent_context.json
```

**If staged or file scope (no branch range available):**
```bash
echo '{"title":"","body":"","commits":""}' > <CR_DIR>/intent_context.json
```

The Premise Reviewer reads this file to understand what the author claims the changes accomplish. If the file is empty or has blank fields, the agent degrades gracefully by inferring intent from the diff itself.

---

## Step 2.1: Compute Prompt Hash + Context Key (when caching is active)

**Skip this step if `CACHE_DIR` is empty.**

The prompt hash is needed by cache-check, so copy the shared prompt **here** (before Step 2.5). The canonical copy ships at `${CLAUDE_PLUGIN_ROOT}/tools/prompts/shared_prompt.txt`.

**SSOT design:** Write the canonical BHA suffix to `<CR_DIR>/bha_suffix.txt` here (the ONLY copy). Step 4 reads from this file instead of having a second inline copy.

```bash
# Copy shared prompt from plugin (canonical copy — do NOT recreate via heredoc)
cp "${CLAUDE_PLUGIN_ROOT}/tools/prompts/shared_prompt.txt" <CR_DIR>/shared_prompt.txt"

# Write canonical BHA suffix (the ONLY copy)
cat > <CR_DIR>/bha_suffix.txt <<'BHA_EOF'
You are Bug Hunter A — a diff-only reviewer focused on correctness.

Focus areas:
- Syntax/type errors, null/undefined handling, logic bugs
- Security: injection, auth bypass, path traversal, data exposure
- State management: race conditions, stale closures, double-trigger patterns
- Error handling: missing try-catch on async, unhandled promise rejections
- Data transformations: off-by-one, incorrect parsing, wrong parameter types

Use Read, Grep, and Glob for codebase context. Do NOT use Bash.
BHA_EOF

# Compute PROMPT_HASH and CONTEXT_KEY
python <HELPERS> compute-hashes \
  --shared-prompt <CR_DIR>/shared_prompt.txt" \
  --bha-suffix <CR_DIR>/bha_suffix.txt" \
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
  --context-key <CONTEXT_KEY>
```

This produces three files:
- `<CR_DIR>/cache_result.json` — stats on cache hits/misses
- `<CR_DIR>/agent_cached_bha.json` — cached BHA findings (glob-compatible with `agent_*`)
- `<CR_DIR>/uncached_diff_data.json` — filtered diff_data with only uncached files

Read `<CR_DIR>/cache_result.json` and report the cache status to the user:

```
If stats.cached > 0:
  "BHA Cache: {cached}/{total_files} files cached ({hit_rate_pct}% hit rate) — {cached} files skip BHA review"
Else if first run (empty cache):
  "BHA Cache: first run — building cache for next review"
Else:
  "BHA Cache: 0/{total_files} files cached (all files changed since last review)"
```

On first run (empty cache), all files will be uncached — zero overhead vs today.

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

If MODE=github, write the hygiene findings to .claude/code-review-summary.md
(same summary file path) and .claude/code-review-findings.json (findings only
contain hygiene items). No inline comments are posted for hygiene-only runs
unless findings exist.

Mark todo as completed. EXIT — do not proceed to Step 3 or beyond.
```

---

## Step 3: Assess Scope and Route Models

Mark todo "Assess scope and route models" as `in_progress`.

Run the `route` subcommand to compute risk scores and model routing:

```bash
python <HELPERS> route --diff-data <CR_DIR>/diff_data.json --critic-gates .claude/settings/critic-gates.json > <CR_DIR>/route.json
```

Read `<CR_DIR>/route.json` with the Read tool.

The script outputs:
- **size_category**: "Small" (≤500), "Medium" (501-2000), or "Large" (2001+)
- **models**: Model assignments for each agent role (bug_hunter_a, bug_hunter_b, unified_auditor, premise_reviewer)
- **high_risk_files**: Top 5 files by risk score
- **domain_critics**: Selected domain critics from critic-gates.json (max 1)

Report to user: model routing decision, which agents will run (including Premise Reviewer), and domain critics (if any).

Mark todo as `completed`.

---

## Step 4: Spawn Reviewer Agents

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
| **Bug Hunter A** | 1 per partition | Opus (all sizes) | Yes | Diff-only: correctness, security, logic bugs, error handling |
| **Bug Hunter B** | 1 total | Sonnet | No (full file list) | Cross-file: DRY, API contracts, pattern consistency, imports |
| **Unified Auditor** | 1 total | Sonnet | No (full file list) | CLAUDE.md rules + architectural conventions |
| **Domain Critic** | 0-1 | Sonnet | No (full file list) | From critic-gates.json (capped at 1) |
| **Premise Reviewer** | 1 total | Opus | No (full file list) | Questions whether changes were necessary at all |

**Max agents = partitions + 4** (BHB + Auditor + Premise + 0-1 domain). Hard cap at 9.

### File Partitioning (Critical for Large Diffs)

**Orchestrator pre-extracts patches to disk files.** Agents Read patch files instead of running `git diff` themselves. This eliminates sub-agent Bash dependencies (many projects have restrictive permission allowlists that block `Bash(git diff:*)`).

**Partition files using the `partition` subcommand:**

When caching is active (`CACHE_DIR` is set), partition only uncached files. Otherwise, partition all files:

```bash
# Caching active: use uncached_diff_data.json (from cache-check)
python <HELPERS> partition --diff-data <CR_DIR>/uncached_diff_data.json --loc-budget 800 --max-files 25 > <CR_DIR>/partitions.json

# No caching: use full diff_data.json
python <HELPERS> partition --diff-data <CR_DIR>/diff_data.json --loc-budget 800 --max-files 25 > <CR_DIR>/partitions.json
```

Read `<CR_DIR>/partitions.json` with the Read tool.

**Skip BHA when all files are cached.** If `uncached_diff_data.json` has an empty `files_to_review`, the partition output will have zero partitions. In that case, skip spawning BHA agents entirely — all BHA findings come from cache. BHB, Unified Auditor, and Domain Critic still run against the full `diff_data.json` and `patches_all.txt` — they are unaffected by caching.

The script performs greedy bin-packing (sorted by LOC descending), splits oversized single files by hunks, and detects test files. It outputs:
- **partitions**: Array of `{id, files, total_loc, is_test_only}` objects
- Each `files[]` entry may include optional `line_range: [start, end]` when a large file is split by hunks
- **test_file_paths**: Array of detected test file paths

### Pre-Extract Patches to Disk (CRITICAL — eliminates sub-agent Bash dependency)

After partitioning, extract patches to disk files so agents can Read them without needing Bash permissions. Run these BEFORE spawning any agents:

**Per-partition patches** (for BHA instances):
```bash
# For each partition, extract its files' patches to a dedicated file
# Example for partition 0 with files file1.ts file2.ts:
git diff <DIFF_SCOPE> -- file1.ts file2.ts > <CR_DIR>/patches_p0.txt

# Repeat for each partition (use a loop or multiple commands)
```

If a partition file entry has `line_range`, include that range in `<files_assigned>`
for the agent and treat it as a hard scope fence. This prevents duplicate reporting when
multiple BHA partitions reference different hunks of the same file.

**Full diff patches** (for BHB, Unified Auditor, Domain Critic — they review all files):
```bash
git diff <DIFF_SCOPE> > <CR_DIR>/patches_all.txt
```

If the full diff is very large (>200 files), batch the extraction:
```bash
# Extract in batches of 50 files, append to the same file
git diff <DIFF_SCOPE> -- file1 file2 ... file50 > <CR_DIR>/patches_all.txt
git diff <DIFF_SCOPE> -- file51 file52 ... file100 >> <CR_DIR>/patches_all.txt
```

### Partition-to-Agent Mapping

Partitions are computed ONCE. Agents are mapped as follows:

- **Bug Hunter A**: one instance per partition (partitioned)
- **Bug Hunter B**: single instance with ALL files (not partitioned)
- **Unified Auditor**: single instance with ALL files (not partitioned)
- **Domain Critic**: single instance with ALL files if triggered (not partitioned)
- **Premise Reviewer**: single instance with ALL files (not partitioned), reads `patches_all.txt` and `intent_context.json`

For BHB, Unified Auditor, Premise Reviewer, and Domain Critic, the `<files_assigned>` in their prompt lists ALL `files_to_review` (not a partition subset). They read the full diff from `<CR_DIR>/patches_all.txt`.

**Total agents** = BHA instances (one per partition) + BHB (1) + Unified Auditor (1) + Premise Reviewer (1) + Domain Critic (0-1). **Cap at 9 total.** If over budget, merge smallest BHA partitions (allow up to 1200 LOC).

### Shared Prompt — Write to File (CRITICAL for context budget)

The shared prompt is ~130 lines of static instructions (constraints, severity guidelines, examples, output format). Embedding it in every agent prompt would duplicate it 10-16× in the orchestrator's context (~40-50K wasted tokens). Instead, write it to a temp file ONCE, and have each agent read it.

**CRITICAL**: The `mode: standalone` line MUST be present in every agent prompt (not in the shared file — it goes in the per-agent prompt). If missing, the code-reviewer agent defaults to loop mode which suppresses Critical/High findings.

**CRITICAL**: Do NOT embed patch content in the agent prompt. Agents read pre-extracted patch files from disk. The orchestrator only passes the file list, statuses, and patch file path.

**Step 4a: Copy shared prompt to `<CR_DIR>`.** Run this ONCE before spawning any agents. Skip if already copied in Step 2.1 (caching was active):

```bash
# Copy shared prompt from plugin (canonical copy — do NOT recreate via heredoc)
[ -f <CR_DIR>/shared_prompt.txt" ] || cp "${CLAUDE_PLUGIN_ROOT}/tools/prompts/shared_prompt.txt" <CR_DIR>/shared_prompt.txt"
```

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

**Premise Reviewer** (always runs, model per routing table — `opus`, AGENT_ID `premise`):
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

## Step 5: Collect, Normalize, and Validate Findings

Mark todo "Collect, normalize, and validate findings" as `in_progress`.

**All agent findings are on disk** in `<CR_DIR>/agent_*.json` files (each agent wrote its own file). The orchestrator does NOT need to parse or extract findings — just merge the files with Bash.

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

Merge and validate in one step:

```bash
python3 -c "
import json, sys, glob
all_f = []
for path in sorted(glob.glob('<CR_DIR>/agent_*.json')):
    try:
        with open(path) as f:
            data = json.load(f)
        all_f.extend(data.get('findings', []) if isinstance(data, dict) else data)
    except (json.JSONDecodeError, KeyError) as e:
        print(f'Warning: skipping {path}: {e}', file=sys.stderr)
try:
    with open('<CR_DIR>/hygiene.json') as hf:
        all_f.extend(json.load(hf).get('findings', []))
except (OSError, json.JSONDecodeError) as e:
    print(f'Warning: failed to read hygiene.json: {e}', file=sys.stderr)
json.dump(all_f, sys.stdout)
" > <CR_DIR>/findings.json

python <HELPERS> validate --findings <CR_DIR>/findings.json --diff-data <CR_DIR>/diff_data.json > <CR_DIR>/validate_output.json
```

**Important:** If hygiene findings are omitted from this merge, they will bypass the validate pipeline entirely (no dedup, no normalization). Always include them.

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

## Step 5.5: BHA Cache Update (when caching is active)

**Skip this step if `CACHE_DIR` is empty.**

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
  --partitions-file <CR_DIR>/partitions.json"
```

This writes the updated manifest to `<CACHE_DIR>/manifest.json`. In GitHub mode, the `actions/cache` post-action saves this directory for subsequent workflow runs. In local mode, the `.claude/cr-cache-*` directory persists on disk across CLI sessions.

**Important:** Use `diff_data.json` (full diff), NOT `uncached_diff_data.json`, so the update has patch hashes for all files. The `--reviewed-files` flag ensures only files that were actually reviewed by BHA agents get cached.

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
**Reviewers:** Bug Hunter A, Bug Hunter B, Unified Auditor, Premise Reviewer
[+ domain specialist if triggered]
**Model Routing:** [Small/Medium/Large] — [model assignments summary]

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

**Note:** Omit `--cache-result` if `CACHE_DIR` is empty (no caching active). The `--cr-dir` flag lets footer read `review_mode_line` from `auto_incremental.json` automatically — no need to pass `--review-mode-line` explicitly.

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

After the footer, emit a single `<pr_verdict>` tag as the absolute last line of output. The verdict is deterministic, computed from validated findings:

1. If any finding has `BLOCKING: true` → verdict is `"decline"`, reason: `"N blocking issue(s): [first title, ≤80 chars]"`
2. If any Premise finding has priority 0 → verdict is `"decline"`, reason: `"Premise: [first title, ≤80 chars]"`
3. If any HIGH-priority findings exist → verdict is `"needs_attention"`, reason: `"N high-priority finding(s) require attention"`
4. Otherwise → verdict is `"approve"`, reason: `"No blocking or high-priority issues found"`

Output exactly one line:

```
<pr_verdict>{"verdict":"decline","reason":"2 blocking issue(s): Missing null check in auth handler"}</pr_verdict>
```

or:

```
<pr_verdict>{"verdict":"approve","reason":"No blocking or high-priority issues found"}</pr_verdict>
```

Keep the reason under 120 characters. This tag is parsed by the ClosedLoop UI to render a verdict banner.

---

## Arguments

$ARGUMENTS
