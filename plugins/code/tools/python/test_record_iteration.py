"""Tests for record_iteration.sh native loop telemetry."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import write_config_env, write_state


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "record_iteration.sh"
ONCE_SCRIPT_PATH = (
    Path(__file__).resolve().parents[2] / "scripts" / "record_native_iteration_once.sh"
)


def run_record_iteration(workdir: Path) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "CLOSEDLOOP_WORKDIR": str(workdir),
    }
    env.pop("CLOSEDLOOP_RUN_ID", None)
    env.pop("CLOSEDLOOP_ITERATION", None)
    env.pop("CLOSEDLOOP_COMMAND", None)
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


def run_record_native_iteration_once(workdir: Path) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "CLOSEDLOOP_WORKDIR": str(workdir),
    }
    env.pop("CLOSEDLOOP_RUN_ID", None)
    env.pop("CLOSEDLOOP_ITERATION", None)
    env.pop("CLOSEDLOOP_COMMAND", None)
    return subprocess.run(
        ["bash", str(ONCE_SCRIPT_PATH), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


def test_iteration_event_is_schema_compatible_and_uses_config_env(
    tmp_path: Path,
) -> None:
    write_config_env(
        tmp_path,
        run_id="run-from-config",
        iteration=3,
        command="EXECUTE",
    )
    write_state(tmp_path, status="COMPLETED")

    result = run_record_iteration(tmp_path)

    assert result.returncode == 0, result.stderr
    records = [
        json.loads(line)
        for line in (tmp_path / "perf.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(records) == 1
    event = records[0]
    assert event["event"] == "iteration"
    assert event["run_id"] == "run-from-config"
    assert event["iteration"] == 3
    assert event["command"] == "EXECUTE"
    assert event["status"] == "ok"
    assert event["claude_exit_code"] == 0
    assert "started_at" in event
    assert "ended_at" in event
    assert "duration_s" in event


def test_missing_state_json_yields_error_status(tmp_path: Path) -> None:
    """A completed iteration with no state.json is recorded as an error."""
    write_config_env(tmp_path, run_id="run-no-state", iteration=1, command="PLAN")

    result = run_record_iteration(tmp_path)

    assert result.returncode == 0, result.stderr
    event = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    assert event["status"] == "error"
    assert event["claude_exit_code"] == 1


def test_incomplete_state_json_yields_error_status(tmp_path: Path) -> None:
    """A state.json that never reached COMPLETED is recorded as an error."""
    write_config_env(tmp_path, run_id="run-incomplete", iteration=1, command="PLAN")
    write_state(tmp_path, status="in_progress")

    result = run_record_iteration(tmp_path)

    assert result.returncode == 0, result.stderr
    event = json.loads((tmp_path / "perf.jsonl").read_text().strip())
    assert event["status"] == "error"
    assert event["claude_exit_code"] == 1


def test_record_iteration_does_not_emit_pipeline_step_events(tmp_path: Path) -> None:
    write_config_env(tmp_path)
    write_state(tmp_path, status="COMPLETED")

    result = run_record_iteration(tmp_path)

    assert result.returncode == 0, result.stderr
    events = [
        json.loads(line)["event"]
        for line in (tmp_path / "perf.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert events == ["iteration"]
    assert "pipeline_step" not in events


def test_record_native_iteration_once_skips_duplicate_terminal_state(
    tmp_path: Path,
) -> None:
    write_config_env(tmp_path, run_id="run-once", iteration=2, command="PLAN")
    write_state(tmp_path, phase="Phase 2.8", status="COMPLETED")

    first = run_record_native_iteration_once(tmp_path)
    second = run_record_native_iteration_once(tmp_path)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    records = [
        json.loads(line)
        for line in (tmp_path / "perf.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(records) == 1
    assert records[0]["event"] == "iteration"


def test_record_native_iteration_once_records_new_terminal_state(
    tmp_path: Path,
) -> None:
    write_config_env(tmp_path, run_id="run-once-new-state", iteration=2, command="PLAN")
    write_state(tmp_path, phase="Phase 2.8", status="COMPLETED")

    first = run_record_native_iteration_once(tmp_path)
    write_state(tmp_path, phase="Phase 2.8", status="COMPLETED", start_sha="def456")
    state = json.loads((tmp_path / "state.json").read_text())
    state["timestamp"] = "2026-06-10T00:00:01Z"
    (tmp_path / "state.json").write_text(json.dumps(state))
    second = run_record_native_iteration_once(tmp_path)

    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    records = [
        json.loads(line)
        for line in (tmp_path / "perf.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert len(records) == 2
