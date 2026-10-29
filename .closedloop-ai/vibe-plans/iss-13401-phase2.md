# Implementation Plan: ISS-13401 Phase 2 Claude start-to-PR baseline

## Summary

Run the first immutable ten-run Claude Code baseline for the fixed Projects search task. Measure five vibe sessions and five fleet-orchestrator sessions with one writer each, against the same pinned plugin, fixture, seeded local web stack, model, effort, CLI and PR contract. A sequential screen refuted its schedule against the fixed speed target. Immediate launch preflights rejected four-way contention, so the final batch uses five balanced `AB` waves.

**Scope:**
- In-scope: main-plugin snapshot, one owned reusable isolated stack and MCP, ten independent fake-origin checkouts, restricted shape-specific Claude entry, harness-owned draft GitHub proof PR lifecycle, exact accounting, immutable result/report, and cleanup.
- Out-of-scope: Codex benchmark runs, model-driven evals, live ClosedLoop tickets, Vercel, Desktop/Electron, compose E2E, installed plugin cache changes, or a PR for this claude-plugins branch.

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-201 | Snapshot fresh claude-plugins `origin/main` at one full SHA into run-owned state; load only that plugin and its declared core dependency; pin Sonnet 5.5/high and preserve per-agent frontmatter models. | ISS-13401 Phase 2 request; operational model precedent |
| AC-202 | Reuse one owned displayless isolated seeded web stack and local MCP for ten independent fake-origin workspaces; run five A and five B in comparable recorded order and concurrency. | Daniel local-stack and speed rulings; Phase 2 request |
| AC-203 | Each successful run reaches a real draft `DO NOT MERGE` PR with benchmark body, records the measurement, closes the PR, and removes its fresh broken-base and repaired-head proof refs; cleanup also runs after partial failure. | Daniel draft-PR and close-after-record rulings |
| AC-204 | Produce immutable per-run Claude results with final-result tokens/dollars, model/effort/CLI/plugin/task/fixture identity, full task-to-PR wall, setup/teardown allocation, attribution and result hash. | PLN-2237 v5 section 4.3; Phase 2 request |
| AC-205 | Report five-run median and MAD per shape, shape A noise below 25 percent or replacement/repetition, total wall against fixed 600-second target, dominant measured drivers, and cached input as informational. | PLN-2237 v5 section 5; Daniel speed ruling; Phase 2 request |
| AC-206 | Validate stack reuse, orchestration, scheduling, snapshot, PR state, failure cleanup and report integrity; leave all owned PRs closed, refs removed, stack down and MCP stopped. | Phase 2 request; repository AGENTS.md |

## Architecture Fit

The Phase 0 `SeededStackLifecycle` and `ControlWebStackAdapter` own one stack and MCP. Phase 1's collector, attribution, schema and report remain shared. Phase 2 adds a batch driver and one PR adapter; the only shape-specific inputs are the Claude entry prompt and expected root/worker role. The benchmark harness keeps `origin` pointed at a local fake bare repo; only its PR adapter can push fresh broken-base and repaired-head proof refs to the explicit GitHub repository. Two refs are required because a repaired task tree equals healthy main and would produce an empty PR against main. Each run pays for the main plugin's real version check and uses its session-record helper to mark the fake checkout as a local benchmark session, without creating a live ticket, operator account, Vercel destination or Desktop session. The agent receives no Bash, GitHub or browser tool access. The local seeded MCP is the sole configured MCP.

- Impacted files/modules: Phase 2 driver, GitHub PR adapter, baseline report, CLI, tests, decision table, and dated measurement record under `tools/vibe-bench`/`.closedloop-ai`.
- State/storage changes: run-owned plugin snapshot, isolated database, fake checkouts, provisional local PR records, final immutable JSON/Markdown; temporary proof refs and draft PRs are closed/removed.
- Integration points: Claude Code CLI, canonical vibe/fleet skills and frontmatter from the pinned snapshot, symphony-alpha control web stack and seed, local MCP, GitHub draft PR API.

## Tasks

### Phase 1: Freeze inputs and lifecycle

- [x] **T-1.1**: Snapshot one exact main plugin commit with its core dependency; validate frontmatter, CLI version, source SHA and environment before launch.
- [x] **T-1.2**: Acquire one isolated seeded stack/MCP, create ten independent fixtures, and schedule five `AB` waves (five per arm; max concurrency two, equal shape contention in every wave).
- [x] **T-1.3**: Exercise the fixed task with shape-specific Claude entry while preserving fake origin and private oracle.
- [x] **T-1.4**: Inside each measured run, complete the main plugin's version check and write its local private session record through the plugin helper so both writer guards admit the restricted benchmark task.

### Phase 2: PR boundary and measurement

- [x] **T-2.1**: Commit each verified task edit, push fresh broken-base and repaired-head proof refs without force, create an explicit draft benchmark PR between them, record results, close the PR, and delete both refs.
- [x] **T-2.2**: Collect each Claude final result and transcript, allocate shared setup/teardown once, stamp hashes, write immutable baseline JSON and human report, and append a dated measurement record.
- [x] **T-2.3**: Test the lifecycle, ten-run schedule, exact accounting, PR contract and cleanup; run package tests, TypeScript noEmit and diff check through the remote heavy slot.

## Implementation Notes

The requested absolute plan-template path is stale/missing. This plan follows the current repository's exact `plugins/closedloop-core/skills/plan-structure/resources/plan_template.md`, previously byte-verified against the installed core template. DT-01 through DT-18 are frozen history; Phase 2 rows append. Fresh claude-plugins `origin/main` was fetched at `6746cd6c0a498610e42d00df544134dc47e10f96`; the measured snapshot must re-verify that full SHA immediately before launch. Existing symptom search found no full baseline record, only the Phase 1 probe docs. The Phase 1 current-main probe measured 109394 ms setup, 21901 ms Claude, 3806 ms teardown, but it had no PR and is not a baseline run. Projection at that measured task rate suggests ten serial short tasks plus one setup may fit 600 seconds; PR overhead and shape-specific agent work are unmeasured, so this is not an acceptance claim. The operator requires exactly five runs per shape, so no additional warmup is inserted; the existing Phase 1 probe is a non-comparable launch check.

The first Phase 2 live attempt at symphony source `cf89e228f9e43aef61a6b67fad5f6dfb013396fe` was stopped after shape A run 1, before PR creation. Claude selected `claude-sonnet-5-5/high`, connected local MCP and requested exactly one writer, but the main plugin's version and session guards denied that writer. The run-owned stack and MCP were torn down. The stopped attempt is harness failure evidence and never enters a baseline sample. The fixed adapter completes those two local preflight contracts inside each measured run and labels the session-record fixture in the report.

The next sequential screen at source `7286694490be0216c9d4d7989b2ede3fdb126112` completed A/B/B at 116626/107565/113558 ms, with $0.2979883/$0.1964816/$0.1894545. These are dated refutation evidence, excluded from baseline statistics. A run-4 sentinel stopped the scheduler at the next boundary and its `finally` closed the owned stack. Four-way launch preflight at 14:19 CDT found 71% of 51.5 GB memory free and 1.0 TiB disk free, but 18 CPUs carried load 19.7/36.9/37.1 while other tickets used over 800% CPU in Biome. The final batch therefore uses five paired `AB` waves, true process concurrency two, with one A and one B sharing each wave. This changes only scheduling; the task, plugin SHA, source SHA, Claude CLI, model, effort, oracle, local stack, and PR contract remain fixed.

A paired attempt at source `e5a03580a185a27212427411c92cefa9958a782b` completed wave 1 and stopped after wave 2 because Claude emitted an interim result followed by a task-notification completion; the collector initially rejected more than one result. Both real wave-2 streams re-collect valid after a failing-first regression and terminal-result fix. Its completed PRs were closed and its stack torn down. At 14:37:49 CDT the 18-CPU load fell to 7.48 and memory free rose to 83%, so the new bounded preflight admits the originally requested four-way `AABB`, `AABB`, `AB` schedule. This is the only schedule change from the serial screen. The paired attempt is excluded from final baseline statistics.

Immediate launch preflights at 14:41 and 14:42 CDT showed load 42.33 then 67.05 on 18 CPUs, with memory free falling to 52% and another ticket's test workload active. At 14:43 load remained 59.20. The final attempt therefore uses five paired `AB` waves. These preflights select a schedule before measurement; the prior attempts remain excluded.

The final batch ran 19:45:05–19:53:26 UTC on heavy slot 1, with five balanced paired `AB` waves and one owned seeded stack. The immutable JSON and human report are `2026-10-29-main-6746cd6c0a49-f7fd8ef6.{json,md}` under `.closedloop-ai/benchmarks/iss-13401/`. Ten of ten tasks and draft-PR lifecycles passed. All PRs #9387–#9396 are CLOSED/draft, have the benchmark explanation and recorded result digest, and have no surviving batch proof refs. Full wall was 500082 ms, including 102976 ms setup and 3062 ms teardown, so the unchanged 600000 ms target passed. A median/MAD is 72647/5874 ms (8.09%); B is 73557/4440 ms (6.04%). Claude cost is $2.3659315. The recorded baseline hash is `496c8809c21a811f94c9fecfaef98e2e9f498b39f844d4e1c104ec9dabd0c56a`. The owned stack, MCP and API key were removed before 14:54 CDT; no compose E2E or Dagger was run.

Post-run package tests passed 34/34, TypeScript noEmit passed, the actual baseline hash revalidated, and `git diff --check` passed through the heavy slot. The root `pnpm test:lanes` selector is unavailable in this repository, so the owning package's complete test and typecheck commands are the selected lanes. All batch PRs were queried independently after completion and the control session reported down.

## API & Data Impacts

The batch JSON records exact source and plugin SHAs, CLI version, task/fixture, schedule and concurrency, one full-stack setup/teardown, ten per-run results and proof-PR lifecycle evidence, medians/MAD, total wall, costs and threshold status. Every result preserves Phase 1's hash and validity checks. No product API or database schema changes.

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| A canonical skill attempts live ticket, Vercel or unrelated shell work | Run a user-authorized local benchmark scope with only file/agent/skill tools; keep the GitHub PR boundary harness-owned and fail on any external tool request. |
| Ten proof PRs trigger automatic CI or review | Close each after local result recording; never dispatch a review or CI manually; delete only the owned proof refs. |
| One run fails after a ref or PR is created | Persist partial evidence, close its exact PR, remove its exact ref and continue owned stack teardown in `finally`; do not present an incomplete batch as baseline. |
| Migration history diverges after #9374 | Use fresh `origin/main` and a new isolated database. Never accept RESET; follow the current Prisma revert runbook if the applied-but-missing condition appears. |
| Resource contention or warm caches skew A/B | Each paired wave has one A and one B on the same stack and machine. Wait for both peers before the next wave; record wave order, setup/teardown and every run. |
| Shape A noise exceeds 25 percent | Keep the first ten-run record append-only; replace the task and repeat the required five-per-shape baseline, without raising the 600-second target. |

## Test Plan

- [x] Unit: exact schedule/counts, plugin/source/CLI/model/effort pin, per-run cost/tokens and setup allocation, draft/body/record/close contract, hash and noise math.
- [x] Integration: fixture-backed fake Claude and fake GitHub adapter for balanced ten-run reuse, peer completion before failure teardown, partial failure cleanup, report integrity and hidden-oracle scope.
- [x] E2E: real pinned Claude baseline on one owned displayless web stack; no compose E2E without a pushed claude-plugins SHA.

## Rollback

Stop the exact owned stack and MCP, close only recorded benchmark PR numbers, delete only recorded proof refs, and retain partial local evidence. Remove Phase 2 source without changing the frozen Phase 0/1 records.

## Open Questions

- [x] **Q-201**: The canonical restricted vibe/fleet Claude paths completed the ten-run baseline in 500082 ms against the 600000 ms cap. Aggregate Claude task time was 303318 ms, fixture creation 230604 ms, and draft PR lifecycle 211960 ms; peer-run durations overlap, so these components are not additive to batch wall.

## Gaps

- [ ] **GAP-201**: Phase 3 implements dual-runtime model-driven evals and CI gates; they do not enter the Claude-only baseline.

## Visual References

No visual references attached.
