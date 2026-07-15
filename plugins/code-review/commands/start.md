---
description: Run comprehensive code review — locally or on GitHub PRs with inline comments
argument-hint: "[scope] [--github] [--hygiene-only] [--base <ref>] [--since-last-review] [--full-review] [--depth shallow|standard|deep]"
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
/start --depth shallow              # Built-ins only (no critic-gates); see Depth Tiers below
/start --depth deep                 # Standard + future heavy reviewers (Impact Analyzer slot)
```

## Depth Tiers (PLN-807)

The `--depth` flag selects which reviewer fleet runs. Default `standard`. Bare `/start` invocations preserve historical behavior.

- **shallow** — hygiene + BHA (partitioned at >5000 LOC) + BHB + unified_auditor + verifier. Skips signal extraction, coverage planning/critic, and all `critic-gates.json` entries. Static spawn spec; no routing/critic decisions. Hygiene emits a `tier_mismatch_nudge` MEDIUM finding (category `Coverage`) when the PR's diff size, schema/migration paths, or public API surface suggest standard would catch more.
- **standard** — current behavior. Full fleet with signal-driven routing, coverage critic, repo-specific critic activation via `critic-gates.json`. Budget arithmetic reserves BHA partitions FIRST (Phase 4) and caps total domain critics across both required and best-effort buckets at the tier-uniform `DOMAIN_CRITIC_CAP = 3` (standard and deep alike). Required critics dropped by the cap emit coverage-gap findings.
- **deep** — standard plus two deep-only conditional core reviewers. The always-on **Design Critic** runs on every deep review (no trigger): a software-design craftsmanship reviewer covering module depth/information hiding, SOLID, dependency direction and layer boundaries, and project structure (drawing on *A Philosophy of Software Design*, SOLID, and *Clean Architecture*); it is `source: "core"` so it is exempt from `DOMAIN_CRITIC_CAP`, runs on Sonnet, is graph-aware (queries the `codebase-memory-mcp` knowledge graph via `get_architecture`/`query_graph` when the repo is indexed, else grep), and emits `category: "Code Quality"` findings scoped to design flaws this change introduces or worsens. The signal-gated **Impact Analyzer** (FEA-1401), a cross-file blast-radius reviewer, runs when signal extraction detects `exported_symbol_change` or `symbol_deletion`. The analyzer identifies changed exported symbols, finds external usages outside the diff (via the `codebase-memory-mcp` knowledge graph when the repo is indexed, else grep), and emits findings with `external_impact[]` listing every callsite that breaks under the new signature. Cost-capped at 30 symbols × 50 callsites with a 5-minute wall budget; deferred symbols surface in the Coverage Plan footer. Impact findings carry `category: "ImpactAnalysis"` and are verifier-audited per-entry (cited callsites read, snippet content-matched, grep replayed). ≥2 verified BLOCKING/HIGH Impact findings escalate the verdict to `NEEDS_ATTENTION` (Rule 6). Deep's extra breadth comes from these two reviewers rather than a wider domain-critic cap.

Tier transitions are detected via `review_state.json`: a cached `shallow` review does not satisfy a subsequent `standard` invocation — the deeper run actually executes the previously skipped reviewers.

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
- **Agent fleet stages** — spawn parallel sub-agent Tasks. `stage_20_spawn_reviewers` invokes the `code-review:spawn-reviewers` skill; `stage_23_verify_findings` invokes the `code-review:verify-findings` skill.
- **Present stage** (`stage_29_present`) — invoke the `code-review:present-local` skill (MODE=local) or follow `github-review.md` (MODE=github).

**Orchestrator model (cost).** The orchestrator runs on the **session model** — there is intentionally no `model:` frontmatter override. The walk is mechanical (run helper, read JSON, honor gates) with no Opus-grade reasoning, so it is safe on a cheaper model; the judgment lives in the **subagents**, which keep their own route-assigned models regardless (BHA Opus / Sonnet on test-only partitions, domain critics Sonnet, Impact Analyzer Opus, verifiers per the verify skill). The spine is ~65% of historical review cost (~180 turns/deep-review, cache-read dominated), so for the cheapest run invoke `/code-review` from a standard-context **Sonnet** session (`/model sonnet`) — the reviewers stay on their assigned models either way. A `model: sonnet` frontmatter override is **deliberately avoided**: a per-command model override inherits the session's context-window tier, so on a **1M-context** session it resolves to Sonnet-with-1M and bills as extra pay-as-you-go API usage outside a Pro/Max subscription (a known Claude Code limitation with no per-command opt-out) — which would invert the saving. **Effort is a separate axis** and, unlike `model`, has no per-Task override — a subagent inherits the session effort unless its own frontmatter pins one. So the two worker agent defs pin `effort: high`, fixing every reviewer's reasoning depth regardless of the session level. That lets you drop the session **model** *and* **effort** for the cheapest orchestrator without starving reviewer thinking (`high` is valid on both Opus and Sonnet, so it holds across the route-assigned reviewer models).

**Turn & context discipline (cost).** Cache cost scales with carried context × turn count, so keep both small:
- **Never read large artifacts into the orchestrator's context.** `diff_data.json`, `patches_*.txt`, and per-file diffs are passed to helpers and reviewers as **file-path arguments**, never `cat`/`Read` into the walk. Reviewers read patches themselves (see the spawn skill's anti-inline rule). The only large file the orchestrator reads is `review_result.json` at the present stage, once, with the per-section display caps the present skill already applies.
- **Batch the deterministic prefix with `run-prefix`.** The entire deterministic prefix (stages 01→19b) runs in ONE process via the `run-prefix` helper — see the **Deterministic Prefix — `run-prefix` loop** section below — collapsing ~19 helper stages (and their ~4 serial model turns each) into a handful of orchestrator turns. This is the default and the single biggest turn-count saving. Only in the per-stage **fallback walk** (when `run-prefix` errored or is unavailable) may you additionally chain a run of consecutive `helper`-kind stages into one `Bash` call (`cmd1 && cmd2 && …`, each redirecting stdout per its `stdout` field) — but ONLY a run in which **every** stage declares `on_failure: abort`, **none** has a `GATES` entry firing after it, **none** is a branching-gate boundary (A/B/C/D) or an `agent_fleet`/`present`/singleton-dispatch stage, and no stage's args depend on a value an in-batch predecessor printed to stdout. Those constraints make recovery unambiguous: there is no gate to interleave, and no `continue` stage whose successors the `&&` short-circuit would wrongly skip. After the chain returns, confirm each chained stage's `expected_outputs`; if the chain exited non-zero, an `abort` stage failed, so **abort** (do not run any gate against the partial batch). Any stage with an associated gate, a non-`abort` `on_failure` (`continue` / `continue_with_coverage_gap`), or a stdout dependency runs solo under the normal one-stage-at-a-time walk. When in doubt, don't batch.
- **Narrate sparingly.** Emit only the operator-essential lines the per-stage notes mark for printing (review-mode line, cache status, fast-path notice, verdict). Do not echo intermediate stage progress as prose.

Four runtime gates modify walker default behavior (they are runtime-driven and either replace the default walk or add a condition on top of a plan stage). **Gate A and Gate B fire inside the prefix — `run-prefix` performs them and surfaces the result to you (as `hygiene_exit` / `ready_for_reviewers`); you only execute their mechanics in the per-stage fallback walk. Gate C and Gate D fire in the walked tail (after `stage_20`), so you always apply them.**
1. **Gate A** — after `stage_12_hygiene`, if `flags.hygiene_only` is true: present hygiene findings and **EXIT** (no further stages, no verdict, no footer).
2. **Gate B** — after `stage_19_cache_check`, invoke `route` (model routing) to compute `fast_path` and `max_bha_agents`. `fast_path == true` skips `stage_17_partition` entirely and drives a single fast-path reviewer in `stage_20`.
3. **Gate C** — before `stage_26_cache_update`, skip if `fast_path == true` OR `CACHE_DIR` is empty.
4. **Gate D** — before `stage_27_review_state_write`, skip unless `MODE == "local"`, `CACHE_DIR` is set, AND all reviewer agents succeeded.

Read this entire file before starting. Agent-fleet dispatch (stages 11/15/20/23) lives in dedicated skills invoked by stage id; the present format and remaining per-stage notes are referenced by stage id below.

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
DEPTH = "standard"

If "--github" present:           MODE = "github"; remove
If "--hygiene-only" present:     HYGIENE_ONLY = true; remove
If "--base <ref>" present:       BASE_REF_OVERRIDE = <ref>; remove both tokens
If "--since-last-review" present: SINCE_LAST_REVIEW = true; remove
If "--full-review" present:       FULL_REVIEW = true; remove
If "--depth <tier>" present:     DEPTH = <tier>; remove both tokens
                                  Valid <tier> values: shallow, standard, deep.
                                  Reject any other value with an error.
```

Flag incompatibility checks (emit error and exit immediately):
- `--base` with `staged` scope — staged has no base ref
- `--since-last-review` with `staged` — requires branch scope
- `--since-last-review` with `--github` — local-only flag
- `--since-last-review` with `--full-review` — contradictory
- `--depth <tier>` with any value outside `shallow|standard|deep` — invalid tier

**Important:** both tokens of `--depth <tier>` MUST be removed from `$ARGUMENTS` before computing `SCOPE_ARGS` below. Leaving `--depth` or its value in the trailing args would either pollute the scope (where they'd be interpreted as paths) or be passed verbatim into `--scope-args`, where `resolve-scope` would reject them.

The remaining `$ARGUMENTS` (after flag removal) is `SCOPE_ARGS`. Detect `PR_NUMBER` if `SCOPE_ARGS` is a single integer.

**0b. Resolve plugin paths and create the CR_DIR via prepare-run.** Run one Bash command to discover the plugin root:

```bash
echo "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py"
```

**Four resolution outcomes — try in order:**

1. **Normal case** — output is a real path ending in `/tools/python/code_review_helpers.py` and the file at that path exists. Track it as `HELPERS` and `PLUGIN_ROOT = ${CLAUDE_PLUGIN_ROOT}`.

2. **In-repo dogfood case** — `${CLAUDE_PLUGIN_ROOT}` is empty (the echo output begins with `/tools/`, no plugin root prefix). This happens when the plugin marketplace cache hasn't picked up an in-repo branch of the plugin itself. Fall back to the in-repo tree IFF `plugins/code-review/.claude-plugin/plugin.json` exists at the current working directory:

   ```bash
   test -f plugins/code-review/tools/python/code_review_helpers.py && pwd
   ```

   If that succeeds, set `PLUGIN_ROOT = <pwd>/plugins/code-review` and `HELPERS = <PLUGIN_ROOT>/tools/python/code_review_helpers.py`. This branch deliberately runs the in-repo helpers against the in-repo branch (correct for dogfooding — the run exercises the helpers actually being reviewed, not the cached marketplace version).

3. **Marketplace cache fallback** — `${CLAUDE_PLUGIN_ROOT}` is empty AND outcome 2 did not apply (no in-repo tree at cwd) AND a populated marketplace cache exists at `~/.claude/plugins/cache/closedloop-ai/code-review/<version>/`. Common case: operator runs `/code-review` from a non-monorepo repo in a session where the marketplace plugin is installed but Claude Code did not populate `${CLAUDE_PLUGIN_ROOT}` (env-var exposure varies across IDEs/CLI configurations). Resolve to the highest-semver cached version:

   ```bash
   ls -d "$HOME/.claude/plugins/cache/closedloop-ai/code-review/"*/ 2>/dev/null | sort -V | tail -1
   ```

   If the output is non-empty AND `<dir>/tools/python/code_review_helpers.py` exists, set `PLUGIN_ROOT = <dir>` (trim the trailing slash) and `HELPERS = <PLUGIN_ROOT>/tools/python/code_review_helpers.py`. Then echo a single-line stderr notice to the operator so the fallback is observable: `Notice: CLAUDE_PLUGIN_ROOT empty; resolved to marketplace cache <PLUGIN_ROOT>`. If the cache directory exists but no version subdirectory contains `tools/python/code_review_helpers.py` (stale or partial install), fall through to outcome 4.

4. **Misconfiguration** — `${CLAUDE_PLUGIN_ROOT}` is empty AND no in-repo tree exists AND no usable marketplace cache exists. The plugin is not installed anywhere reachable. Hard-fail with: `Error: ${CLAUDE_PLUGIN_ROOT} is empty, no in-repo plugin tree at ./plugins/code-review/, and no marketplace cache at ~/.claude/plugins/cache/closedloop-ai/code-review/. Install the code-review plugin via the marketplace, or cd to the claude-plugins monorepo root.` Do NOT attempt the run — every helper invocation would crash on a malformed path.

Then create a session-scoped `CR_DIR` and emit the run plan.

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
  --depth <DEPTH> \
  [--pr-number <PR_NUMBER>]
```

`<DEPTH>` is `shallow`, `standard`, or `deep` — parsed from the `--depth` flag in this command's arguments (default `standard` when absent). Tier filtering happens here: `prepare-run` emits only the stages whose `min_depth`/`max_depth` band brackets the invocation tier. Standard runs see the full 37-stage pipeline; shallow swaps `stage_19b_derive_spawn_spec` for `stage_19c_derive_static_spec` and skips signal extraction (stages 11/11b), coverage planning (stages 14/14a/15/15b/15c), budget arbitrate (16), and spawn verify (20b).

Reads `<CR_DIR>/setup.json` and writes `<CR_DIR>/run_plan.json` containing `review_id`, `flags`, `stages` (the tier-filtered pipeline — 37 stages for `standard` / `deep`, ~27 stages for `shallow`), and `validation_gates`. Read the run plan with the Read tool. Cache `STAGES`, `GATES`, `FLAGS` from the JSON.

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

## Deterministic Prefix — `run-prefix` loop

The deterministic prefix — every stage from `stage_01_setup` through Gate B (`route`), `stage_17_partition`, and `stage_19b_derive_spawn_spec` (or `stage_19c_derive_static_spec` in `--depth shallow`) — is run **in one process** by the `run-prefix` helper instead of one orchestrator turn per stage. This is the default path. Do **not** walk these stages one at a time (the per-stage **Walker Contract** below is the labeled fallback, used only when `run-prefix` returns `error` or is unavailable, e.g. an old marketplace cache with no `run-prefix` subcommand).

`run-prefix` reads `run_plan.json` + `setup.json` from `<CR_DIR>` (both written in stage 0), resolves each stage's placeholder tokens from prior-stage artifacts, honors every stage's `on_failure` policy and validation gate exactly as the Walker Contract prescribes, and pauses only at genuine decision points — emitting a status JSON. See `SCHEMA.md` §7b for the full result contract.

Invoke it, then dispatch on the result's `next_action` (authoritative — read the field, not the exit code, which is `0` for every well-formed result):

```bash
python3 <HELPERS> run-prefix --cr-dir <CR_DIR> --plugin-root <PLUGIN_ROOT>
```

Read the status JSON from stdout and act:

1. **`needs_singleton`** — a PLN-725 singleton needs an agent (`singleton` is `"extract_signals"` or `"coverage_critic"`). Invoke the `code-review:singleton-dispatch` skill for that stage — it reads the prepare manifest `run-prefix` just wrote and spawns one synchronous Task, writing `pln725_<singleton>.json`. Then **re-invoke** `run-prefix` with `--resume-from <resume_stage>` (the `resume_stage` from the result — the sibling consolidate stage) and dispatch on the new result. Both singletons fire on most runs, so expect up to two such pauses per review.

2. **`hygiene_exit`** — **Gate A** (hygiene-only). Mark the pre-review todos `run-prefix` completed (`Parse scope and get diff data`, `Run deterministic hygiene checks`) `completed`. If `cache_status_message` is non-null, print it. Render `<CR_DIR>/hygiene.json` using the **Hygiene Findings Format (Gate A render target)** section below. If `MODE=github`, do the Gate A GitHub write (`.closedloop-ai/code-review-summary.md` + `.closedloop-ai/code-review-findings.json`). Then mark "Present hygiene findings" `completed` and **EXIT** — no route, partition, agents, validate, finalize, verdict, or footer.

3. **`ready_for_reviewers`** — the whole deterministic prefix is done; `run-prefix` has already run Gate B `route`, partitioned (or skipped partition in fast-path), and derived the spawn spec. Mark the pre-review todos `run-prefix` completed (`Parse scope and get diff data`, `Run deterministic hygiene checks`, `Assess scope and route models`) `completed`. Cache `FAST_PATH` (`fast_path`) and `MAX_BHA_AGENTS` (`max_bha_agents`) from the result. **Read `CACHE_DIR` from `<CR_DIR>/cache_config.json` (`cache_dir`, empty when no cache)** — the run-prefix loop skipped the walk where the fallback would have cached it, and Gate C, Gate D, and the notices below all need it. If `cache_status_message` is non-null, print it. If `FAST_PATH` is true, read `<CR_DIR>/spawn.json` (`route.models.fast_path_reviewer`) and print `"Fast path selected: 1 reviewer (<fast_path_reviewer>)."` (matching the Gate B fallback notice) and — when `CACHE_DIR` is set — `"BHA Cache: bypassed in fast-path mode."`, and replace the "Spawn reviewer agents in parallel" todo with "Run fast-path review". Then continue with the **Walker Contract** below **starting at `stage_20_spawn_reviewers`** — the reviewer fleet and everything after it are still walked one stage at a time. (Any `<CACHE_DIR>` / `<REVIEW_ROOT>` / other tokens the tail stages need are resolved from the on-disk artifacts `run-prefix` wrote, per the token table.)

4. **`error`** — a stage aborted or a validation gate failed (`failed_stage` names the stage; `message` carries the diagnostic). Partial artifacts on disk are preserved. **Fall back** to the per-stage **Walker Contract** below, resuming the walk from `failed_stage` (re-run only that stage forward). If a downstream stage keeps failing, surface `message` to the operator.

The routing/cache notices (Gate A cache line, Gate B fast-path + cache line) are the operator-essential output of this loop — emit them and nothing else; do not narrate the individual prefix stages `run-prefix` ran.

---

## Walker Contract

**When this applies.** The Walker Contract governs the **reviewer/verify/present tail** — `stage_20_spawn_reviewers` onward — which is always walked one stage at a time. In the normal flow the `run-prefix` loop above has already run the deterministic prefix (stages 01→19b) and handed off at `stage_20_spawn_reviewers`, so **begin the walk there**. The Contract is ALSO the **per-stage fallback for the prefix**: if `run-prefix` returned `error` (or is unavailable), walk the prefix stages one at a time from `failed_stage`, applying the same steps 1-8 and the Branching Gates (A/B) below. Everything in this section — token resolution, `on_failure`, gates, singleton dispatch — is exactly what `run-prefix` reproduces internally; it is documented here as the canonical contract and the recovery path.

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
| `<REVIEW_ROOT>`    | `<CR_DIR>/scope.json` → `review_root` (empty unless PR-head worktree) |
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
   - **`agent_fleet`**: `stage_20` → invoke the `code-review:spawn-reviewers` skill; `stage_23` → invoke the `code-review:verify-findings` skill.
   - **`present`**: invoke the `code-review:present-local` skill (MODE=local) or follow `github-review.md` Steps 6 and 8 (MODE=github). Gate A hygiene-only early-exit uses the "Hygiene Findings Format (Gate A render target)" section below (mode-agnostic), NOT the skill.

5. **Honor `on_failure`** when the dispatched call fails or `expected_outputs` is missing:
   - `abort` — stop the walk and surface the error.
   - `continue` — log a warning and proceed to the next stage.
   - `continue_with_coverage_gap` — emit a `system_marker: "agent-failure"` finding (shape: the canonical `agent-failure` row in SCHEMA.md §3) and proceed. For `stage_20`, per-agent failures are handled inside the `code-review:spawn-reviewers` skill (Agent Failure Recovery — retry/log/skip steps only); the machine-readable coverage artifact for any skipped *required* reviewer is then materialized deterministically by `stage_20b_verify_spawn` as a `spawn_missing_required_agent` coverage-gap finding in `coverage_gaps.json` — so missing reviewer coverage is never silently dropped even though the orchestrator does not hand-author the finding.

6. **PLN-725 singleton agent dispatch.** When the stage just finished is `stage_11_extract_signals` or `stage_15_coverage_critic`, read the manifest it just wrote and run the protocol in the `code-review:singleton-dispatch` skill before proceeding to the next stage. The manifest's `status` field decides whether an agent spawn is needed — `cache_hit` / `skipped` skips, `needs_agent` spawns. The downstream sibling stage (`stage_11b` / `stage_15b`) walks normally as the next array entry; its `cmd` no-ops on `cache_hit` / `skipped` manifests so the walker doesn't need to branch.

7. **Run gates.** After completing a stage, scan `GATES` for any entry whose `after_stage` matches the stage just finished. For each match, shell out to the canonical enforcer:

   ```bash
   python3 <HELPERS> evaluate-gate --cr-dir <CR_DIR> --after-stage <stage_id>
   ```

   The helper looks the gate up from the same canonical `_build_validation_gates` table that produced `run_plan.json` and checks:
   - Every literal-path entry in `outputs` exists as a regular file (glob entries like `agent_*.json` are scoped to the `all_required_outputs_present` enforcer and are skipped here).
   - For every file listed in `required_sections`, the file exists, parses as JSON, is a top-level JSON object, and every listed section key is present in that object AND its value is a JSON object (dict). The dict-value check catches the corrupt-atomic-write scenario where a section is written as `null` mid-replace — a downstream consumer expecting `state[key]` to be a dict would crash on attribute access.

   Exit code `0` means the gate passed. Exit code `1` means it failed; the diagnostic is on stderr. Read the matching gate's `on_failure_action` from `run_plan.json` (`abort | continue | emit_coverage_gap`) and apply it. The enforcer is gate-policy-agnostic by design — the same helper serves all three actions without branching, so contract changes propagate uniformly.

   `required_sections` distinguishes "the file exists on disk" from "the stage that owns this section actually populated it." `coverage.json` exists from `stage_14` onward (sections accumulate), so a bare file-existence check after `stage_16` would fire-true even if stages 15/15b/15c/16 all failed to populate their sections.

8. **Branching gates** (see next section) fire at specific stage boundaries.

---

## Branching Gates

Four runtime gates modify walker default behavior. Each is documented below with the exact stage boundary it fires at.

**Gate A and Gate B fire inside the prefix, so `run-prefix` performs them for you.** In the normal flow you never execute the mechanics below — `run-prefix` runs Gate A's hygiene-only exit (surfaced as `next_action: "hygiene_exit"`) and Gate B's `route` + partition (surfaced as `next_action: "ready_for_reviewers"` with `fast_path` / `max_bha_agents`), and the **Deterministic Prefix — `run-prefix` loop** section tells you what to print and where to hand off. The Gate A/B detail below is the canonical spec and the recipe for the **per-stage fallback walk** (when `run-prefix` errored). **Gate C and Gate D fire after `stage_20`, in the walked tail, so you always apply them yourself** as described.

### Gate A — After `stage_12_hygiene`: Hygiene-only early exit

If `FLAGS.hygiene_only` is true (or the equivalent `--hygiene-only` was passed):

1. If `CACHE_DIR` is set and `cache_result.json` produced a non-empty `status_message`, print it.
2. Mark "Present hygiene findings" `in_progress`.
3. Parse `<CR_DIR>/hygiene.json` and render using the "Hygiene Findings Format (Gate A render target)" section below.
4. If MODE=github, write hygiene findings to `.closedloop-ai/code-review-summary.md` and `.closedloop-ai/code-review-findings.json`; the workflow handles posting.
5. **EXIT.** Do not run any remaining stages — not route, partition, agents, validate, finalize, cache-update, review-state-write, verdict, or footer. Hygiene-only runs do not emit a `verdict.json` (there is no findings_validated.json or review_result.json for verdict to read; invoking it would crash the walker via `on_failure: abort`).

### Gate B — After `stage_19_cache_check`: Route + fast_path decision

`route` (model selection) is not a canonical PLN-719 stage but the orchestrator needs `fast_path` and `max_bha_agents` before `stage_17_partition` actually runs. The run plan's array order places `stage_17_partition` after `stage_19_cache_check` (the stage id is a stable label; the execution order follows array position). So this gate fires between the two adjacent stages — the walker simply pauses after cache-check, invokes `route`, then resumes with partition.

Run `route`:

```bash
python3 <HELPERS> route \
  --diff-data <CR_DIR>/diff_data.json \
  --critic-gates .closedloop-ai/settings/critic-gates.json \
  --intent <INTENT> \
  --cr-dir <CR_DIR>
```

The cmd writes the routing block directly into `<CR_DIR>/spawn.json.route` via atomic section update (no stdout redirect, no race against the helper's own write). Read `<CR_DIR>/spawn.json` and cache `FAST_PATH` (bool), `MAX_BHA_AGENTS`, `MODELS`, `DOMAIN_CRITICS`, `HIGH_RISK_FILES`, `SIZE_CATEGORY` from the `route` section.

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

## Operator Settings

Two optional operator-authored config files live under `.closedloop-ai/settings/`. Both are absent by default; the pipeline uses built-in defaults until they exist.

### `.closedloop-ai/settings/verdict-thresholds.json` (FEA-1401)

Override the verdict-precedence thresholds without forking the plugin:

```json
{
  "impact_cumulative": 2
}
```

| Key | Default | Effect |
|-----|---------|--------|
| `impact_cumulative` | `2` | Number of BLOCKING/HIGH `ImpactAnalysis` findings on a single PR that flip the verdict to `NEEDS_ATTENTION` (the cumulative Impact gate in `_compute_canonical_verdict`; FEA-1401 / PLN-726 OQ#6). Set higher to relax the gate; raise above any realistic finding count to disable. |

Unknown keys are ignored. Non-integer or `< 1` values fall back to the default — the file is operator-authored and should not crash the pipeline on a typo.

### `.closedloop-ai/settings/verification-gates.json` (PLN-722)

Operator-authored glob lists for path-level verifier escalation. See **stage_24a_verify_consolidate** below for the rule definitions (`sensitive_paths`, `tentative_on_paths`, `mandatory_human_review_paths`).

## Per-Stage Notes

These notes annotate the run-plan stages with anything not obvious from the plan itself. Stages not listed here have no special handling beyond the walker contract.

- **stage_01_setup**: already executed in stage 0b (which captured stdout and wrote `setup.json` itself). The walker treats this as a no-op; the run plan's `stdout` field is `None` for this stage because no shell redirect is correct here.
- **stage_02_prep_assets**: copies `shared_prompt.txt` and `bha_suffix.txt` from `<PLUGIN_ROOT>/tools/prompts/` to `<CR_DIR>`. Both cache and non-cache paths use these assets.
- **stage_03_resolve_scope**: writes `<CR_DIR>/scope.json` with `diff_scope`, `base_ref`, `head_ref`, `review_branch`, `diff_tip`, `pr_number`, `path_filter`, `scope_kind`, `pr_auto_detected`, `head_sha`, `review_root`, `worktree_path`. After this stage, run `finalize-cache` to populate `<CR_DIR>/cache_config.json`. The walker uses these for token resolution downstream. **PR-head worktree (local PR review):** for `MODE=local` PR reviews (`scope_kind == "pr"`, not hygiene-only) resolve-scope isolates source reads so reviewer/verifier agents read the PR head, not the operator's working tree. The diff is computed from the fetched remote refs (`origin/<base>...origin/<head>`); reading the working tree is safe **only** when it already IS the PR head with a clean tree. Otherwise resolve-scope materializes a detached git worktree at the PR head SHA under `<CR_DIR>/pr_head_worktree` and records its absolute path in `review_root`/`worktree_path`; reviewer prompts and verifier inputs then read **source** under `<REVIEW_ROOT>`. **Fail-closed:** if isolation is required but cannot be established (PR head unresolvable, or `git worktree add` fails), resolve-scope returns non-zero and the run aborts (`on_failure: abort`) rather than silently review the wrong branch — the operator is told to check out the PR branch or fix the git error. `review_root` is empty (agents read the working tree) only for the already-at-head-and-clean case, staged/file/branch scope, hygiene-only, and GitHub mode (where the runner already checks out the head). **Worktree lifecycle:** resolve-scope runs a startup GC (`_gc_stale_pr_head_worktrees`) that reclaims orphaned `cr-*/pr_head_worktree` checkouts from prior runs that aborted before teardown; `stage_30_footer` tears down the current run's worktree (validating the path equals the canonical `<CR_DIR>/pr_head_worktree` before the destructive removal). Because the walker can abort before the footer, the next run's startup GC is the backstop — a leaked worktree is never silently reused. Graph-aware reviewers run grep-only (`GRAPH_PROJECT=""`) whenever `review_root` is set, since the knowledge graph indexes the operator checkout, not the PR head.
- **stage_07_auto_incremental**: runs **before** `stage_05_parse_diff` (its array position is between `stage_04_finalize_cache` and `stage_05_parse_diff`). This ordering matters: any `diff_scope` override must be applied to the cached `<DIFF_SCOPE>` token BEFORE parse-diff and extract-patches materialize `diff_data.json` and `patches_all.txt`, otherwise downstream stages see full-PR diff data alongside a narrowed token. The stage retains its `_07_` id as a stable label; execution order follows array position. Writes `<CR_DIR>/auto_incremental.json` with optional `diff_scope` (override) and `review_mode_line`. If `diff_scope` is non-null, update the cached `<DIFF_SCOPE>` token. Print `review_mode_line` (always) and, if `pr_auto_detected` was true in `scope.json`, print `"Auto-detected PR #<PR_NUMBER> for branch <REVIEW_BRANCH>."`.
- **stage_08_fetch_intent**: the helper writes `intent_context.json` into `cr_dir` itself; its stdout is a small `{path, source}` summary that the walker discards. The run plan's `stdout` field is `None` here because redirecting stdout to `intent_context.json` would corrupt the file by overwriting the helper's structured payload with the summary.
- **stage_09_detect_injection** (PLN-720): scores PR title/body/commits against the canonical 9-pattern catalogue and writes `<CR_DIR>/injection_report.json`. On severity ≥ Medium (score ≥ 30), rewrites `<CR_DIR>/intent_context.json` in place with `quarantine: true` and redacted fields. On severity ≥ High (score ≥ 70), also writes `<CR_DIR>/agent_injection-detector.json` containing a canonical `InjectionAttempt` finding — the `agent_*.json` naming makes `cmd_collect_findings` pick it up via the standard glob with no extra wiring. Always appends one JSONL entry to `.closedloop-ai/injection-log.jsonl` (90-day TTL, swept on read). `on_failure: continue` is intentional — a detector crash must never abort the pipeline.
- **stage_11_extract_signals** (PLN-725 Phase 1, wired in Phase 4): runs `extract-signals-prepare`. Writes `<CR_DIR>/extract_signals_manifest.json` describing the cache outcome. On `status: "cache_hit"`, prepare wrote `<CR_DIR>/extract_signals.json` itself — no agent runs, downstream `stage_11b` no-ops. On `status: "needs_agent"`, the walker invokes the `code-review:singleton-dispatch` skill with the manifest's `input_path`, `prompt_path`, and target `pln725_extract_signals.json`. `on_failure: continue_with_coverage_gap` — a signal-extraction failure degrades to the fail-closed default signal set (every taxonomy signal at 0.5 confidence); the required-floor of coverage is unaffected because required rules cannot key solely on LLM signals.
- **stage_11b_extract_signals_consolidate** (PLN-725 Phase 4): runs `extract-signals-consolidate` against `<CR_DIR>/pln725_extract_signals.json`. Validates the agent output against the taxonomy contract and writes the canonical `<CR_DIR>/extract_signals.json`. No-ops when the prepare manifest's `status` is `"cache_hit"` so the walker can drive this unconditionally without inspecting prepare's status. Fail-closed on validation rejection — writes the default signal set + emits a `signal-extraction-failed` finding to `agent_signal-extraction-failed.json`.
- **stage_14_resolve_coverage** (PLN-725): runs `resolve-coverage` against `coverage` rules + `extract_signals.json` + diff data. Writes the deterministic pre-critic plan into `<CR_DIR>/coverage.json` (`initial` section). `depends_on: ["stage_11b_extract_signals_consolidate"]` so the signals input is guaranteed to exist. `on_failure: continue_with_coverage_gap` — downstream stages read `coverage.json.initial` directly.
- **stage_14a_load_available_reviewers** (PLN-725 Phase 5): runs `load-available-reviewers`. Scans `.claude/agents/*.md` (default `--agents-dir`), parses YAML frontmatter for each file's `name` field, writes a flat sorted+dedup JSON list to `<CR_DIR>/available_reviewers.json` — the AVAILABLE roster `stage_15_coverage_critic` enforces against. Independent of stage_14 (no shared data), but slotted between 14 and 15 so the data dependency is explicit on the wire. Empty `.claude/agents/` or missing dir produces an empty roster + exit 0 — stage_15 then falls through to its Phase 4 no-roster skipped semantics. Warnings (unreadable files, missing frontmatter, duplicate names) print to stderr per file but never abort the scan. `on_failure: continue_with_coverage_gap` — a write failure on the roster degrades safely.
- **stage_15_coverage_critic** (PLN-725): runs `coverage-critic-prepare`. Writes the prep manifest into `<CR_DIR>/coverage.json` (`critic` section). On `status: "cache_hit"` (a prior run produced the same coverage plan), prepare wrote the cached plan into `<CR_DIR>/coverage.json` (`final` section) and downstream `stage_15b` no-ops. On `status: "skipped"`, prepare also wrote the initial plan unchanged into `coverage.json.final` — the walker MUST NOT dispatch the singleton critic, no matter which of these skip reasons fired: `"no-critic"` (operator passed `--no-critic`), `"no-roster"` (loaded `available_reviewers.json` is empty — no project agents are configured), or `"no-candidates"` (roster is non-empty but every reviewer is already in the initial plan — nothing left for the critic to propose). Stage_15b is a no-op on any `"skipped"` manifest. On `status: "needs_agent"`, the walker invokes the `code-review:singleton-dispatch` skill with the manifest's paths and target `pln725_coverage_critic.json`. `on_failure: continue` — coverage-critic failure surfaces as `critic_status: "fail_closed"` on the final plan; the deterministic floor from stage_14 still routes reviewers correctly.
- **stage_15b_coverage_critic_consolidate** (PLN-725): runs `coverage-critic-consolidate` against `<CR_DIR>/pln725_coverage_critic.json`. Validates the agent output against the AVAILABLE / additive-only / best-effort-only / evidence / dedup / 5-cap constraints and merges accepted additions into `<CR_DIR>/coverage.json` (`final` section). No-ops when the prepare manifest's `status` (from `coverage.json.critic`) is `"cache_hit"` or `"skipped"`. Fail-closed on all-rejected — writes the initial plan unchanged into `.final` + emits a `coverage-critic-failed` finding to `agent_coverage-critic-failed.json`.
- **stage_15c_verify_coverage** (PLN-725): runs `verify-coverage`. Deterministic post-LLM verifier — reads `<CR_DIR>/coverage.json` (`final` section — post-consolidate; `initial` section — pre-critic) and `<CR_DIR>/available_reviewers.json` (roster), then checks the shape, additive-only, closed-vocabulary, best-effort-only-critic, evidence-required, 5-cap, and no-duplicates contracts. Writes the verdict into `coverage.json` (`verify` section) with `verdict: "PASS"` or `verdict: "BLOCKING"` and a `violations[]` list keyed by check name. On BLOCKING also emits a HIGH system-marker finding to `<CR_DIR>/agent_coverage-verify-blocking.json` (with `source: "coverage-verifier"`, the canonical value in `SOURCES`) so the run summary surfaces the failure. The verifier itself stays observational — exit 0 on both verdicts and `on_failure: continue`. A BLOCKING verdict gates `stage_16_arbitrate_budget`: arbitrate-budget reads this section and short-circuits — the input plan flows through unchanged with `budget.gated_by_verify: true`. The BLOCKING verdict also propagates into `stage_20_spawn_reviewers` via `stage_19b_derive_spawn_spec`: the spawn-spec carries the `gated_by_verify` flag so the orchestrator can surface in the present step that arbitration was bypassed. Spawn-spec derivation still runs against the (unbudgeted) input plan — review is not halted by the BLOCKING verdict, only annotated. Input semantics: missing or unreadable `coverage.json.final` / `coverage.json.initial` sections BLOCK with check `input` so an upstream abort is never confused with a real PASS. Roster semantics: missing or empty roster bypasses the closed-vocabulary check (no-roster skip path); present-but-malformed roster BLOCKs with check `roster` (distinct from absent so an operator config error is surfaced). The `closed_vocabulary` check scopes to `source: "critic"` entries only — core/rule reviewer labels are plugin-internal identifiers that the spawner translates at dispatch time. The `additive` check is bucket-aware: `initial.required ⊆ final.required` enforced separately from best-effort preservation, so a required→best_effort demotion BLOCKs as a silent-coverage-downgrade. The `shape` check validates each entry as a dict with a non-empty `reviewer` string; shape failures short-circuit downstream checks to avoid cascading misleading violations.
- **stage_16_arbitrate_budget** (PLN-719 Section 5): runs `arbitrate-budget` against `<CR_DIR>/coverage.json` (`final` section — post-consolidate input) and writes the arbitrated plan back into the same `.final` section plus `<CR_DIR>/coverage_gaps.json` (multi-writer findings file). PASS verdict from `coverage.json.verify` → arbitration applies the total-reviewer cap (default `BUDGET_TOTAL_CAP_DEFAULT`), fails-closed on required-overflow (drops excess required reviewers + emits `budget-exceeded` system findings per drop), prunes lowest-priority best-effort, and computes the final `bha_partitions` count. BLOCKING verdict → arbitration is bypassed entirely; the input plan flows through unchanged with `budget.gated_by_verify: true` and `arbitrate_status: "blocked_by_verify"`. No new finding is emitted for the gate — the canonical BLOCKING finding already lives in `agent_coverage-verify-blocking.json` from stage_15c, and double-counting would inflate the run summary. Missing `coverage.json.verify` (verifier didn't run, upstream aborted) is treated as PASS so the arbitration path remains operable when verify telemetry is degraded. `on_failure: abort` — a real I/O or shape error here halts the pipeline; the BLOCKING short-circuit is exit 0, not a failure. **Note:** `stage_20_spawn_reviewers` consumes `spawn.json` (`spec` section, derived by `stage_19b_derive_spawn_spec` from this stage's output) and falls back to the static reviewer table in the `code-review:spawn-reviewers` skill only when the spec is missing or marks `arbitrate_status: "fallback"`.
- **stage_12_hygiene**: writes `<CR_DIR>/hygiene.json` with hygiene findings. Triggers **Gate A** (hygiene-only exit) immediately after.
- **stage_17_partition**: positioned in the run plan array after `stage_19_cache_check` so Gate B's `route` invocation runs first and supplies `--max-bha-agents`. The stage id retains its `_17_` prefix as a stable label (stage ids are not strict ordinals; execution order follows array position). Reads `partitions.json` afterward; entries shape `{id, files, total_loc, is_test_only}` with `files[].file` (NOT `path`), `files[].loc`, `files[].is_test`, optional `files[].line_range`. **PLN-774**: top-level keys also carry `partition_mode` (`"unified"` | `"partitioned"`), `partition_count`, `total_changed_loc`, and `unified_threshold_loc`. When total changed LOC ≤ `BHA_UNIFIED_THRESHOLD_LOC` (default 5000, settable via `.closedloop-ai/settings/code-review.json:bha_unified_threshold_loc`; `0` = always partition), the partitioner emits a single unified partition holding every file so cross-region invariants stay visible to one BHA reviewer's context. `cmd_verify_prepare` propagates `partition_mode` + `partition_count` into `verify_manifest.json` for the presenter footer. The `stats.verification.by_reviewer` block naturally labels BHA by partition via the filename-derived `reviewer` field (`agent_bha_p0.json` → `reviewer='bha_p0'`) — no extra split logic is needed; under unified mode only a single `bha_p0` bucket exists because there is only one partition.
- **stage_19_cache_check**: writes `<CR_DIR>/cache_result.json` (stats), `<CR_DIR>/agent_cached_bha.json` (cached BHA findings, glob-compatible with `agent_*`), `<CR_DIR>/uncached_diff_data.json` (filtered diff_data for uncached files). Do NOT print the cache status here — it is printed in Gate A (hygiene exit) or Gate B (after route).
- **stage_19b_derive_spawn_spec** (PLN-725): runs `derive-spawn-spec`. Reads `<CR_DIR>/coverage.json` (`final` section — post-arbitrate), `<CR_DIR>/partitions.json`, and `<CR_DIR>/spawn.json` (`route` section, written by Gate B's `cmd_route --cr-dir`) and writes `<CR_DIR>/spawn.json` (`spec` section) — a flat list of agent descriptors keyed by `agent_id` (e.g. `bha_p0`, `bhb`, `auditor`, `domain_0`, `fast`) carrying `reviewer`, `model`, `partitioned`, `patches_file`, `source`, `bucket`, and (for BHA) `partition_id` + `is_test_only`. The fast-path branch from Gate B is honored (`fast_path: true` → single `fast` agent, bucket walk skipped). BHA descriptors are capped at `coverage_plan.budget.bha_partitions` (the post-arbitrate cap, which may be < the partitioner's output count); the excess partitions land in `skipped[]` with `reason: "budget_capped"`. A BLOCKING verify verdict (`budget.gated_by_verify: true`) drives **plan sanitization**: only `source: "core"` reviewers survive; every `rule` or `critic` entry is moved to `skipped[]` with `reason: "gated_by_verify"` (the canonical BLOCKING finding from stage_15c remains the operator-facing signal). Required-bucket skips with non-benign reasons (everything except `deferred_pln723`, `no_partitions`, `gated_by_verify`) generate coverage-gap findings appended to `<CR_DIR>/coverage_gaps.json` so finalize-result picks them up — the spec-driven dispatch never silently drops a required reviewer. `on_failure: continue` — a derive failure writes a sentinel spec with `arbitrate_status: "fallback"` (`fallback_reason` ∈ {`coverage_plan_missing_or_malformed`, `partitions_missing_or_malformed`}), which the stage_20 orchestrator interprets as "ignore the spec, use the static reviewer table fallback in the `code-review:spawn-reviewers` skill." Note: stage_19b depends only on `stage_16_arbitrate_budget`, NOT on `stage_17_partition`, so Gate B's fast-path branch (which skips stage_17) can still reach stage_20 with a fast descriptor.
- **stage_20_spawn_reviewers**: agent_fleet stage. Invoke the `code-review:spawn-reviewers` skill. The skill reads `<CR_DIR>/spawn.json` (`spec` section) first and dispatches one Task per agent descriptor (using the `agent_id`, `reviewer`, `model`, and `patches_file` from the spec). If `spawn.json` is missing, its `spec` section is absent, or it marks `arbitrate_status: "fallback"`, the skill walks its static reviewer table fallback instead — a derive failure must never block review. In `MODE=github`, the walker must follow the skill's synchronous standard-flow branch: do not use `TaskOutput`, watcher files, sleep loops, polling loops, or turn-ending waits as replacements for synchronous reviewer completion. `stage_20` must complete every GitHub synchronous reviewer and retry, leaving no reviewer task still running, or fail before `stage_21_collect_findings`.
- **stage_20b_verify_spawn** (PLN-725): runs `verify-spawn`. Reads `<CR_DIR>/spawn.json` (`spec` section) and globs `<CR_DIR>/agent_*.json`; for every descriptor with `bucket: "required"` that has no on-disk output, appends a coverage-gap finding to `<CR_DIR>/coverage_gaps.json` (reason `spawn_missing_required_agent`) and records the omission in `<CR_DIR>/spawn.json` (`verification` section). Missing best-effort descriptors are recorded for telemetry but emit no finding — best-effort omissions are budget-driven, not coverage gaps. No-ops cleanly when the spec is missing (`spec_missing`), marks fallback (`spec_fallback`), or contains no agents (`spec_empty`). `on_failure: continue` — a verification bug must never block review; worst case is missing telemetry, not a halted pipeline. Wired before `stage_21_collect_findings` so the gap findings land in `coverage_gaps.json` in time for `cmd_finalize_result` to merge them into the canonical envelope.
- **stage_22_validate**: writes `<CR_DIR>/findings_validated.json` via `> <CR_DIR>/findings_validated.json` redirection. Validates finding scope and applies the out-of-hunk confidence gate. P2+ findings whose `line` falls outside the file's changed range survive when `confidence > out_of_hunk_confidence_floor` (default `0.80`, operator-tunable via `.closedloop-ai/settings/code-review.json:out_of_hunk_confidence_floor`, range `[0.0, 1.0]`) — this admits legitimate companion-change findings (e.g. a signature change in the diff window leaving stale sibling call sites just outside it) while still filtering low-confidence noise. Survivors get tagged `out_of_hunk_kept: true` so presenters can label them as companion-change without re-deriving hunk membership; the validate-stats block exposes `kept_out_of_hunk` and `discarded_out_of_hunk_low_confidence`. The comparison is strict `>`, so setting the floor to `1.0` is a kill switch (nothing can clear); setting it to `0.0` lets every out-of-hunk P2+ through (lean on the PLN-722 verifier downstream). Per-finding verification (stage_23) still applies on top, so noise that surfaces here gets a second-pass CONFIRMED/REJECTED verdict.
- **stage_22b_verify_prepare** (PLN-722): tier-selects findings for verification per the canonical table — BLOCKING/HIGH always; MEDIUM with confidence < 0.85 yes; MEDIUM with confidence ≥ 0.85 no; LOW (P3) no; `category: "Hygiene"` no; `source: "injection-detector"` no. Ranks the eligible set by `severity_weight × confidence`, caps at `VERIFY_MAX_VERIFICATIONS = 50`, and writes (a) `<CR_DIR>/verify_manifest.json` with `to_verify[]` + `skipped_no_verification[]` + `deferred_budget[]` + `cache_hits[]`, and (b) `<CR_DIR>/verifier_inputs/<finding_id>.json` per eligible finding. When `--cache-dir` is set, fresh verifier outputs from a prior run for the same `(finding_id, code_snippet_hash, model, prompt_hash)` tuple are pre-materialized at `agent_verifier_<finding_id>.json` and skipped from `to_verify[]` (logged under `cache_hits[]`). `on_failure: continue` is intentional — verify-prepare failure degrades to "no verifier this run", not a pipeline abort.
- **stage_23_verify_findings** (PLN-722): agent_fleet stage. Invoke the `code-review:verify-findings` skill. Each spawned agent reads its `verifier_inputs/<finding_id>.json` (containing the finding + the `verifier_prompt_path` + the canonical `output_path`) and emits one verdict file at `<CR_DIR>/agent_verifier_<finding_id>.json`. `on_failure: continue` so a single agent crash never aborts review. In `MODE=github`, the walker must follow the skill's synchronous verifier branch: do not use `TaskOutput`, watcher files, sleep loops, polling loops, or turn-ending waits as replacements for synchronous verifier completion. `stage_23` must complete every GitHub synchronous verifier, leaving no verifier task still running, or fail before `stage_24a_verify_consolidate`.
- **stage_24a_verify_consolidate** (PLN-722, extended in PLN-721): merges all `agent_verifier_*.json` outputs back into the validated set, applies sensitive-path escalation from `.closedloop-ai/settings/verification-gates.json` (rules: REJECTED on `sensitive_paths` + BLOCKING/HIGH → TENTATIVE with severity capped at HIGH; any finding on `tentative_on_paths` → TENTATIVE; any finding on `mandatory_human_review_paths` → TENTATIVE + `force_human_review: true`), routes JUSTIFIED-VALID verdicts to a new `justified[]` bucket and JUSTIFIED-INVALID verdicts back into `verified[]` (the audited justification was refuted; the original concern stands), and writes `<CR_DIR>/findings_verified.json` with the bucket-split shape `{verified[], rejected[], pending_verification[], justified[], force_human_review}`. `tentative_on_paths` lifts JUSTIFIED-VALID/INVALID to TENTATIVE on the same operator-policy contract as the other verdicts. When `--cache-dir` is set, fresh verifier outputs are written back to the `verifications/` namespace (30-day TTL) for re-use on subsequent runs. Missing fleet outputs degrade to `pending_verification[]`; `on_failure: continue`.
- **stage_25_finalize_result** (PLN-722 + PLN-721): writes `<CR_DIR>/review_result.json` (the canonical envelope) BEFORE running schema validation. PLN-722: prefers `<CR_DIR>/findings_verified.json` (verify-consolidate output) when present and honors its `force_human_review` flag in the verdict computation; falls back to `findings_validated.json` (everything to `verified[]`) when verify-consolidate didn't run. PLN-721: pipes the consolidate `justified[]` bucket into the envelope, and loads operator-overridable thresholds from `.closedloop-ai/settings/verdict-thresholds.json` (defaults to `impact_cumulative=2`; absent/malformed → built-in default) so `_compute_canonical_verdict`'s cumulative Impact gate (FEA-1401 / PLN-726 OQ#6) can fire (≥ 2 BLOCKING/HIGH `ImpactAnalysis` findings in `verified[]` → NEEDS_ATTENTION). A non-zero exit signals reviewer-emitted category/field drift (e.g. a category not in the canonical enum) but does not block the pipeline — `on_failure: continue` lets `stage_28_verdict` read the structurally complete envelope. Surface the stderr text in the present step so operators can correct prompts/schema; do not abort.
- **stage_26_cache_update**: gated by **Gate C**.
- **stage_27_review_state_write**: gated by **Gate D**.
- **stage_29_present**: present stage. Invoke the `code-review:present-local` skill (MODE=local) or follow Steps 6 and 8 in `github-review.md` (MODE=github). The mode-agnostic Gate A hygiene-only early-exit fires before this stage and uses its own format section above.

---

## Reviewer Fleet (stage_20_spawn_reviewers)

When the walker reaches `stage_20_spawn_reviewers`, invoke the `code-review:spawn-reviewers` skill. The skill owns the full reviewer-fleet dispatch: spawn-spec consumption (`spawn.json.spec`, the authoritative path), GRAPH_PROJECT resolution, the per-agent prompt template and role suffixes (Bug Hunter A/B, Unified Auditor, Domain Critics, Design Critic, Impact Analyzer), the context-budget constraints, the standard / fast-path / all-cached-BHA / gated-by-verify branches, the static-table fallback (`arbitrate_status: "fallback"`), the spawn + collection contract, and agent-failure recovery.

The skill is invoked for both `MODE=local` and `MODE=github`, but standard-flow Task scheduling is mode-specific: GitHub mode dispatches reviewers synchronously, while local mode preserves parallel background dispatch plus blocking collection. The verifier fleet (`stage_23`) and the PLN-725 single-agent dispatch (`stage_11` / `stage_15`) are **not** in this skill; they are owned by the `code-review:verify-findings` and `code-review:singleton-dispatch` skills respectively.

GitHub headless mode has a walker-level guard in addition to the skill contract: standard-flow reviewers and retries must be dispatched synchronously, and the walker must not proceed to `stage_21_collect_findings`, emit a final summary, mark the review complete, or end the assistant turn while any GitHub reviewer remains outstanding. Watcher files, sleep loops, polling loops, background `TaskOutput` waits, and "I'll continue when notified" turns are forbidden substitutes for completing the synchronous reviewer response.

Decomposition rationale: ~470 lines of reviewer-fleet dispatch content was extracted as a skill so the orchestration spine stays lean and the content no longer loads into orchestrator context during the deterministic prefix (stages 0-19) or on hygiene-only / full-cache-hit runs that never reach `stage_20`.

<!-- replaced-by-skill: code-review:spawn-reviewers — DO NOT add inline reviewer-fleet dispatch content here -->

---

## Verifier Fleet (stage_23_verify_findings)

When the walker reaches `stage_23_verify_findings`, invoke the `code-review:verify-findings` skill. The skill owns the full finding-verifier dispatch: reading `verify_manifest.json`, spawning one falsify-oriented verifier Task per `to_verify[]` entry (skipping `cache_hits[]`), the no-retry collection contract, and the `pending_verification[]` degradation when a verifier output is missing.

The skill is invoked for both `MODE=local` and `MODE=github`, but Task scheduling is mode-specific: GitHub mode dispatches verifiers synchronously, while local mode preserves parallel background dispatch plus blocking collection. In `MODE=github` a missing verifier output for a BLOCKING/HIGH finding also raises a durable coverage-gap signal at `stage_24a_verify_consolidate` so an unverified high-severity finding cannot pass silently to an approved verdict.

GitHub headless mode has a walker-level guard in addition to the skill contract: verifiers and retries must be dispatched synchronously, and the walker must not proceed to `stage_24a_verify_consolidate`, emit a final summary, mark the review complete, or end the assistant turn while any GitHub verifier remains outstanding. Watcher files, sleep loops, polling loops, background `TaskOutput` waits, and "I'll continue when notified" turns are forbidden substitutes for completing the synchronous verifier response.

<!-- replaced-by-skill: code-review:verify-findings — DO NOT add inline verifier-fleet dispatch content here -->

---

## PLN-725 Single-Agent Dispatch

The `run-prefix` loop's `next_action: "needs_singleton"` handler points here (and, in the per-stage fallback walk, so does Walker-Contract step 6). When `run-prefix` reports a singleton — or, in the fallback walk, when the stage just finished is `stage_11_extract_signals` or `stage_15_coverage_critic` — invoke the `code-review:singleton-dispatch` skill. The skill owns the full protocol: reading the prepare manifest's `status` (`cache_hit` / `skipped` → no dispatch; `needs_agent` → spawn one synchronous singleton Task), the by-convention `pln725_*.json` agent write target, and the fail-closed semantics the sibling consolidate stage relies on. In the `run-prefix` flow the manifest already exists on disk (the runner wrote it); after the skill writes `pln725_<singleton>.json`, re-invoke `run-prefix --resume-from <resume_stage>` per the loop.

<!-- replaced-by-skill: code-review:singleton-dispatch — DO NOT add inline singleton-dispatch content here -->

---

## Hygiene Findings Format (Gate A render target)

Gate A step 3 ("render using the Hygiene Findings format below") points here. Gate A fires in **both** `MODE=local` and `MODE=github` so this format stays inline in the orchestration spine rather than living in any mode-specific skill.

Parse `<CR_DIR>/hygiene.json` and render:

```markdown
# Hygiene Check Results

**Scope:** [staged/branch/files]
**Files Checked:** [count]
**Mode:** Hygiene-only (no LLM review)

---

## Repo Hygiene ([count])

[List hygiene findings — one entry per finding, with **File**, **Issue**, **Recommendation**]

---

**Summary:** [count] hygiene issues found. No LLM-based review was performed.
```

Then mark "Present hygiene findings" `completed` and **EXIT**. Do NOT run footer or verdict — both depend on artifacts (`findings_validated.json`, `review_result.json`) that hygiene-only never produces, and `stage_28_verdict.on_failure == "abort"` would crash the walker. The GitHub-mode write (`.closedloop-ai/code-review-summary.md` + `.closedloop-ai/code-review-findings.json`) is owned by Gate A step 4 above; do NOT duplicate it here.

---

## Local-Mode Presenter (stage_29_present, MODE=local)

When `MODE=local` AND `stage_29_present` is reached, invoke the `code-review:present-local` skill. The skill owns the full local-mode pipeline: validation summary, BLOCKING/HIGH/MEDIUM sections, Justified Findings (PLN-721), Dismissed Findings (PLN-722), Verifier Stats footer (PLN-773), operator-flag descriptions, override precedence rule (stage_22b context), Validation Summary, and final Summary.

The skill is scoped to local mode only. Gate A hygiene presentation (mode-agnostic) stays above; the `MODE=github` presenter path uses `github-review.md` (see below).

Decomposition rationale: ~270 lines of local-mode presentation content was extracted as a skill so the orchestration spine stays lean and future presenter changes ship in isolation from the orchestration flow.

---

<!-- replaced-by-skill: code-review:present-local — DO NOT add inline local-mode presenter content here -->

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

`stage_28_verdict` runs as a normal helper in the walker. It writes `<CR_DIR>/verdict.json` with three fields: `verdict` (legacy string for `run-loop.sh`: `approve` | `needs_attention` | `decline`), `canonical_verdict` (envelope form: `APPROVED` | `NEEDS_ATTENTION` | `CHANGES_REQUESTED`), and `reason`. After the footer prints, do not output any additional line — the verdict artifact is the contract; consumers read `verdict.json` directly.

---

## Arguments

$ARGUMENTS
