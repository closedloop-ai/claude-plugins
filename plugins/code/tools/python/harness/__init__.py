"""
harness -- Harness-agnostic orchestration contract for the code plugin.

Re-exports types (Command, request/result dataclasses, JSON helpers),
the HarnessAdapter ABC, and the adapter registry (register / get_adapter).
"""

from harness.adapter import HarnessAdapter
from harness.registry import get_adapter, register
from harness.types import (
    CodeReviewFixRequest,
    CodeReviewStartRequest,
    Command,
    ExportLearningsRequest,
    InvocationRequest,
    PlanExecuteRequest,
    ProcessLearningsRequest,
    TerminalFailure,
    TurnResult,
    request_from_json,
    terminal_failure_from_json,
    terminal_failure_to_json,
    turn_result_from_json,
    turn_result_to_json,
)

__all__ = [
    # Enum
    "Command",
    # Request dataclasses
    "PlanExecuteRequest",
    "ProcessLearningsRequest",
    "ExportLearningsRequest",
    "CodeReviewStartRequest",
    "CodeReviewFixRequest",
    "InvocationRequest",
    # Result dataclasses
    "TurnResult",
    "TerminalFailure",
    # JSON helpers
    "request_from_json",
    "turn_result_to_json",
    "turn_result_from_json",
    "terminal_failure_to_json",
    "terminal_failure_from_json",
    # Adapter
    "HarnessAdapter",
    # Registry
    "register",
    "get_adapter",
]
