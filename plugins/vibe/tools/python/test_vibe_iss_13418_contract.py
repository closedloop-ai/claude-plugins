"""Contracts for ISS-13418 independent lane scheduling and reporting."""

import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
TEMPLATES = PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md"


def test_non_e2e_lanes_start_while_e2e_is_queued() -> None:
    """Independent selected lanes use capacity instead of waiting on e2e."""
    machine = flat(section(FLEET.read_text(), "## Machines and CPU"))
    for phrase in (
        "identify true dependencies",
        "Start independent repository selected integration, unit, typecheck and lint lanes at once",
        "available heavy slots on allowed machines",
        "even while e2e is queued or running elsewhere",
        "repository lane selector and `qa-impact.mjs` decision on which checks are needed",
    ):
        assert phrase in machine, phrase


def test_capacity_moves_keep_machine_limits_binding() -> None:
    """A blocked lane moves only to a machine whose rules admit it."""
    machine = flat(section(FLEET.read_text(), "## Machines and CPU"))
    for phrase in (
        "A lane waiting only for a full slot or load moves to another allowed machine with capacity; report the move",
        "Respect operator exclusions, machine load and slot limits, no dagger restrictions",
        "daily machine's no visible e2e rule",
    ):
        assert phrase in machine, phrase


def test_writers_and_reports_preserve_parallel_work() -> None:
    """Both writer prompts and the operator report expose the parallel plan."""
    templates = TEMPLATES.read_text()
    instruction = "Start independent repository selected validation lanes concurrently through assigned heavy slots"
    for heading in ("## Worker preamble", "## Resume prompt"):
        prompt = flat(section(templates, heading))
        assert instruction in prompt
        assert "including non-e2e lanes while e2e runs elsewhere" in prompt
        assert "move a lane waiting only on load or a full slot to another allowed machine" in prompt
    report = section(templates, "## Remaining work report")
    for field in ("REPORT:", "ETA:", "Parallel now:", "Waiting on a real dependency:", "Moved for capacity:", "Time to ready:"):
        assert field in report
    assert "longest dependent path" in report
    assert "Pre-send audit: in the final draft" in report
    raw_report = templates.split("## Remaining work report\n", 1)[1].split("\n## ", 1)[0]
    for label in ("START_INTEGRATION:", "START_TYPECHECK:", "DEPENDENCIES:", "REPORT:", "ETA:"):
        assert len(re.findall(rf"^{re.escape(label)}", raw_report, re.MULTILINE)) == 1, label
    fleet_text = FLEET.read_text()
    fleet_report = section(fleet_text, "## Principles")
    assert "Before replying with remaining work, fill every field of [Remaining work report]" in fleet_report
    assert "incomplete without literal `REPORT:` and `ETA:` lines" in fleet_report
    assert "single `REPORT:` line; no bullets or continuation lines" in fleet_report
    assert "one line naming every parallel and queued step and its machine" in report
    assert "never send only its start action" in fleet_report
    assert "must each occur exactly once with nonempty content after the colon" in fleet_report
    assert "fill it and audit again before sending" in fleet_report
    assert "each step running in parallel and its machine" in fleet_report
    assert "Report those fields even when a lane has already started" in fleet_report
    assert "every capacity move" in fleet_report
    assert "longest dependent path rather than the serial sum" in fleet_report
    assert fleet_text.count("Before replying with remaining work, fill every field of [Remaining work report]") == 1
    assert next(i for i, line in enumerate(fleet_text.splitlines(), 1) if "Before replying with remaining work, fill every field" in line) < 100
