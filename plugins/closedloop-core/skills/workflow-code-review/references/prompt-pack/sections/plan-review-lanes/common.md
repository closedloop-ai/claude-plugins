# Plan Review Lane Contract (All Lanes)

This file is the lane-agnostic core contract for every plan-review lane subagent. Read it together with your assigned lane file under `sections/plan-review-lanes/<laneId>.md`. The orchestrator-facing gate process lives in `sections/planning-quality-gate.md`; lane workers do not need that file unless the handoff packet names it.

Plan reviewers must be read-only. Do not edit the plan, code, ledger, or any status file other than your assigned JSONL status file. Do not implement fixes. Do not decide whether the full planning quality gate passes and do not aggregate other lane findings.

## Required Inspection Inputs

Each lane must inspect, as relevant to its scope:

1. The original work item from ClosedLoop MCP.
2. The generated implementation plan or existing linked implementation plan.
3. Repo guardrails and `AGENTS.md` files.
4. Cross-repo impact across every repository in the validated `WORKFLOW_REPO_MAP`.
5. Relevant call sites, API/wire contracts, payload shapes, storage boundaries, compatibility/version-skew risks, and required validation.
6. For existing linked plans, the selected plan status, plan version/update metadata, source work-item version/update metadata, linked-plan staleness-risk evidence from intake, and the orchestrator-provided latest base branch/SHA for every implementation repo.

## Lane Evidence JSONL Contract

Each plan-review subagent must use the `status_file` path assigned by the orchestrator. Append status events there when starting, entering major phases, encountering blockers, and finishing.

The final JSONL event must be machine-ingestible as either `{"laneEvidence": {...}}` or the same fields at top level, with:

- `laneId`: your assigned lane id, exactly.
- `status`: `pass` | `fail` | `blocked` | `not_applicable`.
- `completedAt`: ISO timestamp.
- `findings`: an array of finding objects, each `{"summary": "<exact issue>", "blocking": true|false}`. Use `blocking: true` only when the finding must block this gate; advisory, stylistic, or nice-to-have findings must use `blocking: false`. Bare-string findings are treated as blocking (fail closed). A `fail` status with zero blocking findings and zero blockers is recorded as an effective pass with the findings preserved as advisory, so do not report `fail` for advisory-only feedback. The inverse also holds: a `pass` or `not_applicable` status that carries blockers is recorded as `blocked`, and one that carries blocking findings is recorded as `fail`, so keep status consistent with finding severity.
- `blockers`: true human/external blockers ONLY (an unmade decision, an unavailable dependency), not a remedy or a restatement of a finding; those go in `findings` as a `blocking: true` entry. A non-empty `blockers` array marks the lane as needing a human and disqualifies it from every automatic downgrade path (refuted-findings pass, the `execute_as_is` off-ramp, and standard-mode accept-as-debt), so a `fail` meant to carry to implementation as debt must be an inline `blocking` finding with `blockers` empty.
- `evidenceSummary`: short summary of what was inspected and concluded.
- `reviewedPlanVersion` (always include).

## Coverage depth: what blocks the plan vs what defers to the decision table

The plan and the decision table have different jobs. The plan commits to the right approach; the
decision-table skill enumerates the exhaustive edge-case matrix at implementation time. Hold each finding to
the plan's job, not the decision table's:

- `blocking: true` only for plan-level decisions: the plan picks the WRONG level or approach (for example,
  isolated mocks where a real producer-to-consumer boundary is cheaply available), OMITS a required coverage
  commitment or scenario-class decision entirely, or has a genuine architecture, contract, ownership,
  validation-order, migration-gate, or correctness gap.
- `blocking: false` (advisory) for implementation-grade completeness: enumerating every stale/mixed-state
  combination, precedence row, failure-mode permutation, or per-route/per-state test once the plan has
  already committed to the boundary and the scenario classes. That exhaustive matrix is the decision table's
  job; demanding it in the plan forces revision rounds that do not converge. Record such a deferral with
  `blocking: false` AND `category: "decision-table-coverage"` so the decision-table creation handoff carries
  exactly these coverage items forward; do not record it as a plan blocker. Reserve plain advisories (no
  category) for stylistic or nice-to-have notes that are not coverage the decision table must enumerate.

In short: block a wrong or absent commitment, not an incomplete matrix.

After the subagent returns, the orchestrator runs `{{WORKFLOW_CLI}} lane --goal-slug <goal-slug> --work-item-id <work-item-id> --kind plan --lane-id <laneId> --status-file <status_file>` before rerunning `{{WORKFLOW_CLI}} next`. The CLI rejects a lane-id mismatch before writing the ledger; it stamps the reviewed version, honoring an ahead version, else the ledger version.

## PASS / FAIL / BLOCKED / not_applicable Semantics

The lane must end with exactly one of:

- `PASS`: no known blocker, no missing required-test gap, no unresolved non-human decision, and all evidence matrix rows for this lane are pass.
- `FAIL`: one or more repo-local corrections are required before upload.
- `BLOCKED`: a human/product/security/external decision is required before the plan can be made executor-ready.
- `not_applicable`: the lane's concern does not apply to this work, with concrete repo/work-item evidence instead of broad speculative review. If applicability is unclear for your lane, return a substantive finding or blocker rather than `not_applicable`; each lane file states its own applicability rule.

Use `status: pass` only when this lane finds no blocker and no required plan correction.

## Evidence Matrix Expectations

Each lane must produce a Plan Review Evidence Matrix for its scope before passing the plan. Every matrix includes these generic rows; lane files add their lane-specific rows:

- work-item acceptance criterion or requirement
- plan section/task that covers it
- repo or repos affected
- latest base branch and base SHA inspected for each implementation repo
- exact files/modules/call sites inspected
- required tests/validation that prove it
- verdict: `PASS` | `FAIL` | `BLOCKED`
- required correction if `FAIL` or human/external decision if `BLOCKED`

Do not mark your lane pass unless every row is `PASS`; surface human blockers. Also fail source-scope misses: absent primary reqs, unclassified linked docs, missing primary `REQ-*`, CTX-only AC/task mappings, linked docs replacing primary scope, or covered linked-doc work in tasks.

## Finding Output Shape

Return findings ordered by severity with:

- plan section
- exact issue
- evidence from the work item or repo
- required correction
- whether it blocks execution
- affected adversarial pass, if applicable
- candidate_knowledge_notes with paths and summaries, or `candidate_knowledge_notes: none` with a short reason

## Loop Events

If the orchestrator provides a `planning_loop_id`, plan-review, revision, and targeted re-check subagents must use ClosedLoop MCP `add_loop_event` for major review starts, review outcomes, blockers, revisions, and re-check results. They must not create, complete, fail, or cancel manual loops.

## Candidate Knowledge Notes

Each plan-review, plan-revision, and targeted re-check subagent must evaluate whether the pass revealed stable, source-backed architecture patterns, repo relationships, contract ownership rules, runtime handoff paths, validation conventions, or recurring planning failure modes that are likely to help future goals. If yes, write short candidate notes under `${WORKFLOW_MEMORY_ROOT}/candidates/` using `sections/lightweight-knowledge-capture.md`. If no, return `candidate_knowledge_notes: none` with a short reason. Keep this separate from ordinary review status and do not write candidate notes for ticket-specific corrections, transient defects, unverified assumptions, or issues better captured as repo-local `AGENTS.md` rules.
