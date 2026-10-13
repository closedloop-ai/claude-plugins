"""Contract checks for Daniel Ochoa's 2026-10-13 decisions from the 2026-10-09 Andy meeting.

1. New Storybook components are built first and the person is pointed to their
   stories without waiting; reuse-only changes skip the notice.
2. A named reference product is researched into a bulleted behavior list that
   the person sees while the build keeps going.
3. Handoff drafts edits to existing product docs pages only (never the
   internal docs/ folder), marked for design or engineering approval, under a
   scoped exception to the copy rule.
4. Handoff marks the rows the person accepted as frozen in the attached session
   decision table, and cl-execute keeps them passing with tests.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml


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


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def agent(name: str) -> str:
    return (AGENTS / f"{name}.md").read_text()


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


def test_feature_docs_edit_only_existing_pages_as_marked_drafts_at_handoff() -> None:
    docs = section(GUARDRAILS.read_text(), "## Feature docs at handoff")
    for required in ("only existing product docs pages", "`apps/web/content/docs/`",
                     "Never edit the repo's internal engineering `docs/` folder",
                     "Never create a page", "`meta.json`", "`apps/web/content/docs/api-reference/`",
                     "create nothing", "behavior this session changed",
                     "agent draft for design or engineering to approve before merge",
                     "{/* Agent draft (<live ticket slug>): approve before merge */}",
                     "{/* End agent draft */}", "Owned prototype sessions skip this"):
        assert required in docs, required
    assert "`<!-- -->`" not in docs
    step = section(HANDOFF_SKILL.read_text(), "### Existing feature docs")
    for required in ("SAME writer", "already exist", "never creates one", "agent draft",
                     "approves before merge", "Feature docs line"):
        assert required in step, required
    handoff = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    assert "- Feature docs:" in handoff
    assert "no page is created" in handoff
    assert "the writer's feature docs record" in flat(HANDOFF_SKILL.read_text())
    assert "Feature docs line lists the edited pages" in section(agent("vibe-ticket-worker"), "## Handoff mode")


def test_the_docs_exception_is_scoped_wherever_the_copy_rule_is_referenced() -> None:
    copy = section(GUARDRAILS.read_text(), "## Copy")
    for required in ("One explicit, scoped exception", "Daniel Ochoa", "2026-10-13",
                     "existing product docs pages", "approves before merge",
                     "not a general license", "no product UI copy", "no new page"):
        assert required in copy, required
    assert "scoped exception" in section(HANDOFF_SKILL.read_text(), "### Existing feature docs")
    assert "gives no license for product copy" in section(HANDOFF_SKILL.read_text(), "### Existing feature docs")
    assert "never covers product copy" in flat(agent("vibe-change-worker"))
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    assert "feature docs drafts are the one scoped exception" in reviewer
    assert ("A new docs page, a navigation change, an unmarked docs edit, a docs edit before handoff, "
            "or any edit under the internal engineering `docs/` folder is blocking") in reviewer
    grading = section(TICKET_TEMPLATE.read_text(), "## Grading")
    assert "The only exception is the marked agent drafts in existing product docs pages" in grading


def test_the_inventory_admits_existing_docs_edits_only_in_the_handoff_phase() -> None:
    inventory = INVENTORY.read_text()
    assert 'file.status === "M"' in inventory
    assert '"apps/web/content/docs/api-reference/"' in inventory
    assert 'const handoffPhase = values.phase !== "build";' in inventory
    assert "handoffPhase && !prototype && isExistingDocsEdit(file)" in inventory


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
