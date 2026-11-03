"""Contracts for the vibe 1.0.84 release: mid-run scope changes are acknowledged and watched (ISS-13096)."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "skills" / "fleet-orchestrator"
MONITOR = ROOT / "skills" / "codex-fleet-monitor"


def read(path: Path) -> str:
    return path.read_text()


def test_orchestrator_sends_scope_changes_through_the_board_and_acts_on_its_flags() -> None:
    skill = read(FLEET / "SKILL.md")
    assert "deliver <id> --kind scope --to <writer> --text <change>" in skill
    assert "answered <writer> --id <id> --text <answer>" in skill
    assert "`SCOPE-NOT-STARTED`" in skill and "`UNACKED-SCOPE`" in skill
    assert "--worktree <path>" in skill


def test_writers_read_their_pending_list_and_never_wait_inside_a_turn() -> None:
    templates = read(FLEET / "references" / "templates.md")
    assert "Before each commit and each verification phase, run `board.mjs <orchDir> pending <you>`" in templates
    assert "never a foreground wait or a `sleep` poll" in templates
    assert "Check the worker inbox" not in templates


def test_the_watcher_wakes_on_board_lines() -> None:
    snapshot = read(MONITOR / "scripts" / "snapshot.sh")
    assert "fleet-orchestrator/scripts/board.mjs $W watch-lines" in snapshot
    assert "`board UNACKED-SCOPE`," in read(MONITOR / "SKILL.md")
    board = read(FLEET / "scripts" / "board.mjs")
    for wired in ('action === "watch-lines"', 'action === "pending"', "scopeProblems(board, now)"):
        assert wired in board, wired
