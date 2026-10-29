# Implementation Plan: ISS-13401 Phase 4 model-free benchmark disclosure gate

## Summary

Require every pull request that changes the shipped vibe surfaces or their benchmark tooling to carry a populated `## Benchmark` section. The gate reads the live pull request and changed files without running a model, validates structured benchmark disclosure, and permits only Daniel's head-bound bypass or red-regression acceptance.

**Scope:**
- In-scope: one read-only GitHub-hosted workflow, live pull request retrieval, vibe-path selection, rendered Markdown section parsing, structured result checks, Daniel-only label provenance, head-SHA binding, a pull request template section, and fixture-backed tests.
- Out-of-scope: model-driven CI, self-hosted runners, running the benchmark, posting or editing comments, applying or removing labels, branch-protection mutation, the Phase 5 reviewer, the Phase 6 developer skill, and any dependency on PR #361.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-401 | A pull request that changes vibe, fleet-orchestrator, vibe-workers or benchmark surfaces must contain one rendered, populated `## Benchmark` section; missing, commented, fenced, duplicate, placeholder or malformed sections fail closed. | ISS-13401 v5; PLN-2237 v5 final Decisions, Enforcement |
| AC-402 | A result disclosure identifies the result hash, pinned Claude model and high effort, wall time, token totals, component, skill, worker and phase breakdowns, comparison with main, and an overall green, yellow or red comparison status. | PLN-2237 v5 sections 4 and 5; final Decisions |
| AC-403 | `benchmark-not-needed` passes only when the current label's latest timeline actor is Daniel's GitHub login and the Benchmark section contains a nonempty bypass reason plus the current full head SHA. | PLN-2237 v5 D7 and D12 final Decisions |
| AC-404 | A yellow result requires a regression explanation. A red result remains blocked unless `benchmark-regression-accepted` was most recently applied by Daniel and the section records the current full head SHA. | PLN-2237 v5 section 5 and D7 final Decisions |
| AC-405 | The workflow runs trusted base-branch code under `pull_request_target`, has read-only repository, issue and pull-request permissions, reads live GitHub state, and never checks out or executes pull-request code. | Model-free CI ruling; symphony-alpha PR-body gate security boundary |
| AC-406 | Fixture tests cover in-scope and out-of-scope paths, rendered Markdown boundaries, complete green and yellow results, red blocking and acceptance, bypass provenance, duplicate labels, stale head approvals and pagination. | Repository testing policy; fail-closed gate requirement |

## Architecture Fit

`tools/vibe-bench` already owns the result and report contracts, so the new gate stays there and consumes the same disclosure fields instead of inventing a second result format. Its pure validator receives live pull request data through a narrow GitHub client. The workflow runs that client from the base commit and never executes contributor-controlled files. The existing symphony-alpha gate demonstrates the live-body and rendered-Markdown pattern, but its broad template, warning, squash-subject and attestation semantics do not apply here; this phase reuses the narrow mechanics while keeping vibe-specific result and approval policy local.

- Impacted files/modules: `tools/vibe-bench/src/` gate, CLI and tests; report builder; `.github/workflows/vibe-benchmark-gate.yml`; `.github/pull_request_template.md`; Phase 4 plan and decision rows.
- State/storage changes: none. The job reads current pull request metadata, files and issue timeline and writes no GitHub or product state.
- Integration points: GitHub pull request, files and issue timeline REST endpoints; labels `benchmark-not-needed` and `benchmark-regression-accepted`; existing benchmark Markdown report.

## Tasks

### Phase 1: Freeze the model-free disclosure contract

- [x] **T-1.1**: Add a pure validator in `tools/vibe-bench/src/pr-body-gate.ts` for path scope, rendered `## Benchmark` extraction, structured results, yellow explanation, red acceptance and bypass approval.
- [x] **T-1.2**: Extend the existing report builder with one explicit overall comparison status line that the gate can validate without model interpretation.
- [x] **T-1.3**: Add fixture tests for valid and adversarial body, label, actor, head-SHA and path combinations.

### Phase 2: Wire trusted live GitHub enforcement

- [x] **T-2.1**: Add a read-only GitHub client and CLI that paginate live changed files and timeline events, then pass exact current state to the pure validator.
- [x] **T-2.2**: Add a `pull_request_target` workflow that checks out only the base SHA, uses Node 24, grants read permissions only and runs on body, label and head changes.
- [x] **T-2.3**: Add the Benchmark section to the pull request template, run the repository lane selector, owning-package tests, touched-file noEmit and workflow/static checks, then record the phase evidence.

## Implementation Notes

ISS-13401 v5 and PLN-2237 v5 were read live before this phase. The final Decisions section replaces the original Phase 4 self-hosted benchmark runner and automatic baseline refresh with this model-free disclosure gate. Daniel's GitHub login is `shafty023`, read from the authenticated GitHub account on 2026-10-29; it is the only accepted label actor. No environment variable is introduced beyond GitHub Actions' documented token and event contracts.

Graph evidence at claude-plugins main `6746cd6c0a49` found eight attributable tickets for `.github/workflows/ci.yml`, including direct ISS-11436 and mined ISS-12135. The symphony-alpha reference at `f8c5f2e8e23a` defines `checkPrBody`, called by `runGate`; three non-test files import its module, and its 18-ticket history includes direct FEA-4119 and ISS-11192. Local source inspection confirms the reusable boundary is live-body retrieval plus rendered section parsing, not the reference gate's template, warning or squash rules.

The workflow intentionally does not mutate labels or comments. An invalid or stale approval stays visible and makes the required check red, so Daniel remains the only human who can refresh it. The required GitHub branch-protection setting is an administrative follow-up after the workflow lands and is not changed from this branch.

The completed gate reads every changed-file and issue-timeline page, includes previous file names for renames, and invalidates an approval when a commit or force-push event follows Daniel's label event. The body still records the current full head SHA, but that author-editable field is not the sole freshness proof. The dedicated workflow checks out only the trusted base SHA with read permissions and never executes contributor-controlled code.

Validation passed all 45 owning-package tests, the touched-file TypeScript noEmit check, Ruby YAML parsing, and `git diff --check` in heavy slot 1. The seven new Phase 4 tests include protected-path selection, hidden and duplicate Markdown headings, complete green and explained yellow results, Daniel-only bypass and red acceptance, stale-label rejection, paginated GitHub responses and the workflow security boundary. The root lane selector remains unavailable because this repository has no root package manifest.

## API & Data Impacts

The pure gate input contains pull request number, head SHA, body, changed file names, current labels and ordered label timeline events. Its output is a deterministic pass or fail record with a stable reason code and human message. No product API, schema, secret or persistent benchmark format changes.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| A contributor edits the workflow or validator to approve their own pull request | Run `pull_request_target`, check out the base SHA only, and never execute pull-request code. |
| A body hides a fake heading in a comment or fence | Strip non-rendered comments and fenced blocks before extracting one exact level-two Benchmark section. |
| A stale bypass or acceptance survives later code | Require the current 40-character head SHA in the section and validate the most recent relevant label event actor. |
| GitHub pagination hides a changed file or label event | Follow every REST `Link` page and reject malformed or incomplete payloads. |
| The gate claims benchmark correctness from prose alone | Validate only disclosure identity and policy fields; cryptographic result verification remains in the local harness and Phase 6 skill. |

## Test Plan

- [x] Unit: path scope, Markdown extraction, structured result fields, comparison states, approval actor and head binding, stable errors.
- [x] Integration: mocked paginated GitHub pull request, files and timeline responses through the CLI client; no write methods or untrusted checkout.
- [x] E2E: validate the workflow and complete fixture suite locally; the new `pull_request_target` workflow becomes authoritative only after it exists on the base branch.

## Rollback

Remove the dedicated workflow and gate modules, then remove the template section. This changes no stored product or benchmark evidence and requires no data migration.

## Open Questions

- [x] **Q-401**: Daniel's GitHub login for approval provenance is `shafty023`, verified from the authenticated GitHub API on 2026-10-29.

## Gaps

- [ ] **GAP-401**: A repository administrator must make the landed `Vibe Benchmark Disclosure` context required; this branch cannot safely mutate branch protection before the workflow exists on main.

## Visual References

No visual references attached.
