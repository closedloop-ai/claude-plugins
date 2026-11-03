"""Contract checks for writes through another tool's API and new data directions in vibe sessions.

1. A write into another tool's data covers its files and its API or IPC. A supported interface
   lowers the risk but does not remove the need for a traced human decision.
2. A new direction of data flow between surfaces needs a traced decision, defined once in
   cl-execute's planning-and-gates.md "Data direction" readiness item. The requirements worker flags
   one in its brief, the change worker builds only along allowed directions and logs an untraced one
   as an `Engineering decision`, and the guardrails reviewer treats an untraced one in the diff as a
   blocking `engineering decision` finding. None of it reaches the person.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
CL_EXECUTE_GATES = PLUGIN_ROOT / "skills" / "cl-execute" / "references" / "planning-and-gates.md"
DATA_DIRECTION = "(`../skills/cl-execute/references/planning-and-gates.md`, Readiness Gate, \"Data direction\")"
THROUGH_API = "a write into another tool's data through its files, API or IPC"


def test_the_data_direction_item_is_defined_once_in_cl_execute() -> None:
    gates = section(CL_EXECUTE_GATES.read_text(), "## Readiness Gate")
    item = paragraph(CL_EXECUTE_GATES.read_text(), "- Data direction:")
    assert item in gates
    assert gates.count("- Data direction:") == 1
    for required in (
        "A write into another tool's data covers its files and its API or IPC",
        "a supported interface lowers the risk but does not remove the need for a traced human decision.",
        "cite the human decision or approved document that allows it",
        "per Decision provenance.",
        "An earlier document that restricts the direction is a conflict.",
        "the direction is a numbered human decision, not an implementation detail.",
    ):
        assert required in item, required


def test_the_guardrails_reviewer_counts_api_writes_and_new_directions() -> None:
    item = paragraph(agent("vibe-guardrails-reviewer"), "12. Mechanisms:")
    for required in (
        "each write into another tool's data (its files, or its API or IPC, such as a method that changes that tool's stored state)",
        "A supported interface lowers the risk but does not remove the need for a traced human decision.",
        f"A new direction of data flow between surfaces in the diff {DATA_DIRECTION} with no traced decision allowing it is a blocking `engineering decision` finding.",
    ):
        assert required in item, required
    assert "write into files another tool owns" not in flat(agent("vibe-guardrails-reviewer"))


def test_the_writer_builds_only_along_allowed_directions() -> None:
    plan = section(agent("vibe-change-worker"), "## Plan before code")
    rule = paragraph(agent("vibe-change-worker"), "Build the outcome only along data directions that are already allowed.")
    assert rule in plan
    for required in (
        f"A new direction of data flow between surfaces {DATA_DIRECTION} that traces to no human decision is not built",
        "`Engineering decision: <question>; built: <what you built along allowed directions>; evidence: <files, records or finding>`",
        "It is never `NEEDS_PERSON`.",
    ):
        assert required in rule, required
    assert THROUGH_API in paragraph(agent("vibe-change-worker"), "Only the outcome a ticket or PRD asks for binds the session.")


def test_requirements_flag_a_new_data_direction_in_the_brief() -> None:
    step = paragraph(agent("vibe-requirements-worker"), "1. Ticket:")
    for required in (
        THROUGH_API,
        f"Flag a new direction of data flow between surfaces the request needs {DATA_DIRECTION} `data direction (new)`",
        "with the decision that allows it and its source, or `untraced`; it is never a question for the person.",
    ):
        assert required in step, required
    assert "each new data direction flagged `data direction (new)`" in section(agent("vibe-requirements-worker"), "## Return")
