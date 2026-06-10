from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

CLOSEDLOOP_STATE_DIR = ".closedloop-ai"


# ---------------------------------------------------------------------------
# Native-command telemetry shared factories (config.env / state.json)
#
# Single source of truth for the telemetry test suites (test_record_iteration,
# test_record_phase, test_user_prompt_expansion_hook). Per CLAUDE.md, test data
# factories used by 2+ test files live here rather than inlined per file.
# ---------------------------------------------------------------------------


def write_config_env(
    workdir: Path,
    *,
    run_id: str = "native-run-001",
    iteration: int = 0,
    command: str = "PLAN",
) -> None:
    """Write a full 4-var CLOSEDLOOP_* config.env under ``workdir``."""
    closedloop_dir = workdir / CLOSEDLOOP_STATE_DIR
    closedloop_dir.mkdir(exist_ok=True)
    (closedloop_dir / "config.env").write_text(
        "\n".join(
            [
                f"CLOSEDLOOP_WORKDIR={workdir}",
                f"CLOSEDLOOP_RUN_ID={run_id}",
                f"CLOSEDLOOP_ITERATION={iteration}",
                f"CLOSEDLOOP_COMMAND={command}",
                "",
            ]
        )
    )


def write_state(
    workdir: Path,
    *,
    phase: str = "plan",
    status: str = "COMPLETED",
    start_sha: str = "abc123",
) -> None:
    """Write a minimal state.json under ``workdir`` for telemetry scripts."""
    state = {"phase": phase, "status": status, "startSha": start_sha}
    (workdir / "state.json").write_text(json.dumps(state))


# ---------------------------------------------------------------------------
# Harness types shared fixtures
# ---------------------------------------------------------------------------

# Ensure harness package is importable regardless of how pytest discovers tests.
sys.path.insert(0, str(Path(__file__).parent))

from harness.adapter import HarnessAdapter  # noqa: E402
from harness.types import (  # noqa: E402
    Command,
    InvocationRequest,
    TerminalFailure,
    TurnResult,
)


# ---------------------------------------------------------------------------
# Fake adapter shared fixtures (used by test_harness_registry.py)
# ---------------------------------------------------------------------------


class _FakeAdapterClass(HarnessAdapter):
    """Minimal concrete HarnessAdapter that satisfies all six abstract methods.

    Used in tests to verify registration and lookup without needing a real
    harness subprocess.
    """

    name = "fake"

    def supports(self, command: Command) -> bool:
        return True

    def build_entry_prompt(
        self,
        workdir: str,
        prompt_name: str,
        prd: str,
        add_dirs: list[str],
    ) -> str:
        return f"entry:{workdir}:{prompt_name}"

    def build_argv(self, request: InvocationRequest) -> list[str]:
        return ["fake-harness", "--workdir", request.workdir]

    def parse_session_id(self, raw_output: str) -> str | None:
        return None

    def parse_turn_result(self, raw_output: str) -> TurnResult:
        return TurnResult(result_text=raw_output, is_error=False)

    def classify_terminal_failure(
        self,
        raw_output: str,
        stderr: str,
        exit_code: int,
    ) -> TerminalFailure:
        return TerminalFailure(
            status="RUNNER_ERROR",
            subcode="NON_ZERO_EXIT",
            message=stderr or "fake harness failure",
        )


class _AnotherFakeAdapterClass(HarnessAdapter):
    """A second concrete HarnessAdapter for multi-adapter registry tests."""

    name = "another-fake"

    def supports(self, command: Command) -> bool:
        return False

    def build_entry_prompt(
        self,
        workdir: str,
        prompt_name: str,
        prd: str,
        add_dirs: list[str],
    ) -> str:
        return f"another:{workdir}"

    def build_argv(self, request: InvocationRequest) -> list[str]:
        return ["another-harness"]

    def parse_session_id(self, raw_output: str) -> str | None:
        return None

    def parse_turn_result(self, raw_output: str) -> TurnResult:
        return TurnResult(result_text=raw_output, is_error=False)

    def classify_terminal_failure(
        self,
        raw_output: str,
        stderr: str,
        exit_code: int,
    ) -> TerminalFailure:
        return TerminalFailure(
            status="RUNNER_ERROR",
            subcode="NON_ZERO_EXIT",
            message=stderr or "fake harness failure",
        )


@pytest.fixture()
def FakeAdapter():  # noqa: N802
    """Return the FakeAdapter class for registry tests."""
    return _FakeAdapterClass


@pytest.fixture()
def AnotherFakeAdapter():  # noqa: N802
    """Return the AnotherFakeAdapter class for registry tests."""
    return _AnotherFakeAdapterClass
