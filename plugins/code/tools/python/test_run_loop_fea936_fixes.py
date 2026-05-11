"""Tests for FEA-936's two correctness fixes in run-loop.sh.

Fix 1: write_runs_log_entry default command must NOT be `self_learning`.
       Fresh-start Loops (before any review/fix sub-step has run) used to
       log every iteration as `command=self_learning`, silently mis-classifying
       the most common Loop type in Datadog. The new precedence is:
         LAST_CLAUDE_COMMAND → CLOSEDLOOP_COMMAND → plan_execute.

Fix 2: emit_perf_event must not crash the Loop when called with an empty
       json_line. Under `set -euo pipefail`, piping "" to jq exits non-zero
       and would terminate run-loop.sh mid-iteration. The guard makes the
       empty case a silent no-op.
"""

import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_LOOP = REPO_ROOT / "plugins" / "code" / "scripts" / "run-loop.sh"


def run_sourced(script: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Source run-loop.sh in a clean shell and run the given script body."""
    full_env = {"PATH": os.environ.get("PATH", "")}
    if env:
        full_env.update(env)
    return subprocess.run(
        ["bash", "-c", f'set --; source "{RUN_LOOP}"; {script}'],
        text=True,
        capture_output=True,
        check=False,
        env=full_env,
    )


# ---------------------------------------------------------------------------
# Fix 1 — write_runs_log_entry default command precedence
# ---------------------------------------------------------------------------


def test_runs_log_default_is_plan_execute_when_all_empty(tmp_path: Path) -> None:
    """On a fresh-start Loop with no LAST_CLAUDE_COMMAND and no
    CLOSEDLOOP_COMMAND, the runs.log row must read `plan_execute` — not the
    historical `self_learning` default that overcounted fresh starts."""
    result = run_sourced(
        f'RUN_ID=test-run write_runs_log_entry "{tmp_path}" 1 in_progress',
        env={"CLOSEDLOOP_COMMAND": "", "LAST_CLAUDE_COMMAND": ""},
    )
    assert result.returncode == 0, result.stderr
    row = (tmp_path / "runs.log").read_text().strip().split("|")
    # Fields: RUN_ID|timestamp|goal|iteration|status|command|session_id
    assert row[5] == "plan_execute", (
        f"expected plan_execute, got {row[5]} (full row: {row})"
    )


def test_runs_log_respects_closedloop_command_over_default(tmp_path: Path) -> None:
    """When LAST_CLAUDE_COMMAND is empty but CLOSEDLOOP_COMMAND is set
    (websocket-derived), prefer CLOSEDLOOP_COMMAND. This is the integration
    point with the run-loop.sh:1504 precedence rule — a single source of
    truth for the slash-command name."""
    result = run_sourced(
        f'RUN_ID=test-run write_runs_log_entry "{tmp_path}" 1 in_progress',
        env={"CLOSEDLOOP_COMMAND": "evaluate-plan", "LAST_CLAUDE_COMMAND": ""},
    )
    assert result.returncode == 0, result.stderr
    row = (tmp_path / "runs.log").read_text().strip().split("|")
    assert row[5] == "evaluate-plan"


def test_runs_log_last_claude_command_wins(tmp_path: Path) -> None:
    """Once a claude invocation has set LAST_CLAUDE_COMMAND (review/fix
    step), it wins over both CLOSEDLOOP_COMMAND and the plan_execute fallback
    — preserves the existing review/fix attribution path.

    Note: LAST_CLAUDE_COMMAND has to be set AFTER sourcing because run-loop.sh
    declares `LAST_CLAUDE_COMMAND=""` at top-level (line 46), which would
    clobber an env-var-supplied value.
    """
    result = run_sourced(
        f'LAST_CLAUDE_COMMAND=code_review RUN_ID=test-run '
        f'write_runs_log_entry "{tmp_path}" 1 in_progress',
        env={"CLOSEDLOOP_COMMAND": "evaluate-plan"},
    )
    assert result.returncode == 0, result.stderr
    row = (tmp_path / "runs.log").read_text().strip().split("|")
    assert row[5] == "code_review"


def test_runs_log_explicit_command_arg_wins(tmp_path: Path) -> None:
    """An explicit 4th arg to write_runs_log_entry overrides every fallback.
    All call sites that pass `plan_execute` literally continue to work."""
    result = run_sourced(
        f'RUN_ID=test-run write_runs_log_entry "{tmp_path}" 1 in_progress plan_execute',
        env={"CLOSEDLOOP_COMMAND": "ignored", "LAST_CLAUDE_COMMAND": "also_ignored"},
    )
    assert result.returncode == 0, result.stderr
    row = (tmp_path / "runs.log").read_text().strip().split("|")
    assert row[5] == "plan_execute"


# ---------------------------------------------------------------------------
# Fix 2 — emit_perf_event empty-input guard
# ---------------------------------------------------------------------------


def test_emit_perf_event_empty_input_is_noop(tmp_path: Path) -> None:
    """Calling emit_perf_event "" must return 0 and not write to perf.jsonl,
    even under `set -euo pipefail`. Previously this crashed the Loop."""
    result = run_sourced(
        'set -euo pipefail; emit_perf_event ""; echo "survived"',
        env={
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "CLOSEDLOOP_COMMAND": "plan_execute",
        },
    )
    assert result.returncode == 0, result.stderr
    assert "survived" in result.stdout
    assert not (tmp_path / "perf.jsonl").exists(), (
        "empty input should produce no perf.jsonl entry"
    )


def test_emit_perf_event_normal_input_still_works(tmp_path: Path) -> None:
    """The guard must not break the normal path — a valid json_line still
    appends to perf.jsonl with command field injected."""
    result = run_sourced(
        'emit_perf_event \'{"event":"phase","phase":"Phase 1"}\'',
        env={
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "CLOSEDLOOP_COMMAND": "plan_execute",
        },
    )
    assert result.returncode == 0, result.stderr
    line = (tmp_path / "perf.jsonl").read_text().strip()
    assert '"event":"phase"' in line
    assert '"command":"plan_execute"' in line


def test_emit_perf_event_empty_then_valid_sequence(tmp_path: Path) -> None:
    """An empty call followed by a valid call must produce exactly one row —
    the empty call is silent, the valid call emits normally."""
    result = run_sourced(
        'emit_perf_event ""; emit_perf_event \'{"event":"run"}\'',
        env={
            "CLOSEDLOOP_WORKDIR": str(tmp_path),
            "CLOSEDLOOP_COMMAND": "plan_execute",
        },
    )
    assert result.returncode == 0, result.stderr
    lines = (tmp_path / "perf.jsonl").read_text().strip().splitlines()
    assert len(lines) == 1
    assert '"event":"run"' in lines[0]
