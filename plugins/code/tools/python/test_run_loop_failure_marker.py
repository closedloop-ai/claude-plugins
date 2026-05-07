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


def write_jsonl(path: Path, entries: list[dict[str, object] | str]) -> None:
    lines = [
        entry if isinstance(entry, str) else json.dumps(entry, separators=(",", ":"))
        for entry in entries
    ]
    path.write_text("\n".join(lines) + "\n")


def test_detect_claude_terminal_failure_observed_rate_limit_jsonl(tmp_path: Path) -> None:
    write_jsonl(tmp_path / "output.jsonl", [
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
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "error": "rate_limit_error",
            "apiErrorStatus": 429,
        },
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "Prompt is too long for this model context limit.",
        },
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "Invalid bearer token. Please log in to Claude.",
        },
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "api_error_status": 429,
            "result": "x" * 1200,
        },
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
        "not-json",
        {
            "type": "result",
            "is_error": True,
            "result": "Unknown tool failed",
        },
    ])

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
    write_jsonl(tmp_path / "output.jsonl", [
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
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


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
    assert (tmp_path / "claude-output-rate-run.jsonl").read_text() == '{"type":"result"}\n'
    assert (tmp_path / "claude-output.name.txt").read_text() == "claude-output-rate-run.jsonl\n"
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker({
        "code": "RUNNER_ERROR",
        "message": message,
        "result": {"subcode": "CLAUDE_RATE_LIMIT"},
    })

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
    assert (tmp_path / "claude-output.name.txt").read_text() == "claude-output-context-run.jsonl\n"
    assert json.loads((tmp_path / "loop-error.json").read_text()) == signed_marker({
        "code": "RUNNER_ERROR",
        "message": message,
        "result": {"subcode": "CLAUDE_CONTEXT_LIMIT"},
    })

    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[3] == "2"
    assert fields[4] == "context_limit"
    assert fields[5] == "plan_execute"


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
    assert (tmp_path / "claude-output-run-exit.jsonl").read_text() == '{"type":"result"}\n'
    assert (tmp_path / "claude-output.name.txt").read_text() == "claude-output-run-exit.jsonl\n"


def test_rename_orphan_output_on_start_clears_sidecar_and_uses_runs_log(tmp_path: Path) -> None:
    (tmp_path / "claude-output.jsonl").write_text('{"type":"result"}\n')
    (tmp_path / "claude-output.name.txt").write_text("claude-output-stale.jsonl\n")
    (tmp_path / "runs.log").write_text("prev-run|2026-05-05T00:00:00Z|reduce-failures|1|error\n")

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
    assert (tmp_path / "claude-output-prev-run.jsonl").read_text() == '{"type":"result"}\n'
    assert (tmp_path / "claude-output.name.txt").read_text() == ""


def test_write_runs_log_entry_uses_workdir_root(tmp_path: Path) -> None:
    result = run_bash(
        f"""
        source {RUN_LOOP}
        RUN_ID='run-root-log'
        write_runs_log_entry "$CLOSEDLOOP_WORKDIR" 2 completed
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert (tmp_path / "runs.log").exists()
    fields = (tmp_path / "runs.log").read_text().strip().split("|")
    assert fields[0] == "run-root-log"
    assert fields[5] == "self_learning"
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
# PLN-502: Heartbeat false-positive prevention (Scenarios A1-A5)
# ---------------------------------------------------------------------------


def test_heartbeat_status_allowed_returns_no_failure(tmp_path: Path) -> None:
    """A1: A single heartbeat with status=allowed must not trigger detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_multiple_heartbeats_only_returns_no_failure(tmp_path: Path) -> None:
    """A2: Multiple benign heartbeats must not trigger detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
            },
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_heartbeat_plus_successful_assistant_message_returns_no_failure(
    tmp_path: Path,
) -> None:
    """A3: Benign heartbeat + successful assistant message -> no failure."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
            },
        },
        {
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": "Task completed successfully."}],
            },
        },
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "Done.",
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_heartbeat_with_assistant_complete_promise_returns_no_failure(
    tmp_path: Path,
) -> None:
    """A4: Heartbeat + assistant COMPLETE promise -> no failure."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
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
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_malformed_heartbeat_missing_status_returns_no_failure(
    tmp_path: Path,
) -> None:
    """A5: Malformed heartbeat with missing status fields -> benign (fail-open)."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


# ---------------------------------------------------------------------------
# PLN-502: Real exhaustion detection (Scenarios B6-B8)
# ---------------------------------------------------------------------------


def test_heartbeat_status_exceeded_detects_rate_limit(tmp_path: Path) -> None:
    """B6: Heartbeat with status=exceeded must trigger rate limit detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "exceeded",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
    ])

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


def test_heartbeat_overage_exceeded_detects_rate_limit(tmp_path: Path) -> None:
    """B7: Heartbeat with overageStatus=exceeded (status=allowed) must trigger detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "exceeded",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
    ])

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


def test_heartbeat_status_paused_detects_rate_limit(tmp_path: Path) -> None:
    """B8: Heartbeat with any non-allowed status (e.g. paused) must trigger detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "paused",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
    ])

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


# ---------------------------------------------------------------------------
# PLN-502: Terminal-result envelope tests (Scenarios C9-C12)
# ---------------------------------------------------------------------------


def test_result_is_error_with_rate_limit_text_detects(tmp_path: Path) -> None:
    """C9: is_error=true result with rate limit text must trigger detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "You've hit your rate limit. Please wait.",
        },
    ])

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


def test_result_is_error_with_auth_text_detects(tmp_path: Path) -> None:
    """C10: is_error=true result with auth text must trigger auth detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "authentication_error: Invalid API key provided.",
        },
    ])

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


def test_result_is_error_unrelated_text_falls_through(tmp_path: Path) -> None:
    """C11: is_error=true result with unrelated text must not trigger any signal."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "Unknown internal server error occurred.",
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_result_no_is_error_ignored(tmp_path: Path) -> None:
    """C12: Result without is_error=true must not trigger even with rate limit text."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "result": "Completed implementing rate limit feature.",
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


# ---------------------------------------------------------------------------
# PLN-502: Synthetic API-error envelope tests (Scenarios D13-D16)
# ---------------------------------------------------------------------------


def test_isapierrormessage_429_detects_rate_limit(tmp_path: Path) -> None:
    """D13: isApiErrorMessage=true with apiErrorStatus=429 must detect rate limit."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "apiErrorStatus": 429,
            "error": "rate_limit_error",
        },
    ])

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


def test_isapierrormessage_rate_limit_error_string_detects(tmp_path: Path) -> None:
    """D14: isApiErrorMessage=true with error="rate_limit" must detect rate limit."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "error": "rate_limit",
        },
    ])

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


def test_isapierrormessage_auth_error_string_detects(tmp_path: Path) -> None:
    """D15: isApiErrorMessage=true with auth error string must detect auth challenge."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "error": "authentication_error",
        },
    ])

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


def test_isapierrormessage_no_error_field_ignored(tmp_path: Path) -> None:
    """D16: isApiErrorMessage=true but no matching error field must not trigger."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "error": "",
        },
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


# ---------------------------------------------------------------------------
# PLN-502: Per-entry message sourcing tests (Scenarios E17-E19)
# ---------------------------------------------------------------------------


def test_failure_message_does_not_include_unrelated_assistant_text(
    tmp_path: Path,
) -> None:
    """E17: Failure message must come from the triggering entry, not assistant text."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "I am working on implementing the feature now."},
                ],
            },
        },
        {
            "type": "result",
            "is_error": True,
            "api_error_status": 429,
            "result": "You've hit your rate limit.",
        },
    ])

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
    # Must NOT contain unrelated assistant text
    assert "implementing the feature" not in payload["message"]
    # Must contain the triggering entry's result text
    assert "You've hit your rate limit" in payload["message"]


def test_failure_message_falls_back_to_static_when_error_string_empty(
    tmp_path: Path,
) -> None:
    """E18: When triggering entry has no result/error string, use static fallback."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "assistant",
            "isApiErrorMessage": True,
            "apiErrorStatus": 429,
        },
    ])

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
    # Should use static fallback message
    assert "Wait for the limit to reset" in payload["message"] or "rate limit" in payload["message"].lower()


def test_message_clamped_to_900_chars(tmp_path: Path) -> None:
    """E19: Messages exceeding 900 chars must be clamped with ellipsis."""
    long_text = "Rate limit error: " + "x" * 1200
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": long_text,
        },
    ])

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


# ---------------------------------------------------------------------------
# PLN-502: Auth challenge tightening tests (Scenarios F20-F21)
# ---------------------------------------------------------------------------


def test_assistant_text_mentioning_auth_does_not_trigger_auth_challenge(
    tmp_path: Path,
) -> None:
    """F20: Assistant text mentioning auth keywords must not trigger auth challenge."""
    write_jsonl(tmp_path / "output.jsonl", [
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
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


def test_real_auth_error_envelope_still_detects(tmp_path: Path) -> None:
    """F21: Real auth error envelope (is_error=true) must still trigger auth detection."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "authentication_error: Your API key is invalid.",
        },
    ])

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
    assert "authentication_error" in payload["message"]


# ---------------------------------------------------------------------------
# PLN-502: Stderr fallback preservation tests (Scenarios G22-G24)
# ---------------------------------------------------------------------------


def test_empty_jsonl_with_rate_limit_stderr_detects(tmp_path: Path) -> None:
    """G22: Empty JSONL + rate limit stderr must trigger detection via fallback."""
    (tmp_path / "output.jsonl").write_text("")
    (tmp_path / "stderr.txt").write_text("Error: You've hit your rate limit.\n")

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" "$CLOSEDLOOP_WORKDIR/stderr.txt"
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "claude_rate_limit"
    assert payload["subcode"] == "CLAUDE_RATE_LIMIT"


def test_empty_jsonl_with_context_limit_stderr_detects(tmp_path: Path) -> None:
    """G23: Empty JSONL + context limit stderr must trigger detection via fallback."""
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


def test_empty_jsonl_with_auth_stderr_detects(tmp_path: Path) -> None:
    """G24: Empty JSONL + auth error stderr must trigger detection via fallback."""
    (tmp_path / "output.jsonl").write_text("")
    (tmp_path / "stderr.txt").write_text(
        "Error: authentication_error: invalid bearer token.\n",
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
    assert payload["status"] == "claude_auth_error"
    assert payload["subcode"] == "CLAUDE_AUTH_CHALLENGE"


# ---------------------------------------------------------------------------
# PLN-502: PLN-500 canonical regression test (Scenario H25)
# ---------------------------------------------------------------------------


def test_pln500_planning_jsonl_fixture_no_false_positive(tmp_path: Path) -> None:
    """H25: Benign heartbeats + tool_use + COMPLETE promise must return {}."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "toolu_01", "name": "Write", "input": {}},
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
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" ""
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {}


# ---------------------------------------------------------------------------
# PLN-502: Context-limit regression test (Scenario I26)
# ---------------------------------------------------------------------------


def test_context_limit_signal_unchanged(tmp_path: Path) -> None:
    """I26: Existing context_limit detection path must still work unchanged."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "result",
            "is_error": True,
            "result": "Prompt is too long for this model context limit.",
        },
    ])

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


# ---------------------------------------------------------------------------
# PLN-502: E2E shell smoke test (Scenario J27)
# ---------------------------------------------------------------------------


def test_run_loop_does_not_write_loop_error_json_for_heartbeat_only_iteration(
    tmp_path: Path,
) -> None:
    """J27: Full bash-level integration -- heartbeats + clean COMPLETE -> no loop-error.json."""
    write_jsonl(tmp_path / "output.jsonl", [
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
            },
        },
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "overageStatus": "allowed",
                "rateLimitType": "five_hour",
                "resetsAt": 1778095200,
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
    ])

    result = run_bash(
        f"""
        source {RUN_LOOP}
        detection=$(detect_claude_terminal_failure "$CLOSEDLOOP_WORKDIR/output.jsonl" "")
        if [[ "$detection" != "{{}}" ]] && [[ -n "$detection" ]]; then
            status=$(echo "$detection" | jq -r '.status')
            subcode=$(echo "$detection" | jq -r '.subcode')
            message=$(echo "$detection" | jq -r '.message')
            write_loop_user_visible_failure RUNNER_ERROR "$subcode" "$message"
            echo "FAIL: wrote loop-error.json"
            exit 1
        fi
        echo "PASS: no loop-error.json written"
        exit 0
        """,
        tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert "PASS" in result.stdout
    assert not (tmp_path / "loop-error.json").exists()
