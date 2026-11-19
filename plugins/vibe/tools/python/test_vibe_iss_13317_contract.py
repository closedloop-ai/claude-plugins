"""Contract checks for ISS-13317: the frozen-render gate is settled only by the shipped command.

A product manager's session could never clear `frozen-render`: main's own render of a story varied between
runs and vibe shipped no deterministic capture, so the session wrote its own loop. The command now renders
the base twice, pins its inputs and prints the only line the gate accepts; every instruction points at it.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import PROVIDER_REFERENCES, flat


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF = PLUGIN_ROOT / "skills" / "handoff"
AGENTS = PLUGIN_ROOT / "agents"
REFERENCES = PLUGIN_ROOT / "skills" / "vibe" / "references"


def test_the_remedy_names_the_command_and_counts_story_files() -> None:
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "run handoff's scripts/frozen-render-gate.mjs as its own shell step" in rules
    assert "never a capture of your own" in rules
    assert "with fixed args, globals and viewport" not in rules
    assert "Frozen render unchanged: all ${affected.length} story files (" in rules


def test_handoff_change_worker_and_decomposer_point_at_the_command() -> None:
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    assert "A `frozen-render` finding is settled only by one shell step that launches no agent" in handoff
    assert "node scripts/frozen-render-gate.mjs --repo <worktree> --base <base>" in handoff
    assert "Nobody captures frozen stories any other way" in handoff
    worker = flat((AGENTS / "vibe-change-worker.md").read_text())
    assert "done only by handoff's `scripts/frozen-render-gate.mjs`" in worker
    assert "never write that line by hand" in worker
    decomposer = flat((AGENTS / "vibe-storybook-decomposer.md").read_text())
    assert "Never render or capture frozen stories" in decomposer


def test_unstable_base_stories_go_on_the_ticket_as_known_main_failures() -> None:
    template = flat((PROVIDER_REFERENCES / "ticket-template.md").read_text())
    assert "Each `unstable-on-base` story goes there as" in template
    assert "renders differently on two base renders at <base>; diff: <its cropped diff>" in template


def test_the_base_storybook_runs_a_repaired_story_file_from_the_session() -> None:
    # ISS-14395: the gate prepares the base itself; the driver keeps the compile-only repair rule.
    driver = (HANDOFF / "scripts" / "frozen-render.mjs").read_text()
    assert "prepare-base" in driver and "compile-only repair" in driver
    inventory = (HANDOFF / "scripts" / "handoff-inventory.mjs").read_text()
    assert "keepsStoryIdentity," in inventory and "function keepsStoryIdentity" not in inventory
