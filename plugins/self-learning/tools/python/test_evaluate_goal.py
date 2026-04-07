
"""Tests for evaluate_goal.py path handling."""

import json
from pathlib import Path

import pytest

from evaluate_goal import evaluate_minimize_tokens
from goal_config import GoalConfig


def _write_session(path: Path, input_tokens: int = 10, output_tokens: int = 5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                }
            }
        )
        + "\n"
    )


def test_reads_home_session_file(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Should continue reading Claude session transcripts from `~/.claude/sessions`."""
    session_id = "home-session"
    home_dir = tmp_path / "home"
    workdir = tmp_path / "workdir"
    _write_session(home_dir / ".claude" / "sessions" / f"{session_id}.jsonl")
    monkeypatch.setenv("HOME", str(home_dir))
    monkeypatch.setenv("CLOSEDLOOP_SESSION_ID", session_id)

    outcome = evaluate_minimize_tokens(
        GoalConfig(name="minimize-tokens", success_criteria={"target": 100}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["input_tokens"] == 10
    assert outcome.metrics["output_tokens"] == 5
    assert outcome.metrics["total_tokens"] == 15


def test_ignores_repo_local_legacy_session_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Should not read session transcripts from `workdir/.claude/sessions`."""
    session_id = "legacy-workdir-session"
    home_dir = tmp_path / "home"
    workdir = tmp_path / "workdir"
    _write_session(workdir / ".claude" / "sessions" / f"{session_id}.jsonl")
    monkeypatch.setenv("HOME", str(home_dir))
    monkeypatch.setenv("CLOSEDLOOP_SESSION_ID", session_id)

    outcome = evaluate_minimize_tokens(
        GoalConfig(name="minimize-tokens", success_criteria={"target": 100}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["error"] == "session_file_not_found"
    assert outcome.score == 0.5
