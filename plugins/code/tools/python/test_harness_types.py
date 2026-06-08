"""Tests for harness/types.py.

Covers:
- Command enum member values (AC-002)
- All request dataclass construction and field access (AC-003)
- TerminalFailure subcode validation — valid accepted, invalid rejected (AC-004)
- TurnResult construction
- JSON round-trip: request_from_json, turn_result serialization,
  terminal_failure serialization (AC-003, AC-007)

Uses a table-driven (pytest.mark.parametrize) approach throughout.
Shared fixtures are defined in conftest.py.
"""

from __future__ import annotations

import pytest

from harness.types import (
    AdapterName,
    CodeReviewFixRequest,
    CodeReviewStartRequest,
    Command,
    ExportLearningsRequest,
    MethodName,
    PlanExecuteRequest,
    ProcessLearningsRequest,
    TerminalFailure,
    TurnResult,
    adapter_name_from_str,
    method_name_from_str,
    request_from_json,
    terminal_failure_from_json,
    terminal_failure_to_json,
    turn_result_from_json,
    turn_result_to_json,
)


# ---------------------------------------------------------------------------
# Command enum member values (AC-002)
# ---------------------------------------------------------------------------

COMMAND_MEMBER_CASES = [
    (Command.PLAN_EXECUTE, "plan_execute"),
    (Command.PROCESS_LEARNINGS, "process_learnings"),
    (Command.EXPORT_LEARNINGS, "export_learnings"),
    (Command.CODE_REVIEW_START, "code_review_start"),
    (Command.CODE_REVIEW_FIX, "code_review_fix"),
]


@pytest.mark.parametrize("member,expected_value", COMMAND_MEMBER_CASES)
def test_command_enum_values(member: Command, expected_value: str) -> None:
    """Each Command member has the expected string value."""
    assert member == expected_value
    assert str(member) == expected_value


def test_command_enum_has_exactly_five_members() -> None:
    """Command enum contains exactly five members."""
    assert len(Command) == 5


# ---------------------------------------------------------------------------
# AdapterName / MethodName enum values and string conversion helpers
# ---------------------------------------------------------------------------

ADAPTER_NAME_MEMBER_CASES = [
    (AdapterName.CLAUDE, "claude"),
    (AdapterName.CODEX, "codex"),
]

METHOD_NAME_MEMBER_CASES = [
    (MethodName.BUILD_ENTRY_PROMPT, "build_entry_prompt"),
    (MethodName.BUILD_ARGV, "build_argv"),
    (MethodName.PARSE_SESSION_ID, "parse_session_id"),
    (MethodName.PARSE_TURN_RESULT, "parse_turn_result"),
    (MethodName.CLASSIFY_TERMINAL_FAILURE, "classify_terminal_failure"),
]


@pytest.mark.parametrize("member,expected_value", ADAPTER_NAME_MEMBER_CASES)
def test_adapter_name_enum_values(member: AdapterName, expected_value: str) -> None:
    """Each AdapterName member has the expected string value."""
    assert member == expected_value
    assert str(member) == expected_value


@pytest.mark.parametrize("member,expected_value", METHOD_NAME_MEMBER_CASES)
def test_method_name_enum_values(member: MethodName, expected_value: str) -> None:
    """Each MethodName member has the expected string value."""
    assert member == expected_value
    assert str(member) == expected_value


# Each case: (helper, valid_value, expected_member)
VALID_CONVERSION_CASES = [
    (adapter_name_from_str, "claude", AdapterName.CLAUDE),
    (adapter_name_from_str, "codex", AdapterName.CODEX),
    (method_name_from_str, "build_argv", MethodName.BUILD_ARGV),
    (method_name_from_str, "parse_turn_result", MethodName.PARSE_TURN_RESULT),
]


@pytest.mark.parametrize("helper,value,expected", VALID_CONVERSION_CASES)
def test_str_to_enum_valid(helper, value, expected) -> None:
    """The conversion helpers return the matching enum member for valid values."""
    result = helper(value)
    assert result is expected


# Each case: (helper, invalid_value, category_label, expected_supported_substring)
INVALID_CONVERSION_CASES = [
    (adapter_name_from_str, "cursor", "adapter", "claude"),
    (adapter_name_from_str, "", "adapter", "codex"),
    (adapter_name_from_str, "Claude", "adapter", "claude"),  # case-sensitive
    (method_name_from_str, "nonexistent", "method", "build_argv"),
    (method_name_from_str, "BUILD_ARGV", "method", "build_argv"),  # case-sensitive
]


@pytest.mark.parametrize(
    "helper,value,category,supported_substring", INVALID_CONVERSION_CASES
)
def test_str_to_enum_invalid_raises_descriptive_error(
    helper, value, category, supported_substring
) -> None:
    """Invalid values raise ValueError naming the value, category, and allowed set."""
    with pytest.raises(ValueError) as exc_info:
        helper(value)
    message = str(exc_info.value)
    assert repr(value) in message
    assert category in message
    assert supported_substring in message


# ---------------------------------------------------------------------------
# Request dataclass construction and field access (AC-003)
# ---------------------------------------------------------------------------

REQUEST_CONSTRUCTION_CASES = [
    # (dataclass_factory, kwargs, expected_command, extra_field_checks)
    (
        PlanExecuteRequest,
        {"workdir": "/work", "prompt": "do it"},
        Command.PLAN_EXECUTE,
        {},
    ),
    (
        ProcessLearningsRequest,
        {"workdir": "/work", "prompt": "learn"},
        Command.PROCESS_LEARNINGS,
        {},
    ),
    (
        ExportLearningsRequest,
        {"workdir": "/work", "prompt": "export"},
        Command.EXPORT_LEARNINGS,
        {},
    ),
    (
        CodeReviewStartRequest,
        {"workdir": "/work", "prompt": "review", "base_sha": "abc123"},
        Command.CODE_REVIEW_START,
        {"base_sha": "abc123"},
    ),
    (
        CodeReviewFixRequest,
        {"workdir": "/work", "prompt": "fix", "cr_dir": "/tmp/cr"},
        Command.CODE_REVIEW_FIX,
        {"cr_dir": "/tmp/cr"},
    ),
]


@pytest.mark.parametrize(
    "factory,kwargs,expected_command,extra_checks",
    REQUEST_CONSTRUCTION_CASES,
)
def test_request_construction_and_field_access(
    factory, kwargs, expected_command, extra_checks
) -> None:
    """Each request dataclass constructs successfully with correct field values."""
    req = factory(**kwargs)
    assert req.workdir == kwargs["workdir"]
    assert req.prompt == kwargs["prompt"]
    assert req.command == expected_command
    for field, value in extra_checks.items():
        assert getattr(req, field) == value


def test_request_dataclasses_are_frozen() -> None:
    """Request dataclasses are immutable (frozen).

    ``frozen=True`` is inherited identically from ``_BaseRequest`` by all five
    request types, so one representative is sufficient to pin the contract.
    """
    req = PlanExecuteRequest(workdir="/work", prompt="do it")
    with pytest.raises((AttributeError, TypeError)):
        req.workdir = "mutated"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# TurnResult construction
# ---------------------------------------------------------------------------

TURN_RESULT_CASES = [
    # (result_text, is_error, session_id)
    ("success output", False, "sess-001"),
    ("error output", True, None),
    ("", False, "sess-xyz"),
    ("multi\nline\ntext", False, None),
]


@pytest.mark.parametrize("result_text,is_error,session_id", TURN_RESULT_CASES)
def test_turn_result_construction(
    result_text: str, is_error: bool, session_id: str | None
) -> None:
    """TurnResult constructs with correct field values."""
    tr = TurnResult(result_text=result_text, is_error=is_error, session_id=session_id)
    assert tr.result_text == result_text
    assert tr.is_error == is_error
    assert tr.session_id == session_id


def test_turn_result_session_id_defaults_to_none() -> None:
    """TurnResult.session_id defaults to None when omitted."""
    tr = TurnResult(result_text="ok", is_error=False)
    assert tr.session_id is None


def test_turn_result_is_frozen() -> None:
    """TurnResult is immutable (frozen dataclass)."""
    tr = TurnResult(result_text="ok", is_error=False)
    with pytest.raises((AttributeError, TypeError)):
        tr.result_text = "mutated"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# TerminalFailure subcode validation (AC-004)
# ---------------------------------------------------------------------------

VALID_SUBCODES = [
    "ABC",
    "XYZ",
    "ABC_DEF",
    "A0B",
    "RUNNER_ERROR",
    "TIMEOUT_FAILURE",
    "A" + "B" * 63,  # exactly 64 chars total — max allowed (1 + 63)
    "A12",
    "A_B_C_D",
]

INVALID_SUBCODES = [
    "",               # empty
    "AB",             # too short (2 chars total, needs at least 3)
    "ab",             # lowercase — must start uppercase
    "abc",            # all lowercase
    "1ABC",           # starts with digit
    "_ABC",           # starts with underscore
    "A" + "B" * 64,  # 65 chars — too long (max is 1 + 63 = 64)
    "A B",            # contains space
    "A-B",            # contains hyphen
    "A.B",            # contains dot
]


@pytest.mark.parametrize("subcode", VALID_SUBCODES)
def test_terminal_failure_valid_subcode_accepted(subcode: str) -> None:
    """TerminalFailure constructs successfully with a valid subcode."""
    tf = TerminalFailure(status="RUNNER_ERROR", subcode=subcode, message="msg")
    assert tf.subcode == subcode


@pytest.mark.parametrize("subcode", INVALID_SUBCODES)
def test_terminal_failure_invalid_subcode_rejected(subcode: str) -> None:
    """TerminalFailure raises ValueError for invalid subcodes before construction completes."""
    # status + message are valid so the subcode is the sole rejection reason.
    with pytest.raises(ValueError, match="subcode"):
        TerminalFailure(status="RUNNER_ERROR", subcode=subcode, message="msg")


def test_terminal_failure_field_access() -> None:
    """TerminalFailure fields are accessible after construction."""
    tf = TerminalFailure(status="RUNNER_ERROR", subcode="XYZ_FAILURE", message="Loop failed.")
    assert tf.status == "RUNNER_ERROR"
    assert tf.subcode == "XYZ_FAILURE"
    assert tf.message == "Loop failed."


# Mirrors the ``case "$code"`` allowlist in run-loop.sh:70-77.
VALID_STATUSES = ["RUNNER_ERROR", "PRE_RUN_VALIDATION_FAILED", "PLAN_STATE_UNAVAILABLE"]
INVALID_STATUSES = ["", "EXIT", "TIMEOUT", "error", "runner_error", "RUNNER ERROR"]


@pytest.mark.parametrize("status", VALID_STATUSES)
def test_terminal_failure_valid_status_accepted(status: str) -> None:
    """TerminalFailure accepts every status in the run-loop.sh allowlist."""
    tf = TerminalFailure(status=status, subcode="NON_ZERO_EXIT", message="msg")
    assert tf.status == status


@pytest.mark.parametrize("status", INVALID_STATUSES)
def test_terminal_failure_invalid_status_rejected(status: str) -> None:
    """TerminalFailure rejects any status outside the run-loop.sh allowlist."""
    with pytest.raises(ValueError, match="status"):
        TerminalFailure(status=status, subcode="NON_ZERO_EXIT", message="msg")


def test_terminal_failure_max_length_message_accepted() -> None:
    """A 1000-char message (the boundary) is accepted."""
    tf = TerminalFailure(status="RUNNER_ERROR", subcode="NON_ZERO_EXIT", message="x" * 1000)
    assert len(tf.message) == 1000


@pytest.mark.parametrize("message", ["", "x" * 1001])
def test_terminal_failure_invalid_message_rejected(message: str) -> None:
    """TerminalFailure rejects empty and over-1000-char messages (run-loop.sh:84-87)."""
    with pytest.raises(ValueError, match="message"):
        TerminalFailure(status="RUNNER_ERROR", subcode="NON_ZERO_EXIT", message=message)


# ---------------------------------------------------------------------------
# JSON round-trip: request_from_json (AC-003)
# ---------------------------------------------------------------------------

REQUEST_FROM_JSON_CASES = [
    (
        {"command": "plan_execute", "workdir": "/work", "prompt": "run"},
        PlanExecuteRequest,
        {"workdir": "/work", "prompt": "run", "command": Command.PLAN_EXECUTE},
    ),
    (
        {"command": "process_learnings", "workdir": "/data", "prompt": "learn"},
        ProcessLearningsRequest,
        {"workdir": "/data", "prompt": "learn", "command": Command.PROCESS_LEARNINGS},
    ),
    (
        {"command": "export_learnings", "workdir": "/out", "prompt": "export"},
        ExportLearningsRequest,
        {"workdir": "/out", "prompt": "export", "command": Command.EXPORT_LEARNINGS},
    ),
    (
        {"command": "code_review_start", "workdir": "/src", "prompt": "review", "base_sha": "deadbeef"},
        CodeReviewStartRequest,
        {"workdir": "/src", "prompt": "review", "base_sha": "deadbeef", "command": Command.CODE_REVIEW_START},
    ),
    (
        {"command": "code_review_fix", "workdir": "/src", "prompt": "fix", "cr_dir": "/tmp/cr"},
        CodeReviewFixRequest,
        {"workdir": "/src", "prompt": "fix", "cr_dir": "/tmp/cr", "command": Command.CODE_REVIEW_FIX},
    ),
]


@pytest.mark.parametrize("payload,expected_type,expected_fields", REQUEST_FROM_JSON_CASES)
def test_request_from_json_returns_correct_type_and_fields(
    payload, expected_type, expected_fields
) -> None:
    """request_from_json returns the correct type with all fields populated."""
    req = request_from_json(payload)
    assert isinstance(req, expected_type)
    for field, value in expected_fields.items():
        assert getattr(req, field) == value


def test_request_from_json_missing_command_raises_key_error() -> None:
    """request_from_json raises KeyError when 'command' key is absent."""
    with pytest.raises(KeyError):
        request_from_json({"workdir": "/work", "prompt": "run"})


def test_request_from_json_unknown_command_raises_value_error() -> None:
    """request_from_json raises ValueError for an unrecognized command string."""
    with pytest.raises(ValueError):
        request_from_json({"command": "nonexistent_command", "workdir": "/w", "prompt": "p"})


def test_request_from_json_missing_required_field_raises_type_error() -> None:
    """request_from_json raises TypeError when a command-specific required field is absent."""
    with pytest.raises(TypeError):
        request_from_json({"command": "code_review_start", "workdir": "/w", "prompt": "p"})


# ---------------------------------------------------------------------------
# JSON round-trip: TurnResult serialization (AC-007)
# ---------------------------------------------------------------------------

TURN_RESULT_ROUND_TRIP_CASES = [
    TurnResult(result_text="ok", is_error=False, session_id="s1"),
    TurnResult(result_text="failed", is_error=True, session_id=None),
    TurnResult(result_text="", is_error=False, session_id="s2"),
    TurnResult(result_text="multi\nline", is_error=False, session_id=None),
]


@pytest.mark.parametrize("original", TURN_RESULT_ROUND_TRIP_CASES)
def test_turn_result_json_round_trip(original: TurnResult) -> None:
    """TurnResult round-trips through to_json/from_json without data loss."""
    serialized = turn_result_to_json(original)
    assert isinstance(serialized, dict)
    restored = turn_result_from_json(serialized)
    assert restored == original


# ---------------------------------------------------------------------------
# JSON round-trip: TerminalFailure serialization (AC-007)
# ---------------------------------------------------------------------------

TERMINAL_FAILURE_ROUND_TRIP_CASES = [
    TerminalFailure(status="RUNNER_ERROR", subcode="XYZ_FAILURE", message="Loop failed."),
    TerminalFailure(status="PLAN_STATE_UNAVAILABLE", subcode="TIM", message="Timed out after 60s."),
    TerminalFailure(status="PRE_RUN_VALIDATION_FAILED", subcode="NON_ZERO_EXIT", message="Process exited 1."),
]


@pytest.mark.parametrize("original", TERMINAL_FAILURE_ROUND_TRIP_CASES)
def test_terminal_failure_json_round_trip(original: TerminalFailure) -> None:
    """TerminalFailure round-trips through to_json/from_json without data loss."""
    serialized = terminal_failure_to_json(original)
    assert isinstance(serialized, dict)
    restored = terminal_failure_from_json(serialized)
    assert restored == original
