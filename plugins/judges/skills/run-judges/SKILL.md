---
name: run-judges
description: Orchestrate parallel judge agent execution, aggregate CaseScore results, write judges.json or code-judges.json, and validate output. Supports evaluating both implementation plans (13 judges) and code artifacts (11 judges) via --artifact-type parameter.
context: fork
---

# Run Judges Skill

## Purpose

Execute specialized judge agents in parallel to evaluate implementation plan quality (13 judges) or code quality (11 judges). Aggregates results into `$CLOSEDLOOP_WORKDIR/judges.json` (plan) or `$CLOSEDLOOP_WORKDIR/code-judges.json` (code) with validated output format.

## Parameters

**--artifact-type**: Artifact category to evaluate (plan | code), default: plan

- **plan** (default): Evaluate implementation plan with 13 judges, 4 batches, output to judges.json
- **code**: Evaluate implemented code with 11 judges, 3 batches, output to code-judges.json

## Judge Input Contract (`judge-input.json`)

The judge input contract is maintained in:

`references/judge-input-contract.md`

This keeps orchestration flow readable while preserving a single source of truth for contract fields and semantics.

## Task Context

You are orchestrating quality evaluation for a ClosedLoop artifact (implementation plan or code). Your responsibilities:

**For plan artifacts (default):**
1. Launch context-manager-for-judges agent to prepare compressed plan context
2. Build `judge-input.json` with plan task/context mapping
3. Launch all 13 judge agents in parallel batches
4. Aggregate their CaseScore outputs into a valid EvaluationReport
5. Write the report to `$CLOSEDLOOP_WORKDIR/judges.json`
6. Validate output structure and completeness

**For code artifacts (--artifact-type code):**
1. Launch context-manager-for-judges agent to prepare compressed context
2. Build `judge-input.json` with code task/context mapping
3. Launch 11 judge agents in parallel batches
4. Aggregate their CaseScore outputs into a valid EvaluationReport
5. Write the report to `$CLOSEDLOOP_WORKDIR/code-judges.json`
6. Validate output structure and completeness

**Success criteria:**
- All judges executed (or error CaseScores generated for failures)
- Valid JSON written to appropriate output file
- Validation script passes with zero errors

---

## Threshold Overrides

The run-judges skill supports per-artifact-type threshold customization via JSON configuration files. This allows you to adjust evaluation strictness for different artifact types (e.g., applying a lower threshold for test-judge when evaluating code vs plan).

### Configuration Schema

Threshold overrides are defined in a JSON file with the following structure:

```json
{
  "overrides": {
    "artifact_type:judge_name": <threshold_float>
  }
}
```

Where:
- **Key format**: `"artifact_type:judge_name"` (e.g., `"code:test-judge"`, `"plan:technical-accuracy-judge"`)
- **Value**: Threshold as a float in range `[0.0, 1.0]`

**Example configuration:**
```json
{
  "overrides": {
    "code:test-judge": 0.75,
    "plan:technical-accuracy-judge": 0.85
  }
}
```

### Loading Precedence

The skill checks the following locations in order, using the first valid configuration found:

1. **Run-specific overrides** (highest precedence):
   - Path: `$CLOSEDLOOP_WORKDIR/.claude/settings/threshold-overrides.json`
   - Use case: Override thresholds for a specific ClosedLoop run

2. **Repo-level defaults** (fallback):
   - Path: `<project-root>/.claude/settings/threshold-overrides.json`
   - Use case: Set project-wide threshold defaults

3. **Hardcoded defaults** (graceful degradation):
   - If no configuration file exists at any location, use built-in defaults
   - No error is raised for missing configuration files

### Default Overrides

The following default overrides apply when evaluating code artifacts:

| Judge | Code Threshold | Plan Threshold | Rationale |
|-------|----------------|----------------|-----------|
| `test-judge` | 0.75 | 0.8 | Code may have tests written separately from implementation, lower threshold accounts for incremental test development |

All other judges use the same threshold (typically 0.8) across artifact types.

### Validation and Error Handling

When loading threshold overrides, the skill applies the following validation rules:

**Schema Validation:**
- Configuration must contain an `"overrides"` key
- Each key must match the pattern `artifact_type:judge_name`
- Each value must be a float in range `[0.0, 1.0]`
- Keys must reference valid artifact types (`plan`, `code`) and judge names

**Error Behavior:**
- **Malformed JSON**: Log warning and continue with hardcoded defaults
  ```
  Warning: Invalid threshold-overrides.json, skipping overrides: {error}
  ```
- **Invalid schema**: Log warning and continue with hardcoded defaults
- **File not found**: Silently use defaults (no warning logged)

**Error recovery ensures the skill always completes judge execution**, even if threshold configuration is incorrect.

### Integration with Judge Execution

When executing judges:

1. **Before launching judge batches**: Load threshold overrides from the precedence chain
2. **Merge with defaults**: Loaded overrides take precedence over hardcoded defaults
3. **Apply per-judge**: Each judge receives its artifact-type-specific threshold via the evaluation context
4. **CaseScore validation**: Thresholds are used to determine `final_status` (pass/fail) based on metric scores

**When artifact type is code**:
- Load threshold overrides before executing judge batches
- Apply code-specific thresholds to each judge's evaluation criteria
- Merge loaded overrides with defaults (loaded values take precedence)

---

## Performance Instrumentation (Mandatory)

You MUST emit a `pipeline_step` event to `$CLOSEDLOOP_WORKDIR/perf.jsonl` at the **end** of each phase below. This keeps perf telemetry in the canonical schema and adds nested metadata for judge/sub-agent work.

**Context:** `CLOSEDLOOP_WORKDIR`, `CLOSEDLOOP_RUN_ID`, and `CLOSEDLOOP_ITERATION` are set by the run-loop. `CLOSEDLOOP_PARENT_STEP` and `CLOSEDLOOP_PARENT_STEP_NAME` are set as env vars on the `claude` invocation by run-loop; they are inherited by all Bash tool calls — no sourcing needed.
Use `sub_step` as numeric phase order and optional `sub_step_name` to capture the judge/sub-agent name when applicable (for batch-level phases where many judges run, use the batch label).

**Sub-step numbering:**

| Artifact | sub_step | sub_step_name   |
|----------|----------|-----------------|
| plan     | 0        | context_manager |
| plan     | 1–4      | batch_1 … batch_4 |
| plan     | 5        | aggregate       |
| plan     | 6        | validate        |
| code     | 0        | context_manager |
| code     | 1–3      | batch_1 … batch_3 |
| code     | 4        | aggregate       |
| code     | 5        | validate        |

**Start of phase (run Bash once at the beginning of each phase):** Set the two sub-step variables at the top for the current phase, then run the block. It writes start time to a temp file so the end-of-phase Bash can compute duration. `CLOSEDLOOP_PARENT_STEP` and `CLOSEDLOOP_PARENT_STEP_NAME` are already in the environment (set by run-loop on the `claude` invocation).

```bash
# Set these two values for the current phase:
SUB_STEP_NUM=0
SUB_STEP_LABEL="context_manager"   # context_manager | batch_1 … | aggregate | validate

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

1. Read `references/judge-input-contract.md` in full.
2. Apply the contract requirements when constructing `$CLOSEDLOOP_WORKDIR/judge-input.json`.
3. If the reference is missing/unreadable, fail fast with a clear error (do not proceed with judge execution).

### Prerequisites Check

**Performance:** At the start of this phase run the "start of phase" Bash with `SUB_STEP_NUM=0` and `SUB_STEP_LABEL=context_manager` for both plan and code modes. At the end of the phase run the "end of phase" Bash.

**Before starting, verify required inputs exist:**

**For plan artifacts (default):**
```bash
# Validate input files exist
if [ ! -f "$CLOSEDLOOP_WORKDIR/prd.md" ]; then
  echo "WARNING: $CLOSEDLOOP_WORKDIR/prd.md not found. Skipping judges."
  exit 0  # Graceful skip - do not fail workflow
fi

if [ ! -f "$CLOSEDLOOP_WORKDIR/plan.json" ]; then
  echo "WARNING: $CLOSEDLOOP_WORKDIR/plan.json not found. Skipping judges."
  exit 0
fi
```

**Investigation log resolution (plan mode):**

After validating `prd.md` and `plan.json`, resolve supporting context for plan judges:

1. **Use existing file first**
   - If `$CLOSEDLOOP_WORKDIR/investigation-log.md` exists, use it as-is.

2. **Check `@code:pre-explorer` availability before invoking**
   - Perform an explicit capability probe for `@code:pre-explorer` in the active Claude/plugin environment.
   - Treat "unknown agent", "agent not found", or plugin resolution errors as **pre-explorer unavailable**.
   - Recommended probe pattern:
     - Attempt a minimal `Task()` call targeting `@code:pre-explorer`.
     - If the platform rejects the agent type before execution, classify as unavailable and continue to internal fallback.

3. **If available, invoke pre-explorer**
   - Launch `@code:pre-explorer` with `WORKDIR=$CLOSEDLOOP_WORKDIR` to generate missing pre-exploration artifacts.
   - Re-check for `$CLOSEDLOOP_WORKDIR/investigation-log.md` after completion.

4. **If unavailable or invocation failed, run internal fallback**
   - Generate `investigation-log.md` with a lightweight local-only investigation.
   - Keep it fast and deterministic (no external web research).
   - Internal fallback should:
     - Read `prd.md` and extract top entities/actions as search seeds.
     - Run targeted `Glob`/`Grep` against the local repository for likely implementation files.
     - Record top relevant files and short rationale under `Files Discovered` / `Key Findings`.
     - Add requirement-to-code evidence links under `Requirements Mapping`.
   - Use the canonical sections:
     - `## Search Strategy`
     - `## Files Discovered`
     - `## Key Findings`
     - `## Requirements Mapping`
     - `## Uncertainties`

5. **Never block plan context preparation on investigation context**
   - If log generation still fails, emit a warning and continue.

6. **Prepare plan-context.json via context-manager-for-judges**
   - Launch `@judges:context-manager-for-judges` with `artifact_type=plan`.
   - Verify `$CLOSEDLOOP_WORKDIR/plan-context.json` exists.
   - If missing after invocation, log warning and activate **compatibility mode** for this run:
     - Compatibility mode allows one emergency fallback to raw `plan.json` + `prd.md`.
     - Use compatibility mode only when context generation fails.

7. **Plan-mode source-of-truth policy**
   - Normal mode: `plan-context.json` is primary and required.
   - Compatibility mode: `plan.json` + `prd.md` may be used for this run only.

8. **Build plan-mode `judge-input.json`**
   - Set `evaluation_type` = `plan`.
   - Set `task` to plan quality evaluation objective (13-plan-judge workflow).
   - Set `primary_artifact` to `plan-context.json` in normal mode.
   - In compatibility mode, set primary to `plan.json` and include `prd.md` as supporting.
   - Include `investigation-log.md` as supporting artifact when available.
   - Set `source_of_truth` ordering from primary to secondary artifacts.

**For code artifacts (--artifact-type code):**
```bash
# Resolve investigation context for code judges (best effort)
if [ ! -f "$CLOSEDLOOP_WORKDIR/investigation-log.md" ]; then
  echo "INFO: investigation-log.md missing. Attempting best-effort generation via @code:pre-explorer..."
  # Launch @code:pre-explorer with WORKDIR=$CLOSEDLOOP_WORKDIR
  # If unavailable/fails, continue with warning (non-blocking for code judges)
fi

# Launch context-manager-for-judges agent to prepare compressed context
# This agent reads code artifacts (git diff, changed-files.json, etc.)
# and produces code-context.json with token-budgeted compression

# investigation-log.md is optional secondary context for code judging
if [ ! -f "$CLOSEDLOOP_WORKDIR/investigation-log.md" ]; then
  echo "WARNING: investigation-log.md unavailable. Continuing code judges with code-context.json only."
fi

# Verify code-context.json exists after context manager completes
if [ ! -f "$CLOSEDLOOP_WORKDIR/code-context.json" ]; then
  echo "ERROR: Context preparation failed - code-context.json not found"
  # Abort with error CaseScore for all judges
  # Generate error report with final_status=3, justification="Context preparation failed"
  exit 1
fi

# Build code-mode judge-input.json
# - evaluation_type: "code"
# - task: code quality evaluation objective (11-code-judge workflow)
# - primary_artifact: code-context.json
# - supporting_artifacts: investigation-log.md (optional), plus any other run artifacts
# - source_of_truth: ["code_context", ...]
```

**If required files are missing:**
- Plan mode: Exit gracefully with code 0 (do not fail parent workflow)
- Code mode: Exit with error if context preparation fails

## Artifact Type Configuration

The run-judges skill supports two artifact types with different judge configurations:

### Plan Artifacts (Default)
- **Judges**: 13 total
- **Batches**: 4 sequential batches (max 4 concurrent per batch)
- **Output**: `judges.json`
- **Report ID**: `{RUN_ID}-judges`
- **Validation**: `--category plan` (13 judges expected)

### Code Artifacts (--artifact-type code)
- **Judges**: 11 total (excludes goal-alignment-judge, verbosity-judge)
- **Batches**: 3 sequential batches (max 4 concurrent per batch)
- **Output**: `code-judges.json`
- **Report ID**: `{RUN_ID}-code-judges`
- **Validation**: `--category code` (11 judges expected)

**Code Judge Batches:**

**Batch 1: Core Principles (4 judges)**
- `judges:dry-judge`
- `judges:ssot-judge`
- `judges:kiss-judge`
- `judges:code-organization-judge`

**Batch 2: Best Practices + SOLID Principles (4 judges)**
- `judges:custom-best-practices-judge`
- `judges:readability-judge`
- `judges:solid-isp-dip-judge`
- `judges:solid-liskov-substitution-judge`

**Batch 3: Technical Quality + Testing (3 judges)**
- `judges:solid-open-closed-judge`
- `judges:technical-accuracy-judge`
- `judges:test-judge`

---

### Step 1: Launch Judge Agents in Parallel

**Performance:** For each batch, run "start of phase" Bash before launching the batch and "end of phase" Bash after the batch completes. Plan: batch_1=sub_step 1, batch_2=sub_step 2, batch_3=sub_step 3, batch_4=sub_step 4. Code: batch_1=sub_step 1, batch_2=sub_step 2, batch_3=sub_step 3.

**Constraint:** The Task tool supports maximum 4 concurrent agents per batch.

**Action:** Launch judges in sequential batches based on artifact type.

<judge_batches>

### Plan Artifact Judge Batches (13 judges, 4 batches)

**Batch 1: Core Principles (DRY/SSOT/KISS + Organization)**

| Agent Type | Evaluates |
|------------|-----------|
| `judges:dry-judge` | Don't Repeat Yourself violations |
| `judges:ssot-judge` | Single Source of Truth violations |
| `judges:kiss-judge` | Keep It Simple violations |
| `judges:code-organization-judge` | File and folder structure organization |

**Batch 2: Best Practices + Response Quality**

| Agent Type | Evaluates |
|------------|-----------|
| `judges:custom-best-practices-judge` | Adherence to custom best practices documents |
| `judges:goal-alignment-judge` | Alignment with stated health goals |
| `judges:readability-judge` | Plan readability, clarity, structure, template adherence |
| `judges:verbosity-judge` | Verbosity calibration to problem complexity |

**Batch 3: SOLID Principles**

| Agent Type | Evaluates |
|------------|-----------|
| `judges:solid-isp-dip-judge` | Interface Segregation & Dependency Inversion Principles |
| `judges:solid-liskov-substitution-judge` | Liskov Substitution Principle adherence |
| `judges:solid-open-closed-judge` | Open/Closed Principle adherence |
| `judges:technical-accuracy-judge` | Technical accuracy (API usage, algorithms) |

**Batch 4: Testing**

| Agent Type | Evaluates |
|------------|-----------|
| `judges:test-judge` | Test coverage, assertions, structure, best practices |

</judge_batches>

<prompt_template>

### Preamble Injection

**Before invoking each judge, prepend the common and artifact-specific preambles:**

1. **Locate preamble files**:
   - `skills/artifact-type-tailored-context/preambles/common_input_preamble.md`
   - `skills/artifact-type-tailored-context/preambles/{artifact_type}_preamble.md`
   - Use Glob tool to find: `**/artifact-type-tailored-context/preambles/*.md`
   - Validate both files exist (fail with error CaseScore if either is missing)

2. **Read preamble content**:
   - Read `common_input_preamble.md`
   - Read `{artifact_type}_preamble.md`
   - Validate combined preamble size is reasonable for judge context (target: < 8000 characters)

3. **Concatenate**:
   - `common_input_preamble + "\n\n---\n\n" + artifact_preamble + "\n\n---\n\n" + judge_prompt`
   - `common_input_preamble.md` is the only runtime source of judge input-loading contract text; judge-specific agent files should not duplicate that contract.

4. **Pass to judge**: Use concatenated prompt as judge's full prompt

**If either preamble file is missing:**
- Generate error CaseScore with `final_status=3`, `justification="Preamble file not found: {path}"`
- Continue with other judges

### Prompt Templates

**For plan artifacts:**
```
WORKDIR=$CLOSEDLOOP_WORKDIR. Read $CLOSEDLOOP_WORKDIR/judge-input.json first.
Evaluate according to `task` and `source_of_truth` ordering.
Treat the envelope's `primary_artifact` as authoritative.
If `fallback_mode.active=true`, use fallback artifacts specified in the envelope.
```

**For code artifacts:**
```
WORKDIR=$CLOSEDLOOP_WORKDIR. Read $CLOSEDLOOP_WORKDIR/judge-input.json first.
Evaluate according to `task` and `source_of_truth` ordering.
Treat the envelope's `primary_artifact` as authoritative.
Apply your {judge_name} criteria to assess code quality.
```

</prompt_template>

---

### Expected Output Format

<expected_output>
Each judge returns a **CaseScore** JSON object:

```json
{
  "type": "case_score",
  "case_id": "dry-judge",
  "final_status": 1,
  "metrics": [
    {
      "metric_name": "dry_score",
      "threshold": 0.8,
      "score": 0.85,
      "justification": "Plan follows DRY principles..."
    }
  ]
}
```

**Status Code Semantics:**

| Code | Meaning | When to Use |
|------|---------|-------------|
| `1` | Pass | Score meets or exceeds threshold |
| `2` | Fail | Score below threshold |
| `3` | Error | Judge execution failed |

</expected_output>

---

### Error Handling Protocol

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
- Even if ALL 13 judges fail, you MUST aggregate error CaseScores
- Always produce a complete report with 13 CaseScore entries (plan) or 11 CaseScore entries (code)
- Never abort the workflow due to judge failures

</error_handling>

---

### Step 2: Aggregate Results into EvaluationReport

**Performance:** Run "start of phase" with sub_step 5 (plan) or 4 (code), sub_step_name=aggregate. Emit 'end of phase' after the aggregation step regardless of file write outcome.

**Task:** Collect all CaseScore outputs and structure them into an `EvaluationReport`.

<output_structure>

**Output file logic:**
```python
report_filename = 'code-judges.json' if artifact_type == 'code' else 'judges.json'
report_id = f'{RUN_ID}-code-judges' if artifact_type == 'code' else f'{RUN_ID}-judges'
output_path = $CLOSEDLOOP_WORKDIR / report_filename
```

**Plan artifact report structure (judges.json):**
```json
{
  "report_id": "{RUN_ID}-judges",
  "timestamp": "2024-02-03T15:45:30Z",
  "stats": [
    { /* CaseScore from dry-judge */ },
    { /* CaseScore from ssot-judge */ },
    { /* CaseScore from kiss-judge */ },
    { /* CaseScore from code-organization-judge */ },
    { /* CaseScore from custom-best-practices-judge */ },
    { /* CaseScore from goal-alignment-judge */ },
    { /* CaseScore from readability-judge */ },
    { /* CaseScore from verbosity-judge */ },
    { /* CaseScore from solid-isp-dip-judge */ },
    { /* CaseScore from solid-liskov-substitution-judge */ },
    { /* CaseScore from solid-open-closed-judge */ },
    { /* CaseScore from technical-accuracy-judge */ },
    { /* CaseScore from test-judge */ }
  ]
}
```

**Code artifact report structure (code-judges.json):**
```json
{
  "report_id": "{RUN_ID}-code-judges",
  "timestamp": "2024-02-03T15:45:30Z",
  "stats": [
    { /* CaseScore from dry-judge */ },
    { /* CaseScore from ssot-judge */ },
    { /* CaseScore from kiss-judge */ },
    { /* CaseScore from code-organization-judge */ },
    { /* CaseScore from custom-best-practices-judge */ },
    { /* CaseScore from readability-judge */ },
    { /* CaseScore from solid-isp-dip-judge */ },
    { /* CaseScore from solid-liskov-substitution-judge */ },
    { /* CaseScore from solid-open-closed-judge */ },
    { /* CaseScore from technical-accuracy-judge */ },
    { /* CaseScore from test-judge */ }
  ]
}
```

**Field requirements:**

| Field | Format | How to Derive |
|-------|--------|---------------|
| `report_id` | `{RUN_ID}-judges` or `{RUN_ID}-code-judges` | Extract RUN_ID from `$CLOSEDLOOP_WORKDIR` directory name, append suffix based on artifact type |
| `timestamp` | ISO 8601 | Generate with `date -u +%Y-%m-%dT%H:%M:%SZ` |
| `stats` | Array[CaseScore] | 13 CaseScore objects for plan, 11 for code (one per judge) |

</output_structure>

---

### Step 3: Validate Output (MANDATORY)

**Performance:** Run "start of phase" with sub_step 6 (plan) or 5 (code), sub_step_name=validate. Emit 'end of phase' after each validation attempt regardless of exit code, then apply failure recovery logic.

**CRITICAL:** You MUST run the validation script after writing `judges.json`. Do not consider the task complete until validation passes.

<validation_workflow>

**Step 3.1: Locate the Validation Script**

The script is in this skill's `scripts/` directory:

```bash
SCRIPT_PATH="scripts/validate_judge_report.py"
```

**Step 3.2: Ensure uv is Installed**

```bash
if ! command -v uv &> /dev/null; then
  # Install uv — alternatives: brew install uv, pip install uv
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
```

**Step 3.3: Run Validation**

```bash
# CRITICAL: Run from script's directory so uv can find inline dependencies
cd "$(dirname "$SCRIPT_PATH")"

# Determine category based on artifact type
CATEGORY="plan"  # default
if [ "$ARTIFACT_TYPE" = "code" ]; then
  CATEGORY="code"
fi

# Run validation with appropriate category
uv run "$SCRIPT_PATH" --workdir "$CLOSEDLOOP_WORKDIR" --category "$CATEGORY"
```

**Argument requirements:**
- `--workdir` must be the **absolute path** to `$CLOSEDLOOP_WORKDIR`
- `--category` must be `plan` (13 judges) or `code` (11 judges)
- This is where `judges.json` or `code-judges.json` is located

</validation_workflow>

---

### Validation Checks

<validation_checks>

The script validates using strict Pydantic models:

| Check | Requirement |
|-------|-------------|
| **JSON syntax** | Valid JSON format |
| **Required fields** | report_id, timestamp, stats array |
| **Judge coverage** | All expected judges present (13 for plan, 11 for code) |
| **Status values** | final_status ∈ {1, 2, 3} |
| **Metric completeness** | Each judge has ≥1 metric |
| **Report ID format** | Ends with '-judges' (plan) or '-code-judges' (code) |

**Expected judge case_ids for plan artifacts (13 total):**
```
code-organization-judge
custom-best-practices-judge
dry-judge
goal-alignment-judge
kiss-judge
readability-judge
solid-isp-dip-judge
solid-liskov-substitution-judge
solid-open-closed-judge
ssot-judge
technical-accuracy-judge
test-judge
verbosity-judge
```

**Expected judge case_ids for code artifacts (11 total):**
```
code-organization-judge
custom-best-practices-judge
dry-judge
kiss-judge
readability-judge
solid-isp-dip-judge
solid-liskov-substitution-judge
solid-open-closed-judge
ssot-judge
technical-accuracy-judge
test-judge
```

**Note:** Code artifacts exclude: goal-alignment-judge, verbosity-judge

</validation_checks>

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

## Reference: Pydantic Models

<pydantic_schema>

The validation script uses these strict Pydantic models:

```python
class MetricStatistics(BaseModel):
    """A single metric evaluation result."""
    metric_name: str
    threshold: Optional[float] = None
    score: float
    justification: str

class CaseScore(BaseModel):
    """Score for a single judge evaluation."""
    type: Optional[str] = "case_score"
    case_id: str
    final_status: int  # 1=pass, 2=fail, 3=error
    metrics: List[MetricStatistics]

class EvaluationReport(BaseModel):
    """Top-level report containing all judge evaluations."""
    report_id: str
    timestamp: str
    stats: List[CaseScore]
```

**Model constraints:**
- `ConfigDict(strict=True)` enforces exact type matching
- `final_status` validator rejects values outside {1, 2, 3}

</pydantic_schema>

---

## Success Checklist

<completion_criteria>

Before marking this task complete, verify:

**For plan artifacts (default):**
- [ ] **Input validation** - prd.md and plan.json exist (or graceful skip)
- [ ] **Context preparation** - context-manager-for-judges launched with `artifact_type=plan`
- [ ] **Plan context validation** - `plan-context.json` exists, or compatibility mode explicitly activated
- [ ] **Judge input contract** - `judge-input.json` exists with required fields
- [ ] **Investigation context resolution** - `investigation-log.md` reused, generated via pre-explorer, or best-effort generated internally
- [ ] **Parallel execution** - All 13 judges launched in 4 batches (max 4 per batch)
- [ ] **Result aggregation** - Valid EvaluationReport with 13 CaseScore entries
- [ ] **File output** - `judges.json` written to `$CLOSEDLOOP_WORKDIR`
- [ ] **Validation passed** - Script exits with code 0 using `--category plan`

**For code artifacts (--artifact-type code):**
- [ ] **Context preparation** - context-manager-for-judges agent launched successfully
- [ ] **Context validation** - code-context.json exists at `$CLOSEDLOOP_WORKDIR`
- [ ] **Judge input contract** - `judge-input.json` exists with required fields
- [ ] **Investigation context resolution** - `investigation-log.md` reused or generated best-effort; missing file does not block code judging
- [ ] **Preamble injection** - common_input_preamble.md + code_preamble.md prepended to all judge prompts
- [ ] **Parallel execution** - All 11 judges launched in 3 batches (max 4 per batch)
- [ ] **Result aggregation** - Valid EvaluationReport with 11 CaseScore entries
- [ ] **File output** - `code-judges.json` written to `$CLOSEDLOOP_WORKDIR`
- [ ] **Report ID format** - report_id ends with '-code-judges'
- [ ] **Validation passed** - Script exits with code 0 using `--category code`

</completion_criteria>

---

## Troubleshooting Guide

<troubleshooting>

| Error Message | Root Cause | Solution |
|---------------|------------|----------|
| "Report file does not exist" | File not written to correct location | Verify `$CLOSEDLOOP_WORKDIR` is set; check write path matches artifact type (judges.json or code-judges.json) |
| "Invalid JSON" | Syntax error in output file | Run `python3 -m json.tool "$CLOSEDLOOP_WORKDIR/[code-]judges.json"` to identify syntax error |
| "Missing expected judges" | Incomplete batch execution | Verify all batches launched (4 for plan, 3 for code); check error CaseScores for failures; plan expects 13 judges, code expects 11 |
| "final_status must be 1, 2, or 3" | Invalid status code | Use only: 1 (pass), 2 (fail), 3 (error) |
| "report_id should end with '-judges'" | Incorrect ID format for plan | Use pattern: `{RUN_ID}-judges` for plan artifacts |
| "report_id should end with '-code-judges'" | Incorrect ID format for code | Use pattern: `{RUN_ID}-code-judges` for code artifacts |
| "Judge {name} has no metrics" | Empty metrics array | Each CaseScore must have ≥1 MetricStatistics entry |
| "Context preparation failed" | context-manager-for-judges failed | Check context-manager agent output; verify artifact files exist |
| "judge-input.json missing" | Orchestrator did not generate envelope | Build `$CLOSEDLOOP_WORKDIR/judge-input.json` before launching judges |
| "judge-input schema invalid" | Missing required envelope fields | Ensure required fields: `evaluation_type`, `task`, `primary_artifact`, `supporting_artifacts`, `source_of_truth`, `fallback_mode`, `metadata` |
| "plan-context.json not found" | plan context manager did not produce output | Run `@judges:context-manager-for-judges` with `artifact_type=plan`; if still missing, activate one-run compatibility fallback to `plan.json` + `prd.md` |
| "Preamble file not found" | Missing common or artifact preamble .md file | Verify both `skills/artifact-type-tailored-context/preambles/common_input_preamble.md` and `skills/artifact-type-tailored-context/preambles/{artifact_type}_preamble.md` exist |
| "pre-explorer unavailable" | `@code:pre-explorer` not installed/resolvable | Log warning and use internal fallback investigation to create `investigation-log.md` |
| "investigation-log.md missing after fallback" | Both pre-explorer and internal fallback failed | Log warning and continue; do not block context preparation |
| "investigation-log.md missing in code mode" | pre-explorer unavailable or generation failed during code preflight | Log warning and continue with `code-context.json` only (non-blocking) |
| "Invalid --artifact-type value" | Unsupported artifact type | Use only 'plan' or 'code' |

</troubleshooting>

---

## Error Handling Requirements

### Invalid Artifact Type

If `--artifact-type` value is not 'plan' or 'code':
- Fail immediately with clear error message
- Do not attempt judge execution
- Exit with non-zero status

### Context Manager Timeout (Code Mode)

If context-manager-for-judges agent exceeds 5 minutes:
- Abort judge execution
- Generate error CaseScores for all 11 judges
- Each error CaseScore: `final_status=3`, `justification="Context preparation timeout"`
- Write complete report with all error CaseScores

### Context Manager Timeout (Plan Mode)

If context-manager-for-judges agent exceeds 5 minutes in plan mode:
- Attempt one emergency compatibility fallback to raw `plan.json` + `prd.md`
- If fallback files are unavailable, abort plan judge execution and emit clear error

### Individual Judge Failures

If a single judge Task call fails during execution:
- **Do not abort** the entire workflow
- Generate error CaseScore for that judge only
- Continue with remaining judges in batch and subsequent batches
- Include error CaseScore in final aggregated report

### Plan Mode Execution Flow

When `--artifact-type` is not specified or equals 'plan':
- Execute standard 13-judge plan logic
- Launch 4 batches with existing judge assignments
- Write to `judges.json` (not `code-judges.json`)
- Launch context-manager-for-judges for plan context preparation
- Use `plan-context.json` as primary input; use one-run compatibility fallback only if context preparation fails
- Build and pass `judge-input.json` envelope to judges
- Prepend preambles to judge prompts
- Use default validation with `--category plan`

This ensures existing workflows and orchestrators continue to function without modification.

---
