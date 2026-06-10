"""Tests for record_iteration.sh native loop telemetry."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "record_iteration.sh"


def run_record_iteration(workdir: Path) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "CLOSEDLOOP_WORKDIR": str(workdir),
    }
    return subprocess.run(
        ["bash", str(SCRIPT_PATH), str(workdir)],
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


def write_config_env(
    workdir: Path,
    *,
    run_id: str = "native-run-001",
    iteration: int = 0,
    command: str = "PLAN",
) -> None:
    closedloop_dir = workdir / ".closedloop-ai"
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


def test_iteration_event_is_schema_compatible_and_uses_config_env(
    tmp_path: Path,
) -> None:
    write_config_env(
        tmp_path,
        run_id="run-from-config",
        iteration=3,
        command="EXECUTE",
    )

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
    assert event["status"] in {"ok", "success", "failure", "completed", "COMPLETED"}
    assert "started_at" in event
    assert "ended_at" in event
    assert "duration_s" in event


def test_record_iteration_does_not_emit_pipeline_step_events(tmp_path: Path) -> None:
    write_config_env(tmp_path)

    result = run_record_iteration(tmp_path)

    assert result.returncode == 0, result.stderr
    events = [
        json.loads(line)["event"]
        for line in (tmp_path / "perf.jsonl").read_text().splitlines()
        if line.strip()
    ]
    assert events == ["iteration"]
    assert "pipeline_step" not in events
