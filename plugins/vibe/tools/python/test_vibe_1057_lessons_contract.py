"""Contract coverage for the twelve open vibe 1.0.57 lessons."""

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"


def test_precedent_clears_narrow_layout_obstructions_and_captures_both_states() -> None:
    brief = (VIBE / "scripts" / "precedent-check.mjs").read_text()
    requirements = section(agent("vibe-requirements-worker"), "## Precedent mode")
    for text in (brief, requirements):
        assert "close" in text
        assert "sidebars" in text or "sidebar" in text
        assert "dismiss banners" in text
        assert "capture" in text
        assert "both" in text


def test_frozen_stories_compare_dependency_closure_and_stable_output() -> None:
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    decomposer = flat(agent("vibe-storybook-decomposer"))
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    assert "rendered dependency closure" in rules
    assert "fixed args, globals and viewport" in rules
    assert "fixed args, globals and viewport" in decomposer
    assert "`frozen-render`" in decomposer and "`frozen-render`" in reviewer
    assert "even when its file is byte-identical" in reviewer


def test_storybook_train_is_rechecked_against_pinned_base_before_pr() -> None:
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    verify = flat(agent("vibe-verify-worker"))
    ticket = flat(agent("vibe-ticket-worker"))
    for text in (handoff, verify, ticket):
        assert "pinned" in text
        assert "release history" in text
        assert "component and story counts" in text
        assert "in-flight" in text


def test_inventory_fails_closed_for_every_outside_path() -> None:
    inventory = (HANDOFF / "scripts" / "handoff-inventory.mjs").read_text()
    reviewer = section(agent("vibe-guardrails-reviewer"), "## Check, for added or changed lines only")
    writer = flat(agent("vibe-change-worker"))
    handoff = section((HANDOFF / "SKILL.md").read_text(), "## 1. Internal checklist")
    assert "forbidden.length === 0 && outsideAllowed.length === 0" in inventory
    assert "Any entry under `forbidden` or `outsideAllowed` is blocking" in reviewer
    assert "shrinkOnlyAllowlists" in reviewer
    assert "Before `DONE`, run the handoff inventory in build phase" in writer
    assert "`blocking.forbiddenPaths` is false" in handoff


def test_malformed_metadata_must_emit_the_monitored_corruption_event() -> None:
    backend = flat(agent("vibe-backend-worker"))
    adversarial = flat(agent("vibe-adversarial-reviewer"))
    for text in (backend, adversarial):
        assert "malformed" in text
        assert "monitored corruption event" in text
        assert "no warning or error" in text


def test_external_dependency_evidence_gates_criteria_and_plan_completion() -> None:
    writer = flat(agent("vibe-change-worker"))
    ticket = flat(agent("vibe-ticket-worker"))
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    for text in (writer, ticket, handoff):
        assert "external" in text
        assert "collector" in text
        assert "selector" in text
        assert "monitor" in text
        assert "evidence" in text


def test_pr_creation_requires_real_host_and_two_touch_devices() -> None:
    handoff = flat((HANDOFF / "SKILL.md").read_text())
    verify = flat(agent("vibe-verify-worker"))
    for text in (handoff, verify):
        assert "real web host" in text or "real web-host" in text
        assert "WebKit" in text
        assert "iPhone" in text
        assert "Chromium" in text
        assert "Pixel" in text
        assert "blocked" in text or "hard gated" in text


def test_overlapping_live_children_require_explicit_reconciliation() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    ticket = flat(agent("vibe-ticket-worker"))
    assert "required reconciliation" in requirements
    assert "Discovery alone is incomplete" in requirements
    assert "reconcile it explicitly" in ticket
    assert "Every other child is listed uncovered with its unmet item" in ticket
    assert "Never set `IN_REVIEW` without a pull request" in ticket


def test_source_prd_children_are_scope_units_claimed_and_closed_with_evidence() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    ticket = flat(agent("vibe-ticket-worker"))
    assert "existing children are the scope units" in skill
    assert "the ticket worker claims or reports them" in skill
    for phrase in (
        "assign it to the session operator",
        "create one `RELATES_TO` link",
        "move exactly `children.inReview` to `IN_REVIEW`",
        "`DONE` with the merge URL and commit",
    ):
        assert phrase in ticket, phrase


def test_outdated_version_does_not_stop_an_explicit_proceed() -> None:
    # Operator ruling 2026-10-27: a resumed session is asked too; only an
    # opening instruction to proceed carries on without the question.
    version = flat(section((VIBE / "SKILL.md").read_text(), "### Plugin version"))
    assert "`outdated`, new or resumed, unless the opening message already says to proceed" in version
    assert "run `choose --choice proceed --by opening-message`" in version
    assert "continue in the same turn, without asking" in version
    assert "ask only on a fresh start" not in version
    assert "On a resumed session" not in version


def test_existing_children_are_never_agent_superseded() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    ticket = flat(agent("vibe-ticket-worker"))
    gate = (HANDOFF / "scripts" / "live-ticket-check.mjs").read_text()
    assert "no agent decides that one is superseded" in requirements
    assert "any supersession that is not a human ruling outside this session's ticket and plan" in ticket
    assert "cites the session's own ticket, plan or table as the supersession ruling" in gate


def test_desktop_launch_requires_verified_build_output() -> None:
    control = section(agent("vibe-verify-worker"), "## Control mode")
    assert "run `pnpm -C apps/desktop build` first" in control
    assert "`apps/desktop/dist` exists" in control
    assert "contains the documented Electron entry" in control
    assert "abort the Desktop scenario" in control
    assert "without calling any Electron" in control


def test_claimed_children_move_only_through_the_ticket_check_gate() -> None:
    ticket = section(agent("vibe-ticket-worker"), "## Handoff mode")
    gate = (HANDOFF / "scripts" / "live-ticket-check.mjs").read_text()
    assert "you are not the writer; its audit is never evidence" in ticket
    assert "move exactly `children.inReview` to `IN_REVIEW`" in ticket
    assert '"child-evidence": { type: "string" }' in gate
    assert "its own audit never moves a child" in gate
    assert "16. PRD child reconciliation" not in agent("vibe-guardrails-reviewer")


def test_session_text_is_never_provenance() -> None:
    quality = (VIBE / "references" / "quality-loop.md").read_text()
    assert "is never a source" in section(quality, "## Communication and product questions")
    assert "Never strengthen them either" in section(quality, "## Acceptance criteria before ready")
    assert "a stated requirement there wins" in section(quality, "### Precedent before asking")
    check = flat(agent("vibe-guardrails-reviewer"))
    assert "never a reason to build that behavior" in section(quality, "## Tests: repair, don't author")
    for phrase in ("new user-reachable capability (a write path, action or control)", "a PRD display cap is not one", "numeric limit", "criterion worded more strongly than its source"):
        assert phrase in check, phrase
    assert "flag, rollout, rollback, parity, boundary and non-goal clauses are criteria too" in flat(agent("vibe-requirements-worker"))
