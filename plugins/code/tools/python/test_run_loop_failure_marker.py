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


def test_detect_spurious_complete_no_plan_returns_empty(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "{}"


def test_detect_spurious_complete_no_pending_tasks_returns_empty(tmp_path: Path) -> None:
    (tmp_path / "plan.json").write_text(json.dumps({"pendingTasks": []}))

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "{}"


def test_detect_spurious_complete_pending_with_questions_flags(tmp_path: Path) -> None:
    (tmp_path / "plan.json").write_text(json.dumps({
        "pendingTasks": [{"id": "T-1.0"}, {"id": "T-2.0"}],
        "openQuestions": [{"id": "Q1", "text": "?"}],
    }))

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["subcode"] == "PENDING_TASKS_BLOCKED_BY_QUESTIONS"
    assert "T-1.0" in payload["message"]
    assert "T-2.0" in payload["message"]


def test_detect_spurious_complete_pending_without_questions_flags(tmp_path: Path) -> None:
    (tmp_path / "plan.json").write_text(json.dumps({
        "pendingTasks": [{"id": "T-1.0"}],
        "openQuestions": [],
    }))

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["subcode"] == "PENDING_TASKS_AT_COMPLETION"


def test_detect_spurious_complete_skips_when_awaiting_user(tmp_path: Path) -> None:
    # Phase 1.1 plan review checkpoint: a freshly drafted plan has pending
    # tasks and open questions by definition, but state.json signals an
    # AWAITING_USER hard stop, not final completion. Must not be flagged.
    (tmp_path / "plan.json").write_text(json.dumps({
        "pendingTasks": [{"id": "T-1.0"}],
        "openQuestions": [{"id": "Q1", "text": "?"}],
    }))
    (tmp_path / "state.json").write_text(json.dumps({
        "phase": "Phase 1.1: Plan review checkpoint",
        "status": "AWAITING_USER",
    }))

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "{}"


def test_detect_spurious_complete_flags_when_completed_status_with_pending(tmp_path: Path) -> None:
    # Final-completion claim with leftover pendingTasks remains a contract
    # violation and must still be flagged.
    (tmp_path / "plan.json").write_text(json.dumps({
        "pendingTasks": [{"id": "T-1.0"}],
        "openQuestions": [],
    }))
    (tmp_path / "state.json").write_text(json.dumps({
        "phase": "Phase 7: Logging and completion",
        "status": "COMPLETED",
    }))

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["subcode"] == "PENDING_TASKS_AT_COMPLETION"


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
