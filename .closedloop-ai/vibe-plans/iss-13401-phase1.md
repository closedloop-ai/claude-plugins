# Implementation Plan: ISS-13401 Phase 1 Claude benchmark measurement

## Summary

Extend the Phase 0 local benchmark with a Claude Code result contract, collector, attribution, comparison, report, and local driver. This phase makes one run measurable and a five-run baseline comparable with three PR runs. Phase 2 will collect the first baseline and exercise the complete PR path.

**Scope:**
- In-scope: final-result token and cost totals, optional per-request OTEL, deduplicated transcript calls, evidence-backed attribution, exact section 5 thresholds, Markdown report, and Claude-only local CLI.
- Out-of-scope: a Codex benchmark arm, model-driven evals, CI and hosted runners, a real benchmark PR or ClosedLoop write, PR #361 hooks or session-record rewrites, and baseline collection.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-101 | Final totals and dollars equal Claude's final `result`/`modelUsage`; missing or conflicting required records fail; assistant output placeholders never count. | ISS-13401; PLN-2237 v5 section 4.3 |
| AC-102 | Each distinct model call has exactly one top-level component, with an unattributed reason when evidence cannot identify it; skill, worker, and phase are assigned only when supported. | PLN-2237 v5 section 4.3 |
| AC-103 | A result records the exact model and effort, CLI and plugin versions, task and fixture, stack timing, success, tokens, calls, cost, and hash; mismatches and environment overrides invalidate. | ISS-13401 v3 operational precedent; Daniel runtime ruling |
| AC-104 | Five-run main versus three-run PR comparison applies section 5 median, MAD, yellow/red, task-success, static-growth, and 600-second rules exactly. | PLN-2237 v5 section 5; Daniel speed ruling |
| AC-105 | The report names the component and phase for yellow changes, records red as requiring Daniel's acceptance, and renders component, skill, worker, and phase tables where observable. | PLN-2237 v5 sections 4-5 |
| AC-106 | A local Claude-only driver and CLI consume the Phase 0 fixture/stack contract without touching external services. | ISS-13401 Phase 1 scope and Phase 0 decision table |

## Architecture Fit

The Phase 0 `tools/vibe-bench` contract remains the authority for task identity, model/effort, fake origin, hidden oracle, stack ownership, and draft PR state. Phase 1 adds pure parsing and comparison modules, a report builder, then a thin local driver/CLI adapter. The collector receives the final stream and optional OTEL; it never rewrites a vibe session record or installs a hook. Per-call attribution is separate from authoritative run totals, so unknown call detail remains explicit instead of inventing token counts. The Claude Code benchmark is the only measured runtime; Phase 3 model-driven evals remain dual-runtime.

- Impacted files/modules: new `tools/vibe-bench/src/{result-schema,claude-collector,attribution,comparison,report,driver,cli}.ts`, fixtures and tests; Phase 0 real probe integration.
- State/storage changes: local JSON and Markdown in the disposable run directory only; no product database/schema changes.
- Integration points: Phase 0 `runLivePhase0`, Claude stream `result.modelUsage`, optional OTEL request records, agent frontmatter, local stack and oracle, and a later PR adapter.

## Tasks

### Phase 1: Measurement contract

- [x] **T-1.1**: Define a versioned Claude-only result schema with source-of-truth and hash rules in `tools/vibe-bench/src/result-schema.ts` (AC-101, AC-103).
- [x] **T-1.2**: Collect final totals, distinct calls, and optional OTEL, failing on missing/truncated/mismatched required data in `tools/vibe-bench/src/claude-collector.ts` (AC-101, AC-102).
- [x] **T-1.3**: Attribute calls to component, then skill, worker, and phase using only evidenced transcript and agent metadata in `tools/vibe-bench/src/attribution.ts` (AC-102).

### Phase 2: Comparison and entry

- [x] **T-2.1**: Implement five-versus-three median/MAD thresholds and report tables in `tools/vibe-bench/src/{comparison,report}.ts` (AC-104, AC-105).
- [x] **T-2.2**: Add a local Claude-only driver and CLI that attach Phase 0 stack/probe metadata and produce reviewable artifacts in `tools/vibe-bench/src/{driver,cli}.ts` (AC-103, AC-106).
- [x] **T-2.3**: Validate real anonymized Claude fixtures, math, invalidation, and the local entry through the owning package tests and noEmit TypeScript check (AC-101 through AC-106).

## Implementation Notes

The AGENTS.md absolute template path is stale/missing. This plan uses the current repository `plugins/closedloop-core/skills/plan-structure/resources/plan_template.md`, already byte-verified against the installed template in Phase 0. The previous decision table's DT-01 through DT-11 rows are frozen; new rows are appended. Existing `tools/vibe-workers/src/claude-worker.ts` validates a basic result envelope but does not collect authoritative modelUsage or attribution, so Phase 1 adds narrow benchmark-specific pure primitives rather than copying PR #361. The actual Phase 0 stream contains repeated assistant blocks sharing message IDs; its final modelUsage output exceeds assistant-line output placeholders. That real shape drives the fixtures.

## API & Data Impacts

The local JSON schema records runtime `claude`, shape, identity, configured and observed model/effort, per-agent declared model, authoritative token categories and cost, distinct model calls with provenance and attribution, stack timing, task success, validity reasons, and SHA-256 result hash. Optional OTEL adds per-request detail only after reconciliation with final modelUsage. Unknown facets are `null` or `unattributed` with a reason; they are never zero-filled. No external API is changed.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| Assistant stream repeats a message or reports placeholder output | Deduplicate by `message.id`, take output only from final modelUsage or reconciled OTEL, and test exact totals. |
| Missing or truncated final result looks like a cheap run | Require one final result, complete modelUsage and request records, and mark the run invalid on mismatch. |
| OTEL request metadata cannot identify a worker or phase | Assign exactly one top-level component or `unattributed` with a specific reason; leave finer facets null. |
| Fixed task appears fast while full start-to-PR workflow exceeds ten minutes | Keep the 600-second cap, report measured durations, and collect the full baseline in Phase 2 without retuning it. |
| Comparison noise hides a regression | Use five-run baseline MAD and three-run PR median; retune only once after Phase 2 measured noise if required. |

## Test Plan

- [x] Unit: final totals, duplicate IDs, missing/truncated/conflicting records, attribution partition, model/effort invalidation, median/MAD and every threshold boundary.
- [x] Integration: anonymized real Phase 0 Claude stream/result fixture, explicitly synthetic OTEL overlay, local driver and compare CLI output, and report tables.
- [ ] E2E: the full start-to-PR baseline requires Phase 2; no compose E2E before a pushed SHA.

## Rollback

Remove Phase 1 modules and tests. Phase 0 remains a working local scaffold; no product state or external record is changed.

## Open Questions

- [x] **Q-101**: The current Claude CLI emitted no per-request console OTEL in the owned current-main probe with documented telemetry flags; stdout had zero `api_request` records and stderr was empty. Optional OTEL remains supported and reconciled when available; the fixture labels its overlay synthetic.

## Gaps

- [ ] **GAP-101**: Phase 2 must run five real main and three PR start-to-PR sessions, record actual total cost and noise, and complete a real draft PR lifecycle.
- [ ] **GAP-102**: Phase 3 implements the dual-runtime model-driven evals and CI gate; they are outside this Claude benchmark arm.

## Visual References

No visual references attached.

## Phase 1 verification

- The current symphony-alpha source was a clean disposable worktree at `origin/main` SHA `9bb55fb42e8e8557cef29f542edb6de8713249be`, including the re-landed PLN-2125 migration. The documented `loops-setup.sh` bootstrapped that worktree. Control used a new isolated `control_*` database; no Prisma reset was accepted or offered. The older local `main` ref was stale; the fixture now clones the exact source HEAD and requires HEAD to equal `origin/main` for the live path.
- The pinned real Claude probe on that source used `claude-sonnet-5-5` with explicit `--effort high`, local MCP and fake bare origin. The private oracle failed before and passed after. Setup took 109394 ms, teardown 3806 ms, full wall 135223 ms, and Claude reported $0.0532566 for 5 model calls. Final totals were input 10, cache read 175146, cache write 6513, output 967. The hash-stamped collector result was valid with observed high effort and hash `150b9c038d1dfc1f3f3a50551d9e54a9d9a79626ad4b9129e8d9727568131e90`. Task success is false by design because Phase 1 did not create, record or close a PR.
- The owned control session `iss13401-8fc2c02a` reported `running: false` after down, local MCP port 3010 was free, and the seed key was removed. The agent checkout had only the benchmark task file modified. No external GitHub or ClosedLoop write occurred.
- The repository root `pnpm test:lanes` has no package manifest (`ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND`). Through the owned heavy slot, `pnpm test` in `tools/vibe-bench` passed 22/22; TypeScript noEmit over `src/*.ts oracle/*.ts` passed with the current symphony-alpha worktree's TypeScript binary and Node type roots. `git diff --check` passed. No compose E2E ran because there is no pushed SHA.
- The documented console OTEL flags produced no `api_request` record in stdout or stderr. The real Phase 0 stream and transcript remain the anonymized fixtures; the optional OTEL overlay is clearly synthetic and is exercised only as a reconciliation and attribution test.
