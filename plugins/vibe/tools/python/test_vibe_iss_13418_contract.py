"""Contracts for ISS-13418 independent lane scheduling and reporting."""

import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
TEMPLATES = PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md"
QUALITY = PLUGIN / "skills" / "vibe" / "references" / "quality-loop.md"
GUARDRAILS = PLUGIN / "skills" / "vibe" / "references" / "guardrails.md"
PARALLEL_PROMPT = PLUGIN / "evals" / "orch-parallel-e2e-queued" / "prompt.md"


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


def test_operator_reporting_requires_visible_critical_path_eta() -> None:
    """The owning reporting section and eval prompt both reach the ETA contract."""
    reporting = flat(section(FLEET.read_text(), "## Reporting to the operator"))
    template = TEMPLATES.read_text().split("## Remaining work report\n", 1)[1].split("\n## ", 1)[0]
    prompt = PARALLEL_PROMPT.read_text()
    assert "Time to ready" in reporting
    assert "longest dependent path" in reporting
    assert "dependency graph" in reporting
    assert "incomplete" in reporting
    assert re.search(r"^ETA: <duration>; Time to ready: <same duration>; longest dependent path: <named steps", template, re.MULTILINE)
    assert "not a sum of independent lanes" in template
    assert '"Reporting to the operator" section' in prompt
    assert '"Remaining work report" template' in prompt


def test_disjoint_helpers_keep_exclusive_branches_and_return_defects() -> None:
    """Fleet helpers may build separate proof files or a whole new module without replacing the ticket writer."""
    roles = flat(section(FLEET.read_text(), "## Roles"))
    for phrase in (
        "Every ticket writer is a vibe session",
        "One writer per branch at a time",
        "exact files do not overlap each other or the ticket writer's concurrent files",
        "use the existing `fleet-home.mjs shape fleet` transition",
        "own branch, worktree and exclusive file allowlist",
        "proof tests of separate criteria or a whole new disjoint module or file set",
        "never the ticket branch",
        "never repairs defects in ticket-writer code and never integrates",
        "that writer alone reviews and integrates returned commits or proof",
        "Independent reviewers remain read-only",
    ):
        assert phrase in roles, phrase
    brief = flat(section(TEMPLATES.read_text(), "## Disjoint helper branch brief"))
    for phrase in ("Ticket writer:", "Helper branch and worktree:", "Exclusive file allowlist:",
                   "proof tests for separate criteria, or a whole new disjoint module or file set",
                   "helper does not integrate", "helper does not repair it", "independent read-only reviewer"):
        assert phrase in brief, phrase
    assert "BRANCH_ISOLATION: one writer per branch; helpers never edit or touch the ticket branch" in brief
    principles = flat(section(FLEET.read_text(), "## Principles"))
    assert "Before sending a helper split plan" in principles
    assert "mandatory `BRANCH_ISOLATION:` line" in principles
    assert "incomplete and must not be sent until that line is present and nonempty" in principles
    quality = flat(section(QUALITY.read_text(), "## One persistent writer and a serial queue"))
    assert "outside this session only on a separate branch and worktree" in quality
    assert "This session keeps its one persistent writer and serial queue" in quality
    assert "that writer alone reviews and integrates a helper's returned commit or proof" in quality
    guardrails = flat(section(GUARDRAILS.read_text(), "## What may change"))
    assert "A fleet helper branch is outside this one-writer vibe session" in guardrails
    assert "whole new module or file set" in guardrails
    assert "under existing test-authoring authority or an explicit user test request" in guardrails
