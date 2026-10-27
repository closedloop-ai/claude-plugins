"""Contracts for the vibe 1.1.0 release (operator ruling, 2026-10-27).

1. fleet-orchestrator is the entry point for a program with one writer, or with
   none, as well as several: its description says so, and its table states
   what every section asks of the smaller shapes.
2. Every vibe and fleet-orchestrator start checks every installed ClosedLoop
   plugin in Claude Code and Codex, asks to update or proceed knowing an
   outdated plugin could give worse results, records the answer, and updates
   whichever harness is outdated.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, section


ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "skills" / "fleet-orchestrator"
FLEET_SKILL = FLEET / "SKILL.md"
TEMPLATES = FLEET / "references" / "templates.md"
STATE = FLEET / "references" / "state.md"
SINGLE_USE = "## Programs with one writer or none"


def test_the_fleet_skill_is_the_entry_point_for_one_writer_and_for_none() -> None:
    description = FLEET_SKILL.read_text().split("---")[1]
    for phrase in ("several workers at once", "one writer delivering one pull request",
                   "a session with no writer at all (design, research or analysis)"):
        assert phrase in description, phrase


def shape_lines() -> dict[str, str]:
    text = section(FLEET_SKILL.read_text(), SINGLE_USE)
    return {label: text.split(f"- {label}", 1)[1].split(" - ", 1)[0] for label in ("Both shapes:", "one-writer, also:", "no-writer, also:")}


def test_every_fleet_section_says_whether_a_one_writer_and_a_no_writer_program_needs_it() -> None:
    # A section added later without a mention would leave the smaller shapes guessing again.
    headings = [line[3:] for line in FLEET_SKILL.read_text().splitlines() if line.startswith("## ") and line != SINGLE_USE]
    lines = shape_lines()
    one_writer = lines["Both shapes:"] + lines["one-writer, also:"]
    assert [heading for heading in headings if heading not in one_writer] == []
    assert [heading for heading in headings if heading in lines["Both shapes:"] and heading in lines["one-writer, also:"]] == []
    assert "Principles (evidence before every claim)" in lines["Both shapes:"]
    assert "State and persistence (resume log, rulings)" in lines["Both shapes:"]
    assert "Quality gates and QA except merge order and shared version-file conflicts" in lines["one-writer, also:"]
    assert lines["no-writer, also:"].rstrip().endswith("nothing else.")


def test_the_shape_is_recorded_and_enforced_by_the_scripts() -> None:
    single = section(FLEET_SKILL.read_text(), SINGLE_USE)
    assert "`fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet` records the shape" in single
    assert "`board.mjs writer` refuses a writer the shape does not allow" in single
    assert "`fleet-home.mjs start <slug> --shape <shape>`" in STATE.read_text()


def test_every_fleet_chat_starts_with_the_plugin_version_check() -> None:
    setup = section(FLEET_SKILL.read_text(), "## Setup")
    for phrase in (
        "Plugin version, first in every chat: run the check `fleet-home.mjs resume` prints (`node ../vibe/scripts/plugin-version.mjs check --state <orchDir>/plugin-version.json`",
        "\"A newer version of the plugins is available (<versions>). Update now, or proceed on this version? Proceeding on an outdated plugin could give worse results.\"",
        "`plugin-version.mjs choose --choice update|proceed --state <same file>` and in the resume log",
        "run `plugin-version.mjs update --state <same file>`; whatever its status, tell the operator which harness in its `restart` needs a new session or a reopened app, and stop when yours is one of them",
    ):
        assert phrase in setup, phrase
    new_chat = section(STATE.read_text(), "## A new chat")
    assert "Run the plugin version check its `PLUGIN-VERSION` line names (SKILL.md, Setup) before anything else." in new_chat


def test_writers_carry_the_operators_version_answer_instead_of_asking_again() -> None:
    line = "Plugin version: the operator answered this program's version check; when vibe's check finds a plugin outdated, record `plugin-version.mjs choose --choice proceed --by opening-message` and carry on."
    templates = TEMPLATES.read_text()
    for name in ("## Worker preamble", "## Resume prompt"):
        assert line in flat(section(templates, name)), name
    assert "keep the current version" not in templates


def test_a_partial_update_still_asks_for_the_restart_it_needs() -> None:
    # PR #350 review: a failed update could leave one harness on replaced files with nobody told to restart it.
    version = section((ROOT / "skills" / "vibe" / "SKILL.md").read_text(), "### Plugin version")
    assert "Whatever its status, tell the person, for each harness in its `restart`" in version
    assert "Then stop when the harness you run in is in `restart`: the update is used only from a new session." in version
    assert "a takeover of its writer, which keeps the writer's board row name" in section(FLEET_SKILL.read_text(), SINGLE_USE)
