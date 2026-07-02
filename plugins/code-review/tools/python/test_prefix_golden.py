"""PLN-1229 Phase 0 / P0-A + P0-B — end-to-end prefix golden tests.

These pin the intermediate artifacts the deterministic prefix produces so the
``run-prefix`` batch runner (Phases 1-2) can be proven byte-identical against
the current per-stage walk. The suite walks the whole deterministic prefix
(stages 01→19b, stopping at the reviewer fleet) across a fixture matrix that
covers the branches the refactor must preserve: standard/partitioned,
fast-path, hygiene-only (Gate A), empty-diff, cache-hit, and since-last-review.

The committed snapshots under ``prefix_fixtures/<name>/expected/`` are a
long-term drift net; ``pytest --update-golden`` regenerates them in place after
an intentional change. The determinism test is the independent oracle: it never
reads ``expected/``, so a snapshot that happens to be wrong-but-stable still has
to survive human review of the committed golden.
"""

from __future__ import annotations

import difflib
from collections.abc import Callable
from pathlib import Path

import pytest

from prefix_golden_harness import (
    PREFIX_ARTIFACTS,
    PRE_SINGLETON_STOP_STAGE,
    PrefixFixture,
    PrefixRun,
    cache_hit_fixture,
    coverage_critic_fixture,
    empty_diff_fixture,
    fast_path_fixture,
    hygiene_only_fixture,
    run_prefix_fixture,
    run_prefix_fixture_subprocess,
    run_prefix_fixture_via_runner,
    since_last_review_fixture,
    standard_fixture,
)

_PREFIX_FIXTURES_ROOT = Path(__file__).parent / "prefix_fixtures"

# The full fixture matrix (P0-B). Each entry's ``name`` is also its golden dir
# under prefix_fixtures/<name>/expected/.
_FIXTURE_FACTORIES: dict[str, Callable[[], PrefixFixture]] = {
    "golden_prefix_standard": standard_fixture,
    "golden_prefix_fast_path": fast_path_fixture,
    "golden_prefix_hygiene_only": hygiene_only_fixture,
    "golden_prefix_empty_diff": empty_diff_fixture,
    "golden_prefix_cache_hit": cache_hit_fixture,
    "golden_prefix_since_last_review": since_last_review_fixture,
    "golden_prefix_coverage_critic": coverage_critic_fixture,
}

_ALL_FIXTURES = list(_FIXTURE_FACTORIES)


def _expected_dir(name: str) -> Path:
    return _PREFIX_FIXTURES_ROOT / name / "expected"


def _statuses(run: PrefixRun) -> dict[str, str]:
    return {r.stage_id: r.status for r in run.results}


# ---------------------------------------------------------------------------
# Branch-specific structural guards (independent of the byte-level golden)
# ---------------------------------------------------------------------------


def test_standard_runs_partition_non_fast_path(tmp_path: Path) -> None:
    """>200 LOC → route picks non-fast-path → partition runs, spawn spec derived."""
    run = run_prefix_fixture(tmp_path, standard_fixture())
    statuses = _statuses(run)
    assert statuses.get("stage_17_partition") == "ran"
    assert statuses.get("stage_19b_derive_spawn_spec") == "ran"
    assert "partitions.json" in run.snapshots
    # route wrote a non-fast-path decision into spawn.json.
    assert '"fast_path": false' in run.snapshots["spawn.json"]
    # extract-signals ran the healthy agent-driven path (stub accepted).
    assert '"status": "ok"' in run.snapshots["extract_signals.json"]


def test_fast_path_skips_partition(tmp_path: Path) -> None:
    """≤200 LOC → route picks fast-path → partition skipped, no partitions.json."""
    run = run_prefix_fixture(tmp_path, fast_path_fixture())
    statuses = _statuses(run)
    assert statuses.get("stage_17_partition") == "skipped_fast_path"
    assert "partitions.json" not in run.snapshots
    assert '"fast_path": true' in run.snapshots["spawn.json"]


def test_hygiene_only_exits_at_gate_a(tmp_path: Path) -> None:
    """Hygiene-only stops after stage_12 (Gate A) — no signals/coverage/route."""
    run = run_prefix_fixture(tmp_path, hygiene_only_fixture())
    statuses = _statuses(run)
    assert statuses.get("stage_12_hygiene") == "ran"
    assert "stage_11_extract_signals" not in statuses
    assert "stage_19_cache_check" not in statuses
    # Only the pre-hygiene artifacts exist; nothing coverage/partition-related.
    assert "coverage.json" not in run.snapshots
    assert "partitions.json" not in run.snapshots
    assert "spawn.json" not in run.snapshots


def test_empty_diff_reviews_no_files(tmp_path: Path) -> None:
    """Base-only repo → empty diff → degenerate (fast-path) prefix still completes."""
    run = run_prefix_fixture(tmp_path, empty_diff_fixture())
    diff = run.snapshots["diff_data.json"]
    assert '"files_to_review": []' in diff
    assert '"total_loc": 0' in diff
    # 0 LOC ≤ 200 → fast path → partition skipped.
    assert _statuses(run).get("stage_17_partition") == "skipped_fast_path"


def test_cache_hit_produces_uncached_subset(tmp_path: Path) -> None:
    """Warm cache → cache-check reports a hit and narrows the uncached set."""
    run = run_prefix_fixture(tmp_path, cache_hit_fixture())
    cache_result = run.snapshots["cache_result.json"]
    assert '"cached": 1' in cache_result
    # The cached file drops out of the uncached diff that partition consumes.
    assert "src/app.py" in run.snapshots["uncached_diff_data.json"]
    assert "src/constants.py" not in run.snapshots["uncached_diff_data.json"]
    # The cached finding actually replays into agent_cached_bha.json — the
    # payload that later skips BHA re-review and feeds collect-findings.
    assert "agent_cached_bha.json" in run.snapshots
    replay = run.snapshots["agent_cached_bha.json"]
    assert "src/constants.py" in replay
    assert "magic constant should be named" in replay


def test_coverage_critic_singleton_consolidates(tmp_path: Path) -> None:
    """A planted roster drives stage_15 to needs_agent → consolidates the stub.

    Exercises the second PLN-725 singleton's agent-driven path (the other
    fixtures leave the roster empty, so stage_15 always skips).
    """
    run = run_prefix_fixture(tmp_path, coverage_critic_fixture())
    statuses = _statuses(run)
    assert statuses.get("stage_15_coverage_critic") == "ran"
    assert statuses.get("stage_15b_coverage_critic_consolidate") == "ran"
    coverage = run.snapshots["coverage.json"]
    # The prepare stage emitted the spawn manifest (needs_agent), and the
    # consolidated stub's proposed reviewer survived into the plan as a critic
    # addition — i.e. the agent output was accepted, not fail-closed. (The
    # transient final.critic_status is overwritten by stage_16 arbitrate-budget,
    # so we assert on the merged reviewer + absence of the fail-closed finding.)
    assert '"status": "needs_agent"' in coverage
    assert "security-critic" in coverage
    assert '"source": "critic"' in coverage
    assert "agent_coverage-critic-failed.json" not in run.all_artifacts
    assert "security-critic" in run.snapshots["available_reviewers.json"]


def test_since_last_review_overrides_diff_scope(tmp_path: Path) -> None:
    """Prior review state → auto-incremental narrows the scope to base...HEAD."""
    run = run_prefix_fixture(tmp_path, since_last_review_fixture())
    auto = run.snapshots["auto_incremental.json"]
    # A non-null incremental scope override was produced (base_sha...HEAD).
    assert '"diff_scope": null' not in auto
    assert "since-last-review" in auto.lower() or "incremental" in auto.lower()


# ---------------------------------------------------------------------------
# Determinism oracle — two independent runs must be byte-identical
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", _ALL_FIXTURES)
def test_prefix_is_deterministic(name: str, tmp_path: Path) -> None:
    """Two independent runs produce byte-identical normalized snapshots.

    Uses two sibling temp roots so absolute paths differ pre-normalization —
    proving the path scrubs (cr_dir / repo / home / plugin root) neutralize
    them. This is the parity oracle's foundation: a non-deterministic per-stage
    walk could never be matched by a batched runner.
    """
    factory = _FIXTURE_FACTORIES[name]
    run_a = run_prefix_fixture(tmp_path / "a", factory())
    run_b = run_prefix_fixture(tmp_path / "b", factory())

    assert set(run_a.snapshots) == set(run_b.snapshots)
    for artifact in run_a.snapshots:
        assert run_a.snapshots[artifact] == run_b.snapshots[artifact], (
            f"non-deterministic artifact {artifact!r} in {name!r}:\n"
            + "\n".join(
                difflib.unified_diff(
                    run_a.snapshots[artifact].splitlines(),
                    run_b.snapshots[artifact].splitlines(),
                    lineterm="",
                )
            )
        )


# ---------------------------------------------------------------------------
# Committed-golden comparison
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", _ALL_FIXTURES)
def test_prefix_matches_golden(name: str, tmp_path: Path, update_golden: bool) -> None:
    """Each normalized artifact matches its committed ``expected/`` snapshot."""
    run = run_prefix_fixture(tmp_path, _FIXTURE_FACTORIES[name]())
    expected_dir = _expected_dir(name)

    if update_golden:
        expected_dir.mkdir(parents=True, exist_ok=True)
        for existing in expected_dir.iterdir():
            if existing.is_file() and existing.name not in run.snapshots:
                existing.unlink()
        for artifact, text in run.snapshots.items():
            (expected_dir / artifact).write_text(text)
        return

    assert expected_dir.exists(), (
        f"golden dir {expected_dir} missing — run pytest --update-golden"
    )

    diffs: list[str] = []
    committed = {p.name for p in expected_dir.iterdir() if p.is_file()}
    if committed != set(run.snapshots):
        diffs.append(
            f"artifact set drift: committed={sorted(committed)} "
            f"produced={sorted(run.snapshots)}"
        )
    for artifact, actual in run.snapshots.items():
        expected_path = expected_dir / artifact
        if not expected_path.exists():
            diffs.append(f"{artifact}: no committed golden (run --update-golden)")
            continue
        expected = expected_path.read_text()
        if actual != expected:
            diffs.append(
                "\n".join(
                    difflib.unified_diff(
                        expected.splitlines(),
                        actual.splitlines(),
                        fromfile=f"expected/{artifact}",
                        tofile=f"actual/{artifact}",
                        lineterm="",
                    )
                )
            )
    assert not diffs, f"[{name}] prefix artifact drift:\n" + "\n\n".join(diffs)


# ---------------------------------------------------------------------------
# Subprocess A/B parity oracle (PLN-1229 Phase 1)
# ---------------------------------------------------------------------------
#
# The refactor guarantee: run the deterministic prefix two ways and assert the
# artifacts are byte-identical (modulo review_id / timestamps / abs paths, which
# normalization scrubs). A-side is the subprocess-per-stage walk (what start.md
# does today); B-side is production ``run-prefix``. Both run the WHOLE
# deterministic prefix — including Gate B route + partition — and stop at the
# reviewer fleet, so the compared artifact set runs 01→derive-spawn-spec. A and
# B implement the walk WRAPPER independently, so a shared wrapper bug can't hide.

# The pause sequence each fixture drives run-prefix through, as
# ``<next_action>[:<singleton>]`` per emitted segment. Pins the resumable
# segment contract at the integration level (the two singletons almost always
# fire; hygiene-only is the one-segment Gate A exit; the terminal segment runs
# Gate B route + partition and returns ready_for_reviewers).
_EXPECTED_SEGMENTS: dict[str, list[str]] = {
    "golden_prefix_standard": [
        "needs_singleton:extract_signals", "ready_for_reviewers",
    ],
    "golden_prefix_fast_path": [
        "needs_singleton:extract_signals", "ready_for_reviewers",
    ],
    "golden_prefix_hygiene_only": ["hygiene_exit"],
    "golden_prefix_empty_diff": [
        "needs_singleton:extract_signals", "ready_for_reviewers",
    ],
    "golden_prefix_cache_hit": [
        "needs_singleton:extract_signals", "ready_for_reviewers",
    ],
    "golden_prefix_since_last_review": [
        "needs_singleton:extract_signals", "ready_for_reviewers",
    ],
    "golden_prefix_coverage_critic": [
        "needs_singleton:extract_signals",
        "needs_singleton:coverage_critic",
        "ready_for_reviewers",
    ],
}


def _segment_labels(statuses: list[dict[str, object]]) -> list[str]:
    labels: list[str] = []
    for status in statuses:
        action = str(status["next_action"])
        singleton = status.get("singleton")
        labels.append(f"{action}:{singleton}" if singleton else action)
    return labels


@pytest.mark.parametrize("name", _ALL_FIXTURES)
def test_run_prefix_matches_subprocess_walk(name: str, tmp_path: Path) -> None:
    """``run-prefix`` (B) produces the same artifacts as the per-stage walk (A)."""
    factory = _FIXTURE_FACTORIES[name]
    a_snaps = run_prefix_fixture_subprocess(tmp_path / "a", factory())
    b_snaps, statuses = run_prefix_fixture_via_runner(tmp_path / "b", factory())

    assert set(a_snaps) == set(b_snaps), (
        f"[{name}] artifact-set drift between per-stage walk and run-prefix:\n"
        f"  only in walk:      {sorted(set(a_snaps) - set(b_snaps))}\n"
        f"  only in run-prefix:{sorted(set(b_snaps) - set(a_snaps))}"
    )
    diffs: list[str] = []
    for artifact in sorted(a_snaps):
        if a_snaps[artifact] != b_snaps[artifact]:
            diffs.append(
                "\n".join(
                    difflib.unified_diff(
                        a_snaps[artifact].splitlines(),
                        b_snaps[artifact].splitlines(),
                        fromfile=f"per-stage-walk/{artifact}",
                        tofile=f"run-prefix/{artifact}",
                        lineterm="",
                    )
                )
            )
    assert not diffs, f"[{name}] run-prefix artifact drift:\n" + "\n\n".join(diffs)


@pytest.mark.parametrize("name", _ALL_FIXTURES)
def test_run_prefix_pause_sequence(name: str, tmp_path: Path) -> None:
    """``run-prefix`` pauses at exactly the expected decision points, in order."""
    _snaps, statuses = run_prefix_fixture_via_runner(tmp_path, _FIXTURE_FACTORIES[name]())
    assert _segment_labels(statuses) == _EXPECTED_SEGMENTS[name]
    # The final segment resolves the pipeline (no dangling needs_singleton).
    terminal = statuses[-1]
    assert terminal["next_action"] in ("ready_for_reviewers", "hygiene_exit")
    assert terminal["failed_stage"] is None
    # A ready_for_reviewers terminal carries the Gate B routing decision the
    # orchestrator prints without re-reading spawn.json.
    if terminal["next_action"] == "ready_for_reviewers":
        assert isinstance(terminal["fast_path"], bool)
        assert "cache_status_message" in terminal
        assert "max_bha_agents" in terminal
    # Every needs_singleton names the sibling consolidate stage to resume at.
    for status in statuses:
        if status["next_action"] == "needs_singleton":
            assert str(status["resume_stage"]).endswith("_consolidate")


# ---------------------------------------------------------------------------
# Coverage guards
# ---------------------------------------------------------------------------


def test_pre_singleton_stop_lands_on_gate_a(tmp_path: Path) -> None:
    """A pre-singleton-only walk stops exactly at the Gate A / hygiene boundary.

    Pins that stage_12_hygiene is the last stage before the first LLM singleton
    in array order — the property the run-prefix segment boundaries rely on.
    """
    run = run_prefix_fixture(
        tmp_path, standard_fixture(), stop_before=PRE_SINGLETON_STOP_STAGE,
    )
    statuses = _statuses(run)
    assert statuses.get("stage_12_hygiene") == "ran"
    assert "stage_11_extract_signals" not in statuses
    assert "coverage.json" not in run.snapshots


# Files the walk legitimately leaves in cr_dir that are NOT derived pipeline
# state and so are deliberately not snapshotted: the run plan, prompt-asset
# copies (verbatim plugin inputs), the PLN-725 agent input bundles + injected
# stubs, and the singleton fail-closed finding files (only on degradation).
_NON_STATE_ARTIFACTS = {
    "run_plan.json",
    "shared_prompt.txt",
    "bha_suffix.txt",
    "verifier_prompt.txt",
    "impact_analyzer_prompt.txt",
    "design_critic_suffix.txt",
    "coverage_critic_input.json",
    "coverage_critic_diff_summary.json",
    "extract_signals_input.json",
    "extract_signals_taxonomy.json",
    "pln725_extract_signals.json",
    "pln725_coverage_critic.json",
    "agent_signal-extraction-failed.json",
    "agent_coverage-critic-failed.json",
}


def _is_ignored_artifact(name: str) -> bool:
    """Non-state files: the explicit set plus per-partition patch files.

    ``patches_p<N>.txt`` is dynamically named (one per partition), so it is
    matched by pattern rather than enumerated — its content is already pinned
    via ``diff_data.json`` / ``patches_all.txt`` / ``partitions.json``.
    """
    if name in _NON_STATE_ARTIFACTS:
        return True
    return name.startswith("patches_p") and name.endswith(".txt")


def test_no_undeclared_state_artifacts(tmp_path: Path) -> None:
    """Every state file the walk writes is either snapshotted or explicitly ignored.

    Inspects the REAL cr_dir contents (run.all_artifacts), not the already-
    filtered snapshot set, so a new stage that starts writing an artifact nobody
    added to PREFIX_ARTIFACTS fails here — forcing a snapshot-or-ignore decision
    rather than silently escaping the drift net.
    """
    for name, factory in _FIXTURE_FACTORIES.items():
        run = run_prefix_fixture(tmp_path / name, factory())
        undeclared = {
            a for a in run.all_artifacts
            if a not in PREFIX_ARTIFACTS and not _is_ignored_artifact(a)
        }
        assert not undeclared, (
            f"[{name}] cr_dir has undeclared artifacts (add to PREFIX_ARTIFACTS "
            f"or _NON_STATE_ARTIFACTS): {sorted(undeclared)}"
        )
