"""Contract checks for the 2026-10-13 operator decisions from the 2026-10-09 stakeholder meeting.

1. New Storybook components are built first and the person is pointed to their
   stories without waiting; reuse-only changes skip the notice.
2. A named reference product is researched into a bulleted behavior list that
   the person sees while the build keeps going.
3. Retired by the 2026-10-16 operator ruling: handoff no longer drafts
   product docs edits; test_vibe_review_lessons_contract.py pins the rule that
   replaced it.
4. Handoff marks the rows the person accepted as frozen in the attached session
   decision table, and cl-execute keeps them passing with tests.
"""

from __future__ import annotations

from pathlib import Path

import yaml

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
VIBE_SKILL = VIBE / "SKILL.md"
QUALITY = REFERENCES / "quality-loop.md"
GUARDRAILS = REFERENCES / "guardrails.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
CL_EXECUTE = PLUGIN_ROOT / "skills" / "cl-execute" / "SKILL.md"
CL_EXECUTE_GATES = PLUGIN_ROOT / "skills" / "cl-execute" / "references" / "planning-and-gates.md"
WORKER_CONTRACTS = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src" / "contracts.ts"
NOTICES = '### Notices that never wait'


def tools(name: str) -> set[str]:
    frontmatter = yaml.safe_load(agent(name).split("---", 2)[1])
    return {tool.strip() for tool in frontmatter["tools"].split(",")}


def test_both_notices_are_sent_without_waiting_and_are_never_approval_gates() -> None:
    notices = section(VIBE_SKILL.read_text(), NOTICES)
    assert "notifications, not approval gates" in notices
    assert "keep going without waiting for a reply" in notices
    assert "never asked to approve them" in notices
    assert "continues the active request in the SAME writer" in notices
    communication = section(QUALITY.read_text(), "## Communication and product questions")
    assert "never approval gates" in communication
    assert "primitive Storybook approval" not in communication


def test_new_storybook_components_are_built_first_and_linked_while_the_build_continues() -> None:
    notices = section(VIBE_SKILL.read_text(), NOTICES)
    assert "NEW Storybook components" in notices
    assert "before the feature and returns `STORIES_READY`" in notices
    assert "<storybookUrl>/?path=/story/<id>" in notices
    assert "resume the SAME writer to build the feature" in notices
    assert "only reuses existing components skips this step" in notices
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert loop.index("returns `STORIES_READY`") < loop.index("resume it at once to build the feature")
    assert "`STORIES_READY`" in section(VIBE_SKILL.read_text(), "## Workers")
    writer = flat(agent("vibe-change-worker"))
    assert "every NEW Storybook component the request needs (or none)" in writer
    assert "build those components and their stories first" in writer
    assert "only reuses existing components never returns `STORIES_READY`" in writer
    assert "`STORIES_READY` names the new Storybook components' story IDs and continues the same request" in writer
    primitives = section(GUARDRAILS.read_text(), "## Missing primitives")
    assert "ask the person to approve" not in primitives
    assert "Only after approval" not in primitives
    assert "does not wait" in primitives
    primitive = flat(agent("vibe-primitive-worker"))
    assert "never an approval gate" in primitive
    assert "what the person is approving" not in primitive
    assert "Storybook product approval" not in primitive + writer


def test_the_claude_launcher_accepts_the_new_components_status() -> None:
    contracts = WORKER_CONTRACTS.read_text()
    statuses = contracts[contracts.index("export const statusSchema") :].split(";", 1)[0]
    assert '"STORIES_READY"' in statuses
    bundle = (VIBE / "scripts" / "dist" / "claude-worker.mjs").read_text()
    assert "Use status PLAN, STORIES_READY," in bundle


def test_a_reference_product_is_researched_into_a_behavior_list_the_build_keeps_using() -> None:
    notices = section(VIBE_SKILL.read_text(), NOTICES)
    assert "names an outside product as the reference" in notices
    assert "`vibe-requirements-worker` in reference mode" in notices
    assert "bulleted list of behaviors" in notices
    assert "forward the request with that list to the SAME writer" in notices
    assert "names behaviors, not wording" in notices
    assert "reference mode" in section(VIBE_SKILL.read_text(), "## Workers")
    research = section(agent("vibe-requirements-worker"), "## Reference mode")
    for required in ("public documentation", "Never sign in", "bulleted list of the behaviors",
                     "source link", "without waiting", "never a question",
                     "never propose the product's labels as our copy"):
        assert required in research, required
    assert {"WebSearch", "WebFetch"} <= tools("vibe-requirements-worker")
    assert not {"Write", "Edit"} & tools("vibe-requirements-worker")
    assert "list of behaviors to build" in flat(agent("vibe-change-worker"))


def test_handoff_freezes_the_accepted_rows_in_the_attached_session_table() -> None:
    frozen = section(QUALITY.read_text(), "### Frozen behavior at handoff")
    for required in ("`## Frozen Behavior`", "stable row ID of every row the person accepted",
                     "request provenance", "Superseded rows", "remaining Open Question",
                     "rewrites this one section", "stays local to the session worktree",
                     "attachment on the live ticket is what travels", "`cl-execute`",
                     "tests in its pull request", "explicit OK of the person who ran the session"):
        assert required in frozen, required
    step = section(HANDOFF_SKILL.read_text(), "## 8. Choose who picks it up, then check the ticket")
    assert step.index("`## Frozen Behavior` section") < step.index("Then dispatch `vibe-ticket-worker` in handoff mode")
    assert "Frozen Behavior row IDs" in step
    ticket = section(agent("vibe-ticket-worker"), "## Handoff mode")
    assert "must carry its `## Frozen Behavior` section before you attach it" in ticket
    assert "return `NEEDS_CHANGE`" in ticket
    assert "names the attachment and its Frozen Behavior row IDs" in ticket
    handoff = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    assert "Frozen Behavior row IDs" in handoff
    assert "changes only with that person's explicit OK" in handoff
    assert "`## Frozen Behavior` section with the row IDs the person accepted" in flat(agent("vibe-change-worker"))


def test_cl_execute_reads_the_attachment_and_keeps_frozen_rows_passing() -> None:
    gates = section(CL_EXECUTE_GATES.read_text(), "## Vibe Frozen Behavior")
    for required in ("`Built in a vibe session by`", "download the session decision table",
                     "`HUMAN_REVIEW_REQUIRED`", "Record every frozen row ID in the plan",
                     "Keep every frozen row passing", "includes a test for each frozen row",
                     "engineering writes these tests in this PR",
                     "Never change a frozen row's behavior without that person's explicit OK",
                     "`PRODUCT_BLOCKED`", "recorded OK",
                     "frozen row's test and every Missing tests entry passes at the PR head"):
        assert required in gates, required
    skill = flat(CL_EXECUTE.read_text())
    assert "references/planning-and-gates.md#vibe-frozen-behavior" in skill
    assert "keep every frozen row passing with tests in the PR" in skill


def test_new_text_uses_no_emdashes_or_double_hyphen_dashes() -> None:
    for path in (VIBE_SKILL, QUALITY, GUARDRAILS, TICKET_TEMPLATE, HANDOFF_SKILL, CL_EXECUTE_GATES,
                 AGENTS / "vibe-requirements-worker.md", AGENTS / "vibe-change-worker.md",
                 AGENTS / "vibe-ticket-worker.md", AGENTS / "vibe-primitive-worker.md",
                 AGENTS / "vibe-guardrails-reviewer.md"):
        text = path.read_text()
        assert "—" not in text, path.name
        assert " -- " not in text, path.name
