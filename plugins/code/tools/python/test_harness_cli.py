"""Tests for harness/cli.py — subprocess-based CLI integration tests.

Covers:
- CLI dispatches to a registered fake adapter and returns valid JSON on stdout (AC-006)
- Full stdin-to-stdout round-trip: TurnResult JSON round-trips back to an equal
  TurnResult via turn_result_from_json (AC-007)

All test cases invoke the CLI as a subprocess so the full stdin→dispatch→stdout
path is exercised end-to-end, exactly as a shell caller would use it.

The fake adapter is injected into the subprocess via Python's ``-c`` flag, which
registers the adapter in the subprocess's registry before calling ``harness.cli.main()``.
This avoids the need for a separate helper script while keeping each case self-contained.

Because the CLI now validates the adapter-name argument against the closed
``AdapterName`` enum, the bootstrap mocks that enum with a superset that adds a
``FAKE`` member. ``adapter_name_from_str`` resolves ``AdapterName`` from the
``harness.types`` module namespace at call time, so reassigning it there is
enough to let the fake harness through the boundary.

Uses a table-driven (pytest.mark.parametrize) approach throughout.
Shared fixtures (FakeAdapter, AnotherFakeAdapter) are defined in conftest.py.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HARNESS_DIR = str(Path(__file__).parent)

# ---------------------------------------------------------------------------
# Helper: run the CLI in a subprocess with a pre-registered fake adapter
# ---------------------------------------------------------------------------

_BOOTSTRAP = """\
import sys
from enum import StrEnum
sys.path.insert(0, {harness_dir!r})
import harness.types as _htypes
from harness.adapter import HarnessAdapter
from harness.registry import register
from harness.types import Command, InvocationRequest, TurnResult, TerminalFailure

# Mock the closed AdapterName enum with a superset that adds a test harness so
# the fake adapter passes the CLI's adapter-name validation boundary.
class _MockAdapterName(StrEnum):
    CLAUDE = "claude"
    CODEX = "codex"
    FAKE = "fake"

# SSOT drift guard: the mock MUST stay a superset of the canonical AdapterName
# (the only synthetic addition is FAKE). _htypes.AdapterName is still the real
# enum here, before the reassignment below. If AdapterName ever gains or renames
# a member, this fails the subprocess loudly instead of letting the stale copy
# diverge silently behind the always-"fake" test path.
assert {{m.value for m in _htypes.AdapterName}} <= {{m.value for m in _MockAdapterName}}, (
    "_MockAdapterName drifted from harness.types.AdapterName; update the bootstrap superset"
)

_htypes.AdapterName = _MockAdapterName

class _SubprocessFakeAdapter(HarnessAdapter):
    name = _MockAdapterName.FAKE

    def supports(self, command: Command) -> bool:
        return True

    def build_entry_prompt(self, workdir, prompt_name, prd, add_dirs) -> str:
        return f"entry:{{workdir}}:{{prompt_name}}"

    def build_argv(self, request: InvocationRequest) -> list:
        return ["fake-harness", "--workdir", request.workdir]

    def parse_session_id(self, raw_output: str):
        return None

    def parse_turn_result(self, raw_output: str) -> TurnResult:
        return TurnResult(result_text=raw_output, is_error=False)

    def classify_terminal_failure(self, raw_output, stderr, exit_code) -> TerminalFailure:
        return TerminalFailure(status="RUNNER_ERROR", subcode="NON_ZERO_EXIT", message=stderr or "fail")

register(_SubprocessFakeAdapter)

import harness.cli
harness.cli.main()
"""


def _run_cli(
    adapter_name: str,
    method_name: str,
    stdin_payload: dict[str, object],
) -> subprocess.CompletedProcess[str]:
    """Invoke the CLI via subprocess with the fake adapter pre-registered."""
    code = _BOOTSTRAP.format(harness_dir=HARNESS_DIR)
    return subprocess.run(
        [sys.executable, "-c", code, adapter_name, method_name],
        input=json.dumps(stdin_payload),
        capture_output=True,
        text=True,
    )


# ---------------------------------------------------------------------------
# parse_turn_result: full stdin-to-stdout round-trip (AC-006, AC-007)
# ---------------------------------------------------------------------------

# Each case: (raw_output, expected_result_text, expected_is_error)
# The fake adapter's parse_turn_result returns TurnResult(result_text=raw_output, is_error=False).
PARSE_TURN_RESULT_CASES = [
    ("hello world", "hello world", False),
    ("", "", False),
    ("multi\nline\noutput", "multi\nline\noutput", False),
    ("exit code 0", "exit code 0", False),
]


@pytest.mark.parametrize("raw_output,expected_text,expected_is_error", PARSE_TURN_RESULT_CASES)
def test_parse_turn_result_round_trip(raw_output: str, expected_text: str, expected_is_error: bool) -> None:
    """CLI exits 0, returns valid JSON, and round-trips via turn_result_from_json (AC-006, AC-007)."""
    from harness.types import TurnResult, turn_result_from_json  # noqa: PLC0415

    payload: dict[str, object] = {
        "command": "plan_execute",
        "workdir": "/work",
        "prompt": "run",
        "raw_output": raw_output,
    }
    proc = _run_cli("fake", "parse_turn_result", payload)
    assert proc.returncode == 0, f"CLI exited {proc.returncode}; stderr={proc.stderr!r}"

    stdout_dict = json.loads(proc.stdout)
    assert isinstance(stdout_dict, dict)

    restored = turn_result_from_json(stdout_dict)
    expected = TurnResult(result_text=expected_text, is_error=expected_is_error)
    assert restored == expected, f"Round-trip mismatch: {restored!r} != {expected!r}"


# ---------------------------------------------------------------------------
# build_argv: CLI dispatches correctly (AC-006)
# ---------------------------------------------------------------------------

BUILD_ARGV_CASES = [
    # (command, workdir, prompt, expected_argv_contains)
    ("plan_execute", "/project", "run the plan", "fake-harness"),
    ("code_review_start", "/src", "do review", "fake-harness"),
    ("process_learnings", "/data", "learn", "fake-harness"),
]


@pytest.mark.parametrize("command,workdir,prompt,expected_argv_token", BUILD_ARGV_CASES)
def test_build_argv_dispatch(command: str, workdir: str, prompt: str, expected_argv_token: str) -> None:
    """CLI exits 0 and returns an argv list containing the expected token (AC-006)."""
    payload: dict[str, object] = {"command": command, "workdir": workdir, "prompt": prompt}
    if command == "code_review_start":
        payload["base_sha"] = "deadbeef"
    proc = _run_cli("fake", "build_argv", payload)
    assert proc.returncode == 0, f"CLI exited {proc.returncode}; stderr={proc.stderr!r}"
    result = json.loads(proc.stdout)
    assert "argv" in result
    assert expected_argv_token in result["argv"]


# ---------------------------------------------------------------------------
# classify_terminal_failure: dispatches and returns JSON (AC-006)
# ---------------------------------------------------------------------------

CLASSIFY_FAILURE_CASES = [
    # (command, workdir, stderr, exit_code)
    ("plan_execute", "/work", "something went wrong", 1),
    ("export_learnings", "/out", "timeout", 2),
]


@pytest.mark.parametrize("command,workdir,stderr,exit_code", CLASSIFY_FAILURE_CASES)
def test_classify_terminal_failure_dispatch(command: str, workdir: str, stderr: str, exit_code: int) -> None:
    """CLI exits 0 and returns valid TerminalFailure JSON (AC-006)."""
    payload: dict[str, object] = {
        "command": command,
        "workdir": workdir,
        "prompt": "run",
        "raw_output": "",
        "stderr": stderr,
        "exit_code": exit_code,
    }
    proc = _run_cli("fake", "classify_terminal_failure", payload)
    assert proc.returncode == 0, f"CLI exited {proc.returncode}; stderr={proc.stderr!r}"
    result = json.loads(proc.stdout)
    assert "status" in result
    assert "subcode" in result
    assert "message" in result


# ---------------------------------------------------------------------------
# Error cases: unregistered adapter / unknown method (AC-006)
# ---------------------------------------------------------------------------


def test_unknown_adapter_exits_nonzero() -> None:
    """CLI exits non-zero when the adapter name is not registered."""
    payload: dict[str, object] = {"command": "plan_execute", "workdir": "/work", "prompt": "run"}
    proc = _run_cli("nonexistent-adapter", "parse_turn_result", payload)
    assert proc.returncode != 0


def test_unknown_method_exits_nonzero() -> None:
    """CLI exits non-zero when the method name is not supported."""
    payload: dict[str, object] = {"command": "plan_execute", "workdir": "/work", "prompt": "run"}
    proc = _run_cli("fake", "nonexistent_method", payload)
    assert proc.returncode != 0


def test_missing_args_exits_nonzero() -> None:
    """CLI exits non-zero (prints usage) when called with wrong number of arguments."""
    code = _BOOTSTRAP.format(harness_dir=HARNESS_DIR)
    proc = subprocess.run(
        [sys.executable, "-c", code],  # no adapter_name or method_name
        input="{}",
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
