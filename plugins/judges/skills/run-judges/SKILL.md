---
name: run-judges
description: Orchestrate parallel judge agent execution, aggregate CaseScore results, write judges.json or code-judges.json, and validate output using a manifest-driven judge configuration.
context: fork
---

# Run Judges Skill

## Purpose

Execute specialized judge agents in parallel for plan or code evaluation using the external judge manifest. Aggregates results into the manifest-defined output file with validated format.

## Parameters

**--artifact-type**: Artifact category to evaluate (plan | code), default: plan

- **plan** (default): Evaluate implementation plans using `categories.plan` from the manifest
- **code**: Evaluate implemented code using `categories.code` from the manifest

## Judge Input Contract (`judge-input.json`)

The judge input contract is maintained in:

`$CLAUDE_PLUGIN_ROOT/skills/run-judges/references/judge-input-contract.md`

This keeps orchestration flow readable while preserving a single source of truth for contract fields and semantics.

## Task Context

You are orchestrating quality evaluation for a ClosedLoop artifact (implementation plan or code). Your responsibilities:

**For any artifact type** (plan by default, or code via `--artifact-type code`):
1. Launch context-manager-for-judges agent to prepare compressed context
2. Build `judge-input.json` with artifact-appropriate task/context mapping
3. Launch all manifest-defined judges in a single parallel wave
4. Aggregate their CaseScore outputs into a valid EvaluationReport
5. Write the report to the manifest-defined output file for the artifact category
6. Validate output structure and completeness

**Success criteria:**
- All judges executed (or error CaseScores generated for failures)
- Valid JSON written to appropriate output file
- Validation script passes with zero errors

---

## Performance Instrumentation (Mandatory)

You MUST emit a `pipeline_step` event to `$CLOSEDLOOP_WORKDIR/perf.jsonl` at the **end** of each phase below. This keeps perf telemetry in the canonical schema and adds nested metadata for judge/sub-agent work.

**Context:** `CLOSEDLOOP_WORKDIR`, `CLOSEDLOOP_RUN_ID`, and `CLOSEDLOOP_ITERATION` are set by the run-loop. `CLOSEDLOOP_PARENT_STEP` and `CLOSEDLOOP_PARENT_STEP_NAME` are set as env vars on the `claude` invocation by run-loop; they are inherited by all Bash tool calls — no sourcing needed.
Use `sub_step` as numeric phase order and optional `sub_step_name` to capture the phase label.

**Sub-step numbering:**

| Artifact | sub_step | sub_step_name   |
|----------|----------|-----------------|
| plan     | 0        | context_manager |
| plan     | 1        | judge_execution |
| plan     | 2        | aggregate       |
| plan     | 3        | validate        |
| code     | 0        | context_manager |
| code     | 1        | judge_execution |
| code     | 2        | aggregate       |
| code     | 3        | validate        |

**Start of phase (run Bash once at the beginning of each phase):** Set the two sub-step variables at the top for the current phase, then run the block. It writes start time to a temp file so the end-of-phase Bash can compute duration. `CLOSEDLOOP_PARENT_STEP` and `CLOSEDLOOP_PARENT_STEP_NAME` are already in the environment (set by run-loop on the `claude` invocation).

```bash
# Set these two values for the current phase:
SUB_STEP_NUM=0
SUB_STEP_LABEL="context_manager"   # context_manager | judge_execution | aggregate | validate

mkdir -p "$CLOSEDLOOP_WORKDIR/.closedloop"
{
  echo "SUB_STEP=${SUB_STEP_NUM}"
  echo "SUB_STEP_NAME=${SUB_STEP_LABEL}"
  echo "PARENT_STEP=${CLOSEDLOOP_PARENT_STEP:-0}"
  echo "PARENT_STEP_NAME=${CLOSEDLOOP_PARENT_STEP_NAME:-unknown}"
  echo "STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "START_EPOCH=$(date +%s)"
} > "$CLOSEDLOOP_WORKDIR/.closedloop/perf-substep-start.env"
```

**End of phase (run Bash once at the end of each phase, after the phase work is done):** Read start time, compute duration, append one line to `perf.jsonl`, then remove the temp file.

```bash
source "$CLOSEDLOOP_WORKDIR/.closedloop/perf-substep-start.env"
END_EPOCH=$(date +%s)
ENDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DURATION=$((END_EPOCH - START_EPOCH))
jq -n -c \
  --arg event "pipeline_step" \
  --arg run_id "${CLOSEDLOOP_RUN_ID:-unknown}" \
  --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
  --argjson step "$PARENT_STEP" \
  --arg step_name "$PARENT_STEP_NAME" \
  --argjson sub_step "$SUB_STEP" \
  --arg sub_step_name "$SUB_STEP_NAME" \
  --arg started_at "$STARTED_AT" \
  --arg ended_at "$ENDED_AT" \
  --argjson duration_s "$DURATION" \
  --argjson exit_code 0 \
  --argjson skipped false \
  '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,sub_step:$sub_step,sub_step_name:$sub_step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}' >> "$CLOSEDLOOP_WORKDIR/perf.jsonl"
rm -f "$CLOSEDLOOP_WORKDIR/.closedloop/perf-substep-start.env"
```

**Order of operations per phase:** Run the "start of phase" Bash first (set `SUB_STEP_NUM` and `SUB_STEP_LABEL` at the top, then run the block), then perform the phase work, then run the "end of phase" Bash.

---

## Execution Workflow

### Step 0: Mandatory Contract Pre-Read

Before any prerequisite checks or judge launches:

1. Resolve the contract path deterministically as:
   - `$CLAUDE_PLUGIN_ROOT/skills/run-judges/references/judge-input-contract.md`
2. Validate that the path exists and is readable.
3. Read the `judge-input-contract.md` file in full.
4. Apply the contract requirements when constructing `$CLOSEDLOOP_WORKDIR/judge-input.json`.
5. If the file is missing or unreadable, fail fast with a clear error (do not proceed with judge execution).

### Prerequisites Check

**Performance:** At the start of this phase run the "start of phase" Bash with `SUB_STEP_NUM=0` and `SUB_STEP_LABEL=context_manager` for both plan and code modes. At the end of the phase run the "end of phase" Bash.

**Step P1: Run preflight script**

```bash
bash "$CLAUDE_PLUGIN_ROOT/skills/run-judges/scripts/preflight_judges.sh" "$ARTIFACT_TYPE" "$CLOSEDLOOP_WORKDIR"
```

Read `$CLOSEDLOOP_WORKDIR/.closedloop/preflight-report.json` and branch on `status`:

- **`skip`** — exit 0 gracefully (do not fail parent workflow).
- **`error`** — exit 1 with the `error` message.
- **`ready`** or **`needs_action`** — continue below.

**Step P2: Execute actions from preflight report**

Iterate over the `actions` array. Each entry has an `action` key:

| Action | How to Execute |
|--------|----------------|
| `resolve_investigation_log` | Run `bash "$CLAUDE_PLUGIN_ROOT/skills/run-judges/scripts/resolve_investigation_log.sh" "$CLOSEDLOOP_WORKDIR"`, read the JSON output, and follow `instructions`. If `resolution=try_pre_explorer`, attempt the launch; on failure re-run with `--pre-explorer-failed` and follow the next instruction. Never block on failure. |
| `launch_context_manager` | Launch `@judges:context-manager-for-judges` with the reported `artifact_type`. |

**Step P3: Build judge-input.json**

Ensure uv is available before running:
```bash
if ! command -v uv &> /dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
```

```bash
BUILD_SCRIPT="$CLAUDE_PLUGIN_ROOT/skills/run-judges/scripts/build_judge_input.py"
uv run "$BUILD_SCRIPT" --artifact-type "$ARTIFACT_TYPE" --workdir "$CLOSEDLOOP_WORKDIR"
```

If code mode and build fails — exit 1 (context preparation failed).

**Performance:** Run "end of phase" Bash.

## Artifact Type Configuration

The run-judges skill supports two artifact types configured in:

`$CLAUDE_PLUGIN_ROOT/agents/judge-manifest.json`

For each category (`plan`, `code`), the manifest controls:
- Judge list via `judges`
- Output filename (`output_file`)
- Report id suffix (`report_id_suffix`)

### Mandatory Manifest Loading (Fail-Fast)

Before launching any judges:
1. Resolve manifest path (`agents/judge-manifest.json`)
2. Parse JSON and validate schema
3. Ensure requested `artifact_type` category exists
4. Validate `judges` exists

If any validation fails, abort judge execution with a clear error.

---

### Step 1: Launch Judge Agents in Parallel

**Performance:** Run "start of phase" Bash before launching judge execution with `sub_step=1` and `sub_step_name=judge_execution`; run "end of phase" Bash after all judge tasks complete.

**Constraint:** The Task tool supports maximum 4 concurrent agents.

**Action:** Launch all manifest-defined judges in one parallel wave for the selected artifact type.

<judge_execution>

### Manifest-Driven Judge Execution

Load `judges` from `judge-manifest.json` for the selected category.

- Execute all listed judges in one parallel wave (max 4)
- For each judge id `X`, invoke agent `judges:X`

</judge_execution>

<prompt_template>

### Preamble Injection

**Before invoking each judge, prepend the common and artifact-specific preambles:**

1. **Locate preamble files**:
   - `$CLAUDE_PLUGIN_ROOT/skills/run-judges/preambles/common_input_preamble.md`
   - `$CLAUDE_PLUGIN_ROOT/skills/run-judges/preambles/{artifact_type}_preamble.md`
   - Validate both files exist (fail with error 'preambles-missing' if either is missing)

2. **Read preamble content**:
   - Read `common_input_preamble.md`
   - Read `{artifact_type}_preamble.md`

3. **Concatenate**:
   - `common_input_preamble + "\n\n---\n\n" + artifact_preamble + "\n\n---\n\n" + judge_prompt`
   - `common_input_preamble.md` is the only runtime source of judge input-loading contract text.

4. **Pass to judge**: Use concatenated prompt as judge's full prompt

</prompt_template>

### Per-Judge JSON Validation (MANDATORY)

After each judge returns JSON, validate the payload.

1. Write raw judge payload to a temporary file:
   - `$CLOSEDLOOP_WORKDIR/judge-output-{judge_id}.json`
2. Validate via script:
  Run CaseScore validation directly:
  **Ensure uv is installed**

  ```bash
  if ! command -v uv &> /dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  ```
  **Validate judge output JSON**
  ```bash
  SKILL_DIR=$CLAUDE_PLUGIN_ROOT/skills/run-judges
  SCRIPT_PATH="$SKILL_DIR/scripts/judge_report_contract.py"
  uv run "$SCRIPT_PATH" validate-case-score --case-score-path "$CLOSEDLOOP_WORKDIR/judge-output-{judge_id}.json" --expected-case-id "{judge_id}"
  ```
3. If validation fails:
   - Replace payload with deterministic error CaseScore (`final_status=3`) for that judge
   - Continue processing remaining judges

Validation is required for each judge output to prevent malformed JSON from propagating into aggregation.

#### Error Handling Protocol

<error_handling>

**CRITICAL REQUIREMENT:** If a judge Task call fails, you MUST construct an error CaseScore.

**Error CaseScore Template:**
```json
{
  "type": "case_score",
  "case_id": "{judge-name}",
  "final_status": 3,
  "metrics": [
    {
      "metric_name": "{metric}_score",
      "threshold": 0.8,
      "score": 0.0,
      "justification": "Judge execution failed: {error message}"
    }
  ]
}
```

**Continue-on-failure semantics:**
- Even if all judges fail, you MUST aggregate error CaseScores
- Always produce a complete report with one CaseScore per manifest-listed judge
- Never abort the workflow due to judge failures

</error_handling>

---

### Step 2: Aggregate Results into EvaluationReport

**Performance:** Run "start of phase" with `sub_step=2`, `sub_step_name=aggregate`. Emit 'end of phase' after the aggregation step regardless of file write outcome.

**Task:** Run the aggregate script. The script handles report format and manifest logic.

<aggregation_workflow>

**Run the aggregate script**

```bash
SKILL_DIR=$CLAUDE_PLUGIN_ROOT/skills/run-judges
AGGREGATE_SCRIPT="$SKILL_DIR/scripts/judge_report_contract.py"
RESULTS_PATH="$CLOSEDLOOP_WORKDIR/judge-results-${ARTIFACT_TYPE}.json"
CATEGORY="plan"
[ "$ARTIFACT_TYPE" = "code" ] && CATEGORY="code"

uv run "$AGGREGATE_SCRIPT" aggregate \
  --workdir "$CLOSEDLOOP_WORKDIR" \
  --category "$CATEGORY" \
  --results-path "$RESULTS_PATH"
```

</aggregation_workflow>

---

### Step 3: Validate Output (MANDATORY)

**Performance:** Run "start of phase" with `sub_step=3`, `sub_step_name=validate`. Emit 'end of phase' after each validation attempt regardless of exit code, then apply failure recovery logic.

**CRITICAL:** You MUST run the validation script after writing the manifest-defined output file (`judges.json` or `code-judges.json`). Do not consider the task complete until validation passes.

<validation_workflow>

**Step 3.1: Locate the Validation Script**

The script is in the run-judges skill scripts directory:

```bash
SKILL_DIR=$CLAUDE_PLUGIN_ROOT/skills/run-judges
SCRIPT_PATH="$SKILL_DIR/scripts/judge_report_contract.py"
```

**Step 3.2: Run Validation**

```bash
# Determine category based on artifact type
CATEGORY="plan"  # default
if [ "$ARTIFACT_TYPE" = "code" ]; then
  CATEGORY="code"
fi

uv run "$SCRIPT_PATH" validate-report --workdir "$CLOSEDLOOP_WORKDIR" --category "$CATEGORY"
```

**Argument requirements:**
- `--workdir` must be the **absolute path** to `$CLOSEDLOOP_WORKDIR`
- `--category` must exist in manifest categories (typically `plan` or `code`)
- This is where `judges.json` or `code-judges.json` is located

</validation_workflow>

---

### Validation Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| `0` | Valid | Task complete ✓ |
| `1` | Invalid | Read error, fix `judges.json`, re-validate |

---

### If Validation Fails

<failure_recovery>

**Follow this sequence:**

1. **Read error message** - Understand what failed
2. **Fix `judges.json`** - Correct the specific validation error
3. **Re-run validation** - Repeat until exit code 0
4. **Never skip validation** - Do not mark task complete until validation passes

</failure_recovery>

---

## Error Handling Requirements

### Invalid Artifact Type

If `--artifact-type` value is not 'plan' or 'code':
- Fail immediately with clear error message
- Do not attempt judge execution
- Exit with non-zero status

### Individual Judge Failures

If a single judge Task call fails during execution:
- **Do not abort** the entire workflow
- Generate error CaseScore for that judge only
- Continue with all remaining judges
- Include error CaseScore in final aggregated report

### Plan Mode Execution Flow

When `--artifact-type` is not specified or equals 'plan'

---
