"""Contracts for the vibe 1.0.86 release (operator ruling, 2026-10-27).

1. fleet-orchestrator is the entry point for a program with one writer, or with
   none, as well as several: its description says so, and its table states
   what every section asks of the smaller shapes.
2. Every vibe and fleet-orchestrator start checks every installed ClosedLoop
   plugin in Claude Code and Codex, asks to update or proceed knowing an
   outdated plugin could give worse results, records the answer, and updates
   whichever harness is outdated.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from vibe_contract_text import flat, section


ROOT = Path(__file__).resolve().parents[2]
FLEET = ROOT / "skills" / "fleet-orchestrator"
FLEET_SKILL = FLEET / "SKILL.md"
TEMPLATES = FLEET / "references" / "templates.md"
STATE = FLEET / "references" / "state.md"
SINGLE_USE = "## Programs with one writer or none"
CELL = re.compile(r"^\| (?P<section>[^|]+?) \| (?P<none>[^|]+?) \| (?P<one>[^|]+?) \|$")


def test_release_and_both_manifests_are_1086() -> None:
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads((ROOT / manifest).read_text())["version"] == "1.0.86"


def test_the_fleet_skill_is_the_entry_point_for_one_writer_and_for_none() -> None:
    description = FLEET_SKILL.read_text().split("---")[1]
    for phrase in ("several workers at once", "one writer delivering one pull request",
                   "a session with no writer at all (design, research or analysis)"):
        assert phrase in description, phrase


def single_use_rows() -> dict[str, tuple[str, str]]:
    text = FLEET_SKILL.read_text()
    block = text[text.index(SINGLE_USE):].split("\n## ", 1)[0]
    rows = {}
    for line in block.splitlines():
        match = CELL.match(line)
        if match and match["section"] not in ("Section", "---"):
            rows[match["section"]] = (match["none"], match["one"])
    return rows


def test_every_fleet_section_says_what_it_asks_of_a_one_writer_and_a_no_writer_program() -> None:
    # A section added later without a row would leave the smaller shapes guessing again.
    headings = [line[3:] for line in FLEET_SKILL.read_text().splitlines() if line.startswith("## ")]
    rows = single_use_rows()
    assert sorted(rows) == sorted(heading for heading in headings if heading != SINGLE_USE[3:])
    for name, cells in rows.items():
        assert all(cell.strip() and not cell.startswith("-") for cell in cells), name
    for always in ("Principles", "State and persistence", "Research with closedloop-graph", "Reporting to the operator"):
        assert rows[always][0].startswith("applies"), always
    assert "evidence before every claim" in rows["Principles"][0]
    assert "resume log, rulings" in rows["State and persistence"][0]
    assert rows["Fleet board and direct messages"][0] == "skip"
    assert "merge order and shared version-file conflicts" in rows["Quality gates and QA"][1]


def test_the_shape_is_recorded_and_enforced_by_the_scripts() -> None:
    single = section(FLEET_SKILL.read_text(), SINGLE_USE)
    assert "`fleet-home.mjs start <slug> --shape no-writer|one-writer|fleet`" in single
    assert "`board.mjs writer` refuses a writer the shape does not allow" in single
    assert "`fleet-home.mjs start <slug> --shape <shape>`" in STATE.read_text()


def test_every_fleet_chat_starts_with_the_plugin_version_check() -> None:
    setup = section(FLEET_SKILL.read_text(), "## Setup")
    for phrase in (
        "Plugin version, first in every chat, new or resumed: run `node ../vibe/scripts/plugin-version.mjs check --state <orchDir>/plugin-version.json`",
        "update now, or proceed knowing an outdated plugin could give worse results",
        "`plugin-version.mjs choose --choice update|proceed --state <same file>` and in the resume log",
        "`plugin-version.mjs update --state <same file>`",
        "it updates each outdated plugin in Claude Code and Codex, whichever has one, and verifies it",
        "In Claude Code the vibe hooks refuse worker launches until the check and any answer are recorded.",
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
