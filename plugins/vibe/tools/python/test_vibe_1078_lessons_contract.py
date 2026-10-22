"""Contract coverage for the vibe 1.0.78 release."""

from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def test_the_lessons_loop_measures_instruction_words_at_the_final_head() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "instruction-words.mjs --base <last release> --changelog CHANGELOG.md --version <x.y.z>" in skill
    assert (FLEET / "scripts" / "instruction-words.mjs").exists()
