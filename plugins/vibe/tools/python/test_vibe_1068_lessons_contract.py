"""Contract coverage for the vibe 1.0.68 lessons: the scripts are wired where their readers act."""

from pathlib import Path

from vibe_contract_text import agent, flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def test_narrow_controls_check_is_run_by_the_reviewer() -> None:
    assert (HANDOFF / "scripts" / "narrow-controls.mjs").exists()
    assert "narrow-controls.mjs" in flat(agent("vibe-adversarial-reviewer"))


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


def test_new_data_mechanisms_need_a_traced_decision() -> None:
    for text in (
        flat(agent("vibe-requirements-worker")),
        flat((PLUGIN / "skills" / "cl-execute" / "references" / "planning-and-gates.md").read_text()),
        flat((PLUGIN / "skills" / "cl-execute" / "references" / "plan-review-prompt.md").read_text()),
    ):
        assert "mechanism that moves data between surfaces along an existing direction" in text


def test_newest_ruling_is_searched_recorded_and_checked() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    assert "search_memory_facts" in requirements and '"descoped"' in requirements
    assert "Newest ruling:" in (VIBE / "references" / "ticket-template.md").read_text()
    assert "Newest ruling" in (HANDOFF / "scripts" / "live-ticket-check.mjs").read_text()
    assert "Newest ruling and Prior removal lines" in flat(agent("vibe-ticket-worker"))
    fleet = flat((FLEET / "SKILL.md").read_text())
    assert "newest-ruling search" in fleet
    assert "press Esc in the named pane" in fleet and "Keep long briefs in a file" in fleet


def test_prior_removals_are_searched_recorded_and_gated() -> None:
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert '"restored-removal"' in rules and "Restore authorization:" in rules
    assert "Prior removal:" in (VIBE / "references" / "ticket-template.md").read_text()
    assert "Prior removal" in (HANDOFF / "scripts" / "live-ticket-check.mjs").read_text()
    for name in ("vibe-requirements-worker", "vibe-change-worker", "vibe-ticket-worker"):
        assert "Prior removal" in flat(agent(name))


def test_whole_environment_dumps_are_a_diff_rule() -> None:
    assert '"env-dump"' in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
