"""Contracts for the vibe 1.0.81 prevention lessons (2026-10-23 and 2026-10-24)."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def test_release_and_both_manifests_are_1081() -> None:
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads(read(manifest))["version"] == "1.0.81"


def test_targeted_tests_are_the_lanes_test_lanes_names() -> None:
    verify = read("agents/vibe-verify-worker.md")
    assert "each named lane by the command\n`pnpm test:lanes` prints" in verify
    assert "a whole lane or package suite locally" not in verify
    assert "ci-job-shape.mjs" in verify
    assert "capability ledger or\nparity test listing a sibling prop" in read("agents/vibe-change-worker.md")
    facts = read("skills/handoff/scripts/pr-facts.mjs")
    assert "ciCheckProblems(runs, changed, commit)" in facts
    assert "a hand-picked subset is not the lane" in facts


def test_bot_threads_and_holds_have_owned_rules() -> None:
    handoff = read("skills/handoff/SKILL.md")
    fleet = read("skills/fleet-orchestrator/SKILL.md")
    assert "`source: bot` thread is fixed only when it reproduces" in handoff
    assert "vibe.reviewBots" in read("agents/vibe-environment-worker.md")
    assert "Hold an agent with TaskStop, never a message" in fleet
    hooks = json.loads(read("hooks/hooks.json"))["hooks"]["PreToolUse"]
    assert any(entry["matcher"] == "SendMessage" for entry in hooks)


def test_env_less_sessions_push_and_qa_env_uses_vibe_up() -> None:
    environment = read("agents/vibe-environment-worker.md")
    assert "A session with no environment (no `lastRequestId`)" in environment
    assert 'command: "pnpm vibe up"' in read("skills/handoff/scripts/parallel-prep.mjs")
    verify = read("agents/vibe-verify-worker.md")
    assert "--head <the pushed sha>" in verify
    assert "`image-head.mjs` refuses stale images" in verify
    assert "position or scrolling the\n  diff changes, inspect every" in verify
    assert "imageProblem(images)" in read("skills/vibe/scripts/e2e-lock.mjs")
