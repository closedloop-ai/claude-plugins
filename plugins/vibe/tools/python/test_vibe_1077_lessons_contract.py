"""Contract coverage for the vibe 1.0.77 lesson: the status audit runs at every merge and writer assignment."""

from pathlib import Path

from vibe_contract_text import flat


FLEET = Path(__file__).resolve().parents[2] / "skills" / "fleet-orchestrator"


def test_status_audit_runs_at_every_merge_and_writer_assignment() -> None:
    assert (FLEET / "scripts" / "status-audit.mjs").exists()
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "At every writer assignment and every merge" in skill
    assert "status-audit.mjs --snapshot <file>" in skill
