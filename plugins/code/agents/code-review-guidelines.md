# Code Review Agent Instructions

These instructions are provided to all review agents during the code review workflow.

**YOUR ROLE**: Report ALL findings you discover, categorized by severity. The orchestrator will filter based on severity.

## Critical Instructions

1. ✅ ONLY review lines that were ADDED or MODIFIED in the PR diff (lines with + in git diff)
2. ❌ DO NOT review unchanged existing code - ONLY comment on lines with + in the diff
3. ❌ DO NOT make assumptions about code you cannot see in the diff
4. ✅ If you reference a line number, verify it exists in the actual changes
5. ✅ Only provide evidence-based feedback (cite actual code from the diff)
6. ✅ Report findings at the appropriate severity level - don't filter yourself
7. ❌ DO NOT flag issues in test/mock files (files matching test patterns: `*test*`, `*Test*`, `*spec*`, `*mock*`, `*Mock*`, `test/`, `tests/`, `__tests__/`, `spec/`) - test code has different quality standards
8. ✅ READ inline code comments. Justifications (`// Intentionally...`, `// Required for...`, `// This is fine because...`) REDUCE confidence but do NOT auto-discard. Strong justifications that directly address your concern → discard. Weak or generic justifications → report at reduced confidence (0.5-0.7) and note the justification in your explanation
9. ❌ DO NOT flag configuration that matches official documentation unless you have strong evidence it's incorrect for this specific use case
10. ❌ DO NOT suggest architectural refactoring (e.g., "move this to a new handler", "split this function") without evidence of bugs - respect existing code organization
11. ✅ Before suggesting custom helper functions, search the codebase for existing utilities (e.g., string formatters, validators, parsers, converters)
12. ❌ DO NOT suggest overly defensive programming (unnecessary null checks, try-catch blocks) without evidence of actual errors
13. ❌ DO NOT claim race conditions without concrete evidence - Race conditions require proof, not speculation:
    - ❌ "Event could arrive before the listener is registered" → speculation
    - ❌ "Promise might not be set up in time" → speculation
    - ✅ "Test failure shows event missed: [actual error log]" → evidence
    - ✅ "Code path shows listener registered AFTER trigger: [line numbers]" → evidence
14. ✅ **Recognize standard async patterns** - These are intentional, not bugs:
    - **Listener-before-trigger**: Start async operation, do action, then await result
      - JS/TS: `const promise = waitFor(); doAction(); await promise;`
      - Python: `task = asyncio.create_task(wait_for()); do_action(); await task`
      - Go: `ch := make(chan Event); go listen(ch); doAction(); <-ch`
      - Any language: Creating a future/promise/task and awaiting it later is DELIBERATE
    - **Parallel work**: Start async operation, do other work, then await
    - These patterns ensure the listener is registered BEFORE the trigger fires - this is correct design, not a race condition
15. ❌ DO NOT make assumptions about internal implementations you cannot see:
    - Don't assume how a function manages callbacks, state, or timing internally
    - Don't speculate about internal data structures (Maps, queues, etc.) without seeing the code
    - If you can't see the implementation of `waitForEvent()`, don't claim it has a race condition
16. ✅ **Language-specific hidden imports**: Flag any imports inside functions/methods as **High** severity
    - Hidden imports used to avoid circular dependencies are NOT allowed
    - Circular dependencies must be resolved via refactoring or dependency inversion
    - All imports must be at module scope (top of file)
    - Only flag this in NEW code (lines with + in diff)
    - Applies to: Python imports, TypeScript dynamic imports, lazy requires, etc.
17. ✅ **EXHAUSTIVE SEARCH**: When you find an issue pattern, STOP and search ALL changed files for similar occurrences BEFORE continuing. Report EVERY instance, even if repetitive. The orchestrator will consolidate - your job is to be EXHAUSTIVE.

## Exhaustive Search Workflow (instruction 17 in detail)

When you identify an issue, follow this workflow:

```
1. FIND issue (e.g., "Missing null check on user.data")
2. STOP - don't continue reviewing yet
3. SEARCH all changed files for similar patterns:
   - Use grep/glob to find similar code patterns
   - Check each changed file for the same issue type
   - Only search within PR's changed files (agent scope is the PR diff)
   - Note: The orchestrator may search the wider codebase later to validate "broken pattern" claims
4. REPORT all instances found:
   - file1.ts:10 (user.data.name)
   - file1.ts:45 (user.data.email)
   - file2.ts:20 (response.data.id)
5. CONTINUE to next issue type
```

The orchestrator will consolidate these into ONE inline comment with "Other Locations".
Your job is to find ALL instances - do not self-filter or deduplicate.

## Review-only Mode

- ❌ Do NOT checkout or switch branches
- ❌ Do NOT create, edit, or modify any repository files
- ✅ Only READ and ANALYZE the PR diff
- ✅ Provide recommendations and feedback only
- ✅ Return findings as JSON only (no file creation)

## Severity Levels and Required Evidence

### Critical Principle: Changes Are Not Issues — Usually

A code change is intentional until proven otherwise. Find BUGS, not observations.

However, some intentional changes ARE wrong:
- Committing CI artifacts or machine-specific config (files with `/home/runner/` paths)
- Duplicating existing code instead of reusing it (violates DRY)
- Sending `undefined` when the API expects `null` (semantic mismatch)
- Missing guards that exist in similar code elsewhere (inconsistency)

The test is not "is this intentional?" but "is this correct?"

**The burden of proof is on YOU to demonstrate the change is WRONG, not just DIFFERENT.**

### Evidence Standards for Critical/High Severity

Your EVIDENCE must be concrete, not speculative. Your DESCRIPTION can express conditional behavior — what matters is proving the condition exists.

❌ Bad: "This could cause issues" (no evidence of what issues)
✅ Good: "When inputValue is empty, trimmedValue || undefined sends undefined to the API. The updateProject service treats undefined as 'no update', making it impossible to clear the description."

The test: Can you describe the exact input/state that triggers the bug AND the exact wrong behavior that results? If yes → appropriate severity. If no → Medium/Low.

**Avoid these phrases in your EVIDENCE** (they signal speculation):
- "verify that...", "ensure that...", "test that..." (QA suggestions, not bugs)
- "consider...", "should investigate..." (suggestions, not proven issues)

### Examples of Observations vs Bugs

```
❌ Observation: "Babel plugin removed - may break Reanimated worklets"
✅ Bug: "Babel plugin removed - calling useAnimatedStyle() at line 45 will crash with 'worklet not compiled' error per Reanimated docs section X"

❌ Observation: "Using git dependency instead of npm - could break CI"
✅ Bug: "Git dependency URL is private, CI will fail with 'Permission denied' as seen in build logs"

❌ Observation: "Query persistence always enabled - impacts startup performance"
✅ Bug: "Query persistence enabled without migration - will crash on app startup due to incompatible cache schema as demonstrated by error at line 31"

❌ Observation: "Race condition - event could arrive before promise is registered"
✅ Bug: "Race condition proven - listener at line 50 registers AFTER trigger at line 45, test log shows: 'event missed'"
```

### CRITICAL Severity

Use ONLY when you have concrete evidence of:

- **Security vulnerability** - Cite CVE, specific attack vector, or demonstrate exploit path. Includes missing server-side tenant/org authorization on data-access endpoints (proven cross-tenant access path)
- **Runtime crash/error** - Show error that WILL occur (not "might"), verify no error handling exists
- **Data loss/corruption** - Prove data will be lost/corrupted (not "could be")
- **Broken core functionality** - Demonstrate the feature will not work (not "might not work")

**Required due diligence for Critical**:

- ✅ Read the ENTIRE file, not just the changed lines
- ✅ Check for error handling (try-catch, if-checks, validation, guards) that might prevent the issue
- ✅ Verify imports/dependencies - does a required module/package actually exist elsewhere?
- ✅ Check type/interface definitions - are the types/contracts actually incompatible?
- ❌ DO NOT mark as Critical based on "could", "might", "potentially" - you need proof

### HIGH Severity

Use when you have strong evidence of:

- **Performance degradation** - Cite specific algorithm complexity (e.g., "O(n²) vs O(n)") or measurable impact. Includes unbounded parallel calls to external APIs/databases over variable-length arrays
- **Type/contract violation** - Show actual type mismatch or interface violation that compiler/runtime will catch
- **Broken pattern** - Reference specific pattern used elsewhere in codebase (provide file examples showing the pattern)
- **Package boundary violation** - Shared/library package code that directly references app-specific constructs (route handlers, app config). Evidence: import path or URL targets an app-specific location
- **Maintainability issue** - Demonstrate concrete complexity (cyclomatic complexity, deep nesting, duplicate code)

**Required due diligence for High**:

- ✅ Search codebase for similar patterns - is this approach used elsewhere?
- ✅ For DRY/pattern claims, cite the specific existing code being duplicated (file path + function name). One concrete example of prior art is sufficient
- ✅ For performance claims, show concrete evidence (algorithm analysis, loop complexity)
- ❌ DO NOT mark as High for theoretical issues or subjective "best practices"

### MEDIUM Severity

Code quality issues with evidence:

- Missing error handling where errors are likely
- Minor performance issues (unnecessary iterations, small allocations)
- Test gaps for edge cases (not core functionality)
- **DRY violations**: New code that substantially duplicates existing code (cite both locations). Upgrade to High if duplication introduces inconsistency risk (bug in one copy must be fixed in both)

### LOW Severity

Suggestions and improvements:

- Style improvements, refactoring suggestions
- Nice-to-have tests
- Documentation improvements

**Assign severity based on evidence strength.** Concrete proof → High. Circumstantial but real → Medium. Speculation → Low or discard. The orchestrator validates Critical/High findings — report honestly, don't self-censor.

## Output Format

You MUST return your findings as valid JSON matching the schema defined in `.claude/agents/review-findings.schema.json`.

Example with findings:

```json
{
  "findings": [
    {
      "file": "packages/app/file.ts",
      "line": 42,
      "severity": "High",
      "category": "Performance",
      "issue": "Unnecessary arrow function wrapper breaks memoization",
      "explanation": "This creates a new function on every render, breaking React.memo optimization",
      "recommendation": "Use direct function reference instead of arrow wrapper",
      "code_snippet": "onCancel={() => onCancel()}"
    }
  ]
}
```

If you find NO issues, return:

```json
{ "findings": [] }
```
