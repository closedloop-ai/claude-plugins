"""Rate-limit signed-marker contract tests for run-loop.sh.

Each scenario is a row in the ``cases`` table with
``{input, expected, validator?, dependencies}`` structure (AC-006).
All fixture constants and helpers are imported from the centralized mock
suite (AC-007).

The table covers (AC-001, AC-005):
  - ``write_loop_user_visible_failure()`` with valid RUNNER_ERROR/subcode/message
    writes loop-error.json with correct JSON structure.
  - The HMAC-SHA256 signature in the written file validates against the payload
    using the test secret.
  - Subcode in the written marker matches ``^[A-Z][A-Z0-9_]{2,63}$``.
  - Invalid subcode is rejected (non-zero exit, no file written).
  - Invalid status code is rejected (non-zero exit, no file written).
  - Empty message is rejected (non-zero exit, no file written).
  - Message over 1000 chars is rejected (non-zero exit, no file written).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

import pytest

from test_loop_contract_mocks import (
    FAILURE_SECRET,
    run_bash,
    signed_marker,
)

# ---------------------------------------------------------------------------
# Constants shared by all cases
# ---------------------------------------------------------------------------

_SUBCODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")

_VALID_SUBCODE = "RATE_LIMIT_EXCEEDED"
_VALID_MESSAGE = "Loop execution failed: Claude rate limit reached."
_VALID_CODE = "RUNNER_ERROR"

_MARKER_FILE = "loop-error.json"


# ---------------------------------------------------------------------------
# Executor helpers
# ---------------------------------------------------------------------------


def _call_write_marker(
    workdir: Path,
    *,
    code: str,
    subcode: str,
    message: str,
    failure_secret: str | None = FAILURE_SECRET,
) -> Any:
    """Call write_loop_user_visible_failure() via the shared bash helper.

    run_bash() already prepends ``source {RUN_LOOP}`` to the
    script_body, so script_body must NOT include another source call —
    double-sourcing would re-capture CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET
    (already unset by the first source) and erase the secret.

    Returns the CompletedProcess from run_bash so callers
    can inspect returncode, stdout, and stderr.
    """
    return run_bash(
        workdir,
        script_body=(
            f"write_loop_user_visible_failure {code!r} {subcode!r} {message!r}"
        ),
        failure_secret=failure_secret,
    )


# ---------------------------------------------------------------------------
# Validator helpers
# ---------------------------------------------------------------------------


def _marker_written_with_correct_structure(
    expected_code: str,
    expected_subcode: str,
    expected_message: str,
) -> Callable[[dict[str, Any]], None]:
    """Return a validator asserting loop-error.json has the expected JSON structure."""

    def _validate(ctx: dict[str, Any]) -> None:
        marker_path = ctx["workdir"] / _MARKER_FILE
        assert marker_path.exists(), (
            f"loop-error.json was not created in {ctx['workdir']}"
        )
        data = json.loads(marker_path.read_text())
        assert data["code"] == expected_code, (
            f"JSON 'code' field: expected {expected_code!r}, got {data.get('code')!r}"
        )
        assert data["message"] == expected_message, (
            f"JSON 'message' field: expected {expected_message!r}, got {data.get('message')!r}"
        )
        assert isinstance(data.get("result"), dict), (
            f"JSON 'result' field must be a dict, got {data.get('result')!r}"
        )
        assert data["result"].get("subcode") == expected_subcode, (
            f"JSON 'result.subcode' field: expected {expected_subcode!r}, "
            f"got {data['result'].get('subcode')!r}"
        )
        assert "signature" in data, (
            "loop-error.json is missing the 'signature' field"
        )

    return _validate


def _signature_validates_against_payload(
    expected_code: str,
    expected_subcode: str,
    expected_message: str,
) -> Callable[[dict[str, Any]], None]:
    """Return a validator that re-derives the HMAC and compares to the written signature."""

    def _validate(ctx: dict[str, Any]) -> None:
        marker_path = ctx["workdir"] / _MARKER_FILE
        assert marker_path.exists(), (
            f"loop-error.json was not created in {ctx['workdir']}"
        )
        data = json.loads(marker_path.read_text())

        # Reconstruct expected signed payload using the Python signed_marker helper
        # which mirrors the bash HMAC signing logic exactly.
        payload = {
            "code": expected_code,
            "message": expected_message,
            "result": {"subcode": expected_subcode},
        }
        expected = signed_marker(payload, secret=FAILURE_SECRET)

        assert data == expected, (
            f"Signed marker mismatch.\n"
            f"  Written:  {data!r}\n"
            f"  Expected: {expected!r}"
        )
        assert data["signature"] == expected["signature"], (
            f"HMAC-SHA256 signature mismatch: "
            f"written={data['signature']!r}, expected={expected['signature']!r}"
        )

    return _validate


def _subcode_matches_regex() -> Callable[[dict[str, Any]], None]:
    """Return a validator asserting result.subcode in loop-error.json matches the pattern."""

    def _validate(ctx: dict[str, Any]) -> None:
        marker_path = ctx["workdir"] / _MARKER_FILE
        assert marker_path.exists(), (
            f"loop-error.json was not created in {ctx['workdir']}"
        )
        data = json.loads(marker_path.read_text())
        subcode = data.get("result", {}).get("subcode", "")
        assert _SUBCODE_RE.match(subcode), (
            f"subcode {subcode!r} does not match ^[A-Z][A-Z0-9_]{{2,63}}$"
        )

    return _validate


def _rejected_no_marker_written() -> Callable[[dict[str, Any]], None]:
    """Return a validator asserting the call was rejected and no marker file written."""

    def _validate(ctx: dict[str, Any]) -> None:
        result = ctx["proc"]
        assert result.returncode != 0, (
            f"Expected non-zero exit for invalid input, got returncode=0.\n"
            f"  stderr: {result.stderr!r}"
        )
        marker_path = ctx["workdir"] / _MARKER_FILE
        assert not marker_path.exists(), (
            f"loop-error.json should NOT exist after rejection, "
            f"but found it at {marker_path}"
        )

    return _validate


# ---------------------------------------------------------------------------
# Parametrized cases table
#
# Schema per row:
#   id           - human-readable scenario label (used in pytest -v output)
#   input        - dict with fields: code, subcode, message, failure_secret (opt)
#   expected     - direct comparison value; None when validator handles it
#   validator    - callable(ctx) → None; ctx contains workdir, input, proc
#   dependencies - list of mock-suite references (documentation; imported at module level)
# ---------------------------------------------------------------------------

cases = [
    # ------------------------------------------------------------------
    # Valid RUNNER_ERROR with valid subcode and message: marker written
    # ------------------------------------------------------------------
    {
        "id": "valid_runner_error_writes_marker_with_correct_structure",
        "input": {
            "code": _VALID_CODE,
            "subcode": _VALID_SUBCODE,
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _marker_written_with_correct_structure(
            _VALID_CODE, _VALID_SUBCODE, _VALID_MESSAGE
        ),
        "dependencies": ["signed_marker", "run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Valid PRE_RUN_VALIDATION_FAILED code: also writes a valid marker
    # ------------------------------------------------------------------
    {
        "id": "valid_pre_run_validation_failed_writes_marker",
        "input": {
            "code": "PRE_RUN_VALIDATION_FAILED",
            "subcode": "BAD_PLAN_STATE",
            "message": "Plan state is not loadable.",
        },
        "expected": None,
        "validator": _marker_written_with_correct_structure(
            "PRE_RUN_VALIDATION_FAILED",
            "BAD_PLAN_STATE",
            "Plan state is not loadable.",
        ),
        "dependencies": ["signed_marker", "run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Valid PLAN_STATE_UNAVAILABLE code: also writes a valid marker
    # ------------------------------------------------------------------
    {
        "id": "valid_plan_state_unavailable_writes_marker",
        "input": {
            "code": "PLAN_STATE_UNAVAILABLE",
            "subcode": "PLAN_FILE_MISSING",
            "message": "Plan file not found in workdir.",
        },
        "expected": None,
        "validator": _marker_written_with_correct_structure(
            "PLAN_STATE_UNAVAILABLE",
            "PLAN_FILE_MISSING",
            "Plan file not found in workdir.",
        ),
        "dependencies": ["signed_marker", "run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # HMAC-SHA256 signature validates against the payload using test secret
    # ------------------------------------------------------------------
    {
        "id": "hmac_sha256_signature_validates_against_payload",
        "input": {
            "code": _VALID_CODE,
            "subcode": _VALID_SUBCODE,
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _signature_validates_against_payload(
            _VALID_CODE, _VALID_SUBCODE, _VALID_MESSAGE
        ),
        "dependencies": ["signed_marker", "run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Subcode in written marker matches ^[A-Z][A-Z0-9_]{2,63}$
    # ------------------------------------------------------------------
    {
        "id": "subcode_in_marker_matches_required_regex",
        "input": {
            "code": _VALID_CODE,
            "subcode": "CLAUDE_RATE_LIMIT",
            "message": "Claude rate limit reached. Wait for the limit to reset.",
        },
        "expected": None,
        "validator": _subcode_matches_regex(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Invalid subcode (lowercase) is rejected: non-zero exit, no file
    # ------------------------------------------------------------------
    {
        "id": "invalid_subcode_lowercase_is_rejected",
        "input": {
            "code": _VALID_CODE,
            "subcode": "invalid_subcode",
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Invalid subcode (too short, 2 chars) is rejected: non-zero exit, no file
    # ------------------------------------------------------------------
    {
        "id": "invalid_subcode_too_short_is_rejected",
        "input": {
            "code": _VALID_CODE,
            "subcode": "AB",
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Invalid subcode (starts with digit) is rejected: non-zero exit, no file
    # ------------------------------------------------------------------
    {
        "id": "invalid_subcode_starts_with_digit_is_rejected",
        "input": {
            "code": _VALID_CODE,
            "subcode": "1BAD_SUBCODE",
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Invalid status code is rejected: non-zero exit, no file written
    # ------------------------------------------------------------------
    {
        "id": "invalid_status_code_is_rejected",
        "input": {
            "code": "PROCESS_FAILED",
            "subcode": _VALID_SUBCODE,
            "message": _VALID_MESSAGE,
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Empty message is rejected: non-zero exit, no file written
    # ------------------------------------------------------------------
    {
        "id": "empty_message_is_rejected",
        "input": {
            "code": _VALID_CODE,
            "subcode": _VALID_SUBCODE,
            "message": "",
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Message over 1000 chars is rejected: non-zero exit, no file written
    # ------------------------------------------------------------------
    {
        "id": "message_over_1000_chars_is_rejected",
        "input": {
            "code": _VALID_CODE,
            "subcode": _VALID_SUBCODE,
            "message": "X" * 1001,
        },
        "expected": None,
        "validator": _rejected_no_marker_written(),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
    # ------------------------------------------------------------------
    # Message exactly 1000 chars is accepted: marker written
    # ------------------------------------------------------------------
    {
        "id": "message_exactly_1000_chars_is_accepted",
        "input": {
            "code": _VALID_CODE,
            "subcode": _VALID_SUBCODE,
            "message": "Y" * 1000,
        },
        "expected": None,
        "validator": _marker_written_with_correct_structure(
            _VALID_CODE, _VALID_SUBCODE, "Y" * 1000
        ),
        "dependencies": ["run_bash", "FAILURE_SECRET"],
    },
]


# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", cases, ids=[c["id"] for c in cases])
def test_signed_marker_contract(case: dict[str, Any], tmp_path: Path) -> None:
    """Each row drives write_loop_user_visible_failure() via the shared bash helper.

    When a validator is provided it receives a context dict instead of an
    expected value, following the {input, expected, validator?, dependencies}
    harness pattern from CLAUDE.md.

    The context dict passed to validators contains:
      - workdir: the pytest temporary directory (used as CLOSEDLOOP_WORKDIR)
      - input: the case's input dict
      - proc: the CompletedProcess from the bash invocation
    """
    workdir = tmp_path
    inp = case["input"]

    proc = _call_write_marker(
        workdir,
        code=inp["code"],
        subcode=inp["subcode"],
        message=inp["message"],
        failure_secret=inp.get("failure_secret", FAILURE_SECRET),
    )

    ctx: dict[str, Any] = {
        "workdir": workdir,
        "input": inp,
        "proc": proc,
    }

    if case["validator"] is not None:
        case["validator"](ctx)
    else:
        assert case["expected"] is not None, (
            f"Case {case['id']!r}: both validator and expected are None"
        )
        # Direct comparison fallback (not used by any current row)
        marker_path = workdir / _MARKER_FILE
        actual = json.loads(marker_path.read_text())
        assert actual == case["expected"], (
            f"Scenario {case['id']!r}: got {actual!r}, expected {case['expected']!r}"
        )
