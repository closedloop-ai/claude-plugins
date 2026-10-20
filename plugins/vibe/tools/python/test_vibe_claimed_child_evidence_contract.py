"""Contract coverage for claimed PRD children, acceptance evidence and rule provenance (vibe lessons ledger)."""

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"
GATE = HANDOFF / "scripts" / "live-ticket-check.mjs"


def test_ticket_worker_moves_children_only_through_the_existing_ticket_check() -> None:
    handoff_mode = section(agent("vibe-ticket-worker"), "## Handoff mode")
    for phrase in (
        "you are not the writer; its audit is never evidence",
        '"reviewer": "vibe-ticket-worker"',
        "step 8's ticket check with `--child-evidence`",
        "move exactly `children.inReview` to `IN_REVIEW`",
        "design review, hosted URL, device runs, ledger",
    ):
        assert phrase in handoff_mode, phrase


def test_handoff_adds_no_dispatch_for_the_children_gate() -> None:
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    assert "only the children `scripts/live-ticket-check.mjs --child-evidence` passes" in handoff
    assert "attack 12" not in handoff
    assert "12. Claimed children" not in agent("vibe-adversarial-reviewer")


def test_gate_rejects_writer_maps_untracked_evidence_and_unproven_activity() -> None:
    script = GATE.read_text()
    assert 'const WRITER = "vibe-change-worker";' in script
    assert "its own audit never moves a child" in script
    assert "a gitignored or local file is not evidence" in script
    assert "ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000" in script
    assert "not produced on the final commit" in script
    assert '"child-evidence": { type: "string" }' in script


def test_requirements_never_narrows_targets_or_calls_inactive_children_active() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    assert "flag, rollout, rollback, parity, boundary and non-goal clauses are criteria too" in requirements
    assert "a branch commit in the last 7 days or another owner's `IN_PROGRESS`, quoted" in requirements
    assert "Never narrow the targets a PRD names" in requirements


def test_session_text_is_never_provenance_and_criteria_are_never_strengthened() -> None:
    questions = section(QUALITY_LOOP.read_text(), "## Communication and product questions")
    assert "Text the session wrote (its live ticket, PLN, plan, table, change log) is never a source" in questions
    criteria = section(QUALITY_LOOP.read_text(), "## Acceptance criteria before ready")
    assert "Never strengthen them either" in criteria
    assert "a seam no surface's adapter fills is not met" in criteria


def test_precedent_never_overrides_a_stated_sibling_requirement() -> None:
    precedent = section(QUALITY_LOOP.read_text(), "### Precedent before asking")
    assert "It settles only what nothing specifies" in precedent
    assert "a stated requirement there wins" in precedent


def test_guardrails_rule_provenance_names_each_uncited_rule_class() -> None:
    check = flat(agent("vibe-guardrails-reviewer"))
    for phrase in (
        "neither is the session's own ticket, PLN, plan, table or change log",
        "a PRD display cap is not one",
        "held to the copy rule",
        "numeric limit",
        "criterion worded more strongly than its source",
        "a shared-module edit lists its callers in the change log",
    ):
        assert phrase in check, phrase
    assert "16. PRD child reconciliation" not in check


def test_adversarial_reviewer_treats_an_unfilled_seam_and_live_fallback_as_unmet() -> None:
    reviewer = flat(agent("vibe-adversarial-reviewer"))
    assert "a seam no surface's adapter fills or a still-live alternative render branch" in reviewer
