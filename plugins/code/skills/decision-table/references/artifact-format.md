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

## Contract Literal Inventory

Record exact external contract literals before implementation. Include feature flag keys, rollout names, query parameters, route paths, header names, cache key segments, storage keys, environment variables, event names, command names, plugin identifiers, marketplace identifiers, URL schemes, and reason/status strings when they affect behavior.

| Literal | Contract Type / Purpose | Source of Truth | Producers | Consumers | Compatibility / Failure Behavior |
| --- | --- | --- | --- | --- | --- |
| ... | feature flag / query param / cache segment / event / command / plugin id / etc. | plan, repo constant, API contract, rollout config, user-provided fact, or existing code | ... | ... | exact-key behavior, wrong-key behavior, legacy alias if any |

## Evidence Artifacts

Record evidence for high-yield coverage and non-applicability claims. Paste concise command output or cite exact source references; do not rely on assertions such as "no consumers", "not externally visible", or "covered by tests".

| Claim / Surface | Evidence Required | Evidence Captured | Disposition |
| --- | --- | --- | --- |
| changed export/package subpath | package export surface and consumer grep | ... | covered / not applicable / not aligned |
| new CLI flag or input parser behavior | real entry-path tests for valid, valueless, `0`/empty, and invalid inputs | ... | covered / not aligned |
| filesystem/path write | symlink/clobber/bounds/canonicalization evidence and tests | ... | covered / not applicable / not aligned |
| new trusted/persisted field | source, forgeability, validation/guard, legacy behavior, and mutation test | ... | covered / not applicable / not aligned |
| replay/idempotency behavior | replay path test through production sequencing, not only helper state | ... | covered / not aligned |
| integration-boundary coverage claim | named test entering through CLI, route, package export, worker/job, replay, ingest, attribution, or public API | ... | covered / not aligned |

## Behavioral Edge-Case Expansion

Apply every category in [`edge-cases.md`](edge-cases.md). Each must be represented by rows or an explicit non-applicability note with source-backed evidence before marking `Final Alignment Status: Aligned`. The bullets below are placeholder shape — the canonical list is in `edge-cases.md`; do not skip categories that are absent from this template.

- Structured-result setup failures: <rows or non-applicability note>
- External contract literal binding: <rows or non-applicability note>
- Library-managed lifecycle re-entry: <rows or non-applicability note>
- Cross-surface propagation and reconciliation: <rows or non-applicability note>
- Data visibility versus side effects: <rows or non-applicability note>
- Cached capability drift: <rows or non-applicability note>
- Time-bound credentials/signatures: <rows or non-applicability note>
- Durable finalization and replay eligibility: <rows or non-applicability note>
- Backward-compatible persisted defaults and promotion: <rows or non-applicability note>
- Distributed lifecycle coverage: <rows or non-applicability note>
- Diagnostic reason/category taxonomy: <rows or non-applicability note>
- Side-effect boundaries for validation/preparation failures: <rows or non-applicability note>
- ... (continue with every category from `edge-cases.md`)

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
- Exact contract-literal binding tests for feature flags, query parameters, headers, events, cache/storage keys, command names, plugin identifiers, or other external keys. Mocks should fail closed unless the exact intended literal is used.

## Verification Findings

- Drift or mismatches found after implementation
- Missing edge cases or missing tests
- Every finding must be resolved by a corresponding fix, marked not applicable with source evidence, or carried into `Final Alignment Status: Not aligned` with a specific human/external blocker.

## Adversarial Review

- Delegation mode: independent lanes / sequential self-pass / assigned lane only / not run
- Lanes run:
  - Abuse / filesystem / untrusted input: <worker or self-pass, findings or no findings with evidence>
  - Published contract / compatibility: <worker or self-pass, findings or no findings with evidence>
  - Input validation / parsing: <worker or self-pass, findings or no findings with evidence>
  - State / replay / idempotency: <worker or self-pass, findings or no findings with evidence>
  - Test realism: <worker or self-pass, findings or no findings with evidence>
- Independent review required but unavailable: <yes/no and blocker>
- Findings promoted to `Verification Findings`: <list or none>

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
- Use `Behavioral Edge-Case Expansion` to record behavior-only edge cases that must be represented in rows or explicitly ruled out as not applicable with source-backed evidence.
- Use `Contract Literal Inventory` to prevent similar-looking strings from being conflated. Classify each literal by semantic role, record the source of truth, and state whether wrong or legacy literals are rejected, ignored, or supported through an explicit compatibility path.
- Use `Evidence Artifacts` for claims that are easy for an author to wave through: changed exports or subpaths, CLI flags, filesystem writes, untrusted or persisted fields, replay/idempotency behavior, and integration-boundary coverage. A `Covered` claim needs a named fail-closed test; a `not applicable` claim needs source-backed evidence such as grep output, export/package inventory, call-site inventory, schema/query inventory, or code references.
- Keep the same state axes and column meanings across `Current Code` and `Intended Change` within each behavior area.
- Use additive rows rather than prose for behavior changes whenever possible.
- For distributed workflows, include rows for how each replica/process learns about writes, how stale or offline replicas reconcile, and which durable source of truth wins.
- When the same eligibility, completion, or terminal predicate is enforced at one site (a gate) but re-derived independently at another (a list filter, a terminal or disposition check, a batch or unscoped routing path, or an early short-circuit), include rows for both sites and confirm they share the predicate through a shared helper or a parity test, because the two derivations can disagree (for example a predicate at a gate vs. re-derived in a list filter, or scoped vs. unscoped routing).
- Keep data visibility rows separate from side-effect rows such as notifications, dispatches, telemetry, cleanup, and deduplication.
- For capability- or operation-gated behavior, include fresh cache, stale false negative, stale false positive, old peer, fallback, retry, and reconciliation rows.
- For legacy persisted records missing new fields, include conservative defaults, evidence-backed promotion/backfill, downgrade behavior, and manual-record protection.
- For distributed command/key/signing workflows, include register/create, approval/authorization, normal command, revoke/delete, offline/reconnect reconciliation, repeated action/idempotency, and stale UI/cache scenarios.
- Every nontrivial row should include file or plan references.
- Mark inferred target-state behavior explicitly when the plan implies it but does not say it directly.
- Freeze `Current Code` and `Intended Change` once implementation begins.
- Record post-implementation work in `Verification Findings`, `Adversarial Review`, `Fixes Applied`, `Final Alignment Status`, and optional `Plan Clarifications`.
- Treat `Verification Findings` as a resolution queue, not a backlog. Do not leave fixable repo-local work as a recorded gap when the user asked for implementation.
- If independent adversarial review was required but could not run, record that blocker in `Adversarial Review` and mark `Final Alignment Status: Not aligned` unless a coordinator completes the lane review.
- Do not assume a human will read this artifact. Anything the user needs to know or do must also be surfaced in the final response.
