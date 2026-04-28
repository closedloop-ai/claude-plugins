# Decision Table Artifact Format

Write the artifact to `.closedloop-ai/decision-tables/<slug>.md`.

Use this structure:

```md
# <work item title>

## Inputs

- Repo: <repo-root-name>
- Work item: <plan id / ticket / feature / short description>
- Current code sources:
  - [path](/abs/path/file.ts:line)
- Plan sources:
  - plan id / URL / local file
- Notes:
  - assumptions or missing details

## Behavior Areas

- <area 1>: why this area is included
- <area 2>: why this area is included

## Behavioral Edge-Case Expansion

- Structured-result setup failures: <rows or non-applicability note>
- Library-managed lifecycle re-entry: <rows or non-applicability note>
- Time-bound credentials/signatures: <rows or non-applicability note>
- Diagnostic reason/category taxonomy: <rows or non-applicability note>
- Side-effect boundaries for validation/preparation failures: <rows or non-applicability note>

## Shared State Axes

- <axis 1>
- <axis 2>
- <axis 3>

### <behavior area 1>

#### Current Code

Frozen pre-implementation baseline. Do not rewrite after implementation begins.

| Entry Path | State Inputs | Decision / Branch | Actions / Side Effects | External Outcome | Source |
| --- | --- | --- | --- | --- | --- |
| ... | ... | ... | ... | ... | ... |

#### Intended Change

Frozen target behavior derived from the plan or work item. Only change after implementation if you are explicitly recording a plan clarification.

| Entry Path | State Inputs | Decision / Branch | Actions / Side Effects | External Outcome | Source |
| --- | --- | --- | --- | --- | --- |
| ... | ... | ... | ... | ... | ... |

### <behavior area 2>

Repeat as needed.

## Delta Checklist

- Behavior that changes
- Behavior that must stay identical
- Open questions or plan ambiguities

## Required Tests

- Exact scenario coverage implied by the changed rows

## Verification Findings

- Drift or mismatches found after implementation
- Missing edge cases or missing tests
- Every finding must be resolved by a corresponding fix, marked not applicable with source evidence, or carried into `Final Alignment Status: Not aligned` with a specific human/external blocker.

## Fixes Applied

- Code or test fixes made to resolve verification findings

## Final Alignment Status

- `Aligned` or `Not aligned`
- Short explanation with source links
- Do not use soft statuses such as `Partially aligned`, `Mostly aligned`, or `Recorded Gaps`.
- Use `Aligned` only when no known fixable drift or required-test gap remains. Otherwise use `Not aligned` and state the blocker or user action.

## Plan Clarifications

Only include if the plan itself was ambiguous or incorrect and the intended target needed an explicit correction. Do not use this section to silently rewrite the target to match the implementation.

## Optional Mermaid

Only add this section when the user explicitly asks for a flowchart or when the table is too large to review quickly without one.
```

Guidelines:

- Default to one artifact per plan or work item.
- Use sections for multiple behavior areas inside one artifact.
- Only split into multiple files if the work spans clearly separate repos/systems or the single artifact becomes too large to review effectively.
- Use `Behavioral Edge-Case Expansion` to record behavior-only edge cases that must be represented in rows or explicitly ruled out as not applicable.
- Keep the same state axes and column meanings across `Current Code` and `Intended Change` within each behavior area.
- Use additive rows rather than prose for behavior changes whenever possible.
- Every nontrivial row should include file or plan references.
- Mark inferred target-state behavior explicitly when the plan implies it but does not say it directly.
- Freeze `Current Code` and `Intended Change` once implementation begins.
- Record post-implementation work in `Verification Findings`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications`.
- Treat `Verification Findings` as a resolution queue, not a backlog. Do not leave fixable repo-local work as a recorded gap when the user asked for implementation.
- Do not assume a human will read this artifact. Anything the user needs to know or do must also be surfaced in the final response.
