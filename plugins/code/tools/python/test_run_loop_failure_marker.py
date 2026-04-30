import json
import os
import subprocess
from pathlib import Path
import hmac
import hashlib


REPO_ROOT = Path(__file__).resolve().parents[4]
RUN_LOOP = REPO_ROOT / "plugins" / "code" / "scripts" / "run-loop.sh"
FAILURE_SECRET = "test-loop-failure-secret"


def signed_marker(payload: dict) -> dict:
    canonical = json.dumps(payload, separators=(",", ":"))
    signature = hmac.new(
        FAILURE_SECRET.encode(),
        canonical.encode(),
        hashlib.sha256,
    ).hexdigest()
    return {**payload, "signature": f"sha256={signature}"}


def run_bash(
    script: str,
    workdir: Path,
    failure_secret: str | None = FAILURE_SECRET,
) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "CLOSEDLOOP_WORKDIR": str(workdir)}
    if failure_secret is not None:
        env["CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET"] = failure_secret
    return subprocess.run(
        ["bash", "-c", script],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
        env=env,
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
    assert json.loads(marker.read_text()) == signed_marker({
        "code": "RUNNER_ERROR",
        "message": "Loop execution failed because XYZ.",
        "result": {"subcode": "XYZ_FAILURE"},
    })


def test_write_loop_user_visible_failure_unsets_exported_secret(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        env | grep -q '^CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET='
        """,
        tmp_path,
    )

    assert result.returncode == 1


def test_write_loop_user_visible_failure_requires_secret(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        write_loop_user_visible_failure RUNNER_ERROR XYZ_FAILURE 'Do not write this.'
        """,
        tmp_path,
        failure_secret=None,
    )

    assert result.returncode != 0
    assert not (tmp_path / "loop-error.json").exists()
    assert "CLOSEDLOOP_USER_VISIBLE_FAILURE_SECRET is required" in result.stderr


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
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker({
        "code": "PRE_RUN_VALIDATION_FAILED",
        "message": "Plan state is not loadable.",
        "result": {"subcode": "BAD_PLAN_STATE"},
    })
