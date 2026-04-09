---
name: fix
description: Verify and fix code review findings, then run project verification. Use this skill whenever the user wants to address, fix, or remediate code review findings after running /code-review:start, when there are BLOCKING or HIGH severity issues to resolve, or when the user says things like "fix the review comments", "address the findings", or "remediate code review issues". Only applies when a prior code review session directory exists. Accepts a review session directory path and optional --max-cycles flag.
---

# Fix Code Review Findings

Verify and remediate BLOCKING and HIGH severity findings from a prior `/code-review:start` run, then run project verification (test, lint, typecheck, build). Caps at a configurable number of review-fix cycles to prevent infinite loops.

## Usage

```
/code-review:fix .closedloop-ai/code-review/cr-abc123
/code-review:fix .closedloop-ai/code-review/cr-abc123 --max-cycles 1
```

**Finding the session directory:** The most recent review session is the latest `cr-*` directory under `.closedloop-ai/code-review/`:
```bash
ls -td .closedloop-ai/code-review/cr-* | head -1
```

---

## Step 1: Parse Arguments and Load Findings

Parse `$ARGUMENTS` to extract:
- **CR_DIR** (required positional): Path to the code-review session directory
- **--max-cycles N** (optional, default: 2): Maximum review-fix cycles. Initialize `CYCLE = 1`.

Validation:
- If CR_DIR is missing: auto-discover by running `ls -td .closedloop-ai/code-review/cr-* | head -1`. If no session directories exist, print error "No code review session found. Run /code-review:start first." and exit
- If `<CR_DIR>/validate_output.json` does not exist: print error "No validate_output.json found in <CR_DIR>. Run /code-review:start first." and exit

### Load Findings

- Read `<CR_DIR>/validate_output.json`
- Extract the `validated` array
- Filter to findings where `severity` is `BLOCKING` or `HIGH`
- Count and log MEDIUM/LOW findings that will be skipped
- If no BLOCKING/HIGH findings: print "No actionable findings (BLOCKING/HIGH). Review complete." and mark all todos completed and exit

### Create Todo List

```json
TodoWrite([
  {"content": "Parse arguments and load findings", "status": "completed", "activeForm": "Parsing arguments"},
  {"content": "Verify findings", "status": "pending", "activeForm": "Verifying findings"},
  {"content": "Fix confirmed findings", "status": "pending", "activeForm": "Fixing findings"},
  {"content": "Run project verification", "status": "pending", "activeForm": "Running verification"},
  {"content": "Re-review", "status": "pending", "activeForm": "Re-reviewing"},
  {"content": "Print summary", "status": "pending", "activeForm": "Printing summary"}
])
```

---

## Step 2: Verify Each Finding

For each BLOCKING/HIGH finding, launch a verification subagent to determine if it is a real bug or a false positive.

For each finding, launch a Task with `model: sonnet` and tools `Read, Grep, Glob`:

**Prompt template** (inline all values -- no shell variables):
```
Determine if this code review finding is a real bug or a false positive.

**Finding:**
- File: <file>
- Line: <line>
- Severity: <severity>
- Category: <category>
- Issue: <issue>
- Explanation: <explanation>
- Code snippet: <code_snippet>
- Recommendation: <recommendation>

Read the cited file and 50 lines of surrounding context. Check for error handling, type guards, intentional patterns, or inline justifications that would make this a false positive. Verify the issue actually exists at the cited line.

Output exactly one of:
CONFIRMED: <brief reasoning why this is a real bug>
REJECTED: <brief reasoning why this is a false positive>
```

Launch all verification agents **in parallel** (multiple Task calls in a single message).

### Collect Results

- Parse each agent's response for `CONFIRMED` or `REJECTED`
- Filter to only CONFIRMED findings
- If no confirmed findings remain: print "All findings were false positives. No fixes needed." and mark remaining todos as completed and exit

---

## Step 3: Fix Confirmed Findings

Group related confirmed findings by file. Findings in the same file should be fixed together.

Fix each finding **one at a time, sequentially** -- do NOT launch fix agents in parallel. Separate findings may affect the same source files, so each fix must see the results of prior fixes to avoid conflicts.

For each finding or group, launch a Task with `model: sonnet` and tools `Read, Write, Edit, Grep, Glob`:

**Prompt template** (inline all values -- no shell variables):
```
Fix this code review finding. Apply the minimal change needed -- do NOT refactor surrounding code, add new features, or add unnecessary error handling.

**Finding:**
- File: <file>
- Line: <line>
- Issue: <issue>
- Explanation: <explanation>
- Recommendation: <recommendation>

Read the file, apply the fix, and confirm what you changed.
```

Wait for each fix agent to complete before launching the next one. Track the list of modified files for re-review in Step 5.

---

## Step 4: Run Project Verification

Launch a Task with `subagent_type: "code:build-validator"`:

```
Run all validation commands (test, lint, typecheck, build) for this project. Report VALIDATION_PASSED, VALIDATION_FAILED, or NO_VALIDATION.
```

- **VALIDATION_PASSED** or **NO_VALIDATION**: Proceed to Step 5
- **VALIDATION_FAILED**: Delegate fix to a Sonnet subagent and retry the validator, up to 5 attempts total. Log a warning and proceed on persistent failure.

---

## Step 5: Re-review (Conditional)

- If `CYCLE >= MAX_CYCLES`: log any remaining concerns as warnings, proceed to Step 6
- If `CYCLE < MAX_CYCLES` AND fixes were applied in Step 3:
  - Increment `CYCLE`
  - Invoke the code review on only the modified files using the Skill tool: `Skill(skill="code-review:start", args="<file1> <file2> ...")`
  - Find the new session directory (`ls -td .closedloop-ai/code-review/cr-* | head -1`) and read its `validate_output.json`
  - If new BLOCKING/HIGH findings exist: loop back to Step 2 with the new findings
  - If clean: proceed to Step 6

---

## Step 6: Summary

Print a structured summary of the fix session:

```markdown
## Fix Summary

| Metric | Value |
|--------|-------|
| Findings received | N |
| Confirmed (not false positive) | N |
| Fixed | N |
| Remaining (warnings) | N |
| Verification | PASSED/FAILED/NO_VALIDATION |
| Cycles used | N of MAX |
```

Mark all todos as `completed`.

---

$ARGUMENTS
