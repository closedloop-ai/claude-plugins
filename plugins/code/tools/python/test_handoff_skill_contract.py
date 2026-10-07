"""Contract checks for how the handoff skill routes the person's answers (ISS-12135).

A handoff answer that decides what the product does must reach the change worker,
and the checks, reviews, and redeploy must follow, before the ticket is finished.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
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
    step_nine = section(HANDOFF_SKILL.read_text(), "## 9. Check the ticket")

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
