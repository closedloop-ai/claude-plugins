"""Tests for skills/codex-review/scripts/run_codex_review.sh against a fake codex.

The fake rejects arguments the way codex-cli 0.154+ does: `--full-auto` on any
subcommand, and `-s`/`--sandbox` on `exec resume`, each with exit 2 and a clap
error on stderr.
"""

import json
import os
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT = REPO_ROOT / "plugins/code/skills/codex-review/scripts/run_codex_review.sh"

FAKE_CODEX = r"""#!/usr/bin/env python3
import json, os, sys

args = sys.argv[1:]
with open(os.environ["FAKE_CODEX_ARGV_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")

sys.stderr.write("Reading additional input from stdin...\n")

def reject(flag):
    sys.stderr.write(
        f"error: unexpected argument '{flag}' found\n\n"
        f"  tip: to pass '{flag}' as a value, use '-- {flag}'\n\n"
        "Usage: codex exec [OPTIONS] [PROMPT]\n\n"
        "For more information, try '--help'.\n"
    )
    sys.exit(2)

if "--full-auto" in args:
    reject("--full-auto")
if args[:2] == ["exec", "resume"]:
    for flag in ("-s", "--sandbox"):
        if flag in args:
            reject(flag)

mode = os.environ.get("FAKE_CODEX_MODE")
if mode == "reject-json":
    reject("--json")
if mode == "runtime-error":
    sys.stderr.write("Not inside a trusted directory and --skip-git-repo-check was not specified.\n")
    sys.exit(1)

print(json.dumps({"type": "thread.started", "thread_id": "thread-new"}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "VERDICT: APPROVED"}}))
"""


def run_review(
    tmp_path: Path, *extra: str, mode: str = ""
) -> tuple[subprocess.CompletedProcess[str], list[list[str]]]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "codex"
    fake.write_text(FAKE_CODEX)
    fake.chmod(0o755)
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")
    argv_log = tmp_path / "argv.jsonl"
    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "FAKE_CODEX_ARGV_LOG": str(argv_log),
        "FAKE_CODEX_MODE": mode,
    }
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
    calls = (
        [json.loads(line) for line in argv_log.read_text().splitlines()]
        if argv_log.exists()
        else []
    )
    return result, calls


def has_pair(args: list[str], flag: str, value: str) -> bool:
    return any(args[i] == flag and args[i + 1] == value for i in range(len(args) - 1))


def test_first_round_runs_codex_exec_read_only(tmp_path: Path) -> None:
    result, calls = run_review(tmp_path, "--round", "1")

    assert result.stdout.splitlines()[0] == "VERDICT:APPROVED", result.stdout
    assert len(calls) == 1
    assert calls[0][0] == "exec"
    assert has_pair(calls[0], "-c", "sandbox_mode=read-only"), calls[0]


def test_resumed_round_runs_codex_exec_resume_read_only(tmp_path: Path) -> None:
    result, calls = run_review(tmp_path, "--round", "2", "--session-id", "thread-old")

    assert result.stdout.splitlines()[0] == "VERDICT:APPROVED", result.stdout
    # One call means the resume itself succeeded, not the fresh-session fallback.
    assert len(calls) == 1
    assert calls[0][:3] == ["exec", "resume", "thread-old"]
    assert has_pair(calls[0], "-c", "sandbox_mode=read-only"), calls[0]


def test_codex_failed_carries_a_cli_rejection(tmp_path: Path) -> None:
    result, _ = run_review(tmp_path, "--round", "1", mode="reject-json")

    assert (
        result.stdout.splitlines()[0]
        == "CODEX_FAILED:codex exited with code 2: error: unexpected argument '--json' found"
    )


def test_codex_failed_carries_the_last_stderr_line_when_none_names_an_error(
    tmp_path: Path,
) -> None:
    result, _ = run_review(tmp_path, "--round", "1", mode="runtime-error")

    assert result.stdout.splitlines()[0] == (
        "CODEX_FAILED:codex exited with code 1: "
        "Not inside a trusted directory and --skip-git-repo-check was not specified."
    )
