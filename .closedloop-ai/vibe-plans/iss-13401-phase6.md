# Implementation Plan: ISS-13401 Phase 6 developer benchmark skill

## Summary

Add a repo-local `vibe-bench` skill for Claude Code and Codex that asks which open pull request to update, verifies the selected PR is the current branch head, runs three Claude benchmark samples per shape on one isolated seeded stack, runs the shared model eval corpus locally on Claude Code and Codex, compares against the accepted baseline, and idempotently replaces that PR's `## Benchmark` section.

**Scope:**
- In-scope: canonical Claude skill plus thin Codex adapter, PR listing and head verification, a shared six-run batch primitive, exact baseline comparison, full local dual-runtime eval invocation, explanation pause for yellow/red results, deterministic Benchmark-section rendering and replacement, idempotent PR body update, cleanup verification, and tests.
- Out-of-scope: a Codex benchmark arm, model-driven CI, comments, automatic label application, Daniel's bypass or red-acceptance act, branch-protection changes, live ClosedLoop tickets, Vercel, Desktop, visible UI, Dagger, and any dependency on PR #361.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-601 | Before any expensive run, the skill lists the developer's open claude-plugins PRs, asks which one to update, and refuses unless the current branch and full HEAD equal that open PR's head. | ISS-13401 developer-skill request; PLN-2237 section 8 step 1 |
| AC-602 | One benchmark invocation runs exactly three vibe and three fleet-one-writer samples in balanced parallel pairs on one reused isolated web stack, with pinned Claude model/effort and full task-to-closed-proof-PR evidence, targeting less than 10 minutes. | Daniel speed/runtime ruling; PLN-2237 section 5 and final Decisions |
| AC-603 | The run compares each shape with the accepted five-run baseline under section 5 thresholds, preserves component, skill, worker and phase breakdowns, reports wall/tokens/cost per run, and pauses for developer explanations on every yellow or red signal. | PLN-2237 sections 4 and 5; Phase 2 baseline |
| AC-604 | The skill then runs the exact shared model eval corpus locally on Claude Code and Codex from the same committed PR head; a failed, partial, mismatched or reduced case set is not publishable. | PLN-2237 final local-only eval decision; Phase 3 contract |
| AC-605 | Publishing verifies the PR head has not moved, writes one structured Benchmark section with benchmark and eval identities, replaces the prior rendered section idempotently, updates no comment, and confirms the live body. | PLN-2237 Enforcement and developer skill; Phase 4 gate |
| AC-606 | Every proof PR is draft with `DO NOT MERGE`, records its digest, closes and removes owned refs before publish; stack and MCP teardown finish on success or failure. | Daniel PR and cleanup rulings; Phase 2 lifecycle |
| AC-607 | The skill never applies bypass or red-acceptance labels. Red disclosure stays blocked for Daniel; an approved bypass is a separate Daniel action tied to the current head. | PLN-2237 D7 and D12 final Decisions |
| AC-608 | Contract, unit and integration tests cover PR selection, balanced scheduling, artifact hashes, comparison/explanation rules, eval identity, Markdown replacement, idempotent body update and cleanup evidence. | Repository testing policy; skill-creator validation guidance |

## Architecture Fit

Phase 2's batch currently owns the exact seeded-stack, fixture, Claude and proof-PR lifecycle. This phase extracts that lifecycle into one lower-level batch primitive used by both the ten-run baseline and the six-run developer path, avoiding a second implementation. Phase 1 comparison and report table helpers remain the authority for thresholds and breakdowns. Phase 3 remains the authority for dual-runtime evals, and Phase 4 remains the authority for the published body contract. The skill contains only orchestration and authorization guidance; deterministic TypeScript owns mutations and validation.

- Impacted files/modules: shared batch orchestration, developer artifact/report/PR adapter, local CLI, Phase 4 result admission, canonical `.claude/skills/vibe-bench/`, thin `.agents/skills/vibe-bench/` adapter, README, tests, Phase 6 plan and decision rows.
- State/storage changes: run-owned local JSON/Markdown and process logs; one selected PR body edit; temporary benchmark draft PRs and refs are removed.
- Integration points: Git and GitHub CLI, accepted baseline JSON, isolated symphony-alpha web stack and local MCP, Claude Code benchmark, Claude/Codex local eval CLIs, Phase 4 model-free gate.

## Tasks

### Phase 1: Reuse the measured batch and comparison core

- [x] **T-1.1**: Extract a generic balanced-wave Claude batch helper used unchanged by Phase 2 and the developer run.
- [x] **T-1.2**: Add pure developer artifact finalization, six-run identity and cleanup checks, per-shape five-versus-three comparisons, instruction-word counts and content hashing.
- [x] **T-1.3**: Add a combined disclosure renderer that aggregates all runs, requires explanations, verifies the complete dual-runtime eval result and emits Phase 4's structured contract.

### Phase 2: PR-safe skill workflow

- [x] **T-2.1**: Add read-only PR list/preflight and idempotent body replacement/publish adapters with exact current-head verification and no comment or label mutation.
- [x] **T-2.2**: Add CLI commands for candidate listing, developer benchmark execution and final publish, while keeping full local eval execution on the existing Phase 3 command.
- [x] **T-2.3**: Add the canonical Claude skill, thin Codex adapter, skill validation, fixture-backed tests, documentation and full owning validation before the second-machine cutoff.

## Implementation Notes

ISS-13401 v5 and PLN-2237 v5 were read live. The final Decisions section replaces section 8's runtime choice, sandbox key, benchmark comment and CI disclaimer. The benchmark is Claude-only against the seeded local web stack and local MCP; results go in the PR body; model evals remain local on both runtimes; no self-hosted runner or CI comment exists.

The skill-creator guidance was read before design. The canonical skill stays concise and delegates repeatable operations to deterministic scripts. The Codex surface is a thin adapter that reads the canonical skill, not a duplicated workflow. No optional UI metadata or ancillary README is added to the skill folders.

Graph lookup at claude-plugins main `6746cd6c0a49` found no existing repo-local `vibe-bench` skill. The branch-only Phase 2 driver and CLI are absent from the trunk index, so their importer and ticket routes are unestablished there; local source inspection shows `runPhase2Baseline` is called only by the benchmark CLI and its pure primitives are covered by Phase 2 tests. Refactoring retains the public baseline entry and test contracts.

The accepted baseline is the committed Phase 2 JSON with hash `496c8809c21a811f94c9fecfaef98e2e9f498b39f844d4e1c104ec9dabd0c56a`. Developer samples use three balanced `AB` waves, one stack and concurrency two. Model evals run only after benchmark teardown, so their resource use cannot distort the benchmark wall measurement.

## API & Data Impacts

The developer artifact records selected PR and head, baseline identity, source and plugin SHAs, six immutable run results and proof cleanup, shared setup/teardown, full wall, total cost, instruction-word counts, two comparisons and a content hash. The final Benchmark section adds one full-corpus eval line per runtime and its combined eval hash. No product API or database schema changes.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| Refactoring changes the accepted baseline path | Keep `runPhase2Baseline`, `orchestrateTen` and existing tests stable; add a common helper beneath them and rerun all Phase 0 through 6 tests. |
| A developer publishes results for another branch or a moved PR | Verify branch name and full HEAD before the run and re-fetch the same open PR head immediately before body edit. |
| Eval load changes benchmark timing | Complete and tear down the six-run benchmark before starting the separate dual-runtime eval command. |
| A non-green result gets published without explanation | Final renderer requires one component, phase and reason for every yellow/red signal and refuses otherwise. |
| A failed proof PR or stack survives | Reuse Phase 2 record-before-close and `finally` cleanup; final artifact requires every proof closed and both refs removed. |
| Body replacement erases unrelated PR text | Replace exactly one rendered level-two Benchmark section and preserve every byte outside its range; append only when absent. |
| A skill applies Daniel-only authority | Do not include label-mutation commands; publish red as blocked and stop bypass flow with instructions to ask Daniel. |

## Test Plan

- [x] Unit: generic waves, six-run finalizer, baseline identity, hash, aggregate report, eval verification, explanation requirements and Markdown replacement.
- [x] Integration: fake GitHub candidate/preflight/body update, moved-head refusal, idempotent second publish, exact no-comment/no-label commands, and Phase 2 baseline compatibility.
- [x] E2E: no additional paid live run; reuse the accepted Phase 2 full benchmark and Phase 3 real probes, then run all deterministic package and skill validators before the cutoff.

## Rollback

Remove the repo-local skill, developer CLI modules and Phase 6 tests; revert Phase 2 to its prior private batch implementation while preserving the accepted baseline and all measurement artifacts. No PR body or product data migration is required.

## Open Questions

- [x] **Q-601**: The developer skill publishes to the required PR body section, not a comment, because the final Enforcement decision supersedes section 8's self-report comment proposal.

## Gaps

- [x] **GAP-601**: A new full paid six-run developer benchmark is not repeated in this implementation phase; Phase 2's accepted ten-run baseline already proves the same task, stack and proof-PR lifecycle, and Phase 6 adds deterministic scheduling and publication coverage.
- [x] **GAP-602**: Known main failure at `6746cd6c0a498610e42d00df544134dc47e10f96`: `plugins/vibe/skills/fleet-orchestrator/scripts/fleet-home.test.mjs` matches `iss-1` inside a checkout name containing `iss-13401`, so its isolation assertion fails on unchanged main. Three other full-suite process timing failures passed their targeted reruns.

## Visual References

No visual references attached.
