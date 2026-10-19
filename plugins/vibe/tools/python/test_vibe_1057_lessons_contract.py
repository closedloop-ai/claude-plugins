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
    decomposer = flat(agent("vibe-storybook-decomposer"))
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    for text in (decomposer, reviewer):
        assert "transitive rendered dependency closure" in text
        assert "stable" in text
        assert "story IDs" in text
        assert "fixed args, globals and viewport" in text


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
    assert "uncovered with current owner and status" in ticket


def test_source_prd_children_are_scope_units_claimed_and_closed_with_evidence() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    ticket = flat(agent("vibe-ticket-worker"))
    for phrase in (
        "existing children are the scope units",
        "assigning them to the session operator",
        "linking them `RELATES_TO`",
        "No agent supersedes a child",
    ):
        assert phrase in skill
    for phrase in ("active by someone else", "`IN_REVIEW`", "`DONE`", "merge URL and commit"):
        assert phrase in ticket


def test_outdated_version_does_not_stop_resume_or_explicit_proceed() -> None:
    version = section((VIBE / "SKILL.md").read_text(), "### Plugin version")
    assert "ask only on a fresh start" in version
    assert "On a resumed session" in version
    assert "opening message already says to proceed" in version
    assert "continue in the same turn" in version
    assert "Do not ask the version question or stop orchestration" in version


def test_existing_children_are_never_agent_superseded() -> None:
    requirements = flat(agent("vibe-requirements-worker"))
    ticket = flat(agent("vibe-ticket-worker"))
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    assert "no agent decides that one is superseded" in requirements
    assert "never authority" in ticket
    assert "session-created supersession" in reviewer
    assert '"not reused"' in reviewer


def test_desktop_launch_requires_verified_build_output() -> None:
    control = section(agent("vibe-verify-worker"), "## Control mode")
    assert "run `pnpm -C apps/desktop build` first" in control
    assert "`apps/desktop/dist` exists" in control
    assert "contains the documented Electron entry" in control
    assert "abort the Desktop scenario" in control
    assert "without calling any Electron" in control
