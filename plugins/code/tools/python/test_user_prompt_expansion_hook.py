"""Tests for native PLAN/EXECUTE UserPromptExpansion observability setup."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from conftest import write_config_env


HOOK_PATH = (
    Path(__file__).resolve().parents[2] / "hooks" / "user-prompt-expansion-hook.sh"
)


def run_hook(
    workdir: Path,
    command_name: str,
    *,
    cwd: Path | None = None,
    command_arguments: str | None = None,
    include_workdir_env: bool = True,
) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "CLAUDE_PLUGIN_ROOT": str(Path(__file__).resolve().parents[2]),
    }
    # Isolate from ambient run context so the hook's seeding behavior is driven
    # only by config.env and the test inputs (mirrors test_record_iteration.py).
    env.pop("CLOSEDLOOP_RUN_ID", None)
    env.pop("CLOSEDLOOP_ITERATION", None)
    env.pop("CLOSEDLOOP_COMMAND", None)
    if include_workdir_env:
        env["CLOSEDLOOP_WORKDIR"] = str(workdir)
    else:
        env.pop("CLOSEDLOOP_WORKDIR", None)
    payload = {"command_name": command_name}
    if cwd is not None:
        payload["cwd"] = str(cwd)
    if command_arguments is not None:
        payload["command_arguments"] = command_arguments
    return subprocess.run(
        ["bash", str(HOOK_PATH)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=15,
        env=env,
    )


def read_config_env(config_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in config_path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def test_create_plan_generates_run_id_and_persists_metadata(tmp_path: Path) -> None:
    closedloop_dir = tmp_path / ".closedloop-ai"
    closedloop_dir.mkdir()
    config_path = closedloop_dir / "config.env"
    config_path.write_text(f"CLOSEDLOOP_WORKDIR={tmp_path}\n")

    result = run_hook(tmp_path, "create-plan")

    assert result.returncode == 0, result.stderr
    config = read_config_env(config_path)
    assert config["CLOSEDLOOP_WORKDIR"] == str(tmp_path)
    assert config["CLOSEDLOOP_RUN_ID"] != "unknown"
    assert config["CLOSEDLOOP_RUN_ID"]
    assert config["CLOSEDLOOP_ITERATION"] == "0"
    assert config["CLOSEDLOOP_COMMAND"] == "PLAN"


def test_create_plan_uses_explicit_workdir_argument_without_env(
    tmp_path: Path,
) -> None:
    launch_cwd = tmp_path / "launch"
    workdir = tmp_path / "target workdir"
    launch_cwd.mkdir()
    closedloop_dir = workdir / ".closedloop-ai"
    closedloop_dir.mkdir(parents=True)
    config_path = closedloop_dir / "config.env"
    escaped_workdir = str(workdir).replace(" ", "\\ ")
    config_path.write_text(f"CLOSEDLOOP_WORKDIR={escaped_workdir}\n")

    result = run_hook(
        workdir,
        "create-plan",
        cwd=launch_cwd,
        command_arguments=str(workdir),
        include_workdir_env=False,
    )

    assert result.returncode == 0, result.stderr
    config = read_config_env(config_path)
    assert config["CLOSEDLOOP_WORKDIR"] == escaped_workdir
    assert config["CLOSEDLOOP_RUN_ID"] != "unknown"
    assert config["CLOSEDLOOP_ITERATION"] == "0"
    assert config["CLOSEDLOOP_COMMAND"] == "PLAN"
    assert not (launch_cwd / "perf.jsonl").exists()
    assert (workdir / "perf.jsonl").exists()


def test_execute_implementation_appends_schema_compatible_run_event(
    tmp_path: Path,
) -> None:
    closedloop_dir = tmp_path / ".closedloop-ai"
    closedloop_dir.mkdir()
    config_path = closedloop_dir / "config.env"
    config_path.write_text(f"CLOSEDLOOP_WORKDIR={tmp_path}\n")

    result = run_hook(tmp_path, "execute-implementation")

    assert result.returncode == 0, result.stderr
    config = read_config_env(config_path)
    perf_lines = (tmp_path / "perf.jsonl").read_text().splitlines()
    assert len(perf_lines) == 1
    event = json.loads(perf_lines[0])
    assert event["event"] == "run"
    assert event["run_id"] == config["CLOSEDLOOP_RUN_ID"]
    assert event["run_id"] != "unknown"
    assert event["command"] == "EXECUTE"
    assert "started_at" in event
    assert "repo" in event
    assert "branch" in event


def test_existing_run_id_is_restored_instead_of_replaced(tmp_path: Path) -> None:
    config_path = tmp_path / ".closedloop-ai" / "config.env"
    write_config_env(
        tmp_path, run_id="existing-run-123", iteration=7, command="OLD"
    )

    result = run_hook(tmp_path, "create-plan")

    assert result.returncode == 0, result.stderr
    config = read_config_env(config_path)
    assert config["CLOSEDLOOP_RUN_ID"] == "existing-run-123"
    assert config["CLOSEDLOOP_ITERATION"] == "0"
    assert config["CLOSEDLOOP_COMMAND"] == "PLAN"


def test_hook_fails_open_when_config_env_is_missing(tmp_path: Path) -> None:
    result = run_hook(tmp_path, "create-plan")

    assert result.returncode == 0
    assert not (tmp_path / "perf.jsonl").exists()
