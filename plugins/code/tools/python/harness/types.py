"""
Harness type definitions: Command enum, request/result dataclasses, and JSON helpers.

All dataclasses are frozen (immutable). TerminalFailure validates its subcode at
construction time using the same regex enforced by run-loop.sh line 79.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from enum import StrEnum
from typing import Literal, Union


# ---------------------------------------------------------------------------
# Command enum
# ---------------------------------------------------------------------------

class Command(StrEnum):
    """Discriminant for all harness invocation requests.

    Using StrEnum so pyright can verify exhaustiveness in match/case blocks.
    """

    PLAN_EXECUTE = "plan_execute"
    PROCESS_LEARNINGS = "process_learnings"
    EXPORT_LEARNINGS = "export_learnings"
    CODE_REVIEW_START = "code_review_start"
    CODE_REVIEW_FIX = "code_review_fix"


# ---------------------------------------------------------------------------
# Request dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True, kw_only=True)
class _BaseRequest:
    """Fields shared by all invocation requests."""

    workdir: str
    prompt: str


@dataclass(frozen=True, kw_only=True)
class PlanExecuteRequest(_BaseRequest):
    """Request to execute a planning loop iteration."""

    command: Literal[Command.PLAN_EXECUTE] = Command.PLAN_EXECUTE


@dataclass(frozen=True, kw_only=True)
class ProcessLearningsRequest(_BaseRequest):
    """Request to process learnings after an iteration."""

    command: Literal[Command.PROCESS_LEARNINGS] = Command.PROCESS_LEARNINGS


@dataclass(frozen=True, kw_only=True)
class ExportLearningsRequest(_BaseRequest):
    """Request to export accumulated learnings."""

    command: Literal[Command.EXPORT_LEARNINGS] = Command.EXPORT_LEARNINGS


@dataclass(frozen=True, kw_only=True)
class CodeReviewStartRequest(_BaseRequest):
    """Request to start a code-review run."""

    base_sha: str
    command: Literal[Command.CODE_REVIEW_START] = Command.CODE_REVIEW_START


@dataclass(frozen=True, kw_only=True)
class CodeReviewFixRequest(_BaseRequest):
    """Request to apply code-review fixes."""

    cr_dir: str
    command: Literal[Command.CODE_REVIEW_FIX] = Command.CODE_REVIEW_FIX


# Union alias used as the single type across the boundary.
InvocationRequest = Union[
    PlanExecuteRequest,
    ProcessLearningsRequest,
    ExportLearningsRequest,
    CodeReviewStartRequest,
    CodeReviewFixRequest,
]


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class TurnResult:
    """Successful result returned by an adapter method."""

    result_text: str
    is_error: bool
    session_id: str | None = None


_SUBCODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")

# Mirrors every constraint enforced by ``write_loop_user_visible_failure()`` in
# run-loop.sh:55-87. Kept in sync with that function (the authoritative source):
# the ``status`` allowlist matches its ``case "$code"`` block, and the message
# length matches its 1-1000 char guard.
_STATUS_ALLOWLIST = frozenset(
    {"RUNNER_ERROR", "PRE_RUN_VALIDATION_FAILED", "PLAN_STATE_UNAVAILABLE"}
)
_MAX_MESSAGE_LEN = 1000


@dataclass(frozen=True)
class TerminalFailure:
    """Terminal failure returned by an adapter method.

    Validates all three constraints enforced by
    ``write_loop_user_visible_failure()`` in run-loop.sh:55-87, so a misbuilt
    failure fails fast at construction instead of being rejected downstream when
    bash writes the user-visible marker:

    - ``status`` must be one of ``RUNNER_ERROR``, ``PRE_RUN_VALIDATION_FAILED``,
      ``PLAN_STATE_UNAVAILABLE`` (the bash ``code`` allowlist).
    - ``subcode`` must match ``^[A-Z][A-Z0-9_]{2,63}$``.
    - ``message`` must be 1-1000 characters (non-empty, not over-long).
    """

    status: str
    subcode: str
    message: str

    def __post_init__(self) -> None:
        if self.status not in _STATUS_ALLOWLIST:
            allowed = ", ".join(sorted(_STATUS_ALLOWLIST))
            raise ValueError(
                f"TerminalFailure.status {self.status!r} is not allowed. "
                f"Must be one of: {allowed}"
            )
        if not _SUBCODE_RE.match(self.subcode):
            raise ValueError(
                f"TerminalFailure.subcode {self.subcode!r} does not match "
                r"^[A-Z][A-Z0-9_]{2,63}$"
            )
        if not 1 <= len(self.message) <= _MAX_MESSAGE_LEN:
            raise ValueError(
                f"TerminalFailure.message must be 1-{_MAX_MESSAGE_LEN} characters "
                f"(got {len(self.message)})"
            )


# ---------------------------------------------------------------------------
# JSON dispatch table for request deserialization
# ---------------------------------------------------------------------------

_BY_COMMAND: dict[Command, type] = {
    Command.PLAN_EXECUTE: PlanExecuteRequest,
    Command.PROCESS_LEARNINGS: ProcessLearningsRequest,
    Command.EXPORT_LEARNINGS: ExportLearningsRequest,
    Command.CODE_REVIEW_START: CodeReviewStartRequest,
    Command.CODE_REVIEW_FIX: CodeReviewFixRequest,
}


def request_from_json(payload: dict[str, object]) -> InvocationRequest:
    """Deserialize a JSON payload dict to the appropriate request dataclass.

    Dispatches on ``payload["command"]`` via the ``_BY_COMMAND`` table.

    Raises:
        KeyError: if ``"command"`` is missing from payload.
        ValueError: if ``payload["command"]`` is not a valid ``Command`` member.
        TypeError: if required fields are absent for the resolved request class.
    """
    command = Command(payload["command"])  # type: ignore[arg-type]
    cls = _BY_COMMAND[command]
    kwargs = {k: v for k, v in payload.items() if k != "command"}
    return cls(**kwargs)


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------

def turn_result_to_json(result: TurnResult) -> dict[str, object]:
    """Serialize a TurnResult to a plain dict suitable for json.dumps."""
    return asdict(result)


def turn_result_from_json(payload: dict[str, object]) -> TurnResult:
    """Deserialize a plain dict (from json.loads) to a TurnResult."""
    return TurnResult(
        result_text=payload["result_text"],  # type: ignore[arg-type]
        is_error=payload["is_error"],  # type: ignore[arg-type]
        session_id=payload.get("session_id"),  # type: ignore[arg-type]
    )


def terminal_failure_to_json(failure: TerminalFailure) -> dict[str, object]:
    """Serialize a TerminalFailure to a plain dict suitable for json.dumps."""
    return asdict(failure)


def terminal_failure_from_json(payload: dict[str, object]) -> TerminalFailure:
    """Deserialize a plain dict (from json.loads) to a TerminalFailure."""
    return TerminalFailure(
        status=payload["status"],  # type: ignore[arg-type]
        subcode=payload["subcode"],  # type: ignore[arg-type]
        message=payload["message"],  # type: ignore[arg-type]
    )
