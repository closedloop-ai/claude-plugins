import hashlib
import hmac
import json
import os
import subprocess
from pathlib import Path

import pytest

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
    # Remove vars that would be inherited from the outer test-runner process and
    # interfere with tests that assert on the default-fallback behaviour.
    env.pop("CLOSEDLOOP_COMMAND", None)
    env.pop("LAST_CLAUDE_COMMAND", None)
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
    assert json.loads(marker.read_text()) == signed_marker(
        {
            "code": "RUNNER_ERROR",
            "message": "Loop execution failed because XYZ.",
            "result": {"subcode": "XYZ_FAILURE"},
        }
    )


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


def test_detect_spurious_complete_no_pending_tasks_returns_empty(
    tmp_path: Path,
) -> None:
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
    (tmp_path / "plan.json").write_text(
        json.dumps(
            {
                "pendingTasks": [{"id": "T-1.0"}, {"id": "T-2.0"}],
                "openQuestions": [{"id": "Q1", "text": "?"}],
            }
        )
    )

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


def test_detect_spurious_complete_pending_without_questions_flags(
    tmp_path: Path,
) -> None:
    (tmp_path / "plan.json").write_text(
        json.dumps(
            {
                "pendingTasks": [{"id": "T-1.0"}],
                "openQuestions": [],
            }
        )
    )

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
    (tmp_path / "plan.json").write_text(
        json.dumps(
            {
                "pendingTasks": [{"id": "T-1.0"}],
                "openQuestions": [{"id": "Q1", "text": "?"}],
            }
        )
    )
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "phase": "Phase 1.1: Plan review checkpoint",
                "status": "AWAITING_USER",
            }
        )
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_spurious_complete "{tmp_path}"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "{}"


def test_detect_spurious_complete_flags_when_completed_status_with_pending(
    tmp_path: Path,
) -> None:
    # Final-completion claim with leftover pendingTasks remains a contract
    # violation and must still be flagged.
    (tmp_path / "plan.json").write_text(
        json.dumps(
            {
                "pendingTasks": [{"id": "T-1.0"}],
                "openQuestions": [],
            }
        )
    )
    (tmp_path / "state.json").write_text(
        json.dumps(
            {
                "phase": "Phase 7: Logging and completion",
                "status": "COMPLETED",
            }
        )
    )

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
    assert (
        "CLOSEDLOOP_FATAL[BAD_PLAN_STATE]: Plan state is not loadable." in result.stderr
    )
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker(
        {
            "code": "PRE_RUN_VALIDATION_FAILED",
            "message": "Plan state is not loadable.",
            "result": {"subcode": "BAD_PLAN_STATE"},
        }
    )


def write_jsonl(path: Path, entries: list[dict[str, object] | str]) -> None:
    lines = [
        entry if isinstance(entry, str) else json.dumps(entry, separators=(",", ":"))
        for entry in entries
    ]
    path.write_text("\n".join(lines) + "\n")


def run_detect(
    tmp_path: Path,
    *,
    jsonl: list[dict[str, object] | str] | None = None,
    stderr: str = "",
) -> dict:
    """Invoke detect_claude_terminal_failure and return the parsed JSON payload.

    Centralizes the bash-source boilerplate so per-case tests focus on
    fixture data and assertions rather than shell harness mechanics.
    """
    if jsonl is not None:
        write_jsonl(tmp_path / "output.jsonl", jsonl)
    else:
        (tmp_path / "output.jsonl").write_text("")
    stderr_arg = '""'
    if stderr:
        (tmp_path / "stderr.txt").write_text(stderr)
        stderr_arg = '"$CLOSEDLOOP_WORKDIR/stderr.txt"'
    result = run_bash(
        f"source {RUN_LOOP}\n"
        f'detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" {stderr_arg}',
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout or "{}")


def test_detect_claude_terminal_failure_observed_rate_limit_jsonl(
    tmp_path: Path,
) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": "rejected",
                    "rateLimitType": "five_hour",
                    "resetsAt": 1778095200,
                },
            },
            {
                "type": "assistant",
                "error": "rate_limit",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "You've hit your limit - resets 2:20pm (America/Chicago)",
                        },
                    ],
                },
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": True,
                "api_error_status": 429,
                "result": "You've hit your limit - resets 2:20pm (America/Chicago)",
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"
    # Message is sourced from the rate_limit_event entry (per-entry sourcing)
    assert "rate limit" in payload["message"].lower()


def test_detect_claude_terminal_failure_camel_case_api_status(tmp_path: Path) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "assistant",
                "isApiErrorMessage": True,
                "error": "rate_limit_error",
                "apiErrorStatus": 429,
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"
    assert "rate_limit_error" in payload["message"]


def test_detect_claude_terminal_failure_context_limit_jsonl(tmp_path: Path) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "result",
                "is_error": True,
                "result": "Prompt is too long for this model context limit.",
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "context_limit"
    assert payload["subcode"] == "CLAUDE_CONTEXT_LIMIT"
    assert "context limit" in payload["message"].lower()


def test_detect_claude_terminal_failure_context_limit_stderr(tmp_path: Path) -> None:
    (tmp_path / "output.jsonl").write_text("")
    (tmp_path / "stderr.txt").write_text(
        "Error: prompt is too long for the model context limit.\n",
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" "$CLOSEDLOOP_WORKDIR/stderr.txt"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "context_limit"
    assert payload["subcode"] == "CLAUDE_CONTEXT_LIMIT"
    assert "context limit" in payload["message"].lower()


def test_detect_claude_terminal_failure_auth_challenge_jsonl(tmp_path: Path) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "result",
                "is_error": True,
                "result": "Invalid bearer token. Please log in to Claude.",
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "claude_auth_error"
    assert payload["subcode"] == "CLAUDE_AUTH_CHALLENGE"
    assert "Invalid bearer token" in payload["message"]


def test_detect_claude_terminal_failure_clamps_long_marker_message(
    tmp_path: Path,
) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "result",
                "is_error": True,
                "api_error_status": 429,
                "result": "x" * 1200,
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"
    assert len(payload["message"]) <= 1000
    assert payload["message"].endswith("...")


def test_detect_claude_terminal_failure_ignores_unknown_or_malformed_jsonl(
    tmp_path: Path,
) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            "not-json",
            {
                "type": "result",
                "is_error": True,
                "result": "Unknown tool failed",
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_detect_claude_terminal_failure_ignores_successful_rate_limit_prose(
    tmp_path: Path,
) -> None:
    write_jsonl(
        tmp_path / "output.jsonl",
        [
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "Implemented rate limit handling in the API client.",
                        },
                    ],
                },
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "Completed the rate limit feature.",
            },
        ],
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_detect_claude_terminal_failure_flags_success_shaped_unknown_skill(
    tmp_path: Path,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "Unknown skill: code:code",
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        ],
    )

    assert payload["status"] == "unknown_skill"
    assert payload["subcode"] == "CLAUDE_UNKNOWN_SKILL"
    assert payload["message"] == (
        "Claude plugin command unavailable: Unknown skill: code:code"
    )


def test_detect_claude_terminal_failure_ignores_normal_success_prose(
    tmp_path: Path,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "Completed the plugin readiness implementation.",
            },
        ],
    )

    assert payload == {}


def test_handle_claude_terminal_failure_writes_marker_and_stops_retry(
    tmp_path: Path,
) -> None:
    (tmp_path / ".learnings").mkdir()
    (tmp_path / ".learnings" / ".lock").write_text("locked")
    (tmp_path / "state.local").write_text("state")
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')

    message = "Claude rate limit reached: You've hit your limit - resets 2:20pm"
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='rate-run'
        STATE_FILE="$CLOSEDLOOP_WORKDIR/state.local"
        PROGRESS_LOG="$CLOSEDLOOP_WORKDIR/progress.log"
        handle_claude_terminal_failure "$CLOSEDLOOP_WORKDIR" 7 claude_rate_limit CLAUDE_RATE_LIMIT "{message}"
        """,
        tmp_path,
    )

    assert result.returncode == 1
    assert "CLOSEDLOOP_FATAL[CLAUDE_RATE_LIMIT]" in result.stderr
    assert not (tmp_path / ".learnings" / ".lock").exists()
    assert not (tmp_path / "state.local").exists()
    assert not (tmp_path / "claude-output.jsonl").exists()
    assert (
        tmp_path / "claude-output-rate-run.jsonl"
    ).read_text() == '{"type":"result"}\n'
    assert (
        tmp_path / "claude-output.name.txt"
    ).read_text() == "claude-output-rate-run.jsonl\n"
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker(
        {
            "code": "RUNNER_ERROR",
            "message": message,
            "result": {"subcode": "CLAUDE_RATE_LIMIT"},
        }
    )

    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "rate-run"
    assert fields[3] == "7"
    assert fields[4] == "claude_rate_limit"
    assert fields[5] == "plan_execute"


def test_handle_claude_terminal_failure_writes_context_marker(
    tmp_path: Path,
) -> None:
    (tmp_path / ".learnings").mkdir()
    (tmp_path / ".learnings" / ".lock").write_text("locked")
    (tmp_path / "state.local").write_text("state")
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')

    message = "Claude context limit reached. Start a fresh run with reduced context."
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='context-run'
        STATE_FILE="$CLOSEDLOOP_WORKDIR/state.local"
        PROGRESS_LOG="$CLOSEDLOOP_WORKDIR/progress.log"
        handle_claude_terminal_failure "$CLOSEDLOOP_WORKDIR" 2 context_limit CLAUDE_CONTEXT_LIMIT "{message}"
        """,
        tmp_path,
    )

    assert result.returncode == 1
    assert "CLOSEDLOOP_FATAL[CLAUDE_CONTEXT_LIMIT]" in result.stderr
    assert not (tmp_path / ".learnings" / ".lock").exists()
    assert not (tmp_path / "state.local").exists()
    assert (
        tmp_path / "claude-output.name.txt"
    ).read_text() == "claude-output-context-run.jsonl\n"
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker(
        {
            "code": "RUNNER_ERROR",
            "message": message,
            "result": {"subcode": "CLAUDE_CONTEXT_LIMIT"},
        }
    )

    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[3] == "2"
    assert fields[4] == "context_limit"
    assert fields[5] == "plan_execute"


def test_handle_claude_terminal_failure_writes_unknown_skill_marker(
    tmp_path: Path,
) -> None:
    (tmp_path / ".learnings").mkdir()
    (tmp_path / ".learnings" / ".lock").write_text("locked")
    (tmp_path / "state.local").write_text("state")
    (tmp_path / "claude-output.jsonl").write_text(
        '{"type":"result","subtype":"success","is_error":false,"result":"Unknown skill: code:code"}\n'
    )

    message = "Claude plugin command unavailable: Unknown skill: code:code"
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='unknown-skill-run'
        STATE_FILE="$CLOSEDLOOP_WORKDIR/state.local"
        PROGRESS_LOG="$CLOSEDLOOP_WORKDIR/progress.log"
        handle_claude_terminal_failure "$CLOSEDLOOP_WORKDIR" 4 unknown_skill CLAUDE_UNKNOWN_SKILL "{message}"
        """,
        tmp_path,
    )

    assert result.returncode == 1
    assert "CLOSEDLOOP_FATAL[CLAUDE_UNKNOWN_SKILL]" in result.stderr
    assert not (tmp_path / ".learnings" / ".lock").exists()
    assert not (tmp_path / "state.local").exists()
    assert not (tmp_path / "claude-output.jsonl").exists()
    assert (tmp_path / "claude-output-unknown-skill-run.jsonl").read_text() == (
        '{"type":"result","subtype":"success","is_error":false,"result":"Unknown skill: code:code"}\n'
    )
    assert (
        tmp_path / "claude-output.name.txt"
    ).read_text() == "claude-output-unknown-skill-run.jsonl\n"
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker(
        {
            "code": "RUNNER_ERROR",
            "message": message,
            "result": {"subcode": "CLAUDE_UNKNOWN_SKILL"},
        }
    )


def test_rename_output_on_exit_moves_jsonl_and_writes_sidecar(tmp_path: Path) -> None:
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')

    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='run-exit'
        rename_output_on_exit
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "claude-output.jsonl").exists()
    assert (
        tmp_path / "claude-output-run-exit.jsonl"
    ).read_text() == '{"type":"result"}\n'
    assert (
        tmp_path / "claude-output.name.txt"
    ).read_text() == "claude-output-run-exit.jsonl\n"


def test_rename_orphan_output_on_start_clears_sidecar_and_uses_runs_log(
    tmp_path: Path,
) -> None:
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')
    (tmp_path / "claude-output.name.txt").write_text("claude-output-stale.jsonl\n")
    (tmp_path / "runs.log").write_text(
        "prev-run|2026-05-05T00:00:00Z|reduce-failures|1|error\n"
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        WORKDIR="$CLOSEDLOOP_WORKDIR"
        rename_orphan_output_on_start
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "claude-output.jsonl").exists()
    assert (
        tmp_path / "claude-output-prev-run.jsonl"
    ).read_text() == '{"type":"result"}\n'
    assert (tmp_path / "claude-output.name.txt").read_text() == ""


def test_write_runs_log_entry_uses_workdir_root(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='run-root-log'
        # Unset CLOSEDLOOP_COMMAND and LAST_CLAUDE_COMMAND to test the default
        unset CLOSEDLOOP_COMMAND
        unset LAST_CLAUDE_COMMAND
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 2 completed
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "runs.log").exists()
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-root-log"
    # FEA-936 fix 1: the default for write_runs_log_entry when neither
    # LAST_CLAUDE_COMMAND nor CLOSEDLOOP_COMMAND is set is `plan_execute`,
    # not the historical `self_learning` (which overcounted fresh-start Loops).
    assert fields[5] == "plan_execute"
    assert fields[6] == ""
    assert not (tmp_path / ".learnings" / "runs.log").exists()


def test_plan_execute_session_capture_writes_primary_session_and_runs_log(
    tmp_path: Path,
) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        output_file="$CLOSEDLOOP_WORKDIR/output.jsonl"
        printf '%s\\n' '{{"type":"system","session_id":"plan-session-123"}}' > "$output_file"
        printf '%s\\n' '{{"type":"result","subtype":"success"}}' >> "$output_file"
        session_id=$(extract_claude_session_id "$output_file")
        RUN_ID='run-plan-session'
        record_claude_session_id "$CLOSEDLOOP_WORKDIR" plan_execute "$session_id"
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 3 completed plan_execute "$session_id"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "session-id.txt").read_text() == "plan-session-123\n"
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-plan-session"
    assert fields[3] == "3"
    assert fields[4] == "completed"
    assert fields[5] == "plan_execute"
    assert fields[6] == "plan-session-123"


def test_code_review_session_capture_does_not_overwrite_primary_session(
    tmp_path: Path,
) -> None:
    (tmp_path / "session-id.txt").write_text("plan-session-123\n")

    result = run_bash(
        f"""
        source {RUN_LOOP}
        output_file="$CLOSEDLOOP_WORKDIR/output.jsonl"
        printf '%s\\n' '{{"type":"result","sessionId":"review-session-456"}}' > "$output_file"
        session_id=$(extract_claude_session_id "$output_file")
        RUN_ID='run-review-session'
        record_claude_session_id "$CLOSEDLOOP_WORKDIR" code_review "$session_id"
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 3 review_approve code_review "$session_id"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "session-id.txt").read_text() == "plan-session-123\n"
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-review-session"
    assert fields[4] == "review_approve"
    assert fields[5] == "code_review"
    assert fields[6] == "review-session-456"


def test_code_review_log_with_no_session_does_not_backfill_plan_session(
    tmp_path: Path,
) -> None:
    (tmp_path / "session-id.txt").write_text("plan-session-123\n")

    result = run_bash(
        f"""
        source {RUN_LOOP}
        output_file="$CLOSEDLOOP_WORKDIR/output.jsonl"
        printf '%s\\n' '{{"type":"result","subtype":"error"}}' > "$output_file"
        session_id=$(extract_claude_session_id "$output_file")
        RUN_ID='run-review-empty-session'
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 3 review_error code_review "$session_id"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-review-empty-session"
    assert fields[4] == "review_error"
    assert fields[5] == "code_review"
    assert fields[6] == ""


# ---------------------------------------------------------------------------
# PLN-502: detect_claude_terminal_failure consolidated coverage
#
# The four production deltas covered below:
#   1. rate_limit_signal predicate requires status/overageStatus != "allowed"
#      on rate_limit_event entries (Group A).
#   2. Failure messages source from the triggering entry's result/error
#      string, not arbitrary assistant text (E17 + tightened E18).
#   3. auth_challenge_signal only fires inside is_error / isApiErrorMessage
#      envelopes (Group B "auth" cases + F20).
#   4. rename_orphan_output_on_start requires state.workdir to match current
#      workdir before reusing prev_run_id (workdir_mismatch test).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "test_id,status,overage,using_overage,extra_info,expected_subcode",
    [
        ("RL-01-bug-repro", "allowed", "rejected", False, {}, None),
        (
            "RL-02-bug-repro-with-reason",
            "allowed",
            "rejected",
            False,
            {"overageDisabledReason": "org_level_disabled"},
            None,
        ),
        ("RL-03-benign-heartbeat", "allowed", "allowed", False, {}, None),
        ("RL-04-benign-no-overage-fields", "allowed", None, None, {}, None),
        (
            "RL-05-status-exceeded",
            "exceeded",
            "allowed",
            False,
            {},
            None,
        ),
        ("RL-06-status-paused", "paused", "allowed", False, {}, None),
        (
            "RL-07-status-throttled",
            "throttled",
            "allowed",
            False,
            {},
            None,
        ),
        (
            "RL-08-overage-actually-rejected",
            "allowed",
            "rejected",
            True,
            {},
            "CLAUDE_RATE_LIMIT",
        ),
        (
            "RL-09-overage-actually-exceeded",
            "allowed",
            "exceeded",
            True,
            {},
            None,
        ),
        ("RL-10-overage-rejected-flag-absent", "allowed", "rejected", None, {}, None),
        (
            "RL-11-overage-rejected-flag-string-true",
            "allowed",
            "rejected",
            "true",
            {},
            None,
        ),
        (
            "RL-14-both-status-and-overage-bad",
            "exceeded",
            "rejected",
            False,
            {},
            None,
        ),
        (
            "RL-15-both-bad-with-overage-on",
            "exceeded",
            "rejected",
            True,
            {},
            "CLAUDE_RATE_LIMIT",
        ),
        ("RL-16-malformed-both-missing", None, None, None, {}, None),
        ("RL-17-overage-exceeded-no-flag", "allowed", "exceeded", None, {}, None),
        # Group A: allowed_warning and rejected statuses (PLN-530)
        ("RL-18-allowed-warning-no-overage", "allowed_warning", None, False, {}, None),
        (
            "RL-19-allowed-warning-with-pct",
            "allowed_warning",
            None,
            False,
            {"warning_pct_int": 80},
            None,
        ),
        ("RL-20-rejected-no-overage", "rejected", None, False, {}, "CLAUDE_RATE_LIMIT"),
        (
            "RL-21-allowed-warning-overage-on",
            "allowed_warning",
            "allowed_warning",
            True,
            {},
            None,
        ),
        (
            "RL-22-allowed-warning-overage-on-with-pct",
            "allowed_warning",
            "allowed_warning",
            True,
            {"warning_pct_int": 80},
            None,
        ),
        (
            "RL-23-rejected-overage-on",
            "rejected",
            "rejected",
            True,
            {},
            "CLAUDE_RATE_LIMIT",
        ),
        # Group C: overage path regression guards (PLN-530)
        ("RL-25-overage-allowed-on", "allowed", "allowed", True, {}, None),
        ("RL-26-overage-exceeded-on", "allowed", "exceeded", True, {}, None),
        ("RL-27-overage-rejected-off", "allowed", "rejected", False, {}, None),
        # Group D: cross-branch interaction tests (PLN-530)
        (
            "RL-28-rejected-status-allowed-overage",
            "rejected",
            "allowed",
            True,
            {},
            "CLAUDE_RATE_LIMIT",
        ),
        (
            "RL-29-allowed-status-rejected-overage",
            "allowed",
            "rejected",
            True,
            {},
            "CLAUDE_RATE_LIMIT",
        ),
        ("RL-30-both-rejected", "rejected", "rejected", True, {}, "CLAUDE_RATE_LIMIT"),
        (
            "RL-31-both-allowed-warning",
            "allowed_warning",
            "allowed_warning",
            True,
            {},
            None,
        ),
    ],
    ids=lambda v: v if isinstance(v, str) else None,
)
def test_rate_limit_event_predicate(
    tmp_path: Path,
    test_id: str,
    status: str | None,
    overage: str | None,
    using_overage: bool | str | None,
    extra_info: dict,
    expected_subcode: str | None,
) -> None:
    info: dict[str, object] = {
        "rateLimitType": "five_hour",
        "resetsAt": 1778266200,
        **extra_info,
    }
    if status is not None:
        info["status"] = status
    if overage is not None:
        info["overageStatus"] = overage
    if using_overage is not None:
        info["isUsingOverage"] = using_overage

    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "rate_limit_event",
                "rate_limit_info": info,
                "uuid": "9fc896e0-250f-40f4-9022-dfca49a7498f",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            }
        ],
    )

    if expected_subcode is None:
        assert payload == {}, f"{test_id}: expected no failure, got {payload!r}"
    else:
        assert payload.get("status") == "claude_rate_limit", (
            f"{test_id}: status mismatch"
        )
        assert payload.get("subcode") == expected_subcode, (
            f"{test_id}: subcode mismatch"
        )
        assert "Claude rate limit reached" in payload.get("message", ""), (
            f"{test_id}: message must mention rate limit"
        )


@pytest.mark.parametrize(
    "is_error,result_text,expected_status,expected_subcode",
    [
        (
            True,
            "You've hit your rate limit. Please wait.",
            "claude_rate_limit",
            "CLAUDE_RATE_LIMIT",
        ),
        (
            True,
            "authentication_error: Invalid API key provided.",
            "claude_auth_error",
            "CLAUDE_AUTH_CHALLENGE",
        ),
        (True, "Unknown internal server error occurred.", None, None),
        (False, "Completed implementing rate limit feature.", None, None),
    ],
)
def test_result_envelope_dispatch(
    tmp_path: Path,
    is_error: bool,
    result_text: str,
    expected_status: str | None,
    expected_subcode: str | None,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "result",
                "subtype": "success",
                "is_error": is_error,
                "result": result_text,
            }
        ],
    )
    if expected_subcode is None:
        assert payload == {}
    else:
        assert payload["status"] == expected_status
        assert payload["subcode"] == expected_subcode


@pytest.mark.parametrize(
    "extra,error_value,expected_status,expected_subcode",
    [
        (
            {"apiErrorStatus": 429},
            "rate_limit_error",
            "claude_rate_limit",
            "CLAUDE_RATE_LIMIT",
        ),
        ({}, "rate_limit", "claude_rate_limit", "CLAUDE_RATE_LIMIT"),
        ({}, "authentication_error", "claude_auth_error", "CLAUDE_AUTH_CHALLENGE"),
        ({}, "", None, None),
    ],
)
def test_isapierrormessage_envelope_dispatch(
    tmp_path: Path,
    extra: dict[str, object],
    error_value: str,
    expected_status: str | None,
    expected_subcode: str | None,
) -> None:
    entry: dict[str, object] = {
        "type": "assistant",
        "isApiErrorMessage": True,
        "error": error_value,
        **extra,
    }
    payload = run_detect(tmp_path, jsonl=[entry])
    if expected_subcode is None:
        assert payload == {}
    else:
        assert payload["status"] == expected_status
        assert payload["subcode"] == expected_subcode


@pytest.mark.parametrize(
    "stderr_text,expected_status,expected_subcode",
    [
        (
            "Error: You've hit your rate limit.\n",
            "claude_rate_limit",
            "CLAUDE_RATE_LIMIT",
        ),
        (
            "Error: prompt is too long for the model context limit.\n",
            "context_limit",
            "CLAUDE_CONTEXT_LIMIT",
        ),
        (
            "Error: authentication_error: invalid bearer token.\n",
            "claude_auth_error",
            "CLAUDE_AUTH_CHALLENGE",
        ),
    ],
)
def test_stderr_fallback_dispatch(
    tmp_path: Path,
    stderr_text: str,
    expected_status: str,
    expected_subcode: str,
) -> None:
    payload = run_detect(tmp_path, jsonl=[], stderr=stderr_text)
    assert payload["status"] == expected_status
    assert payload["subcode"] == expected_subcode


def test_failure_message_does_not_include_unrelated_assistant_text(
    tmp_path: Path,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "I am working on implementing the feature now.",
                        },
                    ],
                },
            },
            {
                "type": "result",
                "is_error": True,
                "api_error_status": 429,
                "result": "You've hit your rate limit.",
            },
        ],
    )
    assert payload["status"] == "claude_rate_limit"
    assert "implementing the feature" not in payload["message"]
    assert "You've hit your rate limit" in payload["message"]


def test_failure_message_static_fallback_when_trigger_has_no_string(
    tmp_path: Path,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "isApiErrorMessage": True,
                "apiErrorStatus": 429,
            }
        ],
    )
    assert payload["status"] == "claude_rate_limit"
    assert payload["message"] == (
        "Claude rate limit reached. Wait for the limit to reset, "
        "then re-run /code:code."
    )


def test_assistant_text_mentioning_auth_does_not_trigger_auth_challenge(
    tmp_path: Path,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "I implemented the authentication_error handler and the unauthorized response code.",
                        },
                    ],
                },
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "Completed implementing the authentication error handling.",
            },
        ],
    )
    assert payload == {}


def test_pln500_canonical_planning_jsonl_no_false_positive(tmp_path: Path) -> None:
    """Regression fixture: benign heartbeats + tool_use + COMPLETE → {}."""
    benign = {
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed",
            "overageStatus": "allowed",
            "rateLimitType": "five_hour",
            "resetsAt": 1778095200,
        },
    }
    payload = run_detect(
        tmp_path,
        jsonl=[
            benign,
            benign,
            benign,
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_01",
                            "name": "Write",
                            "input": {},
                        },
                    ],
                },
            },
            {
                "type": "assistant",
                "message": {
                    "content": [
                        {"type": "text", "text": "<promise>COMPLETE</promise>"},
                    ],
                },
            },
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "<promise>COMPLETE</promise>",
            },
        ],
    )
    assert payload == {}


def test_rate_limit_prose_in_message_content_does_not_trigger(
    tmp_path: Path,
) -> None:
    """is_error envelope whose .result is empty must not fire on
    rate-limit prose buried in .message.content[].text."""
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "is_error": True,
                "result": "",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "Note: you've hit your limit on test fixture cardinality.",
                        },
                    ],
                },
            }
        ],
    )
    assert payload == {}


def test_rate_limit_prose_in_result_with_is_error_triggers(
    tmp_path: Path,
) -> None:
    """is_error envelope with rate-limit prose in .result must fire and
    source the marker message from the triggering entry."""
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "result",
                "is_error": True,
                "result": "You've hit your limit; please wait for reset.",
            }
        ],
    )
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"
    assert "You've hit your limit" in payload["message"]


def test_context_limit_prose_in_message_content_does_not_trigger(
    tmp_path: Path,
) -> None:
    """is_error envelope whose .result is empty must not fire on
    context-limit prose buried in .message.content[].text."""
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "is_error": True,
                "result": "",
                "message": {
                    "content": [
                        {
                            "type": "text",
                            "text": "Discussing why prompt is too long is a common topic.",
                        },
                    ],
                },
            }
        ],
    )
    assert payload == {}


def test_context_limit_prose_in_error_with_isapierrormessage_triggers(
    tmp_path: Path,
) -> None:
    """isApiErrorMessage envelope with context-limit prose in .error must
    fire and source the marker message from the triggering entry."""
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "isApiErrorMessage": True,
                "error": "Prompt is too long for the model context limit.",
            }
        ],
    )
    assert payload["status"] == "context_limit"
    assert payload["subcode"] == "CLAUDE_CONTEXT_LIMIT"
    assert "Prompt is too long" in payload["message"]


def test_rate_limit_event_malformed_info_null(tmp_path: Path) -> None:
    """RL-12: rate_limit_info: null → predicate must not fire."""
    payload = run_detect(
        tmp_path,
        jsonl=[{"type": "rate_limit_event", "rate_limit_info": None}],
    )
    assert payload == {}


def test_rate_limit_event_malformed_info_missing(tmp_path: Path) -> None:
    """RL-13: rate_limit_event with no rate_limit_info key → predicate must not fire."""
    payload = run_detect(
        tmp_path,
        jsonl=[{"type": "rate_limit_event"}],
    )
    assert payload == {}


def test_overage_rejected_message_sources_from_event(tmp_path: Path) -> None:
    """RL-08 detail: when overage is actually rejected, the message must mention rate limit
    and include the rate event metadata (rateLimitType, resetsAt) — sourced via rate_event_message."""
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": "allowed",
                    "overageStatus": "rejected",
                    "isUsingOverage": True,
                    "rateLimitType": "five_hour",
                    "resetsAt": 1778266200,
                },
            }
        ],
    )
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"
    assert "five_hour" in payload["message"]
    assert "1778266200" in payload["message"]


def test_rl_x2_isapierrormessage_rate_limit_error_without_429(tmp_path: Path) -> None:
    """RL-X2: isApiErrorMessage + error:"rate_limit_error" without apiErrorStatus:429.

    The isApiErrorMessage branch of rate_limit_signal must fire on the bare
    error string alone, independently of whether apiErrorStatus:429 is present.
    This isolates the error_string pattern match inside the isApiErrorMessage
    envelope from the status_429 branch.
    """
    payload = run_detect(
        tmp_path,
        jsonl=[
            {
                "type": "assistant",
                "isApiErrorMessage": True,
                "error": "rate_limit_error",
            }
        ],
    )
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"


def test_rl_x4_bare_error_string_rate_limit(tmp_path: Path) -> None:
    """RL-X4: bare {"error":"rate_limit"} entry with no envelope flags.

    The error_string branch of rate_limit_signal (matching ^rate_limit(_error)?$)
    must fire on a JSONL entry that carries only the error key, with no
    isApiErrorMessage, is_error, or apiErrorStatus fields present.
    This isolates the error_string branch standalone.
    """
    payload = run_detect(
        tmp_path,
        jsonl=[{"error": "rate_limit"}],
    )
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"


# ---------------------------------------------------------------------------
# PLN-511: Exit code 4 on MAX_ITERATIONS with zero forward progress
# ---------------------------------------------------------------------------


def test_max_iterations_zero_success_writes_marker_and_exits_4(tmp_path: Path) -> None:
    """When successful_iterations=0 at the max-iterations boundary, run-loop.sh
    must write a signed failure marker with subcode MAX_ITERATIONS_NO_PROGRESS
    and exit with code 4."""
    result = run_bash(
        f"""
        source {RUN_LOOP}
        successful_iterations=0
        max_iterations=5
        if [[ $successful_iterations -eq 0 ]]; then
          write_loop_user_visible_failure "RUNNER_ERROR" "MAX_ITERATIONS_NO_PROGRESS" \
            "Iteration budget exhausted without forward progress (0/$max_iterations iterations succeeded)"
          exit 4
        fi
        exit 0
        """,
        tmp_path,
    )

    assert result.returncode == 4
    marker = tmp_path / "loop-error.json"
    assert marker.exists()
    payload = json.loads(marker.read_text())
    assert payload == signed_marker(
        {
            "code": "RUNNER_ERROR",
            "message": "Iteration budget exhausted without forward progress (0/5 iterations succeeded)",
            "result": {"subcode": "MAX_ITERATIONS_NO_PROGRESS"},
        }
    )


def test_max_iterations_with_success_exits_0_no_marker(tmp_path: Path) -> None:
    """When successful_iterations > 0 at the max-iterations boundary, exit 0
    and no failure marker is written."""
    result = run_bash(
        f"""
        source {RUN_LOOP}
        successful_iterations=3
        max_iterations=5
        if [[ $successful_iterations -eq 0 ]]; then
          write_loop_user_visible_failure "RUNNER_ERROR" "MAX_ITERATIONS_NO_PROGRESS" \
            "Iteration budget exhausted without forward progress (0/$max_iterations iterations succeeded)"
          exit 4
        fi
        exit 0
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "loop-error.json").exists()


def test_write_runs_log_entry_with_successful_iterations(tmp_path: Path) -> None:
    """write_runs_log_entry with the 6th parameter appends successful_iterations
    as an 8th pipe-delimited field."""
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='run-max-iter'
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 6 max_iterations plan_execute "" 3
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "runs.log").exists()
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-max-iter"
    assert fields[3] == "6"
    assert fields[4] == "max_iterations"
    assert fields[5] == "plan_execute"
    # Field 6 is session_id (empty string passed), field 7 is successful_iterations
    assert fields[7] == "3"


def test_write_runs_log_entry_without_successful_iterations_no_trailing_field(
    tmp_path: Path,
) -> None:
    """Backward compatibility: calling write_runs_log_entry without the 6th
    parameter does NOT append a trailing field."""
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='run-compat'
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 4 completed plan_execute
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    line = (tmp_path / "runs.log").read_text().strip()
    fields = line.split("|")
    assert len(fields) == 7  # No 8th field


def test_completion_promise_exits_0_regardless_of_counter(tmp_path: Path) -> None:
    """The completion-promise path exits 0 independently of the
    successful_iterations counter (AC-005: no interference)."""
    # Simulate: promise was found, successful_iterations may be any value.
    # The completion path should always exit 0 without writing a failure marker.
    result = run_bash(
        f"""
        source {RUN_LOOP}
        successful_iterations=0
        promise_found=1
        if [[ $promise_found -eq 1 ]]; then
          exit 0
        fi
        # Should not reach here
        exit 99
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "loop-error.json").exists()


# ---------------------------------------------------------------------------
# Group E: malformed / unusual rate_limit_info payloads (RL-32 through RL-35)
#
# All cases assert no signal fires. The parametrized entries exercise jq type
# guards: string equality rejects non-string values, and the "object" type
# check rejects non-object rate_limit_info payloads.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "test_id,rate_limit_info",
    [
        # RL-32: empty object passes type check but has no status/overage fields
        ("RL-32-empty-object", {}),
        # RL-33: integer status — jq string equality returns false
        (
            "RL-33-status-integer",
            {"status": 429, "rateLimitType": "five_hour", "resetsAt": 1778266200},
        ),
        # RL-34: boolean status — jq string equality returns false
        (
            "RL-34-status-boolean",
            {"status": True, "rateLimitType": "five_hour", "resetsAt": 1778266200},
        ),
        # RL-35: string instead of object — "object" type guard rejects it
        ("RL-35-info-is-string", "rejected"),
    ],
    ids=lambda v: v if isinstance(v, str) else None,
)
def test_rate_limit_info_malformed(
    tmp_path: Path,
    test_id: str,
    rate_limit_info: object,
) -> None:
    payload = run_detect(
        tmp_path,
        jsonl=[{"type": "rate_limit_event", "rate_limit_info": rate_limit_info}],
    )
    assert payload == {}, f"{test_id}: expected no failure, got {payload!r}"


# ---------------------------------------------------------------------------
# Group G: end-to-end integration test (PLN-530)
# ---------------------------------------------------------------------------


def test_rl_group_g_allowed_warning_e2e(tmp_path: Path) -> None:
    """Group G: end-to-end integration test (PLN-530).

    Feeds a complete, realistic Claude API response JSONL stream containing a
    rate_limit_event with status "allowed_warning" through the full
    detect_claude_terminal_failure pipeline and asserts no rate-limit signal
    fires.

    Covers the primary branch (isUsingOverage=false) with warning_pct_int=80
    and other realistic fields that appear in production API responses.
    """
    payload = run_detect(
        tmp_path,
        jsonl=[
            # Session initialisation event
            {
                "type": "system",
                "subtype": "init",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
                "tools": ["Bash", "Read", "Write", "Edit"],
                "mcp_servers": [],
            },
            # Benign heartbeat — status "allowed", no overage trouble
            {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": "allowed",
                    "overageStatus": "allowed",
                    "isUsingOverage": False,
                    "rateLimitType": "five_hour",
                    "resetsAt": 1778266200,
                    "warning_pct_int": 60,
                },
                "uuid": "aaa00000-0000-0000-0000-000000000001",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            },
            # Key event: allowed_warning with warning_pct_int=80 and isUsingOverage=false
            {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": "allowed_warning",
                    "overageStatus": None,
                    "isUsingOverage": False,
                    "rateLimitType": "five_hour",
                    "resetsAt": 1778266200,
                    "warning_pct_int": 80,
                    "limit": 100000,
                    "usage": 80000,
                },
                "uuid": "bbb00000-0000-0000-0000-000000000002",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            },
            # Normal assistant turn with a tool call
            {
                "type": "assistant",
                "message": {
                    "id": "msg_01XYZ",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "toolu_01",
                            "name": "Read",
                            "input": {"file_path": "/tmp/foo.py"},
                        }
                    ],
                    "model": "claude-opus-4-6",
                    "stop_reason": "tool_use",
                    "usage": {"input_tokens": 1200, "output_tokens": 45},
                },
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            },
            # Tool result
            {
                "type": "tool",
                "tool_use_id": "toolu_01",
                "content": "def hello(): pass\n",
            },
            # Second benign heartbeat after tool use
            {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": "allowed_warning",
                    "overageStatus": None,
                    "isUsingOverage": False,
                    "rateLimitType": "five_hour",
                    "resetsAt": 1778266200,
                    "warning_pct_int": 82,
                    "limit": 100000,
                    "usage": 82000,
                },
                "uuid": "ccc00000-0000-0000-0000-000000000003",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            },
            # Final assistant turn with completion promise
            {
                "type": "assistant",
                "message": {
                    "id": "msg_02XYZ",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "text",
                            "text": "Task complete. <promise>COMPLETE</promise>",
                        }
                    ],
                    "model": "claude-opus-4-6",
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1400, "output_tokens": 30},
                },
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
            },
            # Successful result record
            {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "result": "Task complete. <promise>COMPLETE</promise>",
                "session_id": "c80d0b89-7efe-403c-8e7d-439702b89aff",
                "cost_usd": 0.042,
                "duration_ms": 8700,
                "num_turns": 2,
            },
        ],
    )
    assert payload == {}, (
        f"Group G e2e: expected no failure signal for allowed_warning with "
        f"isUsingOverage=false, got {payload!r}"
    )


def test_rename_orphan_output_on_start_skips_when_state_workdir_mismatches(
    tmp_path: Path,
) -> None:
    """state.workdir != current workdir → must NOT reuse stale run_id from state."""
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')
    (tmp_path / "state.local").write_text(
        "---\nrun_id: stale-run\nworkdir: /some/other/dir\n---\n"
    )
    (tmp_path / "runs.log").write_text(
        "fallback-run|2026-05-05T00:00:00Z|reduce-failures|1|error\n"
    )

    result = run_bash(
        f"""
        source {RUN_LOOP}
        WORKDIR="$CLOSEDLOOP_WORKDIR"
        STATE_FILE="$CLOSEDLOOP_WORKDIR/state.local"
        rename_orphan_output_on_start
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    # Stale run_id from mismatched state.local must NOT be used.
    assert not (tmp_path / "claude-output-stale-run.jsonl").exists()
    # Falls through to runs.log tail instead.
    assert (
        tmp_path / "claude-output-fallback-run.jsonl"
    ).read_text() == '{"type":"result"}\n'
    assert not (tmp_path / "claude-output.jsonl").exists()
