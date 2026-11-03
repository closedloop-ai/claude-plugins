"""Tests for native run attribution in pre-tool-use-hook.sh telemetry."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import CLOSEDLOOP_STATE_DIR, write_config_env


HOOK_PATH = Path(__file__).resolve().parents[2] / "hooks" / "pre-tool-use-hook.sh"


def run_pre_tool_hook(
    *,
    cwd: Path,
    workdir: Path,
    tool_name: str = "Bash",
    tool_input: dict | None = None,
    tool_use_id: str = "tool-123",
    session_id: str = "session-123",
) -> subprocess.CompletedProcess[str]:
    session_dir = cwd / CLOSEDLOOP_STATE_DIR
    session_dir.mkdir(parents=True, exist_ok=True)
    (session_dir / f"session-{session_id}.workdir").write_text(str(workdir))

    payload = {
        "tool_name": tool_name,
        "tool_input": tool_input or {"command": "echo ok"},
        "tool_use_id": tool_use_id,
        "session_id": session_id,
        "cwd": str(cwd),
        "agent_id": "agent-1",
    }
    env = {
        **os.environ,
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
    }
    env.pop("CLOSEDLOOP_WORKDIR", None)
    env.pop("CLOSEDLOOP_RUN_ID", None)
    env.pop("CLOSEDLOOP_ITERATION", None)
    env.pop("CLOSEDLOOP_COMMAND", None)
    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
    )


def test_sentinel_uses_persisted_native_run_metadata(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"
    cwd.mkdir()
    workdir.mkdir()
    write_config_env(workdir, run_id="native-run-42", iteration=7, command="PLAN")

    result = run_pre_tool_hook(cwd=cwd, workdir=workdir)

    assert result.returncode == 0, result.stderr
    sentinel = json.loads((workdir / ".tool-calls" / "tool-123").read_text())
    assert sentinel["run_id"] == "native-run-42"
    assert sentinel["command"] == "PLAN"
    assert sentinel["iteration"] == 7


def test_spawn_event_uses_persisted_native_run_metadata(tmp_path: Path) -> None:
    cwd = tmp_path / "cwd"
    workdir = tmp_path / "workdir"
    cwd.mkdir()
    workdir.mkdir()
    write_config_env(workdir, run_id="native-run-agent", iteration=3, command="EXECUTE")

    result = run_pre_tool_hook(
        cwd=cwd,
        workdir=workdir,
        tool_name="Agent",
        tool_input={"subagent_type": "code-reviewer"},
        tool_use_id="agent-tool-1",
    )

    assert result.returncode == 0, result.stderr
    event = json.loads((workdir / "perf.jsonl").read_text().strip())
    assert event["event"] == "spawn"
    assert event["run_id"] == "native-run-agent"
    assert event["command"] == "EXECUTE"
    assert event["iteration"] == 3
    assert event["planned_subagent_type"] == "code-reviewer"
