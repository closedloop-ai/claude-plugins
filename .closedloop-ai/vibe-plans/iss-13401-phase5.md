# Implementation Plan: ISS-13401 Phase 5 vibe pull request reviewer

> Superseded final state, 2026-10-30: the reviewer no longer requires per-PR benchmark or eval evidence. It checks deterministic coverage and that paid work remains confined to the scheduled local nightly or an explicitly requested on-demand benchmark.

## Summary

Add a repo-local, read-only reviewer agent that applies the ten evidence-backed vibe contribution checks from PLN-2237, reads local eval and benchmark disclosures, and produces specific review findings without posting or starting another model-driven workflow. Freeze the three accepted PR #362 regressions as a local eval case.

**Scope:**
- In-scope: `.claude/agents/vibe-pr-reviewer.md`, the ten review checks, current Daniel decisions, deterministic contract tests, one frozen PR #362 eval case and rubric, local/manual invocation guidance, and benchmark/eval evidence interpretation.
- Out-of-scope: a hosted or self-hosted review workflow, automatic GitHub review posting, approval or request-changes events, fixing findings, changing benchmark results, triggering a new review, plugin runtime weight, and retiring external files not present in this repository.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-501 | A repo-level read-only agent contains all ten PLN-2237 review checks as the single current checklist and is not shipped in the vibe plugin. | PLN-2237 v5 section 7 and Phase 5 |
| AC-502 | The reviewer treats current rulings as authoritative: symphony-alpha coupling is allowed, release smoke is optional, benchmark runs are Claude-only and local, model evals remain dual-runtime and local, and no model-driven workflow is required. | PLN-2237 v5 final Decisions; ISS-13321 ruling |
| AC-503 | Findings require reproduced code or artifact evidence, one concrete failure per item, severity, file and line, triggering input, smallest fix and test; the reviewer never praises, edits, approves, requests changes or posts. | PLN-2237 v5 section 7 voice and limits; standing review rules |
| AC-504 | Benchmark review consumes the exact Phase 4 disclosure states and section 5 thresholds, flags missing disclosure, unexplained yellow, unaccepted red, invalid bypass and stale result identity, and preserves component, skill, worker and phase attribution. | ISS-13401 v5; PLN-2237 sections 4, 5 and 7; Phase 4 gate |
| AC-505 | The frozen PR #362 case requires findings for the duplicated hardcoded classifier, dormant environment switch and plugin version collision, and rejects obsolete findings about symphony-alpha coupling or mandatory release smoke. | PLN-2237 Phase 5 acceptance; PR #362 review evidence |
| AC-506 | Contract tests verify valid frontmatter, read-only tools, the ten headings, required current rulings, output shape and complete eval fixture/rubric. | Repository agent conventions; Phase 5 plan |

## Architecture Fit

The reviewer lives under `.claude/agents`, matching the repository's existing specialist agent roster, so it adds no plugin manifest, runtime instruction or always-loaded vibe weight. It references the existing Phase 4 disclosure contract instead of duplicating parser logic. The frozen regression case lives with the repository's human/model eval sets, while a small owning-package contract test validates static completeness. The agent may use read-only shell and GitHub queries locally, but it returns a review draft to its caller and never performs GitHub mutations.

- Impacted files/modules: `.claude/agents/vibe-pr-reviewer.md`, `evals/vibe-pr-reviewer/`, `tools/vibe-bench/src/phase5.test.ts`, Phase 5 plan and decision rows.
- State/storage changes: none. The agent and eval are static repository artifacts.
- Integration points: local Claude agent invocation, Git diff and GitHub read commands, Phase 4 Benchmark body contract, Phase 3 local eval artifacts and repository tests.

## Tasks

### Phase 1: Encode the current reviewer policy

- [x] **T-1.1**: Add the repo-local read-only agent with precise inputs, evidence discipline, all ten checks and current Daniel decisions.
- [x] **T-1.2**: Define the finding and clean-area output contract, including no GitHub mutation and no speculative findings.
- [x] **T-1.3**: Add static contract tests for frontmatter, tools, headings, rulings, benchmark/eval handling and output fields.

### Phase 2: Freeze real regression evidence

- [x] **T-2.1**: Add a compact PR #362 eval case with the duplicated classifier, dormant switch, version collision and explicit non-findings.
- [x] **T-2.2**: Add the vibe reviewer rubric and contract checks that keep the fixture complete and model-runner neutral.
- [x] **T-2.3**: Run the repository lane selector, focused and full owning-package tests, touched-file noEmit and diff checks through the permitted heavy slot.

## Implementation Notes

ISS-13401 v5 and PLN-2237 v5 were read live. Section 7's reviewer workflow is superseded by the final decision that there is no hosted or self-hosted model runner. The agent remains locally invocable and deterministic artifacts remain testable; no automatic review workflow or review-trigger event is added.

Graph lookup at claude-plugins main `6746cd6c0a49` found no existing `vibe-pr-reviewer`, `review-vibe-contrib`, `benchmark-not-needed` or version-collision implementation. Local inspection found the general `.claude/agents/pr-reviewer.md` and the shipped vibe adversarial reviewer, but neither owns contribution vision, weight, benchmark and eval policy together. The new agent reuses the repo agent frontmatter convention and does not copy the shipped handoff reviewer's product-surface attack list.

PR #362 was read through the GitHub API. Its accepted review evidence names the environment-gated dormant behavior and the third copy of path-area classification, while the PR body records its older 1.1.13/1.1.15 base against main's 1.1.16 collision. It also incorrectly calls the release smoke required; the current reviewer must reject that obsolete finding.

The completed repo-local agent carries read-only tools and all ten current checks. It explicitly treats symphony-alpha coupling and the optional release smoke as non-findings, keeps the Claude-only benchmark separate from dual-runtime local evals, and consumes Phase 4 disclosure states without posting a GitHub review. The frozen PR #362 JSONL case and rubric require the duplicated classifier, dormant switch and version collision findings with concrete triggers and smallest fixes.

Validation passed all 47 owning-package tests, the Phase 5 touched-file TypeScript noEmit check and `git diff --check` in heavy slot 1. The two Phase 5 contract tests pin agent frontmatter, read-only tools, every heading, current rulings, output fields, the absence of an automatic review workflow, the three required #362 findings and the two superseded non-findings. The root lane selector remains unavailable because this repository has no root package manifest.

## API & Data Impacts

None. The eval case is line-delimited JSON with an expected-finding list and explicit non-findings. The reviewer output is Markdown returned to the local caller.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| The reviewer repeats superseded plan recommendations | Put the final decisions before the checklist and pin them in contract tests and the eval's non-findings. |
| The agent duplicates the general PR or shipped adversarial reviewer | Limit it to vibe contribution vision, ownership, weight, repo rules, sandbox, regressions and benchmark/eval evidence. |
| A model posts or approves without authority | Omit mutation tools, state the prohibition in inputs and output, and add no workflow. |
| The frozen case overfits prose instead of failures | Name the exact trigger and expected smallest fix for each of the three proven regressions. |
| A checklist claim lacks current code evidence | Require reproduction before findings and return unverified concerns only under checked-clean or unable-to-establish notes. |

## Test Plan

- [x] Unit: agent frontmatter, read-only tools, ten numbered headings, current-ruling literals and output fields.
- [x] Integration: parse the frozen PR #362 JSONL and rubric, require three findings plus two explicit non-findings, and ensure no model workflow exists for this agent.
- [x] E2E: local static contract validation only; the model-driven reviewer eval remains a developer-run operation under the Phase 3 local eval policy.

## Rollback

Remove the repo-local agent, frozen eval directory and its contract test. No plugin, GitHub or product state requires migration.

## Open Questions

- [x] **Q-501**: The reviewer stays repo-local under `.claude/agents` as PLN-2237 specifies, so it does not increase plugin instruction weight.

## Gaps

- [ ] **GAP-501**: The full model-driven reviewer eval is intentionally not run in CI; developers can run it locally after the agent lands.

## Visual References

No visual references attached.
