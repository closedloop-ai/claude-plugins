---
name: implementation-self-check
description: |
  Shared four-gate verification workflow for write-capable implementation agents.
  Use after editing files for a NOT_IMPLEMENTED task or when an agent prompt says to proceed to a self-verification gate.
  Re-reads changed files, produces PASS/FAIL evidence for each missing requirement, runs caller-specific integration and static-analysis checks, and only allows IMPLEMENTATION_VERIFIED output when every gate passes.
---

# Implementation Self Check

Shared verification protocol for implementation-mode agents. This skill replaces duplicated inline gate text across multiple agent definitions while preserving agent-specific Gate 3 and Gate 4 checks in the caller.

## When to Use

Activate this skill immediately after finishing implementation work, before returning `IMPLEMENTATION_VERIFIED` or `BLOCKED`.

## Standard Four-Gate Protocol

### Gate 1: Re-read Modified Files

Re-read every file created or modified during the session in full. Do not rely on memory of prior edits.

### Gate 2: Requirement Verification

For every item in the orchestrator-provided `NOT_IMPLEMENTED` list, produce explicit `PASS` or `FAIL` evidence with `file:line` references:

```text
VERIFICATION:
- "requirement description" → PASS (path/to/file.py:42 - evidence)
- "another requirement" → FAIL (not found)
```

If any requirement fails, fix the issue before continuing.

### Gate 3: Integration Check

Run the caller's agent-specific integration checks. These checks stay in the agent definition because they differ by domain.

### Gate 4: Static Analysis

Run the caller's agent-specific static-analysis or syntax checks. Fix any issues introduced by the implementation before returning.

## Completion Rules

- Do not emit `IMPLEMENTATION_VERIFIED` until all four gates pass.
- If blocked, return the blocker details using the standard blocked format below.
- If a gate fails, fix the issue and re-run the failed gates before returning.

## Return Format

### Success

```text
IMPLEMENTATION_VERIFIED:
- [path/to/file]: [brief description of changes]

VERIFICATION:
- "requirement 1" → PASS (path/to/file:line - evidence)
- "requirement 2" → PASS (path/to/file:line - evidence)
```

Then emit:

```text
<promise>IMPLEMENTATION_VERIFIED</promise>
```

### Blocked

```text
BLOCKED:
- [describe what is blocked]
- [what information, dependency, or decision is needed]
```

Then emit:

```text
<promise>IMPLEMENTATION_VERIFIED</promise>
```
