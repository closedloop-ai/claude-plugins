"""Contract coverage for the vibe 1.0.78 release."""

import json
import re
from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def test_the_lessons_loop_measures_instruction_words_at_the_final_head() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "instruction-words.mjs --base <last release> --changelog CHANGELOG.md --version <x.y.z>" in skill
    assert (FLEET / "scripts" / "instruction-words.mjs").exists()


MONITOR = PLUGIN / "skills" / "codex-fleet-monitor"
WORK_DIR_USAGE = re.compile(r"Usage:.*<(?:orchDir|workDir)>")


def test_every_script_that_takes_a_work_dir_resolves_it_through_the_fleet_home() -> None:
    scripts = [
        path
        for folder in (FLEET / "scripts", MONITOR / "scripts")
        for path in sorted(folder.iterdir())
        if path.suffix in {".mjs", ".sh"} and not path.name.endswith(".test.mjs") and WORK_DIR_USAGE.search(path.read_text())
    ]
    assert len(scripts) >= 10
    for path in scripts:
        text = path.read_text()
        assert "work-dir.mjs" in text or "resolveWorkDir" in text, path.name


def test_a_new_chat_resumes_from_the_fleet_home() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    state = flat((FLEET / "references" / "state.md").read_text())
    assert "All state lives in one fleet home" in skill
    assert "`board.mjs status` fails on state written outside it" in skill
    for wired in ("fleet-home.mjs resume", "NO-ACTIVE-PROGRAM", "WATCHER-LIVE <pid>", "RELAUNCH <writer> <prompt>", "fleet-home.mjs check", "standing-rulings.md", "fleet-home.mjs migrate"):
        assert wired in state, wired
    setup = flat((FLEET / "references" / "setup.md").read_text())
    assert "REMOTE_FLEET_HOME" in setup and "LOCAL_STATE_DIR=" not in setup


def test_the_2026_10_22_open_lessons_are_wired() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "scheduled review bots post under teammates' accounts" in skill
    assert "Vibe's merge guard refuses `gh pr merge` on another author's pull request" in skill
    assert "a Sonnet watcher" in skill and "starts an Opus fixer" in skill
    assert "run the full e2e suites on main yourself" in skill
    assert "--skip-ruling" in skill
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())
    commands = [hook["command"] for entry in hooks["hooks"]["PreToolUse"] for hook in entry["hooks"]]
    assert any("hooks/merge-guard.mjs" in command for command in commands)
