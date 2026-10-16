"""Contract checks for named mechanisms and decision provenance in vibe sessions.

1. Only the outcome a ticket or PRD asks for binds the session. A mechanism it
   names is a proposal held to the same test as the writer's own; a dominated
   one is swapped for the better option and logged as an `Engineering
   decision` item, never routed to the person.
2. At handoff the guardrails reviewer checks each new mechanism: the existing
   mechanism it could reuse, what its cost scales with at 10x and 100x, and
   its per-device idle cost.
3. A finding that needs a human decision is never the writer's to resolve,
   downgrade or absorb; it goes on the live ticket's Engineering checklist.
4. A recorded decision is settled only when it traces to a human statement.
5. Frozen rows describe user-visible behavior, never mechanism.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
VIBE_SKILL = VIBE / "SKILL.md"
QUALITY = REFERENCES / "quality-loop.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
GRAPH = REFERENCES / "closedloop-graph.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
CL_EXECUTE_GATES = PLUGIN_ROOT / "skills" / "cl-execute" / "references" / "planning-and-gates.md"
LOG_SHAPE = "`Engineering decision: <question>; built: <what the session built>; evidence: <files, records or finding>`"
CHECKLIST_SHAPE = "`- [ ] Engineering decision: <question>; built: <what the session built>; evidence: <files, records or finding>`"
PROVENANCE = "(`quality-loop.md`, \"Communication and product questions\")"


def test_the_guardrails_reviewer_checks_each_new_mechanism() -> None:
    item = paragraph(agent("vibe-guardrails-reviewer"), "12. Mechanisms:")
    for required in (
        "each new poller, interval, background lane, socket, cross-process channel, route, table or cursor in the diff",
        "each write into files another tool owns",
        "name the existing mechanism that does or could do the job",
        "and why it was not used",
        "(installs or idle clients, connected clients, active sessions, events) at 10x and 100x",
        "its per-device idle cost (timer wakeups, network and disk while nothing is active, on battery)",
        "Never argue from current fleet size.",
        "Cost that scales with idle clients when an activity-scaled design meets the outcome is blocking",
        "a write into another tool's data with no cited human decision",
        "A decision recorded in a ticket or plan counts only when it traces to a human statement (who, where, which question;",
        "a Decisions section alone is a record, not a ruling, and an untraced one is an `engineering decision` finding.",
        "A mechanism the ticket named is held to the same test",
        "When the session's local plan has a Cost Scaling table, check it against the diff",
    ):
        assert required in item, required
    output = section(agent("vibe-guardrails-reviewer"), "## Output")
    assert "Mark a finding that needs a human decision" in output
    assert "never for the person" in output


def test_the_writer_treats_a_named_mechanism_as_a_proposal() -> None:
    plan = section(agent("vibe-change-worker"), "## Plan before code")
    rule = paragraph(agent("vibe-change-worker"), "Only the outcome a ticket or PRD asks for binds the session.")
    assert rule in plan
    for required in (
        "is a proposal held to the same test as one you invent.",
        "its cost scales with installs or idle time while an alternative scales with activity",
        "a supported interface exists for a write into another tool's data",
        "build the better option that meets the outcome",
        "`Engineering decision: <question>; built: <what you built instead>; evidence: <files, records or finding>`",
        "It is never `NEEDS_PERSON`.",
        "neither instruction inflation nor manufactured ambiguity",
        "an unexamined mechanism is not one.",
    ):
        assert required in rule, required


def test_periodic_or_cross_surface_plans_carry_a_cost_scaling_table() -> None:
    plan = section(agent("vibe-change-worker"), "## Plan before code")
    assert "When the plan adds periodic or cross-surface work" in plan
    assert "`../skills/cl-execute/references/planning-and-gates.md`, \"Cost Scaling\"" in plan
    assert "## Cost Scaling" in CL_EXECUTE_GATES.read_text()


def test_requirements_tag_named_mechanisms_as_proposals() -> None:
    step = paragraph(agent("vibe-requirements-worker"), "1. Ticket:")
    for required in (
        "`mechanism (proposal)`, never an acceptance criterion",
        "the session checks the outcome and not the named mechanism",
        f"A recorded decision is settled only when it traces to a human statement {PROVENANCE}",
    ):
        assert required in step, required
    assert "each named mechanism tagged `mechanism (proposal)`" in section(agent("vibe-requirements-worker"), "## Return")


def test_decision_findings_go_to_the_engineering_checklist_never_the_person() -> None:
    review = section(HANDOFF_SKILL.read_text(), "## 6. Independent integrated review")
    for required in (
        "that a mechanism, a one-way door, or an unratified or conflicting decision needs a human decision",
        "is never the writer's to resolve, downgrade or absorb, including after verification.",
        f"logs it in the change log as {LOG_SHAPE}",
        "never to the person.",
    ):
        assert required in review, required
    assert "follows step 6's rule for decisions" in section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    loop = paragraph(QUALITY.read_text(), "A reviewer proposal is not a product ruling")
    assert "is never the writer's to resolve, downgrade or absorb" in loop
    assert "never a question for the person" in loop


def test_the_template_and_ticket_worker_place_each_decision_once() -> None:
    template = TICKET_TEMPLATE.read_text()
    rule = paragraph(template, "- Engineering decisions:")
    assert f"goes once at the end of the Engineering checklist as {CHECKLIST_SHAPE}" in rule
    assert "never routed to the person running the session." in rule
    assert "Engineering decision" not in section(template, "## Handoff")
    ticket = flat(agent("vibe-ticket-worker"))
    assert (
        "Place each `Engineering decision` entry in the change log once, as an unchecked item at the end of the "
        "Engineering checklist in its logged shape (`../skills/vibe/references/ticket-template.md`, \"Engineering decisions\")."
    ) in ticket


def test_the_graph_has_a_route_for_existing_channels() -> None:
    graph = GRAPH.read_text()
    row = next(line for line in graph.splitlines() if line.startswith("| Which channels already connect two surfaces"))
    for required in ("`code_grep`", "joined in one regex alternation", "`rg`"):
        assert required in row, required
    change_row = next(line for line in graph.splitlines() if line.startswith("| `vibe-change-worker`"))
    assert "the existing-channels `code_grep`" in change_row


def test_settled_means_traced_to_a_human_statement() -> None:
    communication = section(QUALITY.read_text(), "## Communication and product questions")
    for required in (
        "Apply settled decisions; never ask them again.",
        "A ticket's or plan's Decisions section is a record, not a ruling.",
        "A decision is settled only when it traces to a human statement: who made it, where, and which question it answered.",
        "a technical one becomes an `Engineering decision` item",
        "Never resolve a conflict by recency or by assuming one author meant to change an earlier record.",
    ):
        assert required in communication, required
    assert "Never re-ask a settled decision; a decision is settled only when it traces to a human statement (`references/quality-loop.md`, \"Communication and product questions\")." in flat(VIBE_SKILL.read_text())
    assert f"Apply a settled ruling, never ask it again; settled means traced to a human statement {PROVENANCE}." in flat(agent("vibe-change-worker"))
    assert f"re-ask settled scope {PROVENANCE}" in flat(agent("vibe-requirements-worker"))


def test_frozen_rows_never_freeze_a_mechanism() -> None:
    frozen = section(QUALITY.read_text(), "### Frozen behavior at handoff")
    assert "Frozen rows describe user-visible behavior, never mechanism: no intervals, transports or storage choices." in frozen
