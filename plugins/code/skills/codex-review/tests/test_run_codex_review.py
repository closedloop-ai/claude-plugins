"""Synthetic end-to-end checks for the plan review JSONL wrapper."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_codex_review.sh"
BASH = (
    str(Path(shutil.which("git") or "").parents[1] / "bin" / "bash.exe")
    if os.name == "nt" else "bash"
)


def run_synthetic(
    tmp_path: Path, jsonl: str, *, prior_feedback: bytes | None = None,
    session_id: str | None = None, codex_exit: int = 0,
) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path]:
    home = tmp_path / "home"
    home.mkdir()
    plan = tmp_path / "plan.md"
    plan.write_text("Synthetic plan", encoding="utf-8")
    feedback = tmp_path / "feedback.md"
    if prior_feedback is not None:
        feedback.write_bytes(prior_feedback)
    fixture = tmp_path / "review.jsonl"
    fixture.write_text(jsonl, encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_codex = bin_dir / "codex"
    fake_codex.write_text(
        '#!/usr/bin/env bash\necho call >> "$TEST_CALLS"\n'
        'cat "$TEST_JSONL"\necho "synthetic codex diagnostic" >&2\n'
        'exit "$TEST_CODEX_EXIT"\n', encoding="utf-8",
    )
    fake_codex.chmod(0o755)
    calls = tmp_path / "codex-calls"
    env = os.environ.copy()
    env.update({
        "PATH": str(bin_dir) + os.pathsep + env["PATH"],
        "HOME": home.as_posix(),
        "TEST_JSONL": fixture.as_posix(),
        "TEST_CALLS": calls.as_posix(),
        "TEST_CODEX_EXIT": str(codex_exit),
        "PYTHONIOENCODING": "ascii",
        "PYTHONUTF8": "0",
    })
    args = [BASH, SCRIPT.as_posix(), "--plan-file", plan.as_posix(),
            "--feedback-file", feedback.as_posix(), "--log-id", "synthetic-review"]
    if session_id is not None:
        args.extend(("--session-id", session_id))
    completed = subprocess.run(
        args,
        env=env, capture_output=True, text=True, check=False,
        stdin=subprocess.DEVNULL,
    )
    return completed, feedback, home, calls


def event_jsonl(*events: object) -> str:
    return "\n".join(json.dumps(event, ensure_ascii=False) for event in events) + "\n"


def test_completed_utf8_review_survives_ascii_stdout(tmp_path: Path) -> None:
    """A completed review must survive the host's narrow output encoding."""
    verdict = "Finding: curly quote \u201d\nVERDICT: NEEDS_CHANGES"
    completed, feedback, home, calls = run_synthetic(
        tmp_path,
        event_jsonl(
            {"type": "thread.started", "thread_id": "synthetic-session"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": verdict}},
            {"type": "turn.completed"},
        ),
        prior_feedback=b"old usable feedback",
    )
    assert completed.returncode == 0, completed.stderr
    assert "VERDICT:NEEDS_CHANGES" in completed.stdout
    assert "CODEX_SESSION:synthetic-session" in completed.stdout
    assert feedback.read_bytes() == verdict.encode("utf-8")
    assert calls.read_text(encoding="utf-8").splitlines() == ["call"]
    diagnostics = home / ".closedloop-ai" / "plan-with-codex" / "synthetic-review.stderr"
    assert "synthetic codex diagnostic" in diagnostics.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("jsonl", "expected_error"),
    [
        (
            event_jsonl(
                {"type": "thread.started", "thread_id": "synthetic-session"},
                {"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVED"}},
            ) + '{"type":\n',
            "without turn.completed",
        ),
        (
            event_jsonl(
                {"type": "thread.started", "thread_id": "synthetic-session"},
                {"type": "turn.completed"},
            ),
            "no agent message",
        ),
        (
            event_jsonl(
                {"type": "thread.started", "thread_id": "synthetic-session"},
                {"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVED"}},
            ),
            "without turn.completed",
        ),
    ],
)
def test_failed_extraction_keeps_prior_feedback_and_does_not_rerun(
    tmp_path: Path, jsonl: str, expected_error: str,
) -> None:
    completed, feedback, home, calls = run_synthetic(
        tmp_path, jsonl, prior_feedback=b"prior usable verdict",
        session_id="previous-session", codex_exit=1,
    )
    assert completed.returncode == 0, completed.stderr
    # A failed codex run keeps the established one-line token; the parser's
    # reason goes to the retained diagnostics instead.
    assert completed.stdout.splitlines()[0] == (
        "CODEX_FAILED:codex exited with code 1: synthetic codex diagnostic"
    ), completed.stdout
    assert "CODEX_SESSION:synthetic-session" in completed.stdout
    assert "LOG_ID:synthetic-review" in completed.stdout
    assert feedback.read_bytes() == b"prior usable verdict"
    assert calls.read_text(encoding="utf-8").splitlines() == ["call"]
    diagnostics = home / ".closedloop-ai" / "plan-with-codex" / "synthetic-review.stderr"
    detail = diagnostics.read_text(encoding="utf-8")
    assert expected_error in detail
    assert "synthetic codex diagnostic" in detail


def test_stray_lines_do_not_discard_a_completed_review(tmp_path: Path) -> None:
    """The codex CLI owns this stdout format; a stray line must not cost a paid review.

    A blank line, a plain-text notice, and a truncated object all sit between
    completed events. The completeness gate, not per-line strictness, decides.
    """
    jsonl = (
        event_jsonl({"type": "thread.started", "thread_id": "synthetic-session"})
        + "\nWARNING: a deprecation notice\n" + '{"type":\n'
        + event_jsonl(
            {"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVED"}},
            {"type": "turn.completed"},
        )
    )
    completed, feedback, home, calls = run_synthetic(
        tmp_path, jsonl, prior_feedback=b"old usable feedback",
    )
    assert completed.returncode == 0, completed.stderr
    assert "VERDICT:APPROVED" in completed.stdout, completed.stdout
    assert "CODEX_SESSION:synthetic-session" in completed.stdout
    assert feedback.read_bytes() == b"VERDICT: APPROVED"
    assert calls.read_text(encoding="utf-8").splitlines() == ["call"]
    diagnostics = home / ".closedloop-ai" / "plan-with-codex" / "synthetic-review.stderr"
    assert "ignored 2 non-event JSONL line(s): 3, 4" in diagnostics.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "jsonl",
    [
        pytest.param("", id="empty-stream"),
        pytest.param(
            event_jsonl({"type": "error", "message": "thread previous-session not found"}),
            id="error-event-only",
        ),
    ],
)
def test_failed_resume_without_a_started_thread_starts_fresh(tmp_path: Path, jsonl: str) -> None:
    """No thread.started means nothing resumed and nothing was paid for.

    The error-event case is a dead or expired thread ID: a nonempty stream that a
    file-size test reads as "work happened", wedging every retry on the same ID.
    """
    completed, feedback, _home, calls = run_synthetic(
        tmp_path, jsonl, prior_feedback=b"prior usable verdict",
        session_id="previous-session", codex_exit=1,
    )
    assert calls.read_text(encoding="utf-8").splitlines() == ["call", "call"], completed.stderr
    assert "starting fresh session" in completed.stderr
    assert "CODEX_FAILED:" in completed.stdout
    assert "CODEX_SESSION:none" in completed.stdout
    assert feedback.read_bytes() == b"prior usable verdict"


def test_incomplete_stream_after_a_clean_exit_is_empty_and_keeps_prior_feedback(
    tmp_path: Path,
) -> None:
    """Exit 0 without turn.completed is CODEX_EMPTY, never a published partial review."""
    completed, feedback, _home, calls = run_synthetic(
        tmp_path,
        event_jsonl(
            {"type": "thread.started", "thread_id": "synthetic-session"},
            {"type": "item.completed", "item": {"type": "agent_message", "text": "Looking at the plan"}},
        ),
        prior_feedback=b"prior usable verdict",
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.splitlines() == [
        "CODEX_EMPTY", "CODEX_SESSION:synthetic-session", "LOG_ID:synthetic-review",
    ], completed.stdout
    assert feedback.read_bytes() == b"prior usable verdict"
    assert calls.read_text(encoding="utf-8").splitlines() == ["call"]
