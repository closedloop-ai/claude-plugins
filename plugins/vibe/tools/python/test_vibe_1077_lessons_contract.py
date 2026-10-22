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
