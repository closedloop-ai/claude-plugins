"""Contract checks for ISS-13317: the frozen-render gate is settled only by the shipped command.

A product manager's session could never clear `frozen-render`: main's own render of a story varied between
runs and vibe shipped no deterministic capture, so the session wrote its own loop. The command now renders
the base twice, pins its inputs and prints the only line the gate accepts; every instruction points at it.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF = PLUGIN_ROOT / "skills" / "handoff"
AGENTS = PLUGIN_ROOT / "agents"
REFERENCES = PLUGIN_ROOT / "skills" / "vibe" / "references"


def test_the_remedy_names_the_command_and_counts_story_files() -> None:
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "run handoff's scripts/frozen-render.mjs with every one of these story files" in rules
    assert "never a capture of your own" in rules
    assert "with fixed args, globals and viewport" not in rules
    assert "Frozen render unchanged: all ${affected.length} story files (" in rules


def test_handoff_change_worker_and_decomposer_point_at_the_command() -> None:
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    assert "A `frozen-render` finding is settled only by `scripts/frozen-render.mjs`" in handoff
    assert "nobody captures frozen stories any other way" in handoff
    worker = flat((AGENTS / "vibe-change-worker.md").read_text())
    assert "done only by handoff's `scripts/frozen-render.mjs`" in worker
    assert "never write a `Frozen render unchanged` line by hand" in worker
    decomposer = flat((AGENTS / "vibe-storybook-decomposer.md").read_text())
    assert "renders each story twice on the base and once on the branch" in decomposer
    assert "only its cropped diff, never the full screenshots" in decomposer
    assert "same load and slot rules as every other handoff heavy run" in decomposer
    assert "never write or edit that line yourself" in decomposer


def test_unstable_base_stories_go_on_the_ticket_as_known_main_failures() -> None:
    template = flat((REFERENCES / "ticket-template.md").read_text())
    assert "Each `unstable-on-base` story goes there as" in template
    assert "renders differently on two base renders at <base>; diff: <its cropped diff>" in template
