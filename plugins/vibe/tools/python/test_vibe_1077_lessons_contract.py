"""Contract coverage for the vibe 1.0.77 release: question ids and acknowledgements, and the foreground guard."""

import json
from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def _text(path: Path) -> str:
    return flat(path.read_text())


def test_answers_echo_question_ids_and_unacknowledged_answers_are_flagged() -> None:
    fleet = _text(FLEET / "SKILL.md")
    assert "answered <writer> --id <id>" in fleet and "`UNACKED`" in fleet
    templates = _text(FLEET / "references" / "templates.md")
    assert "question <you> --id <id>" in templates and "ack <you> --id <id>" in templates


def test_vibe_worktrees_refuse_long_foreground_waits() -> None:
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]["PreToolUse"]
    commands = [hook["command"] for entry in hooks if entry.get("matcher") == "Bash" for hook in entry["hooks"]]
    assert any("foreground-guard.mjs" in command for command in commands)


def test_every_pr_open_step_requires_the_lanes_ci_would_run() -> None:
    for path in (PLUGIN / "agents" / "vibe-environment-worker.md", PLUGIN / "skills" / "handoff" / "SKILL.md", FLEET / "SKILL.md"):
        assert "pre-pr-lanes.mjs check" in _text(path), path.name


def test_green_watch_triages_each_lane_and_mocks_per_block() -> None:
    fleet = _text(FLEET / "SKILL.md")
    assert "`NEW-RED`" in fleet and "mock-gap.mjs" in fleet


def test_the_watch_set_finds_every_open_pr_and_names_its_writer() -> None:
    snapshot = (PLUGIN / "skills" / "codex-fleet-monitor" / "scripts" / "snapshot.sh").read_text()
    assert "--author" in snapshot and "done_prs" in snapshot
    assert "liveness signal" in _text(PLUGIN / "skills" / "codex-fleet-monitor" / "SKILL.md")
    assert "<owner/repo> <n> <writer>" in _text(FLEET / "SKILL.md")


def test_away_and_back_phrases_bring_the_away_protocol() -> None:
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]
    assert any("away-protocol.mjs" in hook["command"] for entry in hooks["UserPromptSubmit"] for hook in entry["hooks"])
    assert "`away-protocol` hook" in _text(FLEET / "SKILL.md")
