"""Contract checks for ISS-14229: the affected typecheck still runs when local heavy checks are barred.

The operator's placement order is that nothing heavy runs on the daily laptop. `LOCAL_HEAVY_BARRED=1` in the
fleet's config.env is that order in machine-readable form (fleet.sh refuses a local heavy slot; fleet.test.mjs
covers it); the writer's loop must then send the typecheck to the remote slot, never skip it.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section
import skill_split


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
QUALITY = PLUGIN_ROOT / "skills" / "vibe" / "references" / "quality-loop.md"
SETUP = PLUGIN_ROOT / "skills" / "fleet-orchestrator" / "references" / "setup.md"
REMOTE_TYPECHECK = ("the affected typecheck runs through `fleet.sh <orchDir> remote slot heavy` after each writer fix "
                    "and before each review round; it is never skipped and never run locally.")


def test_the_lean_loop_sends_the_typecheck_to_the_remote_slot_when_local_heavy_work_is_barred() -> None:
    lean = section(skill_split.read(QUALITY), "## Lean build loop")
    assert "When local heavy checks are barred (`LOCAL_HEAVY_BARRED=1` in the fleet's `config.env`), " + REMOTE_TYPECHECK in lean
    assert "Biome on the changed files, the affected typecheck and the source gates" in lean
    assert "run at `$handoff`, never during the loop" in lean


def test_the_writer_sends_the_typecheck_to_the_remote_slot_when_local_heavy_work_is_barred() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert "When local heavy checks are barred (`LOCAL_HEAVY_BARRED=1` in the fleet's `config.env`), " + REMOTE_TYPECHECK in writer
    assert "Biome on the changed files, the affected typecheck and the source gates" in writer


def test_setup_lists_the_bar_beside_the_heavy_slot_keys() -> None:
    # What the bar does is fleet.sh's refusal message, pinned in fleet.test.mjs; setup lists only the key.
    setup = skill_split.read(SETUP)
    keys = setup[setup.index("HEAVY_SLOTS=<"):setup.index("MAX_LOAD_PER_CORE=1.5")]
    assert "LOCAL_HEAVY_BARRED=1" in keys
