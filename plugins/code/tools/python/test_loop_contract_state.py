"""State-file mutation contract tests for run-loop.sh.

Each scenario is a row in the ``cases`` table with
``{input, expected, validator?, dependencies}`` structure (AC-006).
All fixture constants and helpers are imported from the centralized mock
suite (AC-007).

The table covers (AC-001, AC-003):
  - Single successful iteration updates iteration counter and
    successful_iterations count.
  - Append-only runs.log entries include correct pipe-delimited fields.
  - Multi-iteration sequence produces state matching golden snapshot
    (with timestamp/run_id masking).
  - ``update_iteration()`` modifies only the ``iteration`` field in the YAML
    frontmatter.
  - ``update_successful_iterations()`` modifies only the
    ``successful_iterations`` field, and inserts the field when absent
    (legacy-state backward-compat path).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from test_loop_contract_mocks import (
    GOLDEN_RUNS_LOG_FULL_SEQUENCE,
    GOLDEN_RUNS_LOG_ITER1_SUCCESS,
    GOLDEN_STATE_AFTER_ITER1_SUCCESS,
    GOLDEN_STATE_AT_ITER4_MAX_ITERATIONS,
    RUN_LOOP,
    TIMESTAMP_PATTERN,
    build_state_file,
    run_bash,
    runs_log_file,
    state_dir,
    state_file_path,
    substitute_golden_tokens,
)

# ---------------------------------------------------------------------------
# Constants shared by all cases
# ---------------------------------------------------------------------------

FIXED_RUN_ID = "test-run-id-state-contract"
FIXED_TIMESTAMP = "2026-01-01T00:00:00Z"
FIXED_SESSION_ID = "sess-abc123"


# ---------------------------------------------------------------------------
# Normalisation helpers
# ---------------------------------------------------------------------------


def _mask_timestamps(text: str) -> str:
    """Replace ISO-8601 timestamps with the GOLDEN_TIMESTAMP placeholder."""
    return TIMESTAMP_PATTERN.sub("GOLDEN_TIMESTAMP", text)


def _mask_run_id(text: str, run_id: str) -> str:
    """Replace the actual run_id with the GOLDEN_RUN_ID placeholder."""
    return text.replace(run_id, "GOLDEN_RUN_ID")


def _mask_session_id(text: str, session_id: str) -> str:
    """Replace the actual session_id with the GOLDEN_SESSION_ID placeholder."""
    return text.replace(session_id, "GOLDEN_SESSION_ID")


def _normalise(text: str, *, run_id: str, session_id: str) -> str:
    """Apply all masking passes in one call."""
    text = _mask_run_id(text, run_id)
    text = _mask_timestamps(text)
    text = _mask_session_id(text, session_id)
    return text


# Path helpers delegate to mock suite (SSOT for path conventions)
_state_dir = state_dir
_state_file_path = state_file_path
_runs_log_path = runs_log_file


# ---------------------------------------------------------------------------
# Validator helpers
# ---------------------------------------------------------------------------


def _field_equals(field: str, expected_value: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that reads a field from the state file and compares."""

    def _validate(ctx: dict[str, Any]) -> None:
        state_path: Path = ctx["state_file_path"]
        result = run_bash(
            ctx["tmp_path"],
            script_body=(
                f'STATE_FILE="{state_path}" '
                f'source "{RUN_LOOP}"; '
                f'STATE_FILE="{state_path}"; '
                f'get_field "{field}"'
            ),
        )
        assert result.returncode == 0, (
            f"get_field({field!r}) failed: {result.stderr}"
        )
        assert result.stdout.strip() == expected_value, (
            f"get_field({field!r}): expected {expected_value!r}, "
            f"got {result.stdout.strip()!r}"
        )

    return _validate


def _state_matches_golden(golden: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that normalises the state file and compares to a golden.

    For state files the only non-deterministic field is ``run_id`` (randomised
    in production but pinned to FIXED_RUN_ID in tests) and ``workdir`` (the
    pytest tmp_path).  Timestamps are deterministic because build_state_file()
    uses a fixed ``started_at`` value, so they are NOT masked here — masking
    them would break the comparison against golden fixtures that contain the
    literal ``2026-01-01T00:00:00Z``.
    """

    def _validate(ctx: dict[str, Any]) -> None:
        state_path: Path = ctx["state_file_path"]
        actual = state_path.read_text()
        # Replace only the pinned run_id with GOLDEN_RUN_ID placeholder
        normalised = _mask_run_id(actual, ctx["run_id"])
        # Substitute golden tokens: replace /test/workdir with actual tmp_path
        expected = substitute_golden_tokens(
            golden, run_id="GOLDEN_RUN_ID", workdir=str(ctx["tmp_path"])
        )
        assert normalised == expected, (
            f"State file mismatch.\nExpected:\n{expected}\nActual (normalised):\n{normalised}"
        )

    return _validate


def _runs_log_matches_golden(golden: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that normalises runs.log and compares to a golden."""

    def _validate(ctx: dict[str, Any]) -> None:
        log_path = _runs_log_path(ctx["tmp_path"])
        assert log_path.exists(), "runs.log was not created"
        actual = log_path.read_text()
        normalised = _normalise(
            actual, run_id=ctx["run_id"], session_id=ctx["session_id"]
        )
        assert normalised == golden, (
            f"runs.log mismatch.\nExpected:\n{golden}\nActual (normalised):\n{normalised}"
        )

    return _validate


def _runs_log_fields_validator(
    expected_iteration: int,
    expected_status: str,
    expected_command: str = "plan_execute",
) -> Callable[[dict[str, Any]], None]:
    """Return a validator checking pipe-delimited fields in the latest runs.log entry."""

    def _validate(ctx: dict[str, Any]) -> None:
        log_path = _runs_log_path(ctx["tmp_path"])
        assert log_path.exists(), "runs.log was not created"
        lines = [ln for ln in log_path.read_text().splitlines() if ln.strip()]
        assert lines, "runs.log is empty"
        last = lines[-1]
        fields = last.split("|")
        # Minimum 7 fields: run_id|timestamp|goal|iteration|status|command|session_id
        assert len(fields) >= 7, (
            f"Expected at least 7 pipe-delimited fields, got {len(fields)}: {last!r}"
        )
        assert fields[0] == ctx["run_id"], (
            f"Field[0] (run_id): expected {ctx['run_id']!r}, got {fields[0]!r}"
        )
        assert TIMESTAMP_PATTERN.match(fields[1]), (
            f"Field[1] (timestamp) is not ISO-8601: {fields[1]!r}"
        )
        assert fields[2] == "reduce-failures", (
            f"Field[2] (goal): expected 'reduce-failures', got {fields[2]!r}"
        )
        assert fields[3] == str(expected_iteration), (
            f"Field[3] (iteration): expected {expected_iteration!r}, "
            f"got {fields[3]!r}"
        )
        assert fields[4] == expected_status, (
            f"Field[4] (status): expected {expected_status!r}, got {fields[4]!r}"
        )
        assert fields[5] == expected_command, (
            f"Field[5] (command): expected {expected_command!r}, got {fields[5]!r}"
        )

    return _validate


# ---------------------------------------------------------------------------
# Executor helpers (called by the parametrised test body)
# ---------------------------------------------------------------------------


def _run_update_iteration(tmp_path: Path, *, run_id: str, new_iter: int) -> None:
    """Write a state file and call update_iteration(new_iter)."""
    state_path = _state_file_path(tmp_path)
    state_path.write_text(
        build_state_file(
            tmp_path,
            iteration=1,
            successful_iterations=0,
            run_id=run_id,
            max_iterations=4,
            start_sha="abc1234",
        )
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_iteration {new_iter}'
        ),
    )
    assert result.returncode == 0, f"update_iteration failed: {result.stderr}"


def _run_update_successful_iterations(
    tmp_path: Path, *, run_id: str, new_count: int, has_field: bool = True
) -> None:
    """Write a state file and call update_successful_iterations(new_count).

    When has_field=False the state file omits successful_iterations to exercise
    the backward-compat insert path.
    """
    state_path = _state_file_path(tmp_path)
    if has_field:
        state_path.write_text(
            build_state_file(
                tmp_path,
                iteration=2,
                successful_iterations=0,
                run_id=run_id,
                max_iterations=4,
                start_sha="abc1234",
            )
        )
    else:
        # Legacy state file format — no successful_iterations field.
        state_path.write_text(
            "---\n"
            f"iteration: 2\n"
            f"max_iterations: 4\n"
            f"run_id: {run_id}\n"
            'command: "plan_execute"\n'
            f"workdir: {tmp_path}\n"
            "start_sha: abc1234\n"
            "self_learning: false\n"
            "completion_promise: COMPLETE\n"
            "started_at: 2026-01-01T00:00:00Z\n"
            "---\n"
        )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_successful_iterations {new_count}'
        ),
    )
    assert result.returncode == 0, (
        f"update_successful_iterations failed: {result.stderr}"
    )


def _run_write_runs_log_entry(
    tmp_path: Path,
    *,
    run_id: str,
    iteration: int,
    status: str,
    session_id: str,
    success_count: str = "",
) -> None:
    """Call write_runs_log_entry() via bash with the given arguments."""
    success_count_arg = f' "{success_count}"' if success_count else ""
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'RUN_ID="{run_id}"; '
            f'CLOSEDLOOP_ACTIVE_GOAL="reduce-failures"; '
            f'write_runs_log_entry "{tmp_path}" {iteration} '
            f'"{status}" "plan_execute" "{session_id}"{success_count_arg}'
        ),
    )
    assert result.returncode == 0, f"write_runs_log_entry failed: {result.stderr}"


def _run_full_sequence(
    tmp_path: Path, *, run_id: str, session_id: str
) -> None:
    """Drive the full 4-iteration state sequence using individual bash calls.

    Sequence:
      1. Iteration 1 success: write iter-1 runs.log entry, update_iteration(2),
         update_successful_iterations(1).
      2. Iteration 2 spurious: update_successful_iterations(2), write iter-2
         runs.log entry.  (iteration counter stays at 2 — handle_spurious_complete
         does not call update_iteration.)
      3. Iteration 3 success: write iter-3 runs.log entry, update_iteration(4),
         update_successful_iterations(3).
      4. Iteration 4 max-iterations: update_iteration(5), write iter-4 runs.log
         entry with 8th field = "3" (the live successful_iterations at that
         point — three successful iterations have completed, and run-loop.sh
         emits that same persisted value as the 8th runs.log field).
    """
    state_path = _state_file_path(tmp_path)
    state_path.write_text(
        build_state_file(
            tmp_path,
            iteration=1,
            successful_iterations=0,
            run_id=run_id,
            max_iterations=4,
            start_sha="abc1234",
        )
    )

    # --- Iteration 1 success ---
    _run_write_runs_log_entry(
        tmp_path, run_id=run_id, iteration=1, status="in_progress", session_id=session_id
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_iteration 2; '
            f'update_successful_iterations 1'
        ),
    )
    assert result.returncode == 0, f"iter1 state update failed: {result.stderr}"

    # --- Iteration 2 spurious complete ---
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_successful_iterations 2'
        ),
    )
    assert result.returncode == 0, f"iter2 spurious update failed: {result.stderr}"
    _run_write_runs_log_entry(
        tmp_path,
        run_id=run_id,
        iteration=2,
        status="spurious_complete",
        session_id=session_id,
    )

    # --- Iteration 3 success ---
    _run_write_runs_log_entry(
        tmp_path, run_id=run_id, iteration=3, status="in_progress", session_id=session_id
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_iteration 4; '
            f'update_successful_iterations 3'
        ),
    )
    assert result.returncode == 0, f"iter3 state update failed: {result.stderr}"

    # --- Iteration 4 max-iterations ---
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'update_iteration 5'
        ),
    )
    assert result.returncode == 0, f"iter4 iteration update failed: {result.stderr}"
    _run_write_runs_log_entry(
        tmp_path,
        run_id=run_id,
        iteration=5,
        status="max_iterations",
        session_id=session_id,
        success_count="3",
    )


def _run_single_success_update(tmp_path: Path, *, run_id: str) -> None:
    """Write initial state and apply update_iteration(2) + update_successful_iterations(1)."""
    sp = _state_file_path(tmp_path)
    sp.write_text(
        build_state_file(
            tmp_path,
            iteration=1,
            successful_iterations=0,
            run_id=run_id,
            max_iterations=4,
            start_sha="abc1234",
        )
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{sp}"; '
            f'update_iteration 2; '
            f'update_successful_iterations 1'
        ),
    )
    assert result.returncode == 0, f"single success update failed: {result.stderr}"


def _verify_log_statuses_in_order(
    expected_statuses: list[str],
) -> Callable[[dict[str, Any]], None]:
    """Return a validator that reads runs.log and asserts status fields match in order."""

    def _validate(ctx: dict[str, Any]) -> None:
        lines = [
            ln
            for ln in _runs_log_path(ctx["tmp_path"]).read_text().splitlines()
            if ln.strip()
        ]
        _verify_log_order(lines, expected_statuses)

    return _validate


# ---------------------------------------------------------------------------
# Parametrized cases table
#
# Schema per row:
#   id           - human-readable scenario label (used in pytest -v output)
#   setup        - callable(tmp_path, run_id, session_id) that drives the
#                  bash state mutations before validation.
#   expected     - full expected string or None when validator handles it.
#   validator    - callable(ctx) → None; ctx is a dict with keys:
#                    tmp_path, state_file_path, run_id, session_id
#                  Used instead of expected when set.
#   dependencies - list of mock-suite constant names referenced (documentation
#                  only; constants are imported at module level per CLAUDE.md).
# ---------------------------------------------------------------------------

cases = [
    # ------------------------------------------------------------------
    # update_iteration() sets the iteration field to the new value
    # ------------------------------------------------------------------
    {
        "id": "update_iteration_sets_field",
        "setup": lambda tmp_path, run_id, _sid: _run_update_iteration(
            tmp_path, run_id=run_id, new_iter=3
        ),
        "expected": None,
        "validator": _field_equals("iteration", "3"),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # update_iteration() leaves successful_iterations unchanged
    # ------------------------------------------------------------------
    {
        "id": "update_iteration_leaves_successful_iterations_intact",
        "setup": lambda tmp_path, run_id, _sid: _run_update_iteration(
            tmp_path, run_id=run_id, new_iter=5
        ),
        "expected": None,
        "validator": _field_equals("successful_iterations", "0"),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # update_successful_iterations() sets the field correctly
    # ------------------------------------------------------------------
    {
        "id": "update_successful_iterations_sets_field",
        "setup": lambda tmp_path, run_id, _sid: _run_update_successful_iterations(
            tmp_path, run_id=run_id, new_count=3
        ),
        "expected": None,
        "validator": _field_equals("successful_iterations", "3"),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # update_successful_iterations() leaves iteration unchanged
    # ------------------------------------------------------------------
    {
        "id": "update_successful_iterations_leaves_iteration_intact",
        "setup": lambda tmp_path, run_id, _sid: _run_update_successful_iterations(
            tmp_path, run_id=run_id, new_count=2
        ),
        "expected": None,
        "validator": _field_equals("iteration", "2"),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # update_successful_iterations() inserts field when absent (legacy state)
    # ------------------------------------------------------------------
    {
        "id": "update_successful_iterations_inserts_when_absent",
        "setup": lambda tmp_path, run_id, _sid: _run_update_successful_iterations(
            tmp_path, run_id=run_id, new_count=1, has_field=False
        ),
        "expected": None,
        "validator": _field_equals("successful_iterations", "1"),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # Single successful iteration: state matches golden snapshot after
    # update_iteration(2) + update_successful_iterations(1)
    # ------------------------------------------------------------------
    {
        "id": "single_success_state_matches_golden",
        "setup": lambda tmp_path, run_id, _sid: _run_single_success_update(
            tmp_path, run_id=run_id
        ),
        "expected": None,
        "validator": _state_matches_golden(GOLDEN_STATE_AFTER_ITER1_SUCCESS),
        "dependencies": ["GOLDEN_STATE_AFTER_ITER1_SUCCESS"],
    },
    # ------------------------------------------------------------------
    # write_runs_log_entry() produces correct pipe-delimited fields
    # ------------------------------------------------------------------
    {
        "id": "runs_log_entry_has_correct_fields",
        "setup": lambda tmp_path, run_id, session_id: _run_write_runs_log_entry(
            tmp_path,
            run_id=run_id,
            iteration=1,
            status="in_progress",
            session_id=session_id,
        ),
        "expected": None,
        "validator": _runs_log_fields_validator(
            expected_iteration=1,
            expected_status="in_progress",
            expected_command="plan_execute",
        ),
        "dependencies": ["GOLDEN_RUNS_LOG_ITER1_SUCCESS"],
    },
    # ------------------------------------------------------------------
    # Single runs.log entry matches golden template
    # ------------------------------------------------------------------
    {
        "id": "runs_log_single_entry_matches_golden",
        "setup": lambda tmp_path, run_id, session_id: _run_write_runs_log_entry(
            tmp_path,
            run_id=run_id,
            iteration=1,
            status="in_progress",
            session_id=session_id,
        ),
        "expected": None,
        "validator": _runs_log_matches_golden(GOLDEN_RUNS_LOG_ITER1_SUCCESS),
        "dependencies": ["GOLDEN_RUNS_LOG_ITER1_SUCCESS"],
    },
    # ------------------------------------------------------------------
    # Append-only: three entries appear in insertion order
    # ------------------------------------------------------------------
    {
        "id": "runs_log_append_only_order",
        "setup": lambda tmp_path, run_id, session_id: (
            _run_write_runs_log_entry(
                tmp_path,
                run_id=run_id,
                iteration=1,
                status="in_progress",
                session_id=session_id,
            ),
            _run_write_runs_log_entry(
                tmp_path,
                run_id=run_id,
                iteration=2,
                status="spurious_complete",
                session_id=session_id,
            ),
            _run_write_runs_log_entry(
                tmp_path,
                run_id=run_id,
                iteration=3,
                status="in_progress",
                session_id=session_id,
            ),
        ),
        "expected": None,
        "validator": _verify_log_statuses_in_order(
            ["in_progress", "spurious_complete", "in_progress"]
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # Iteration-4 max-iterations entry includes 8th field (success_count)
    # ------------------------------------------------------------------
    {
        "id": "runs_log_max_iterations_has_success_count_field",
        "setup": lambda tmp_path, run_id, session_id: _run_write_runs_log_entry(
            tmp_path,
            run_id=run_id,
            iteration=5,
            status="max_iterations",
            session_id=session_id,
            success_count="3",
        ),
        "expected": None,
        "validator": (
            lambda ctx: _assert_runs_log_has_nth_field(
                ctx, field_index=7, expected_value="3"
            )
        ),
        "dependencies": ["GOLDEN_RUNS_LOG_ITER4_MAX_ITERATIONS"],
    },
    # ------------------------------------------------------------------
    # Multi-iteration sequence: full runs.log matches golden snapshot
    # ------------------------------------------------------------------
    {
        "id": "multi_iteration_runs_log_matches_golden",
        "setup": lambda tmp_path, run_id, session_id: _run_full_sequence(
            tmp_path, run_id=run_id, session_id=session_id
        ),
        "expected": None,
        "validator": _runs_log_matches_golden(GOLDEN_RUNS_LOG_FULL_SEQUENCE),
        "dependencies": [
            "GOLDEN_RUNS_LOG_ITER1_SUCCESS",
            "GOLDEN_RUNS_LOG_ITER2_SPURIOUS",
            "GOLDEN_RUNS_LOG_ITER3_SUCCESS",
            "GOLDEN_RUNS_LOG_ITER4_MAX_ITERATIONS",
            "GOLDEN_RUNS_LOG_FULL_SEQUENCE",
        ],
    },
    # ------------------------------------------------------------------
    # Multi-iteration sequence: final state matches golden snapshot
    # ------------------------------------------------------------------
    {
        "id": "multi_iteration_state_matches_golden",
        "setup": lambda tmp_path, run_id, session_id: _run_full_sequence(
            tmp_path, run_id=run_id, session_id=session_id
        ),
        "expected": None,
        "validator": _state_matches_golden(GOLDEN_STATE_AT_ITER4_MAX_ITERATIONS),
        "dependencies": ["GOLDEN_STATE_AT_ITER4_MAX_ITERATIONS"],
    },
]


# ---------------------------------------------------------------------------
# Small standalone helpers used by inline validators
# ---------------------------------------------------------------------------


def _verify_log_order(lines: list[str], expected_statuses: list[str]) -> None:
    """Assert that each line's status field (index 4) matches expected_statuses."""
    assert len(lines) == len(expected_statuses), (
        f"Expected {len(expected_statuses)} log lines, got {len(lines)}"
    )
    for i, (line, expected_status) in enumerate(zip(lines, expected_statuses)):
        fields = line.split("|")
        assert len(fields) >= 5, f"Line {i}: too few fields: {line!r}"
        assert fields[4] == expected_status, (
            f"Line {i}: status expected {expected_status!r}, got {fields[4]!r}"
        )


def _assert_runs_log_has_nth_field(
    ctx: dict[str, Any], *, field_index: int, expected_value: str
) -> None:
    """Assert that the last runs.log entry has expected_value at field_index."""
    log_path = _runs_log_path(ctx["tmp_path"])
    assert log_path.exists(), "runs.log was not created"
    lines = [ln for ln in log_path.read_text().splitlines() if ln.strip()]
    assert lines, "runs.log is empty"
    fields = lines[-1].split("|")
    assert len(fields) > field_index, (
        f"Last entry has only {len(fields)} fields; "
        f"expected at least {field_index + 1}: {lines[-1]!r}"
    )
    assert fields[field_index] == expected_value, (
        f"Field[{field_index}]: expected {expected_value!r}, got {fields[field_index]!r}"
    )


# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", cases, ids=[c["id"] for c in cases])
def test_state_file_mutation(case: dict[str, Any], tmp_path: Path) -> None:
    """Each row drives state-file mutation helpers via the shared bash helper.

    When a validator is provided it receives a context dict instead of an
    expected value, following the {input, expected, validator?, dependencies}
    harness pattern from CLAUDE.md.

    The context dict passed to validators contains:
      - tmp_path: the pytest temporary directory
      - state_file_path: the path to the closedloop state file
      - run_id: the fixed run ID used for this test run
      - session_id: the fixed session ID used for this test run
    """
    # Ensure the .closedloop-ai directory exists before any setup
    _state_dir(tmp_path)

    ctx: dict[str, Any] = {
        "tmp_path": tmp_path,
        "state_file_path": _state_file_path(tmp_path),
        "run_id": FIXED_RUN_ID,
        "session_id": FIXED_SESSION_ID,
    }

    # Execute the setup callable for this case
    case["setup"](tmp_path, FIXED_RUN_ID, FIXED_SESSION_ID)

    if case["validator"] is not None:
        case["validator"](ctx)
    else:
        assert case["expected"] is not None, (
            f"Case {case['id']!r}: both validator and expected are None"
        )
        # Direct string equality for non-validator cases
        actual = _state_file_path(tmp_path).read_text()
        assert actual == case["expected"], (
            f"Scenario {case['id']!r}: got {actual!r}, expected {case['expected']!r}"
        )
