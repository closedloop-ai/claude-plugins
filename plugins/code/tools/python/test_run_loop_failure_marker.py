import json
import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_LOOP = REPO_ROOT / "plugins" / "code" / "scripts" / "run-loop.sh"


def run_bash(script: str, workdir: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
        env={**os.environ, "CLOSEDLOOP_WORKDIR": str(workdir)},
    )


def test_write_loop_user_visible_failure_writes_marker(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        write_loop_user_visible_failure RUNNER_ERROR XYZ_FAILURE 'Loop execution failed because XYZ.'
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    marker = tmp_path / "loop-error.json"
    assert marker.exists()
    assert json.loads(marker.read_text()) == {
        "code": "RUNNER_ERROR",
        "message": "Loop execution failed because XYZ.",
        "result": {"subcode": "XYZ_FAILURE"},
    }


def test_write_loop_user_visible_failure_rejects_unknown_code(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        write_loop_user_visible_failure PROCESS_FAILED XYZ_FAILURE 'Do not write this.'
        """,
        tmp_path,
    )

    assert result.returncode != 0
    assert not (tmp_path / "loop-error.json").exists()
    assert "unsupported loop failure code" in result.stderr


def test_fail_loop_user_visible_prints_reason_and_exits(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        fail_loop_user_visible PRE_RUN_VALIDATION_FAILED BAD_PLAN_STATE 'Plan state is not loadable.'
        """,
        tmp_path,
    )

    assert result.returncode == 1
    assert "CLOSEDLOOP_FATAL[BAD_PLAN_STATE]: Plan state is not loadable." in result.stderr
    assert json.loads((tmp_path / "loop-error.json").read_text()) == {
        "code": "PRE_RUN_VALIDATION_FAILED",
        "message": "Plan state is not loadable.",
        "result": {"subcode": "BAD_PLAN_STATE"},
    }
