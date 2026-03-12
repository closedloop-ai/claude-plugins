---
name: plan-validate
description: |
  Deterministic plan.json validation via Python script, replacing most plan-validator agent calls.
  Performs JSON parsing, schema validation, task checkbox regex, required section checks, sync validation,
  and data extraction. Only semantic consistency checks (storage/query alignment) require the LLM agent.
  Triggers on: plan validation, checking plan format, extracting plan data.
  Returns PLAN_VALID with extracted data or PLAN_FORMAT_ISSUES with issues list.
context: fork
allowed-tools: Bash
---

# Plan Validate

Deterministic plan.json validation that replaces the plan-validator Sonnet agent for all structural checks. The semantic consistency check (storage/query alignment, task/architecture contradictions) still requires the LLM agent and should be run separately when needed.

## When to Use

Activate this skill **instead of** launching `@code:plan-validator` at every plan validation site. The orchestrator should only launch the full plan-validator agent for semantic-only checks after plan creation or modification phases.

## Usage

```bash
python3 scripts/validate_plan.py <WORKDIR>
```

## Interpreting Output

The script prints JSON to stdout matching the exact plan-validator output format.

### Plan Valid (PLAN_VALID)

```json
{
  "status": "VALID",
  "issues": [],
  "has_unanswered_questions": false,
  "unanswered_questions": [],
  "has_answered_questions": false,
  "answered_questions": [],
  "has_addressed_gaps": false,
  "addressed_gaps": [],
  "pending_tasks": [{"id": "T-1.1", "description": "...", "acceptanceCriteria": ["AC-001"]}],
  "completed_tasks": [],
  "manual_tasks": []
}
```

**Action:** Parse the extracted data fields. Use `pending_tasks`, `completed_tasks`, etc. as if the plan-validator agent returned them.

### Plan Format Issues (PLAN_FORMAT_ISSUES)

```json
{
  "status": "FORMAT_ISSUES",
  "issues": ["Missing required field: openQuestions", "Task missing checkbox in content: '- **T-1.2**: ...'"],
  ...
}
```

**Action:** Handle the same way as plan-validator `FORMAT_ISSUES` — launch fix subagents as appropriate.

### Other Statuses

- `EMPTY_FILE`: plan.json doesn't exist or is empty
- `INVALID_JSON`: plan.json contains malformed JSON

## What This Script Validates

1. **JSON parsing** — file exists, is valid JSON, root is an object
2. **Schema fields** — required top-level fields present with correct types, ID pattern validation
3. **Task checkboxes** — every `**T-X.Y**` line has `- [ ]` or `- [x]` prefix
4. **Required sections** — all 10 required `##` headers present in content
5. **Sync validation** — pendingTasks/completedTasks/manualTasks/openQuestions/answeredQuestions arrays match markdown content lines

## What Still Requires the LLM Agent

**Semantic consistency validation** (Step 6 in plan-validator):
- Cross-referencing storage definitions with query operations
- Verifying tasks don't contradict Architecture Decisions table
- Checking data flow consistency

Only run the plan-validator agent with semantic-only focus after phases that modify the plan content (Phase 1 creation, Phase 2.6 critic merge, Phase 2.7 finalization).

## Resources

### scripts/

- `validate_plan.py` - Deterministic plan.json validation script
