"""Contracts for the vibe 1.0.82 release: one hook script per event."""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import hook_guard_routed


ROOT = Path(__file__).resolve().parents[2]


def test_every_guard_runs_from_its_events_one_script() -> None:
    for guard in ("kill-guard", "foreground-guard", "merge-guard", "shell-safety-guard"):
        assert hook_guard_routed(ROOT, "PreToolUse", guard, tool="Bash"), guard
    assert hook_guard_routed(ROOT, "PreToolUse", "agent-guard", tool="Agent")
    assert hook_guard_routed(ROOT, "PreToolUse", "pause-guard", tool="SendMessage")
    assert hook_guard_routed(ROOT, "UserPromptSubmit", "away-protocol")
    assert not hook_guard_routed(ROOT, "PreToolUse", "agent-guard", tool="Bash")
