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
    for rerun in ("step 3", "step 4", "step 5", "step 6", "step 7", "step 8"):
        assert rerun in answers, rerun
    assert "Only then does the answer go to `vibe-ticket-worker`." in answers
    assert "A wording answer goes straight to `vibe-ticket-worker`." in answers
    assert "`built`" in answers
    assert "`already met`" in answers


def test_step_nine_routes_answers_and_blocks_finalizing_until_reruns_finish() -> None:
    step_nine = section(HANDOFF_SKILL.read_text(), "## 9. Choose who picks it up, then check the ticket")

    assert "`NEEDS_PERSON`" in step_nine
    assert "`NEEDS_CHANGE`" in step_nine
    assert "route their answer as \"Answers from the person\" says" in step_nine
    assert "Environment base commit from the current inventory" in step_nine
    assert "Never go on to step 10 while a behavior answer" in step_nine


def test_summary_corrections_that_change_behavior_are_routed_too() -> None:
    step_two = section(HANDOFF_SKILL.read_text(), "## 2. Summarize and confirm")

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
    fix_mode = section(CHANGE_WORKER.read_text(), "## Fix mode (handoff)")

    assert "the person's answer to it" in fix_mode
    assert "`already met`" in fix_mode
    assert "`built`" in fix_mode
    assert "Scope and acceptance criteria in their words" in fix_mode


def test_step_nine_asks_for_the_next_owner_and_never_defaults() -> None:
    step_nine = section(HANDOFF_SKILL.read_text(), "## 9. Choose who picks it up, then check the ticket")

    assert "Who should pick this up next? A name or email is fine." in step_nine
    assert "`vibe-ticket-worker` in lookup mode" in step_nine
    assert "`Assigning this to <full name>.`" in step_nine
    assert "`<full name> (<email>)`" in step_nine
    assert "ask the question again" in step_nine
    assert "never fall back to anyone by default" in step_nine
    assert "the next owner (full name and email)" in step_nine


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
