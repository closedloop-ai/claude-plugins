"""Contract coverage for the vibe 1.0.75 lessons: each new check is wired where its reader acts."""

from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def _text(path: Path) -> str:
    return flat(path.read_text())


def test_criteria_audit_and_rulings_check_gate_the_handoff() -> None:
    handoff = _text(HANDOFF / "SKILL.md")
    for script in ("criteria-audit.mjs", "rulings-check.mjs"):
        assert (HANDOFF / "scripts" / script).exists()
        assert f"scripts/{script}" in handoff, script
    assert "fresh-context reviewer given only the ticket's criteria and the diff" in handoff
    assert '- Ruling <date> (<who>): "' in (VIBE / "references" / "ticket-template.md").read_text()


def test_findings_reach_a_writer_with_their_evidence() -> None:
    assert "finding-brief.mjs <orchDir> --findings" in _text(FLEET / "SKILL.md")
    assert "$prompt.evidence" in (FLEET / "scripts" / "fleet.sh").read_text()


def test_precedent_disputed_behaviors_and_review_gap_rules_are_wired() -> None:
    assert '--behavior "<the interaction to perform>"' in _text(VIBE / "references" / "quality-loop.md")
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "checkComparators" in rules
    assert "checkUnusedExports" in rules
