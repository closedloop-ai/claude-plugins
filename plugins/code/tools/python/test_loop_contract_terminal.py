"""Terminal classification contract tests for detect_claude_terminal_failure().

Each scenario is a row in the ``cases`` table with
``{input, expected, validator?, dependencies}`` structure (AC-006).
All fixture constants are imported from the centralized mock suite (AC-007).

The table covers:
  - rate-limit via rejected status
  - rate-limit via error string
  - rate-limit via HTTP status 429
  - rate-limit via envelope text match
  - context-limit via JSONL result field
  - context-limit via stderr
  - auth-challenge via JSONL result field
  - auth-challenge via stderr
  - unknown-skill via result field
  - unknown-skill via error field
  - success (no terminal failure)
  - malformed JSONL (graceful no-failure return)
  - message clamping for long messages
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pytest

from test_loop_contract_mocks import (
    FIXTURE_AUTH_CHALLENGE_JSONL,
    FIXTURE_AUTH_CHALLENGE_STDERR,
    FIXTURE_CONTEXT_LIMIT_JSONL,
    FIXTURE_CONTEXT_LIMIT_STDERR,
    FIXTURE_RATE_LIMIT_ENVELOPE_TEXT,
    FIXTURE_RATE_LIMIT_ERROR_STRING,
    FIXTURE_RATE_LIMIT_REJECTED_STATUS,
    FIXTURE_RATE_LIMIT_STATUS_429,
    FIXTURE_SUCCESS_NO_TERMINAL_FAILURE,
    FIXTURE_UNKNOWN_SKILL_ERROR_FIELD,
    FIXTURE_UNKNOWN_SKILL_RESULT_FIELD,
    run_bash_detect,
)

# ---------------------------------------------------------------------------
# Validator helpers
# ---------------------------------------------------------------------------


def _is_empty_dict(result: dict[str, Any]) -> None:
    """Assert the result is an empty dict (no terminal failure)."""
    assert result == {}, f"Expected empty dict, got: {result!r}"


def _message_clamped(result: dict[str, Any]) -> None:
    """Assert the message field is clamped to at most 903 chars (900 + '...')."""
    assert "message" in result, "Expected 'message' key in result"
    assert len(result["message"]) <= 903, (
        f"Message not clamped; length={len(result['message'])}"
    )
    assert result["message"].endswith("..."), (
        f"Clamped message must end with '...', got: {result['message'][-10:]!r}"
    )


def _status_is(expected_status: str) -> Callable[[dict[str, Any]], None]:
    """Return a validator that asserts only the 'status' key."""

    def _validate(result: dict[str, Any]) -> None:
        assert result.get("status") == expected_status, (
            f"Expected status={expected_status!r}, got {result.get('status')!r}"
        )

    return _validate


# ---------------------------------------------------------------------------
# Long-message fixture (constructed inline for the clamping scenario only)
# ---------------------------------------------------------------------------

# The result string is deliberately >900 chars so the JQ clamp_message path fires.
_LONG_RESULT = "Unknown skill: " + "A" * 950
_MALFORMED_JSONL = "NOT_VALID_JSON_AT_ALL\n"
_LONG_MESSAGE_JSONL = (
    '{"type":"result","subtype":"error","is_error":false,'
    f'"result":"{_LONG_RESULT}"}}\n'
)

# ---------------------------------------------------------------------------
# Parametrized cases table
#
# Schema per row:
#   id          - human-readable scenario label (used in pytest -v output)
#   jsonl       - JSONL content to write to output.jsonl (None → empty file)
#   stderr      - stderr text to write to stderr.txt (None → not provided)
#   expected    - full expected dict (compared directly when validator is None)
#   validator   - optional callable(result) → None; used instead of expected when set
#   dependencies - list of fixture constant names referenced (documentation only;
#                  actual constants are imported at module level per CLAUDE.md)
# ---------------------------------------------------------------------------

cases = [
    {
        "id": "rate_limit_rejected_status",
        "jsonl": FIXTURE_RATE_LIMIT_REJECTED_STATUS,
        "stderr": None,
        "expected": {
            "status": "claude_rate_limit",
            "subcode": "CLAUDE_RATE_LIMIT",
            "message": "Claude rate limit reached (five_hour); resetsAt=1778266200",
        },
        "validator": None,
        "dependencies": ["FIXTURE_RATE_LIMIT_REJECTED_STATUS"],
    },
    {
        "id": "rate_limit_error_string",
        "jsonl": FIXTURE_RATE_LIMIT_ERROR_STRING,
        "stderr": None,
        "expected": {
            "status": "claude_rate_limit",
            "subcode": "CLAUDE_RATE_LIMIT",
            "message": "Claude rate limit reached: rate_limit",
        },
        "validator": None,
        "dependencies": ["FIXTURE_RATE_LIMIT_ERROR_STRING"],
    },
    {
        "id": "rate_limit_status_429",
        "jsonl": FIXTURE_RATE_LIMIT_STATUS_429,
        "stderr": None,
        "expected": {
            "status": "claude_rate_limit",
            "subcode": "CLAUDE_RATE_LIMIT",
            "message": (
                "Claude rate limit reached: "
                "You've hit your rate limit. Please wait for the limit to reset."
            ),
        },
        "validator": None,
        "dependencies": ["FIXTURE_RATE_LIMIT_STATUS_429"],
    },
    {
        "id": "rate_limit_envelope_text",
        "jsonl": FIXTURE_RATE_LIMIT_ENVELOPE_TEXT,
        "stderr": None,
        "expected": {
            "status": "claude_rate_limit",
            "subcode": "CLAUDE_RATE_LIMIT",
            "message": (
                "Claude rate limit reached: "
                "You've hit your limit; please wait for the rate limit to reset before retrying."
            ),
        },
        "validator": None,
        "dependencies": ["FIXTURE_RATE_LIMIT_ENVELOPE_TEXT"],
    },
    {
        "id": "context_limit_jsonl",
        "jsonl": FIXTURE_CONTEXT_LIMIT_JSONL,
        "stderr": None,
        "expected": {
            "status": "context_limit",
            "subcode": "CLAUDE_CONTEXT_LIMIT",
            "message": (
                "Claude context limit reached: "
                "Prompt is too long for this model context limit. "
                "Please reduce the size of your prompt."
            ),
        },
        "validator": None,
        "dependencies": ["FIXTURE_CONTEXT_LIMIT_JSONL"],
    },
    {
        "id": "context_limit_stderr",
        "jsonl": None,
        "stderr": FIXTURE_CONTEXT_LIMIT_STDERR,
        "expected": None,
        "validator": _status_is("context_limit"),
        "dependencies": ["FIXTURE_CONTEXT_LIMIT_STDERR"],
    },
    {
        "id": "auth_challenge_jsonl",
        "jsonl": FIXTURE_AUTH_CHALLENGE_JSONL,
        "stderr": None,
        "expected": {
            "status": "claude_auth_error",
            "subcode": "CLAUDE_AUTH_CHALLENGE",
            "message": (
                "Claude authentication or account challenge: "
                "Invalid bearer token. Please log in to Claude to continue."
            ),
        },
        "validator": None,
        "dependencies": ["FIXTURE_AUTH_CHALLENGE_JSONL"],
    },
    {
        "id": "auth_challenge_stderr",
        "jsonl": None,
        "stderr": FIXTURE_AUTH_CHALLENGE_STDERR,
        "expected": None,
        "validator": _status_is("claude_auth_error"),
        "dependencies": ["FIXTURE_AUTH_CHALLENGE_STDERR"],
    },
    {
        "id": "unknown_skill_result_field",
        "jsonl": FIXTURE_UNKNOWN_SKILL_RESULT_FIELD,
        "stderr": None,
        "expected": {
            "status": "unknown_skill",
            "subcode": "CLAUDE_UNKNOWN_SKILL",
            "message": "Claude plugin command unavailable: Unknown skill: code:code",
        },
        "validator": None,
        "dependencies": ["FIXTURE_UNKNOWN_SKILL_RESULT_FIELD"],
    },
    {
        "id": "unknown_skill_error_field",
        "jsonl": FIXTURE_UNKNOWN_SKILL_ERROR_FIELD,
        "stderr": None,
        "expected": {
            "status": "unknown_skill",
            "subcode": "CLAUDE_UNKNOWN_SKILL",
            "message": "Claude plugin command unavailable: Unknown skill: code:code",
        },
        "validator": None,
        "dependencies": ["FIXTURE_UNKNOWN_SKILL_ERROR_FIELD"],
    },
    {
        "id": "success_no_terminal_failure",
        "jsonl": FIXTURE_SUCCESS_NO_TERMINAL_FAILURE,
        "stderr": None,
        "expected": {},
        "validator": _is_empty_dict,
        "dependencies": ["FIXTURE_SUCCESS_NO_TERMINAL_FAILURE"],
    },
    {
        "id": "malformed_jsonl_graceful",
        "jsonl": _MALFORMED_JSONL,
        "stderr": None,
        "expected": {},
        "validator": _is_empty_dict,
        "dependencies": [],
    },
    {
        "id": "message_clamping_long_result",
        "jsonl": _LONG_MESSAGE_JSONL,
        "stderr": None,
        "expected": None,
        "validator": _message_clamped,
        "dependencies": [],
    },
]

# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", cases, ids=[c["id"] for c in cases])
def test_detect_terminal_failure(case: dict[str, Any], tmp_path: Path) -> None:
    """Each row drives detect_claude_terminal_failure() via the shared helper.

    When a validator is provided it is called instead of an equality assertion
    against expected, following the {input, expected, validator?, dependencies}
    harness pattern from CLAUDE.md.
    """
    result = run_bash_detect(
        tmp_path,
        jsonl_content=case["jsonl"],
        stderr_content=case["stderr"],
    )

    if case["validator"] is not None:
        case["validator"](result)
    else:
        assert result == case["expected"], (
            f"Scenario {case['id']!r}: got {result!r}, expected {case['expected']!r}"
        )
