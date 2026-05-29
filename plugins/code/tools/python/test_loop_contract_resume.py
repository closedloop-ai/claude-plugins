"""Resume path contract tests for run-loop.sh.

Each scenario is a row in the ``cases`` table with
``{input, expected, validator?, dependencies}`` structure (AC-006).
All fixture constants and helpers are imported from the centralized mock
suite (AC-007).

The table covers (AC-001, AC-004):
  - After writing a state file with iteration=3, ``get_field("iteration")``
    returns 3.
  - ``get_field("successful_iterations")`` returns the persisted count.
  - session-id.txt content is read by ``write_runs_log_entry()`` fallback
    when LAST_CLAUDE_SESSION_ID is empty.
  - State file fields (workdir, run_id, command) are correctly restored
    via ``get_field()``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from test_loop_contract_mocks import (
    RUN_LOOP,
    build_state_file,
    run_bash,
    run_write_runs_log_with_fallback,
    runs_log_file,
    session_id_file,
    state_dir,
    state_file_path,
    validate_runs_log_session_id_field,
)

# ---------------------------------------------------------------------------
# Constants shared by all cases
# ---------------------------------------------------------------------------

FIXED_RUN_ID = "test-run-id-resume-contract"
FIXED_SESSION_ID = "sess-resume-contract-001"

# Path helpers delegate to mock suite (SSOT for path conventions)
_state_dir = state_dir
_state_file_path = state_file_path
_session_id_file = session_id_file
_runs_log_file = runs_log_file


# ---------------------------------------------------------------------------
# Executor helpers
# ---------------------------------------------------------------------------


def _write_state_and_get_field(
    tmp_path: Path,
    *,
    field: str,
    iteration: int,
    successful_iterations: int,
    run_id: str,
    command: str = "plan_execute",
) -> str:
    """Write a state file and call get_field(field), returning the stripped output."""
    state_path = _state_file_path(tmp_path)
    state_path.write_text(
        build_state_file(
            tmp_path,
            iteration=iteration,
            successful_iterations=successful_iterations,
            run_id=run_id,
            command=command,
        )
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'get_field "{field}"'
        ),
    )
    assert result.returncode == 0, (
        f"get_field({field!r}) exited {result.returncode}: {result.stderr}"
    )
    return result.stdout.strip()


# Delegate to shared executor from mock suite
_run_write_runs_log_with_fallback = run_write_runs_log_with_fallback


# ---------------------------------------------------------------------------
# Validator helpers
# ---------------------------------------------------------------------------


def _get_field_returns(
    field: str,
    expected_value: str,
    *,
    iteration: int,
    successful_iterations: int,
    run_id: str,
    command: str = "plan_execute",
) -> Callable[[dict[str, Any]], None]:
    """Return a validator that writes a state file and asserts get_field() output."""

    def _validate(ctx: dict[str, Any]) -> None:
        actual = _write_state_and_get_field(
            ctx["tmp_path"],
            field=field,
            iteration=iteration,
            successful_iterations=successful_iterations,
            run_id=run_id,
            command=command,
        )
        assert actual == expected_value, (
            f"get_field({field!r}): expected {expected_value!r}, got {actual!r}"
        )

    return _validate


# Delegate to shared validator from mock suite
_runs_log_session_id_field = validate_runs_log_session_id_field


# ---------------------------------------------------------------------------
# Parametrized cases table
#
# Schema per row:
#   id           - human-readable scenario label (used in pytest -v output)
#   input        - dict with fields consumed by setup
#   setup        - callable(tmp_path, input) that writes files / runs bash
#   expected     - direct comparison value; None when validator handles it
#   validator    - callable(ctx) → None; ctx contains tmp_path and input
#   dependencies - list of mock-suite constant names referenced (documentation
#                  only; constants are imported at module level per CLAUDE.md)
# ---------------------------------------------------------------------------

cases = [
    # ------------------------------------------------------------------
    # get_field("iteration") returns the persisted iteration counter (3)
    # ------------------------------------------------------------------
    {
        "id": "get_field_iteration_returns_persisted_value",
        "input": {
            "field": "iteration",
            "iteration": 3,
            "successful_iterations": 2,
            "run_id": FIXED_RUN_ID,
            "expected_value": "3",
        },
        "setup": None,
        "expected": None,
        "validator": _get_field_returns(
            "iteration",
            "3",
            iteration=3,
            successful_iterations=2,
            run_id=FIXED_RUN_ID,
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # get_field("successful_iterations") returns the persisted count
    # ------------------------------------------------------------------
    {
        "id": "get_field_successful_iterations_returns_persisted_count",
        "input": {
            "field": "successful_iterations",
            "iteration": 3,
            "successful_iterations": 2,
            "run_id": FIXED_RUN_ID,
            "expected_value": "2",
        },
        "setup": None,
        "expected": None,
        "validator": _get_field_returns(
            "successful_iterations",
            "2",
            iteration=3,
            successful_iterations=2,
            run_id=FIXED_RUN_ID,
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # get_field("successful_iterations") with count=0 returns "0"
    # ------------------------------------------------------------------
    {
        "id": "get_field_successful_iterations_zero",
        "input": {
            "field": "successful_iterations",
            "iteration": 1,
            "successful_iterations": 0,
            "run_id": FIXED_RUN_ID,
            "expected_value": "0",
        },
        "setup": None,
        "expected": None,
        "validator": _get_field_returns(
            "successful_iterations",
            "0",
            iteration=1,
            successful_iterations=0,
            run_id=FIXED_RUN_ID,
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # get_field("run_id") restores the run_id from the state file
    # ------------------------------------------------------------------
    {
        "id": "get_field_run_id_restores_correctly",
        "input": {
            "field": "run_id",
            "iteration": 3,
            "successful_iterations": 2,
            "run_id": FIXED_RUN_ID,
            "expected_value": FIXED_RUN_ID,
        },
        "setup": None,
        "expected": None,
        "validator": _get_field_returns(
            "run_id",
            FIXED_RUN_ID,
            iteration=3,
            successful_iterations=2,
            run_id=FIXED_RUN_ID,
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # get_field("command") restores the original command value
    # ------------------------------------------------------------------
    {
        "id": "get_field_command_restores_correctly",
        "input": {
            "field": "command",
            "iteration": 3,
            "successful_iterations": 2,
            "run_id": FIXED_RUN_ID,
            "command": "plan_execute",
            "expected_value": "plan_execute",
        },
        "setup": None,
        "expected": None,
        "validator": _get_field_returns(
            "command",
            "plan_execute",
            iteration=3,
            successful_iterations=2,
            run_id=FIXED_RUN_ID,
            command="plan_execute",
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # get_field("workdir") restores the workdir path from the state file
    # ------------------------------------------------------------------
    {
        "id": "get_field_workdir_restores_correctly",
        "input": {
            "field": "workdir",
            "iteration": 2,
            "successful_iterations": 1,
            "run_id": FIXED_RUN_ID,
        },
        "setup": None,
        "expected": None,
        "validator": (
            lambda ctx: _assert_get_field_workdir(ctx)
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # session-id.txt content is read by write_runs_log_entry() fallback
    # when LAST_CLAUDE_SESSION_ID is empty
    # ------------------------------------------------------------------
    {
        "id": "runs_log_fallback_reads_session_id_file",
        "input": {
            "session_id": FIXED_SESSION_ID,
            "run_id": FIXED_RUN_ID,
            "iteration": 3,
            "status": "in_progress",
        },
        "setup": lambda tmp_path, inp: (
            _session_id_file(tmp_path).write_text(inp["session_id"] + "\n"),
            _run_write_runs_log_with_fallback(
                tmp_path,
                run_id=inp["run_id"],
                iteration=inp["iteration"],
                status=inp["status"],
            ),
        ),
        "expected": None,
        "validator": _runs_log_session_id_field(FIXED_SESSION_ID),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # When session-id.txt is absent and LAST_CLAUDE_SESSION_ID is empty,
    # write_runs_log_entry() records an empty session_id field
    # ------------------------------------------------------------------
    {
        "id": "runs_log_fallback_empty_when_no_session_id_file",
        "input": {
            "run_id": FIXED_RUN_ID,
            "iteration": 1,
            "status": "in_progress",
        },
        "setup": lambda tmp_path, inp: _run_write_runs_log_with_fallback(
            tmp_path,
            run_id=inp["run_id"],
            iteration=inp["iteration"],
            status=inp["status"],
        ),
        "expected": None,
        "validator": _runs_log_session_id_field(""),
        "dependencies": [],
    },
]


# ---------------------------------------------------------------------------
# Small standalone helpers used by inline validators
# ---------------------------------------------------------------------------


def _assert_get_field_workdir(ctx: dict[str, Any]) -> None:
    """Assert that get_field("workdir") returns the actual tmp_path string."""
    tmp_path: Path = ctx["tmp_path"]
    state_path = _state_file_path(tmp_path)
    state_path.write_text(
        build_state_file(
            tmp_path,
            iteration=2,
            successful_iterations=1,
            run_id=FIXED_RUN_ID,
        )
    )
    result = run_bash(
        tmp_path,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'STATE_FILE="{state_path}"; '
            f'get_field "workdir"'
        ),
    )
    assert result.returncode == 0, (
        f"get_field('workdir') exited {result.returncode}: {result.stderr}"
    )
    assert result.stdout.strip() == str(tmp_path), (
        f"get_field('workdir'): expected {str(tmp_path)!r}, "
        f"got {result.stdout.strip()!r}"
    )


# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", cases, ids=[c["id"] for c in cases])
def test_resume_path(case: dict[str, Any], tmp_path: Path) -> None:
    """Each row drives resume-path helpers via the shared bash helper.

    When a validator is provided it receives a context dict instead of an
    expected value, following the {input, expected, validator?, dependencies}
    harness pattern from CLAUDE.md.

    The context dict passed to validators contains:
      - tmp_path: the pytest temporary directory (used as CLOSEDLOOP_WORKDIR)
      - input: the case's input dict
    """
    # Ensure the .closedloop-ai directory exists for state-file cases
    _state_dir(tmp_path)

    ctx: dict[str, Any] = {
        "tmp_path": tmp_path,
        "input": case["input"],
    }

    # Run the setup callable when provided
    if case["setup"] is not None:
        case["setup"](tmp_path, case["input"])

    if case["validator"] is not None:
        case["validator"](ctx)
    else:
        assert case["expected"] is not None, (
            f"Case {case['id']!r}: both validator and expected are None"
        )
        actual = _state_file_path(tmp_path).read_text()
        assert actual == case["expected"], (
            f"Scenario {case['id']!r}: got {actual!r}, expected {case['expected']!r}"
        )
