# Implementation Plan: ISS-13401 Phase 3 local dual-runtime evals

## Summary

Make the existing vibe model-driven eval corpus runnable and reportable on both Claude Code and Codex from one local command. Daniel's final decisions in PLN-2237 v5 replace the earlier Phase 3 self-hosted CI runner proposal: model-driven evals always run on a developer machine, while later model-free CI checks enforce PR disclosure. The start-to-PR benchmark remains Claude Code only.

**Scope:**
- In-scope: reuse the existing Claude eval suite and Codex mirror, add a deterministic-only Codex option, a local two-runtime eval driver/CLI, exact case and artifact accounting, failure disclosure, and tests including the `pm-new-session-first-reply` route regression.
- Out-of-scope: model-driven GitHub Actions, runner registration, branch protection, PR comments/body mutation, bypass-label enforcement, Codex start-to-PR measurement, Phase 4 benchmark gating, Phase 5 reviewer, and Phase 6 developer skill.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-301 | One local invocation runs the same vibe case corpus on Claude Code and Codex, with immutable run-owned artifacts and per-runtime case pass counts; no installed plugin cache is changed. | PLN-2237 v5 section 10 Phase 3, final Decisions |
| AC-302 | A wrong `pm-new-session-first-reply` route fails the route grader on both runtime result paths and makes the combined command fail. | PLN-2237 v5 Phase 3 acceptance, `plugins/vibe/evals/pm-new-session-first-reply/graders/route.md` |
| AC-303 | Codex `--deterministic-only` skips the paid wording grader only, preserves every deterministic check, records the skipped wording explicitly, and defaults to the existing full behavior. | PLN-2237 v5 Phase 3 Codex option, `plugins/vibe/evals/codex/run.py` |
| AC-304 | Missing, partial, malformed, mismatched or truncated suite results cannot report green; output identifies runtime, CLI version, plugin SHA, selected cases, pass/fail counts, and artifact hash. | ISS-13401 eval-gate intent; PLN-2237 v5 sections 4 and 6, final Decisions |
| AC-305 | Local eval runs have no model-driven CI runner, live ticket/deployment side effect, browser UI or Desktop path; full live runs respect Daniel's second-machine deadline. | PLN-2237 v5 final Decisions; operator deadline |

## Architecture Fit

The Claude suite already owns `plugins/vibe/evals/*/prompt.md` and its graders. The Codex runner imports those same cases via `cases()` and keeps runtime-specific prompting, install and grading semantics in `plugins/vibe/evals/codex/run.py`. Phase 3 adds a narrow driver under `tools/vibe-bench` that snapshots the current plugin and core, invokes the two existing runners, validates their native result shapes and writes one combined local report. It reuses Phase 1 hash and identity practices without changing the Claude-only start-to-PR batch. The shared driver owns case identity, command lifecycle, artifact integrity and summary; each runtime adapter owns native CLI arguments and native result parsing.

- Impacted files/modules: `plugins/vibe/evals/codex/run.py`, its tests, `tools/vibe-bench/src/cli.ts`, new local eval driver/tests, and `tools/vibe-bench/README.md`.
- State/storage changes: run-owned local JSON/Markdown only, with no product schema or persisted session change.
- Integration points: current `claude plugin eval` CLI, current `codex exec` eval runner, the shared vibe case corpus, and local plugin/core snapshots.

## Tasks

### Phase 1: Preserve and expose the dual-runtime eval contract

- [x] **T-1.1**: Verify current Claude eval CLI flags and existing case/grade result shape; pin output and partial-result handling in a Claude adapter under `tools/vibe-bench/src/`.
- [x] **T-1.2**: Add `--deterministic-only` to `plugins/vibe/evals/codex/run.py`, with a recorded skipped-wording state and failing-first tests for deterministic route failures.
- [x] **T-1.3**: Validate the Codex `results.json` contract, including case coverage, plugin identity, missing records and failure status, in a Codex adapter under `tools/vibe-bench/src/`.

### Phase 2: Local orchestration and evidence

- [x] **T-2.1**: Add one local CLI entry that snapshots the branch's vibe/core files, invokes both suites from a run-owned directory, and writes exact JSON/Markdown with runtime versions, per-case pass counts, failures and hashes.
- [x] **T-2.2**: Prove a wrong `pm-new-session-first-reply` route fails both runtime adapters and the combined CLI, including no green result on partial, malformed, missing or mismatched artifacts.
- [x] **T-2.3**: Run owning-package tests, Python tests/lint/typecheck for touched paths, TypeScript noEmit and diff check through the permitted heavy slot; run bounded real local eval probes only if they can finish before the 17:00 CDT second-machine cutoff.

## Implementation Notes

This file follows the exact repository template at `plugins/closedloop-core/skills/plan-structure/resources/plan_template.md`; the older absolute `plugins/code` template path is missing. ISS-13401 v3 and PLN-2237 v5 were read live. PLN-2237's section 10 Phase 3 still describes `evals.yml`, a signed-in self-hosted runner and branch protection, but its final `Decisions (Daniel Ochoa, 2026-10-29)` section says model-driven evals always run locally and no hosted or self-hosted model runner is used. Therefore Phase 3 builds the local dual-runtime eval path; a later phase can add a model-free PR-body check. The five-plus-five Phase 2 benchmark baseline is unchanged and remains Claude-only.

Graph-first evidence at claude-plugins indexed main `6746cd6c0a49`: `run_case` in `plugins/vibe/evals/codex/run.py` has a `CALLS` edge from `main`; the Python importers zero is unestablished (`python_import_form`). The ticket blast-radius route finds one direct prior ticket, ISS-13171, for the Codex runner path. Current checkout and tests will verify material behavior. The workflow-memory query produced only an unrelated ISS-5965 hint, which is ignored.

The implemented `eval-local` command snapshots one committed vibe/core tree and runs the selected shared corpus on Claude Code and Codex. Both native artifacts are validated for exact coverage and identity before a hash-stamped combined JSON and Markdown result can report green. Codex deterministic mode skips only cases that actually configure a wording grader, and the adapter rejects missing or unexpected skip records.

The bounded real `pm-new-session-first-reply` probes passed on both runtimes without UI. Claude Code 2.1.311 completed in 12 seconds at $0.1630888; its native result did not expose token counts. Codex CLI 0.163.0 completed in 14.1 seconds using 66,574 input tokens, including 39,040 cached input tokens, plus 261 output tokens and 24 reasoning tokens; its native result did not expose a dollar cost. These are working-tree probes, not an accepted immutable full-corpus result.

Validation passed 17 Python tests, Ruff, 38 owning-package TypeScript tests, the touched-file TypeScript noEmit check, and `git diff --check`. The root lane selector cannot choose lanes because this repository has no root package manifest. Heavy slot 1 ran the final package validation from 15:22 CDT and released immediately after completion. No stack, container, browser, Electron process or model runner remains active.

## API & Data Impacts

The new local eval JSON reports the measured plugin SHA, runtime names and CLI versions, selected case IDs, per-runtime pass/fail/skip counts, partial/invalid reasons, elapsed time and content hash. It does not reuse the start-to-PR result schema for one-turn evals because their native success criteria differ; the narrow shared primitives are snapshot identity, hash stamping and fail-closed artifact validation. No new environment variable is introduced.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| A partial Claude eval or missing case silently reports pass | Validate native partial and case records against selected IDs, then fail the combined command. |
| Codex wording skip disguises a deterministic failure | Skip only wording model calls; preserve route and all other checks and label skipped wording in the result. |
| CLI or case corpus drifts between runtimes | Snapshot one plugin/core tree, record versions and compare selected case IDs before accepting results. |
| A local eval launches visible UI or touches installed caches | Use the suites' documented headless one-turn and private-install paths; reject unsupported visual launch paths and never modify installed plugin caches. |
| The second-machine deadline arrives during a model suite | Start only bounded work that can finish and clean before 17:00 CDT; after that use the primary heavy slot one at a time with no Dagger. |

## Test Plan

- [x] Unit: Codex deterministic-only behavior; native result parser truncation, mismatch, duplicate and partial cases; artifact hash.
- [x] Integration: fake Claude/Codex commands through the local driver; wrong route red on both adapters; private snapshot and cleanup on failed command.
- [x] E2E: bounded real Claude and Codex eval case probes on the second machine before the cutoff; no browser or Electron E2E is needed for one-turn evals.

## Rollback

Remove the local eval driver and Codex option; retain the Phase 2 baseline and unchanged native eval corpus. Stop only run-owned child processes and delete only run-owned temporary homes on failure.

## Open Questions

- [x] **Q-301**: Yes. Claude Code 2.1.311 wrote exact selected case IDs and native grader outcomes in JSON during the real one-case probe.

## Gaps

- [ ] **GAP-301**: PR-body enforcement and local developer-skill posting belong to later phases; Phase 3 records eval artifacts for those consumers without starting model-driven CI.

## Visual References

No visual references attached.
