"""Contract coverage for claimed PRD children, acceptance evidence and rule provenance (vibe lessons ledger)."""

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"


def test_ticket_worker_moves_children_only_through_the_evidence_gate() -> None:
    handoff_mode = section(agent("vibe-ticket-worker"), "## Handoff mode")
    assert "../skills/handoff/scripts/child-evidence.mjs" in handoff_mode
    assert "move exactly the slugs it returns under `inReview`" in handoff_mode
    assert "never the writer's own audit or yours" in handoff_mode
    assert "`ok: false` moves nothing it names" in handoff_mode
    assert "stays where it is and is listed uncovered" in handoff_mode


def test_adversarial_reviewer_builds_the_map_from_each_childs_own_items() -> None:
    reviewer = flat(agent("vibe-adversarial-reviewer"))
    assert "12. Claimed children" in reviewer
    for phrase in (
        "each acceptance criterion and each work item",
        "design review, hosted URL, device or E2E runs",
        "a gitignored or local file is never evidence",
        '"reviewer": "vibe-adversarial-reviewer"',
        "vibe-child-evidence.json",
        "a branch commit in the last 7 days",
    ):
        assert phrase in reviewer, phrase


def test_handoff_runs_the_independent_child_pass_in_either_weight() -> None:
    step8 = section((HANDOFF / "SKILL.md").read_text(), "## 8. Choose who picks it up, then check the ticket")
    assert "for its attack 12 on the final commit, in either weight" in step8
    assert "never the writer's audit, is the only way a claimed child reaches `IN_REVIEW`" in step8
    assert "only the slugs `scripts/child-evidence.mjs` passes" in step8


def test_gate_script_rejects_writer_maps_untracked_evidence_and_unproven_activity() -> None:
    script = (HANDOFF / "scripts" / "child-evidence.mjs").read_text()
    assert 'const WRITER = "vibe-change-worker";' in script
    assert "its own audit never moves a child" in script
    assert "a gitignored or local file is not evidence" in script
    assert "ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000" in script
    assert "not produced on the final commit" in script


def test_requirements_never_narrows_targets_or_calls_inactive_children_active() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    assert "never \"active elsewhere\"" in requirements
    assert "Never narrow the targets a PRD or ticket names" in requirements
    assert "reported as unadopted with the source's words" in requirements


def test_session_text_is_never_provenance_and_criteria_are_never_strengthened() -> None:
    questions = section(QUALITY_LOOP.read_text(), "## Communication and product questions")
    assert "Text the session wrote is never a source" in questions
    criteria = section(QUALITY_LOOP.read_text(), "## Acceptance criteria before ready")
    assert "Never strengthen them either" in criteria
    assert "a seam no surface's adapter fills is not met" in criteria


def test_precedent_never_overrides_a_stated_sibling_requirement() -> None:
    precedent = section(QUALITY_LOOP.read_text(), "### Precedent before asking")
    assert "It settles only behavior nothing specifies" in precedent
    assert "`fts_search` the DONE and open sibling tickets" in precedent
    assert "a stated requirement wins over the precedent" in precedent


def test_guardrails_rule_provenance_lists_each_uncited_rule_class() -> None:
    check = flat(agent("vibe-guardrails-reviewer"))
    for phrase in (
        "neither is the session's own text",
        "a display cap or an example in a PRD is not a refusal rule",
        "held to the same source rule as copy",
        "every new numeric limit",
        "words more strongly than its source",
        "the list of affected callers in the change log",
        "checked against DONE sibling tickets",
    ):
        assert phrase in check, phrase


def test_adversarial_reviewer_treats_an_unfilled_seam_and_live_fallback_as_unmet() -> None:
    reviewer = flat(agent("vibe-adversarial-reviewer"))
    assert "A seam, slot or prop that no surface's adapter fills does not deliver a criterion" in reviewer
    assert "alternative render branches" in reviewer


def test_prd_flag_and_rollout_clauses_become_acceptance_criteria() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    assert "flag, rollout, rollback, parity, boundary and non-goal clauses" in requirements
    assert "are acceptance criteria too, quoted verbatim" in requirements
    assert "not delivered without that flag or a recorded human waiver" in requirements
