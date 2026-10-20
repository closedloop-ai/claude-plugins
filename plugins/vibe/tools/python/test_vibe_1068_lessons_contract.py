"""Contract coverage for the vibe 1.0.68 lessons: the scripts are wired where their readers act."""

from pathlib import Path

from vibe_contract_text import agent, flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def test_narrow_controls_check_is_run_by_the_reviewer_and_required_by_the_inventory() -> None:
    assert (HANDOFF / "scripts" / "narrow-controls.mjs").exists()
    assert "narrow-controls.mjs" in flat(agent("vibe-adversarial-reviewer"))
    assert "narrow-controls.mjs --worktree" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()


def test_copy_provenance_is_a_diff_rule() -> None:
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert '"copy-provenance"' in rules
    assert "Copy: " in rules


def test_fix_claims_are_measured_and_tests_do_not_pin_the_opposite() -> None:
    assert "not its container, at the named viewport" in flat(agent("vibe-change-worker"))
    assert "pins the opposite of the behavior its brief asks for" in flat(agent("vibe-guardrails-reviewer"))


def test_one_actor_files_qa_tickets_after_a_duplicate_search() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    templates = flat((FLEET / "references" / "templates.md").read_text())
    assert "You alone file a ticket for a QA finding" in skill
    assert "searching open tickets created in the last day for the same subject" in skill
    assert "Never file a ticket; the orchestrator files them." in templates


def test_upgrade_needs_no_restored_cache() -> None:
    install = flat((VIBE / "INSTALL.md").read_text())
    loop = flat((VIBE / "references" / "quality-loop.md").read_text())
    assert "deletes every older vibe version's cache" in install
    assert "Nothing needs restoring" in install
    assert "helper's grant under a removed root needs no old cache" in loop
