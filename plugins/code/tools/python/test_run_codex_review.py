"""Tests for skills/codex-review/scripts/run_codex_review.sh and hooks/plan-review.sh
against a fake codex.

The fake rejects arguments the way codex-cli 0.147+ does: `--full-auto` on any
subcommand, and `-s`/`--sandbox` on `exec resume`, each with exit 2 and a clap
error on stderr. FAKE_CODEX_MODE selects a failure shape.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT = REPO_ROOT / "plugins/code/skills/codex-review/scripts/run_codex_review.sh"
HOOK = REPO_ROOT / "plugins/code/hooks/plan-review.sh"

FAKE_CODEX = r"""#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]
with open(os.environ["FAKE_CODEX_ARGV_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
mode = os.environ.get("FAKE_CODEX_MODE")
resuming = args[:2] == ["exec", "resume"]

def reject(flag):
    sys.stderr.write(
        f"error: unexpected argument '{flag}' found\n\n"
        f"  tip: to pass '{flag}' as a value, use '-- {flag}'\n\n"
        "Usage: codex exec [OPTIONS] [PROMPT]\n\n"
        "For more information, try '--help'.\n"
    )
    sys.exit(2)

def fail(*stderr_lines):
    sys.stderr.write("".join(line + "\n" for line in stderr_lines))
    sys.exit(1)

def emit(event):
    print(json.dumps(event))

if "--full-auto" in args:
    reject("--full-auto")
if resuming and ("-s" in args or "--sandbox" in args):
    reject("-s" if "-s" in args else "--sandbox")
if mode == "reject-json":
    reject("--json")

banner = "Reading additional input from stdin..."
tracing = "2026-09-29T00:00:00.000000Z ERROR codex_core::mcp: MCP client for `docs` failed to start"
if mode == "stderr-errors":
    fail(banner, tracing, "Error: failed to load config.toml", "error: second error line")
if mode == "untrusted-dir":
    fail(banner, "WARNING: a notice", "Not inside a trusted directory and --skip-git-repo-check was not specified.")
if mode == "banner-only":
    fail(banner)
if mode == "turn-failed":
    emit({"type": "thread.started", "thread_id": "thread-new"})
    emit({"type": "error", "message": "Reconnecting... 1/5"})
    emit({"type": "turn.failed", "error": {"message": "The 'bogus' model is not supported."}})
    fail(banner, tracing)
if mode == "resume-fails" and resuming:
    fail(banner, "Error: no session thread-old")
if mode in ("empty", "no-verdict"):
    sys.stderr.write("WARNING: stream disconnected before completion\n")
    emit({"type": "thread.started", "thread_id": "thread-new"})
    if mode == "no-verdict":
        emit({"type": "item.completed", "item": {"type": "agent_message", "text": "Looking at the plan"}})
    sys.exit(0)

emit({"type": "thread.started", "thread_id": "thread-new"})
emit({"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVED"}})
# codex exec --json ends every finished turn with turn.completed; the wrapper
# publishes feedback only once it has seen one.
emit({"type": "turn.completed"})
"""


def fake_codex_env(tmp_path: Path, mode: str) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "codex"
    fake.write_text(FAKE_CODEX)
    fake.chmod(0o755)
    return {
        **os.environ,
        "HOME": str(tmp_path),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_CODEX_ARGV_LOG": str(tmp_path / "argv.jsonl"),
        "FAKE_CODEX_MODE": mode,
    }


def codex_calls(tmp_path: Path) -> list[list[str]]:
    argv_log = tmp_path / "argv.jsonl"
    if not argv_log.exists():
        return []
    return [json.loads(line) for line in argv_log.read_text().splitlines()]


def run_review(
    tmp_path: Path, *extra: str, mode: str = ""
) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
    env = fake_codex_env(tmp_path, mode)
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")
    result = subprocess.run(
        [
            "bash",
            str(SCRIPT),
            "--plan-file",
            str(plan),
            "--feedback-file",
            str(tmp_path / "feedback.txt"),
            *extra,
        ],
        text=True,
        capture_output=True,
        check=False,
        env=env,
        stdin=subprocess.DEVNULL,
    )
    return result, codex_calls(tmp_path)


def run_plan_review_hook(
    tmp_path: Path, mode: str = ""
) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
    payload = {"cwd": str(tmp_path), "tool_response": {"plan": "# Plan\n"}}
    result = subprocess.run(
        ["bash", str(HOOK)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
        env=fake_codex_env(tmp_path, mode),
    )
    return result, codex_calls(tmp_path)


def has_pair(args: list[str], flag: str, value: str) -> bool:
    return any(args[i] == flag and args[i + 1] == value for i in range(len(args) - 1))


def failed_token(tmp_path: Path, mode: str) -> str:
    """Run round 1 in ``mode`` and return the CODEX_FAILED line, which must be one line."""
    result, _ = run_review(tmp_path, "--round", "1", mode=mode)
    lines = result.stdout.splitlines()
    assert len(lines) == 3, result.stdout
    assert lines[1].startswith("CODEX_SESSION:")
    assert lines[2].startswith("LOG_ID:")
    return lines[0]


def test_first_round_runs_codex_exec_read_only(tmp_path: Path) -> None:
    result, calls = run_review(tmp_path, "--round", "1")

    assert result.stdout.splitlines()[0] == "VERDICT:APPROVED", result.stdout
    assert len(calls) == 1
    assert calls[0][0] == "exec"
    assert has_pair(calls[0], "-c", "sandbox_mode=read-only"), calls[0]
    assert has_pair(calls[0], "-c", "approval_policy=never"), calls[0]


def test_resumed_round_runs_codex_exec_resume_read_only(tmp_path: Path) -> None:
    result, calls = run_review(tmp_path, "--round", "2", "--session-id", "thread-old")

    assert result.stdout.splitlines()[0] == "VERDICT:APPROVED", result.stdout
    # One call means the resume itself succeeded, not the fresh-session fallback.
    assert len(calls) == 1
    assert calls[0][:3] == ["exec", "resume", "thread-old"]
    assert has_pair(calls[0], "-c", "sandbox_mode=read-only"), calls[0]
    assert has_pair(calls[0], "-c", "approval_policy=never"), calls[0]


def test_failed_resume_names_its_cause_and_falls_back_to_exec(tmp_path: Path) -> None:
    result, calls = run_review(
        tmp_path, "--round", "2", "--session-id", "thread-old", mode="resume-fails"
    )

    assert result.stdout.splitlines()[:2] == [
        "VERDICT:APPROVED",
        "CODEX_SESSION:thread-new",
    ]
    assert (
        "Codex session resume failed (Error: no session thread-old), starting fresh session..."
        in result.stderr
    )
    assert len(calls) == 2
    assert calls[1][0] == "exec"
    assert has_pair(calls[1], "-c", "sandbox_mode=read-only"), calls[1]
    assert has_pair(calls[1], "-c", "approval_policy=never"), calls[1]


def test_codex_failed_carries_a_cli_rejection(tmp_path: Path) -> None:
    assert failed_token(tmp_path, "reject-json") == (
        "CODEX_FAILED:codex exited with code 2: error: unexpected argument '--json' found"
    )


def test_codex_failed_carries_the_first_line_starting_with_error(
    tmp_path: Path,
) -> None:
    assert failed_token(tmp_path, "stderr-errors") == (
        "CODEX_FAILED:codex exited with code 1: Error: failed to load config.toml"
    )


def test_codex_failed_carries_the_last_stderr_line_when_none_starts_with_error(
    tmp_path: Path,
) -> None:
    assert failed_token(tmp_path, "untrusted-dir") == (
        "CODEX_FAILED:codex exited with code 1: "
        "Not inside a trusted directory and --skip-git-repo-check was not specified."
    )


def test_codex_failed_does_not_report_the_stdin_banner_as_the_cause(
    tmp_path: Path,
) -> None:
    assert (
        failed_token(tmp_path, "banner-only") == "CODEX_FAILED:codex exited with code 1"
    )


def test_codex_failed_carries_the_turn_failure_from_the_json_stream(
    tmp_path: Path,
) -> None:
    assert failed_token(tmp_path, "turn-failed") == (
        "CODEX_FAILED:codex exited with code 1: The 'bogus' model is not supported."
    )


@pytest.mark.parametrize("mode", ["empty", "no-verdict"])
def test_codex_empty_passes_codex_stderr_through(tmp_path: Path, mode: str) -> None:
    result, _ = run_review(tmp_path, "--round", "1", mode=mode)

    assert result.stdout.splitlines()[0] == "CODEX_EMPTY", result.stdout
    assert "WARNING: stream disconnected before completion" in result.stderr


def test_plan_review_hook_runs_codex_exec_read_only(tmp_path: Path) -> None:
    result, calls = run_plan_review_hook(tmp_path)

    assert "VERDICT: APPROVED" in json.loads(result.stdout)["hookSpecificOutput"][
        "additionalContext"
    ], result.stdout
    assert len(calls) == 1
    assert calls[0][0] == "exec"
    assert has_pair(calls[0], "-c", "sandbox_mode=read-only"), calls[0]
    assert has_pair(calls[0], "-c", "approval_policy=never"), calls[0]


def test_plan_review_hook_logs_codex_stderr(tmp_path: Path) -> None:
    result, _ = run_plan_review_hook(tmp_path, mode="stderr-errors")

    assert result.stdout == ""
    logs = (tmp_path / ".closedloop-ai/plan-review-logs").glob("*.log")
    assert any(
        "Error: failed to load config.toml" in log.read_text() for log in logs
    )
