"""Session-ID recording contract tests for run-loop.sh.

Each scenario is a row in the ``cases`` table with
``{input, expected, validator?, dependencies}`` structure (AC-006).
All fixture constants and helpers are imported from the centralized mock
suite (AC-007).

The table covers (AC-001, AC-004):
  - ``record_claude_session_id()`` with plan_execute command writes
    session-id.txt and exports CLOSEDLOOP_SESSION_ID.
  - Non-plan_execute commands export env var but do not overwrite
    session-id.txt.
  - Empty session_id is a no-op (no file written, no env var exported).
  - ``write_runs_log_entry()`` falls back to session-id.txt when
    LAST_CLAUDE_SESSION_ID is empty.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from test_loop_contract_mocks import (
    RUN_LOOP,
    run_bash,
    run_write_runs_log_with_fallback,
    runs_log_file,
    session_id_file,
    validate_runs_log_session_id_field,
)

# ---------------------------------------------------------------------------
# Constants shared by all cases
# ---------------------------------------------------------------------------

FIXED_RUN_ID = "test-run-id-session-contract"
FIXED_SESSION_ID = "sess-session-contract-001"
OTHER_SESSION_ID = "sess-session-contract-pre"

# Path helpers delegate to mock suite (SSOT for path conventions)
_session_id_file = session_id_file
_runs_log_file = runs_log_file


# ---------------------------------------------------------------------------
# Validator helpers
# ---------------------------------------------------------------------------


def _session_id_file_contains(expected: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that reads session-id.txt and asserts the content."""

    def _validate(ctx: dict[str, Any]) -> None:
        path = _session_id_file(ctx["workdir"])
        assert path.exists(), "session-id.txt was not created"
        actual = path.read_text().strip()
        assert actual == expected, (
            f"session-id.txt: expected {expected!r}, got {actual!r}"
        )

    return _validate


def _session_id_file_absent() -> Callable[[dict[str, Any]], None]:
    """Return a validator that asserts session-id.txt does NOT exist."""

    def _validate(ctx: dict[str, Any]) -> None:
        path = _session_id_file(ctx["workdir"])
        assert not path.exists(), (
            f"session-id.txt should not exist but was found at {path}"
        )

    return _validate


def _session_id_file_unchanged(expected_content: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that asserts session-id.txt still holds expected_content."""

    def _validate(ctx: dict[str, Any]) -> None:
        path = _session_id_file(ctx["workdir"])
        assert path.exists(), "session-id.txt must exist (written in setup)"
        actual = path.read_text().strip()
        assert actual == expected_content, (
            f"session-id.txt content changed unexpectedly: "
            f"expected {expected_content!r}, got {actual!r}"
        )

    return _validate


def _env_var_exported(env_var: str, expected: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that checks bash exported env-var via 'printenv'."""

    def _validate(ctx: dict[str, Any]) -> None:
        result = run_bash(
            ctx["workdir"],
            script_body=(
                f'source "{RUN_LOOP}"; '
                f'record_claude_session_id "{ctx["workdir"]}" "{ctx["command"]}" "{ctx["session_id"]}"; '
                f'printenv {env_var}'
            ),
        )
        assert result.returncode == 0, (
            f"bash exited {result.returncode}: {result.stderr}"
        )
        assert result.stdout.strip() == expected, (
            f"{env_var}: expected {expected!r}, got {result.stdout.strip()!r}"
        )

    return _validate


# Delegate to shared validator from mock suite
_runs_log_session_id_field = validate_runs_log_session_id_field


# ---------------------------------------------------------------------------
# Executor helpers
# ---------------------------------------------------------------------------


def _run_record_session_id(
    workdir: Path,
    *,
    command: str,
    session_id: str,
) -> None:
    """Call record_claude_session_id() and assert it exits 0."""
    result = run_bash(
        workdir,
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'record_claude_session_id "{workdir}" "{command}" "{session_id}"'
        ),
    )
    assert result.returncode == 0, (
        f"record_claude_session_id exited {result.returncode}: {result.stderr}"
    )


# Delegate to shared executor from mock suite
_run_write_runs_log_with_fallback = run_write_runs_log_with_fallback


# ---------------------------------------------------------------------------
# Parametrized cases table
#
# Schema per row:
#   id           - human-readable scenario label (used in pytest -v output)
#   input        - dict with fields consumed by the setup lambda
#   setup        - callable(workdir, input) that drives bash and writes files
#   expected     - direct comparison value; None when validator handles it
#   validator    - callable(ctx) → None; ctx is a dict with keys:
#                    workdir, input, command, session_id
#                  Used instead of expected when set.
#   dependencies - list of mock-suite constant names referenced (documentation
#                  only; constants are imported at module level per CLAUDE.md).
# ---------------------------------------------------------------------------

cases = [
    # ------------------------------------------------------------------
    # plan_execute command: session-id.txt is written with the session id
    # ------------------------------------------------------------------
    {
        "id": "plan_execute_writes_session_id_file",
        "input": {"command": "plan_execute", "session_id": FIXED_SESSION_ID},
        "setup": lambda workdir, inp: _run_record_session_id(
            workdir, command=inp["command"], session_id=inp["session_id"]
        ),
        "expected": None,
        "validator": _session_id_file_contains(FIXED_SESSION_ID),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # plan_execute command: CLOSEDLOOP_SESSION_ID is exported with the value
    # ------------------------------------------------------------------
    {
        "id": "plan_execute_exports_closedloop_session_id",
        "input": {"command": "plan_execute", "session_id": FIXED_SESSION_ID},
        "setup": None,  # validation script drives bash directly
        "expected": None,
        "validator": _env_var_exported("CLOSEDLOOP_SESSION_ID", FIXED_SESSION_ID),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # non-plan_execute command: CLOSEDLOOP_SESSION_ID is still exported
    # ------------------------------------------------------------------
    {
        "id": "non_plan_execute_exports_closedloop_session_id",
        "input": {"command": "code_review", "session_id": FIXED_SESSION_ID},
        "setup": None,  # validation script drives bash directly
        "expected": None,
        "validator": _env_var_exported("CLOSEDLOOP_SESSION_ID", FIXED_SESSION_ID),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # non-plan_execute command: session-id.txt is NOT written
    # ------------------------------------------------------------------
    {
        "id": "non_plan_execute_does_not_write_session_id_file",
        "input": {"command": "code_review", "session_id": FIXED_SESSION_ID},
        "setup": lambda workdir, inp: _run_record_session_id(
            workdir, command=inp["command"], session_id=inp["session_id"]
        ),
        "expected": None,
        "validator": _session_id_file_absent(),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # non-plan_execute command: existing session-id.txt is NOT overwritten
    # ------------------------------------------------------------------
    {
        "id": "non_plan_execute_does_not_overwrite_session_id_file",
        "input": {
            "command": "code_review",
            "session_id": FIXED_SESSION_ID,
            "pre_existing_session_id": OTHER_SESSION_ID,
        },
        "setup": lambda workdir, inp: (
            # Write the pre-existing session-id.txt first
            _session_id_file(workdir).write_text(inp["pre_existing_session_id"] + "\n"),
            _run_record_session_id(
                workdir, command=inp["command"], session_id=inp["session_id"]
            ),
        ),
        "expected": None,
        "validator": _session_id_file_unchanged(OTHER_SESSION_ID),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # empty session_id: no-op — session-id.txt is NOT created
    # ------------------------------------------------------------------
    {
        "id": "empty_session_id_does_not_write_file",
        "input": {"command": "plan_execute", "session_id": ""},
        "setup": lambda workdir, inp: _run_record_session_id(
            workdir, command=inp["command"], session_id=inp["session_id"]
        ),
        "expected": None,
        "validator": _session_id_file_absent(),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # empty session_id: no-op — CLOSEDLOOP_SESSION_ID is NOT exported
    # (printenv exits 1 when the variable is unset)
    # ------------------------------------------------------------------
    {
        "id": "empty_session_id_does_not_export_env_var",
        "input": {"command": "plan_execute", "session_id": ""},
        "setup": None,
        "expected": None,
        "validator": (
            lambda ctx: _assert_env_var_not_exported(ctx, "CLOSEDLOOP_SESSION_ID")
        ),
        "dependencies": [],
    },
    # ------------------------------------------------------------------
    # write_runs_log_entry() falls back to session-id.txt when
    # LAST_CLAUDE_SESSION_ID is empty
    # ------------------------------------------------------------------
    {
        "id": "runs_log_falls_back_to_session_id_file",
        "input": {
            "command": "plan_execute",
            "session_id": FIXED_SESSION_ID,
            "run_id": FIXED_RUN_ID,
        },
        "setup": lambda workdir, inp: (
            # Write session-id.txt before calling write_runs_log_entry
            _session_id_file(workdir).write_text(inp["session_id"] + "\n"),
            _run_write_runs_log_with_fallback(
                workdir,
                run_id=inp["run_id"],
                iteration=1,
                status="in_progress",
            ),
        ),
        "expected": None,
        "validator": _runs_log_session_id_field(FIXED_SESSION_ID),
        "dependencies": [],
    },
]


# ---------------------------------------------------------------------------
# Small standalone helper used by inline validator
# ---------------------------------------------------------------------------


def _assert_env_var_not_exported(ctx: dict[str, Any], env_var: str) -> None:
    """Assert that env_var is NOT set after calling record_claude_session_id() with empty session_id."""
    result = run_bash(
        ctx["workdir"],
        script_body=(
            f'source "{RUN_LOOP}"; '
            f'record_claude_session_id "{ctx["workdir"]}" "plan_execute" ""; '
            f'printenv {env_var}'
        ),
    )
    # printenv exits 1 when the variable is unset — that's the expected outcome
    assert result.returncode != 0, (
        f"{env_var} was unexpectedly exported with value: {result.stdout.strip()!r}"
    )
    assert result.stdout.strip() == "", (
        f"{env_var} should be unset but printenv output: {result.stdout.strip()!r}"
    )


# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", cases, ids=[c["id"] for c in cases])
def test_session_id_recording(case: dict[str, Any], tmp_path: Path) -> None:
    """Each row drives session-ID recording helpers via the shared bash helper.

    When a validator is provided it receives a context dict instead of an
    expected value, following the {input, expected, validator?, dependencies}
    harness pattern from CLAUDE.md.

    The context dict passed to validators contains:
      - workdir: the pytest temporary directory (used as CLOSEDLOOP_WORKDIR)
      - input: the case's input dict
      - command: the command field from input (or "" if absent)
      - session_id: the session_id field from input (or "" if absent)
    """
    workdir = tmp_path
    inp = case["input"]

    ctx: dict[str, Any] = {
        "workdir": workdir,
        "input": inp,
        "command": inp.get("command", ""),
        "session_id": inp.get("session_id", ""),
    }

    # Run the setup callable when provided
    if case["setup"] is not None:
        case["setup"](workdir, inp)

    if case["validator"] is not None:
        case["validator"](ctx)
    else:
        assert case["expected"] is not None, (
            f"Case {case['id']!r}: both validator and expected are None"
        )
        # Direct string equality for non-validator cases
        actual = _session_id_file(workdir).read_text()
        assert actual == case["expected"], (
            f"Scenario {case['id']!r}: got {actual!r}, expected {case['expected']!r}"
        )
