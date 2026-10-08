"""Contract checks for how the handoff skill routes the person's answers (ISS-12135).

A handoff answer that decides what the product does must reach the change worker,
and the checks, reviews, and redeploy must follow, before the ticket is finished.
The ticket goes to the user the person names as the next owner, never to a
built-in default.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
TICKET_TEMPLATE = PLUGIN_ROOT / "skills" / "vibe" / "references" / "ticket-template.md"
TICKET_WORKER = PLUGIN_ROOT / "agents" / "vibe-ticket-worker.md"
CHANGE_WORKER = PLUGIN_ROOT / "agents" / "vibe-change-worker.md"
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"


def section(text: str, heading: str) -> str:
    """The section under `heading`, with line wrapping collapsed to single spaces."""
    start = text.index(heading)
    rest = text[start + len(heading) :]
    end = rest.find("\n## ")
    return re.sub(r"\s+", " ", rest if end == -1 else rest[:end])


def test_behavior_answers_go_to_the_change_worker_before_the_ticket() -> None:
    answers = section(HANDOFF_SKILL.read_text(), "## Answers from the person")

    assert "**Behavior**" in answers
    assert "**Wording**" in answers
    assert "when you are unsure" in answers
    assert "A behavior answer goes to `vibe-change-worker` in fix mode first" in answers
    for rerun in ("step 3", "step 4", "step 5", "step 6", "step 7"):
        assert rerun in answers, rerun
    assert "Only then does the answer go to `vibe-ticket-worker`." in answers
    assert "A wording answer goes straight to `vibe-ticket-worker`." in answers
    assert "`built`" in answers
    assert "`already met`" in answers


def test_step_eight_routes_answers_and_blocks_finalizing_until_reruns_finish() -> None:
    step_eight = section(HANDOFF_SKILL.read_text(), "## 8. Choose who picks it up, then check the ticket")

    assert "`NEEDS_PERSON`" in step_eight
    assert "`NEEDS_CHANGE`" in step_eight
    assert "route their answer as \"Answers from the person\" says" in step_eight
    assert "Environment base commit from the current inventory" in step_eight
    assert "Never go on to step 9 while a behavior answer" in step_eight


def test_summary_corrections_that_change_behavior_are_routed_too() -> None:
    step_two = section(HANDOFF_SKILL.read_text(), "## 2. Summarize internally")

    assert "Answers from the person" in step_two
    assert "goes to the change worker now" in step_two


def test_ticket_worker_refuses_unbuilt_behavior_and_rederives_dependent_sections() -> None:
    handoff = section(TICKET_WORKER.read_text(), "## Handoff mode")

    assert "handoff-inventory.mjs --worktree" in handoff
    assert "it must be the inventory's `baseCommit`" in handoff
    assert "return `NEEDS_CHANGE`" in handoff
    assert "re-derive every section that depends on" in handoff
    for dependent in ("What this is", "Scope and acceptance criteria", "Handoff"):
        assert dependent in handoff, dependent
    assert "--base-commit <inventory baseCommit>" in handoff
    assert "marked `behavior`" in handoff


def test_change_worker_checks_a_handoff_answer_against_the_code() -> None:
    fix_mode = section(CHANGE_WORKER.read_text(), "## Fix mode")

    assert "the person's answer to it" in fix_mode
    assert "`already met`" in fix_mode
    assert "`built`" in fix_mode
    assert "Scope and acceptance criteria in their words" in fix_mode


def test_step_eight_reuses_a_named_owner_or_asks_without_defaulting() -> None:
    step_eight = section(HANDOFF_SKILL.read_text(), "## 8. Choose who picks it up, then check the ticket")

    assert "Who should pick this up next? A name or email is fine." in step_eight
    assert "`vibe-ticket-worker` in lookup mode" in step_eight
    assert "Use a next owner the person already named" in step_eight
    assert "never re-ask that settled choice" in step_eight
    assert "Keep the assignment progress internal" in step_eight
    assert "report the next owner at completion" in step_eight
    assert "`<full name> (<email>)`" in step_eight
    assert "ask the question again" in step_eight
    assert "never fall back to anyone by default" in step_eight
    assert "the next owner (full name and email)" in step_eight


def test_lookup_matches_through_the_script_and_assign_uses_its_user() -> None:
    worker = TICKET_WORKER.read_text()
    lookup = section(worker, "## Lookup mode")
    assign = section(worker, "## Assign mode")

    assert "until `hasMore` is false" in lookup
    assert "match-assignee.mjs" in lookup
    assert "Never match by eye" in lookup
    assert "choose none" in lookup
    assert "the next owner's id as `assigneeId`" in assign
    assert "`expectedStatus: IN_PROGRESS`; never change the status" in assign
    assert "never assign anyone by default" in assign


def test_no_next_owner_is_hardcoded() -> None:
    next_line = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    for text in (HANDOFF_SKILL.read_text(), TICKET_WORKER.read_text(), next_line):
        assert "Nenad" not in text
    assert "- Next: <the next owner the person chose at handoff, by full name>" in next_line


def test_template_grading_block_follows_handoff_with_the_seven_item_checklist() -> None:
    template = TICKET_TEMPLATE.read_text()
    grading = section(template, "## Grading")

    assert template.index("## Handoff") < template.index("## Grading") < template.index("## Engineering checklist")
    for text in ("`Design grade`", "`Eng grade`", "Custom Fields", "it starts collapsed", "before changing anything"):
        assert text in grading, text
    for item in (
        "1. Followed our codebase rules.",
        "2. Reused existing components.",
        "3. Storybook is right.",
        "4. Extended the existing pattern.",
        "5. Backend is wired correctly.",
        "6. No invented copy.",
        "7. What we had to fix before merge.",
    ):
        assert item in grading, item
    assert "Nenad" not in grading


def test_ticket_worker_fills_grading_at_handoff_and_never_rederives_it() -> None:
    worker = TICKET_WORKER.read_text()
    create = section(worker, "## Create mode")
    handoff = section(worker, "## Handoff mode")

    assert "Handoff, and Grading" in create
    assert "Grading is never re-derived: it stays the template's text." in handoff
    assert "template's Grading section copied unchanged" in handoff
    assert "adding the section after Handoff when the ticket has none" in handoff


def test_check_weight_follows_whether_the_session_changed_backend_code() -> None:
    skill = HANDOFF_SKILL.read_text()
    task_list = section(skill, "## 1. Internal checklist")
    checks = section(skill, "## 5. Checks")
    reviews = section(skill, "## 6. Reviews")

    assert "handoff-inventory.mjs --worktree" in task_list
    assert "`backendChanged`" in task_list
    assert "use the backend checks from then on" in task_list
    assert "Lighter: dispatch `vibe-verify-worker` in checks mode" in checks
    assert "Backend: dispatch `vibe-verify-worker` in full-suite mode" in checks
    assert "Lighter: dispatch the repo agent `review-soul`" in reviews
    assert "`vibe-adversarial-reviewer` in implementation mode in parallel" in reviews
    assert "Backend: run the `workflow-code-review` skill" in reviews
    assert "`workflow-code-review` a second time" in reviews


def test_draft_scope_is_retired() -> None:
    for path in (HANDOFF_SKILL, VIBE_SKILL, TICKET_TEMPLATE, TICKET_WORKER, CHANGE_WORKER):
        text = path.read_text()
        for retired in ("draft scope", "full scope", "--scope", "vibe-stub", "stubs.md", "api-requirements"):
            assert retired not in text.lower(), (path.name, retired)
    assert not (PLUGIN_ROOT / "skills" / "vibe" / "references" / "stubs.md").exists()
    assert not (PLUGIN_ROOT / "agents" / "vibe-api-requirements-writer.md").exists()


def test_vibe_sends_pure_mockups_to_prototype() -> None:
    starting_new = section(VIBE_SKILL.read_text(), "## 2. Start or resume")
    build_loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")

    # Daniel ruled that vibe invokes the canonical workflow itself.
    assert "`new-prototype`" in starting_new
    assert "without `--mode`" in starting_new
    assert "absolute `<repo-root>/.claude/skills/prototype/SKILL.md`" in starting_new
    assert "always select" in starting_new
    assert "`vibe-prototype-worker` in iterate mode" in build_loop
    assert "`$prototype`" in build_loop


def test_owned_prototypes_keep_handoff_assignment_and_canonical_transitions() -> None:
    skill = HANDOFF_SKILL.read_text()
    worker = (PLUGIN_ROOT / "agents" / "vibe-prototype-worker.md").read_text()
    assert "Steps 8 and 9 remain unchanged" in skill
    assert "prepare-handoff mode" in skill
    assert "PrototypeStatus.HandedOff remains owned by prototype-approve" in skill
    assert "Do not execute its PR creation" in worker
    assert "Do not reproduce" in worker
    assert "prototype-result --worktree" in worker
    assert "immutable preview URL" in worker


def test_prototype_preflight_mode_survives_setup_worker_repairs() -> None:
    setup_worker = (PLUGIN_ROOT / "agents" / "vibe-setup-worker.md").read_text()
    preflight = (PLUGIN_ROOT / "skills" / "vibe" / "references" / "preflight.md").read_text()
    assert "selected preflight arguments" in VIBE_SKILL.read_text()
    assert "Keep `--prototype` during common/prototype repair" in setup_worker
    assert "replace the `--repo` path but preserve `--prototype`" in preflight
