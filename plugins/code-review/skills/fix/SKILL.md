---
name: fix
description: Verify and fix BLOCKING/HIGH code review findings from a prior review session, then run project verification.
argument-hint: "<cr-dir>"
---

# Fix Code Review Findings

Single verify-and-fix pass for BLOCKING/HIGH findings from a prior code review. The caller controls re-review cycles.

## Arguments

$ARGUMENTS

---

## Step 1: Parse Arguments and Load Findings

```json
TodoWrite([
  {"content": "Parse arguments and load findings", "status": "in_progress", "activeForm": "Parsing arguments"},
  {"content": "Verify findings", "status": "pending", "activeForm": "Verifying findings"},
  {"content": "Fix confirmed findings", "status": "pending", "activeForm": "Fixing findings"},
  {"content": "Run project verification", "status": "pending", "activeForm": "Running verification"},
  {"content": "Print summary", "status": "pending", "activeForm": "Printing summary"}
])
```

Extract **CR_DIR** (positional) from `$ARGUMENTS`.

<constraints>
- CR_DIR missing: auto-discover via `ls -td .closedloop-ai/code-review/cr-* | head -1`. No directories found → error "No code review session found. Run a code review first." → exit.
- `CR_DIR/validate_output.json` missing → error "No validate_output.json found in CR_DIR. Run a code review first." → exit.
</constraints>

### Load Findings

Read `CR_DIR/validate_output.json`. Each entry in the `validated` array:
```json
{"file": "path/to/file.ts", "line": 42, "severity": "HIGH", "category": "Correctness", "issue": "[P1] Brief title", "explanation": "...", "recommendation": "...", "code_snippet": "...", "priority": 1, "confidence": 0.9}
```

Filter to `severity` = `"BLOCKING"` or `"HIGH"`. Log skipped MEDIUM count.
No BLOCKING/HIGH findings → print "No actionable findings. Review complete." → mark all todos completed → exit.

---

## Step 2: Verify Each Finding

For each BLOCKING/HIGH finding, launch an `Agent` tool call with `subagent_type: "general-purpose"`, `model: "sonnet"`. Inline all finding values — no shell variables.

Launch all verification agents **in parallel** (multiple Agent tool calls in a single message).

**Prompt template:**

```
<context>
Verify whether this code review finding is a real bug or a false positive.
File: {file} | Line: {line} | Severity: {severity} | Category: {category}
Issue: {issue}
Explanation: {explanation}
Code snippet: {code_snippet}
Recommendation: {recommendation}
</context>

<instructions>
Read the cited file and 50 lines of surrounding context. Reason through:
1. PREMISE: What is this code supposed to do? (cite function/context)
2. EVIDENCE: What concrete evidence proves or disproves the issue? (trace execution path, cite file:line)
3. GUARD CHECK: Is there error handling or upstream logic that prevents this? (cite search result or "verified none exists at file:line")
4. VERDICT: Real bug or false positive?

If analysis concludes the issue is NOT a problem, verdict MUST be REJECTED.
</instructions>

<examples>
CONFIRMED — proven bug:
Input flows from req.body (line 12) → processData (line 30) → SQL query (line 47) with no escaping. Searched for sanitize/escape calls — none exist.
{"verdict": "CONFIRMED", "reasoning": "Unsanitized user input flows directly into SQL query at line 47 with no upstream validation."}

REJECTED — false positive:
Flagged null dereference at line 85, but variable is guarded by type check at line 78 (if (x !== null)) covering all paths to line 85.
{"verdict": "REJECTED", "reasoning": "Null dereference prevented by type guard at line 78 covering all paths to line 85."}
</examples>

<output_format>
Output ONLY: {"verdict": "CONFIRMED"|"REJECTED", "reasoning": "...citing specific evidence..."}
</output_format>
```

### Collect Results

Parse each response for `verdict` field. Keep only `"CONFIRMED"` findings.
No confirmed findings → print "All findings were false positives. No fixes needed." → mark todos completed → exit.

---

## Step 3: Fix Confirmed Findings

Group confirmed findings by file. Fix **sequentially** (one agent at a time) — findings may share source files, so each fix must see prior results.

For each finding/group, launch `Agent` with `subagent_type: "general-purpose"`, `model: "sonnet"`:

```
Fix this code review finding. Minimal change only — no refactoring, no new features, no unnecessary error handling.
File: {file} | Line: {line}
Issue: {issue}
Explanation: {explanation}
Recommendation: {recommendation}

Read the file, apply the fix, confirm what changed.
```

Track modified files for Step 5 summary.

---

## Step 4: Run Project Verification

Launch `Agent` with `subagent_type: "code:build-validator"`:

```
Run all validation commands (test, lint, typecheck, build). Report VALIDATION_PASSED, VALIDATION_FAILED, or NO_VALIDATION.
```

Do NOT run validation commands directly — the `build-validator` discovers and runs them.

- **PASSED** or **NO_VALIDATION** → proceed to Step 5
- **FAILED** → launch `general-purpose` subagent (`model: "sonnet"`) to fix, re-run `build-validator`. Max 5 attempts. Warn and proceed on persistent failure.

---

## Step 5: Summary

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
| Modified files | file1, file2, ... |
```

Mark all todos as `completed`.
