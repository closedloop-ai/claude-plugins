"""Tests for evaluate_goal.py path handling."""

import json
from pathlib import Path

import pytest
from evaluate_goal import evaluate_minimize_tokens, evaluate_reduce_failures
from goal_config import GoalConfig


def _write_session(path: Path, input_tokens: int = 10, output_tokens: int = 5) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0,
            }
        })
        + "\n"
    )


def test_reads_home_session_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
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


def test_reduce_failures_reads_runs_log_from_workdir_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("CLOSEDLOOP_ITERATION", raising=False)
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "runs.log").write_text(
        "run-1|2026-05-05T00:00:00Z|reduce-failures|2|completed|plan_execute|session-1\n"
    )

    outcome = evaluate_reduce_failures(
        GoalConfig(name="reduce-failures", success_criteria={"target": 3}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["iterations"] == 2
    assert outcome.success is True


def test_reduce_failures_uses_latest_iteration_for_repeated_run_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Multi-row run_id: max iteration wins (regression test for first-match bug)."""
    monkeypatch.delenv("CLOSEDLOOP_ITERATION", raising=False)
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "runs.log").write_text(
        "run-1|2026-05-05T00:00:00Z|reduce-failures|1|in_progress|plan_execute|session-1\n"
        "run-1|2026-05-05T00:01:00Z|reduce-failures|2|in_progress|plan_execute|session-1\n"
        "run-1|2026-05-05T00:02:00Z|reduce-failures|3|completed|plan_execute|session-1\n"
    )

    outcome = evaluate_reduce_failures(
        GoalConfig(name="reduce-failures", success_criteria={"target": 3}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["iterations"] == 3


def test_reduce_failures_falls_back_to_env_when_run_id_absent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """When run_id is not in runs.log, CLOSEDLOOP_ITERATION supplies the count."""
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "runs.log").write_text(
        "other-run|2026-05-05T00:00:00Z|reduce-failures|7|completed|plan_execute|session-x\n"
    )
    monkeypatch.setenv("CLOSEDLOOP_ITERATION", "4")

    outcome = evaluate_reduce_failures(
        GoalConfig(name="reduce-failures", success_criteria={"target": 5}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["iterations"] == 4


def test_reduce_failures_ignores_env_when_run_id_present(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Env var must not leak in when runs.log has at least one row for run_id."""
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "runs.log").write_text(
        "run-1|2026-05-05T00:00:00Z|reduce-failures|2|completed|plan_execute|session-1\n"
    )
    monkeypatch.setenv("CLOSEDLOOP_ITERATION", "99")

    outcome = evaluate_reduce_failures(
        GoalConfig(name="reduce-failures", success_criteria={"target": 3}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["iterations"] == 2


def test_reduce_failures_skips_malformed_iteration_rows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Non-numeric iteration values are skipped; max of valid rows wins."""
    monkeypatch.delenv("CLOSEDLOOP_ITERATION", raising=False)
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    (workdir / "runs.log").write_text(
        "run-1|2026-05-05T00:00:00Z|reduce-failures|1|in_progress|plan_execute|session-1\n"
        "run-1|2026-05-05T00:01:00Z|reduce-failures|foo|in_progress|plan_execute|session-1\n"
        "run-1|2026-05-05T00:02:00Z|reduce-failures|3|completed|plan_execute|session-1\n"
    )

    outcome = evaluate_reduce_failures(
        GoalConfig(name="reduce-failures", success_criteria={"target": 3}),
        "run-1",
        workdir,
    )

    assert outcome.metrics["iterations"] == 3
