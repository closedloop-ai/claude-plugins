# Code Review Plugin Simplification Plan

**Status:** Draft — pending review and formalization as a ClosedLoop PLN document
**Scope:** `plugins/code-review/` only
**Working name:** CRS (Code Review Simplification)

## Overview

The `code-review` plugin has accumulated structural complexity that is now visible in three places: a 13k-line helpers module, a 30-stage walker with 8 retrofit (`b`/`c`) suffix stages, and 34 distinct JSON wire-format artifacts produced per review pass. None of this complexity is *wrong* — each piece was added deliberately to handle real cases — but the layers have not been consolidated as the system matured. This plan executes four targeted simplifications (A → D from the audit) that together remove ~2,400 LOC and ~10 wire-format contracts without changing review semantics.

### Goals

1. **A — Declarative run plan + CLI registry.** Move the two largest config-as-code functions (`_build_run_plan_stages`, `_register_subparsers`) to declarative configuration files.
2. **B — Unified singleton-agent dispatch.** Collapse four `prepare`/`consolidate` cmd pairs into a single dispatch shape and reduce the retrofit-stage count.
3. **C — Coverage artifact consolidation.** Merge the six coverage-decision artifacts down to two (`coverage.json` + `coverage_gaps.json`).
4. **D — Spawn decision consolidation.** Merge `route.json`, `spawn_spec.json`, and `spawn_verification.json` into a single `spawn.json`.

### Non-goals

- **No review-semantics changes.** Same reviewers, same prompts, same finding formats, same verification verdicts.
- **No external contract changes.** The `review_result.json` envelope shape, system-marker schema, finding identifiers, and presenter outputs are preserved byte-for-byte where possible (and structurally always).
- **No reviewer / prompt pruning.** The audit identified prompt-level simplification (defensive findings, etc.) as a separate workstream — out of scope here.
- **No `code_review_helpers.py` file split (E from the audit).** Out of scope. Can revisit after A–D land.
- **No behavior changes to the cache, hygiene, partitioning, or budget arbitration logic.** Those modules are touched only via their entry-point signatures, not their internals.

### Ordering and parallelism

| Phase | Depends on | Can run in parallel with |
|---|---|---|
| A — Declarative config | — | (none — first) |
| B — Singleton dispatch | A (B touches stage definitions A is moving) | — |
| C — Coverage consolidation | B (B unifies the coverage-critic dispatch; C consolidates the artifacts it writes) | D |
| D — Spawn consolidation | A | C |

Phases A → B are strictly sequential. C and D can land in either order after B.

### Versioning

Each phase ships as its own version bump on `code-review`:

| Phase | Version | Bump type | Rationale |
|---|---|---|---|
| A | 2.24.0 | MINOR | No external behavior change but new config files added |
| B | 2.25.0 | MINOR | Internal restructure; same external behavior |
| C | 2.26.0 | MINOR | Internal artifact shape changes; no external consumer impact |
| D | 2.27.0 | MINOR | Internal artifact shape changes; presenter already unified |

If any phase reveals an external consumer of an internal artifact (e.g., `run-loop.sh` reading `coverage_plan.json`), bump to MAJOR instead. **Pre-flight check before each phase: grep the monorepo for the artifact filenames the phase will rename or restructure.**

### Cross-cutting concerns

- **Golden fixtures.** The plugin has 6+ golden fixtures under `tools/python/fixtures/`. Every phase must keep them green; we'll re-record only when an output deliberately changes (Phases C and D).
- **CI parity.** All phases must pass `uv run ruff check .` and `uv run pyright` (the CI commands), not the bare local equivalents.
- **Pre-push CHANGELOG.** Each phase needs a `/update-documentation --plugin code-review --changelog-only` pass before push.
- **Co-Authored-By trailer.** Per project rules, every commit.
- **Rollback.** Each phase is a single PR. If a phase needs to be reverted, the next phase's PR is delayed until the revert lands; no phase makes assumptions about the previous phase's surface area beyond what's tested in golden fixtures.

---

## Phase A: Declarative run plan + CLI registry

**Target version:** `2.24.0`
**Estimated impact:** ~1,500 LOC removed; stages and CLI become inspectable, diffable data.
**Risk:** Low — config refactor, no semantic change.

### Goal

Move `_build_run_plan_stages` (894 LOC) and `_register_subparsers` (706 LOC) from Python into declarative configuration files. The Python code becomes a thin loader that returns the same shapes the existing callers consume.

### Files touched

- `plugins/code-review/tools/python/code_review_helpers.py` — refactor the two functions to loaders.
- `plugins/code-review/config/stages.json` — **new.** Declarative stage definitions.
- `plugins/code-review/config/cli.json` — **new.** Declarative subparser/argument definitions.
- `plugins/code-review/tools/python/test_code_review_helpers.py` — update existing tests; add config-shape validation tests.

### Approach

**Stages.** `_build_run_plan_stages` returns a list of dicts with `id`, `kind`, `subcommand`, `args`, `stdout`, `expected_outputs`, `depends_on`, `on_failure`. The conditional logic is minimal — one `pr_flag` insertion when `pr_number` is set. Strategy:

1. Define a JSON schema (`config/stages.schema.json`) covering the dict shape.
2. Author `config/stages.json` as the canonical stage list with placeholder tokens (`<CR_DIR>`, `<PR_NUMBER>`, etc.) preserved verbatim.
3. The new `_build_run_plan_stages` becomes: load JSON, validate against schema, perform token substitution (the existing logic), apply the `pr_flag` conditional, return.

**CLI registry.** `_register_subparsers` calls `subparsers.add_parser(...).add_argument(...)` for each cmd. Strategy:

1. Define a JSON schema for subparser entries: `{name, help, args: [{flags, type, default, required, action, help}]}`.
2. Author `config/cli.json` with one entry per cmd.
3. The new `_register_subparsers` loops the config and calls argparse APIs. A small `_ARG_TYPE_MAP` maps `"int" | "str" | "path"` strings to Python callables.

**Migration.** Single PR, atomic swap. Both old and new should produce identical run plans and identical argparse output — verify with a snapshot test:

```python
def test_run_plan_unchanged_after_config_extraction():
    plan = _build_run_plan_stages(cr_dir="/tmp/cr", mode="local", pr_number=42, flags={})
    assert plan == EXPECTED_GOLDEN_PLAN  # captured before refactor
```

### Tasks

1. Read both target functions end-to-end; catalogue any non-static logic (conditionals, env lookups, computed defaults).
2. Capture pre-refactor snapshots: run `_build_run_plan_stages` and dump argparse `--help` for every cmd; commit as fixtures.
3. Define `config/stages.schema.json` and `config/cli.schema.json` (JSON Schema draft-07).
4. Author `config/stages.json` and `config/cli.json` from the existing function bodies.
5. Refactor `_build_run_plan_stages` to load + substitute + return.
6. Refactor `_register_subparsers` to load + register.
7. Add validation: `_build_run_plan_stages` validates the loaded JSON against the schema on first call; fail-fast with a clear error if drift.
8. Re-run the snapshot tests; expect bit-identical output.
9. Verify golden fixtures unchanged.
10. Update CHANGELOG via `/update-documentation`.

### Risks

| Risk | Mitigation |
|---|---|
| Hidden conditional logic in the original functions | Task 1 catalogues it; conditionals stay in the loader, only static config moves out |
| Token substitution edge cases (nested placeholders, missing tokens) | Snapshot test catches drift; schema requires a `tokens` field listing every placeholder used |
| JSON loses comment-friendliness | Acceptable tradeoff for tooling reach; consider TOML in a follow-up if friction shows up |
| argparse `type=` callables (e.g., custom validators) don't serialize | Map via `_ARG_TYPE_MAP`; restrict cli.json to the standard set (str/int/float/path/bool); any custom types stay in Python and the JSON entry references them by name |

### Open questions

- **JSON vs TOML?** JSON is simpler tooling; TOML allows comments and is more author-friendly for the stage list (which has 30 entries with similar shape). Recommend JSON for v2.24.0 and revisit if authoring friction emerges.
- **Where exactly do the config files live?** `plugins/code-review/config/` keeps them out of `tools/python/` (which is for executables) and adjacent to `tools/prompts/` (which already holds non-executable assets). Alternative: `plugins/code-review/tools/config/`.

---

## Phase B: Unified singleton-agent dispatch

**Target version:** `2.25.0`
**Estimated impact:** ~600 LOC removed in `code_review_helpers.py`; ~1,200 LOC removed in tests; 4 retrofit `b` stages collapsed.
**Risk:** Medium — touches 4 reviewer flows; requires golden-fixture parity.

### Goal

The plugin currently implements 4 logical operations (extract-signals, coverage-critic, verify-findings, review-dismissed) as 8 cmd functions in 4 prepare/consolidate pairs. Each pair has the same lifecycle: prepare writes a manifest with `status ∈ {cache_hit, skipped, needs_agent}`; on cache_hit/skipped it also writes the target payload directly and the consolidate half no-ops; on needs_agent the orchestrator invokes the singleton dispatch protocol, and consolidate validates the agent's output before writing the canonical target.

Replace the 4 pairs with one shared dispatch shape parameterized by callbacks.

### Files touched

- `plugins/code-review/tools/python/code_review_helpers.py` — add `_singleton_dispatch_prepare()` and `_singleton_dispatch_consolidate()` helpers; refactor the 8 cmd functions to thin wrappers.
- `plugins/code-review/config/stages.json` — collapse the 4 `b` stages into their primary stages by having the primary stage carry the consolidate work too (see decision point below).
- `plugins/code-review/tools/python/test_code_review_helpers.py` — replace 4 sets of prepare/consolidate tests with one set of shared-shape tests + 4 sets of operation-specific tests.

### Approach

**Shared shape:**

```python
@dataclass
class SingletonDispatchSpec:
    op_name: str                    # "extract_signals" | "coverage_critic" | ...
    cache_namespace: str            # for cache key derivation
    inputs: list[Path]              # files read by prepare
    target_path: Path               # canonical payload destination
    manifest_path: Path             # manifest destination
    prompt_path: Path               # prompt asset
    cache_lookup: Callable          # returns Optional[dict] cached payload
    skip_check: Callable            # returns Optional[str] skip_reason
    skip_payload_builder: Callable  # produces target payload on skip
    fail_closed_payload: Callable   # produces target payload on validation failure
    validator: Callable             # validates agent output → bool + error list

def _singleton_dispatch_prepare(spec: SingletonDispatchSpec) -> int: ...
def _singleton_dispatch_consolidate(spec: SingletonDispatchSpec, agent_output_path: Path) -> int: ...
```

The 8 cmd functions become 8 wrappers that build a `SingletonDispatchSpec` for their op and delegate.

**Stage consolidation.** Two options:

| Option | Stage count after | Pros | Cons |
|---|---|---|---|
| B.1 — Keep prepare/consolidate as separate stages | 30 (no change) | Walker model unchanged; existing orchestrator prompt unchanged | Doesn't reduce stage count |
| B.2 — Merge `b` stages into primary stage | 26 | Reduces retrofit-suffix stages from 8 to 4 | Orchestrator prompt needs updates to the singleton-dispatch protocol; cache-hit fast-path becomes less explicit |

**Recommendation: B.1.** The reduction goal is met by collapsing the 8 cmd functions, not the stage count. The walker's `prepare → maybe-spawn-agent → consolidate` shape is one of the few places in the system where the stage model genuinely reflects the runtime — keep it. Revisit B.2 separately if helpful.

### Tasks

1. Read all 4 prepare/consolidate pairs; tabulate per-operation variance: cache key derivation, skip semantics, validator rules, fail-closed payload shape.
2. Draft the `SingletonDispatchSpec` dataclass and shared prepare/consolidate helpers based on the variance table.
3. Refactor `cmd_extract_signals_prepare` + `cmd_extract_signals_consolidate` first (smallest, simplest validator). Golden-fixture parity must hold.
4. Refactor `cmd_coverage_critic_prepare` + `cmd_coverage_critic_consolidate`. Verify Phase 8 spawn-spec flow still receives correct coverage plan.
5. Refactor `cmd_verify_prepare` + `cmd_verify_consolidate`. This is the largest pair; expect the most edge cases.
6. Refactor `cmd_review_dismissed_prepare` + `cmd_review_dismissed_consolidate`.
7. Collapse test duplication: extract shared-shape test class; keep 4 small operation-specific test classes for validator/fail-closed semantics.
8. Verify all golden fixtures unchanged.
9. Update CHANGELOG.

### Risks

| Risk | Mitigation |
|---|---|
| Over-abstraction obscures per-operation semantics | Keep validator + fail-closed-payload as per-op callbacks; only scaffolding is shared |
| Subtle behavior drift in cache key handling | Task 1 catalogues per-op cache semantics; refactor preserves exact key shape |
| Test compression loses coverage of edge cases | Golden fixtures provide end-to-end safety net; shared-shape tests must include error paths |
| Verifier's complexity (`cmd_verify_consolidate` is 295 LOC, the largest consolidate) doesn't fit the shape | Decision point: if forcing it costs more than it saves, leave verify-prepare/consolidate as-is and ship the other 3 pairs |

### Open questions

- **Should `cmd_load_available_reviewers` (stage_14a) also use this shape?** It's not an LLM dispatch, just a deterministic config loader — likely NOT a singleton-dispatch fit. Confirm during Task 1.
- **What's the right module boundary for the new helpers?** Inline in `code_review_helpers.py` for now; revisit if/when E (helpers file split) happens.

---

## Phase C: Coverage artifact consolidation

**Target version:** `2.26.0`
**Estimated impact:** ~200 LOC removed; 4 fewer wire-format contracts.
**Risk:** Medium — every stage that reads coverage state changes import shape.

### Goal

Consolidate the 6 coverage-decision artifacts into 2:

**Before:**
- `coverage_plan_initial.json` (pre-critic plan from stage_14)
- `coverage_plan.json` (post-critic, post-arbitrate plan)
- `coverage_verify.json` (verify verdict)
- `coverage_gaps.json` (gaps surfaced during run)
- `coverage_critic_manifest.json` (singleton dispatch manifest — eliminated by Phase B if it uses unified manifests)
- `pln725_coverage_critic.json` (raw agent output)

**After:**
- `coverage.json` (consolidated state with sections)
- `coverage_gaps.json` (unchanged — different lifecycle, written by multiple stages)

### Proposed `coverage.json` shape

```json
{
  "initial": { ... },     // initial plan from stage_14
  "critic": {
    "status": "cache_hit" | "skipped" | "needs_agent" | "completed" | "fail_closed",
    "skip_reason": "no-critic" | "no-roster" | "no-candidates" | null,
    "raw_agent_output": { ... } | null,    // only on completed
    "accepted_additions": [ ... ],         // only on completed
    "rejected_additions": [ ... ]          // only on completed
  },
  "final": { ... },       // post-consolidate, post-arbitrate plan
  "verify": {
    "verdict": "PASS" | "BLOCKING",
    "violations": [ ... ]
  },
  "arbitrate": {
    "status": "applied" | "blocked_by_verify" | "fallback",
    "budget": { ... },
    "dropped_required": [ ... ]
  }
}
```

### Files touched

- `plugins/code-review/tools/python/code_review_helpers.py` — every coverage-stage cmd function (extract-signals, resolve-coverage, coverage-critic-prepare/consolidate, verify-coverage, arbitrate-budget, derive-spawn-spec) updated to read from / write to the consolidated `coverage.json`.
- `plugins/code-review/config/stages.json` — `expected_outputs` updated.
- `plugins/code-review/tools/python/test_code_review_helpers.py` — fixture updates throughout coverage-related tests.
- `plugins/code-review/tools/python/fixtures/golden_*/expected/` — re-record any golden that snapshots coverage artifacts.
- `plugins/code-review/SCHEMA.md` — documentation update for new artifact shape.

### Tasks

1. **Pre-flight: grep the entire monorepo** (not just `code-review`) for `coverage_plan.json`, `coverage_plan_initial.json`, `coverage_verify.json`, `coverage_critic_manifest.json`, `pln725_coverage_critic.json`. Anything outside `plugins/code-review/` is a blocker — surface for discussion before proceeding.
2. Define the new `coverage.json` schema in `code_review_schema.py`.
3. Add a `CoverageState` reader/writer helper that handles section access (and validates section presence per stage).
4. Refactor `cmd_resolve_coverage` to write `coverage.json.initial`.
5. Refactor `cmd_coverage_critic_prepare`/`_consolidate` to read/write `coverage.json.critic`.
6. Refactor `cmd_verify_coverage` to read `coverage.json.{initial,final}` and write `coverage.json.verify`.
7. Refactor `cmd_arbitrate_budget` to read `coverage.json.verify` and write `coverage.json.{final,arbitrate}`.
8. Refactor `cmd_derive_spawn_spec` to read `coverage.json.final`.
9. Re-record golden fixtures; verify presenter output unchanged.
10. Update `SCHEMA.md` and CHANGELOG.

### Risks

| Risk | Mitigation |
|---|---|
| External consumer outside `plugins/code-review/` reads one of the eliminated artifacts | Task 1 pre-flight; if found, bump to MAJOR and provide a compat shim or pause this phase |
| Concurrent writes to one `coverage.json` cause races | Each stage writes a distinct section; we'll use read-modify-write with a section guard (assert other sections unchanged) to catch ordering bugs |
| Golden fixtures re-recorded incorrectly | Verify the consolidated output is semantically equivalent to the union of the old files before recording |

### Open questions

- **Do we keep `pln725_coverage_critic.json` as the LLM's raw output file for debuggability, or inline it under `coverage.json.critic.raw_agent_output`?** Inlining loses easy `cat`-ability for triage. Recommend inlining but keeping the `coverage.json.critic.raw_agent_output` field optional and human-readable.
- **Should `coverage_gaps.json` move under `coverage.json.gaps`?** No — `coverage_gaps.json` is written by multiple stages across the pipeline (spawn-verification appends gaps too); keeping it separate preserves single-writer semantics per section in `coverage.json`.

---

## Phase D: Spawn decision consolidation

**Target version:** `2.27.0`
**Estimated impact:** ~100 LOC removed; 2 fewer wire-format contracts.
**Risk:** Low — recent code, fewer downstream consumers, presenter already unified.

### Goal

Consolidate the 3 spawn-decision artifacts into 1:

**Before:**
- `route.json` — model routing decision, fast_path flag
- `spawn_spec.json` — flat list of agent descriptors
- `spawn_verification.json` — post-spawn coverage-gap check

**After:**
- `spawn.json` — consolidated with sections

### Proposed `spawn.json` shape

```json
{
  "route": {
    "fast_path": false,
    "max_bha_agents": 5,
    "models": { ... }
  },
  "spec": {
    "arbitrate_status": "applied" | "blocked_by_verify" | "fallback",
    "fallback_reason": null,
    "agents": [
      { "agent_id": "bha_p0", "reviewer": "...", "model": "...", "partitioned": true, ... }
    ],
    "skipped": [ ... ],
    "stats": { "agent_count": 5, ... }
  },
  "verification": {
    "present_ids": [ ... ],
    "missing": [ ... ],
    "present_count": 5,
    "intended_count": 5
  }
}
```

### Files touched

- `plugins/code-review/tools/python/code_review_helpers.py` — `cmd_route`, `cmd_derive_spawn_spec`, `cmd_verify_spawn`, `cmd_render_fleet_summary` updated. The renderer is the largest user-facing change since it consumes all three sources today.
- `plugins/code-review/config/stages.json` — `expected_outputs` updated.
- `plugins/code-review/commands/start.md` — orchestrator prompt instructions updated for `spawn.json` instead of the three separate files.
- `plugins/code-review/skills/present-local/SKILL.md` — renderer invocation updated if its CLI args change.
- `plugins/code-review/prompts/github-review.md` — same renderer invocation update.
- `plugins/code-review/tools/python/test_code_review_helpers.py` — Phase 9 fleet-summary tests updated for new input shape.

### Tasks

1. **Pre-flight: grep the monorepo** for `route.json`, `spawn_spec.json`, `spawn_verification.json`. Phase 9 just landed so external consumption is unlikely, but verify.
2. Define `spawn.json` schema in `code_review_schema.py`.
3. Refactor `cmd_route` to write `spawn.json.route`.
4. Refactor `cmd_derive_spawn_spec` to read `spawn.json.route` and write `spawn.json.spec`.
5. Refactor `cmd_verify_spawn` to read `spawn.json.spec` and write `spawn.json.verification`.
6. Refactor `cmd_render_fleet_summary` to read `spawn.json` (single file, three sections).
7. Update orchestrator prompt and skill/prompt invocations.
8. Verify Phase 9 fleet summary output is byte-identical for the standard fixture.
9. Update CHANGELOG.

### Risks

| Risk | Mitigation |
|---|---|
| `route.json` is consumed early (Gate B in `start.md`) and may be read before the rest of `spawn.json` exists | The orchestrator already writes `route.json` first; with consolidation, `spawn.json.route` is written first and other sections appended later. The reader can tolerate missing sections. |
| Fleet summary renderer regressions | Phase 9 test suite is comprehensive; run all `TestPLN725Phase9*` classes |

### Open questions

- **Should `route.json` be eliminated entirely, or kept as a thin pointer / alias for the operator's `cat` ergonomics?** Eliminate. The presenter already abstracts the file location.
- **Is the orchestrator's Gate B path complicated by `spawn.json` being partially written?** No — Gate B only needs `route` section; the orchestrator writes that and reads it before any other section exists.

---

## Estimated totals

| Metric | Before | After A–D | Delta |
|---|---|---|---|
| `code_review_helpers.py` LOC | 13,152 | ~10,800 | **-18%** |
| `test_code_review_helpers.py` LOC | 17,493 | ~16,300 | **-7%** |
| `cmd_*` functions | 44 | ~40 | -4 |
| Walker stages | 30 | 30 (B.1) / 26 (B.2) | 0 to -4 |
| `<CR_DIR>/*.json` artifacts | 34 | ~24 | **-29%** |
| Largest single function | 894 LOC (`_build_run_plan_stages`) | ~30 LOC (loader) | **-97%** |

After A–D land, the remaining complexity reflects actual phases of the review pipeline, not config-as-code or artifact sprawl.

## Open questions across phases

1. **Should this plan move to a ClosedLoop PLN document?** Recommend yes once we've agreed on shape; this markdown is the working draft.
2. **Branch strategy?** One `refactor/code-review-crs-phase-{A,B,C,D}` branch per phase, or a longer-lived `refactor/code-review-simplification` branch with merged phases? Recommend per-phase branches for clean review and easy revert.
3. **Should we land `unifiedReviewers` rule pruning (the audit's "what's not paying for itself" workstream) before or after CRS?** Separate workstream; can run in parallel since it touches reviewer prompts, not the structural code we're simplifying here.
