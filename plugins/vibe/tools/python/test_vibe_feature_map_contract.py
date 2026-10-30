"""Contracts for ISS-13415 screen notes across vibe and fleet handoff."""

from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN = Path(__file__).resolve().parents[2]
GUARDRAILS = PLUGIN / "skills" / "vibe" / "references" / "guardrails.md"
TICKET_TEMPLATE = PLUGIN / "skills" / "vibe" / "references" / "ticket-template.md"
CHANGE_WORKER = PLUGIN / "agents" / "vibe-change-worker.md"
TICKET_WORKER = PLUGIN / "agents" / "vibe-ticket-worker.md"
ENVIRONMENT_WORKER = PLUGIN / "agents" / "vibe-environment-worker.md"
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
VISUAL_TEMPLATE = PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md"


def test_screen_notes_have_one_owner_and_an_explicit_empty_case() -> None:
    """The writer records screen changes without editing a protected map."""
    rule = flat(section(GUARDRAILS.read_text(), "## Feature map lines"))
    for phrase in (
        "target repo's screen map and its writer policy",
        "never edits or regenerates a map reserved for a bot or refresh skill",
        "one `Feature map: <entry id or screen>: <what changed>` line per screen",
        "existing change log as the change is made",
        "Write no line when nothing user visible changed",
    ):
        assert phrase in rule, phrase
    assert "pnpm control" not in rule
    assert "`Feature map:`" in flat(CHANGE_WORKER.read_text())


def test_screen_notes_reach_the_ticket_and_requested_pr_verbatim() -> None:
    """Both existing record writers carry the same screen note text."""
    handoff = flat(section(TICKET_TEMPLATE.read_text(), "## Handoff"))
    assert "- Feature map: <each `Feature map:` line from the writer's change log, verbatim" in handoff
    assert '"None: no screen behavior or reach changed"' in handoff
    ticket = flat(section(TICKET_WORKER.read_text(), "## Handoff mode"))
    assert "Feature map line: copies each `Feature map:` line from the writer's change log verbatim into Handoff" in ticket
    summary = flat(section(ENVIRONMENT_WORKER.read_text(), "## Pull-request mode"))
    assert "Add each `Feature map:` line from the change log as a standalone line in Summary, verbatim" in summary
    assert "Add none when the log has none" in summary


def test_fleet_discovers_screens_and_respects_the_repository_writer() -> None:
    """Fleet uses a target repo specialist and its protected file policy."""
    skill = FLEET.read_text()
    roles = section(skill, "## Roles")
    assert "Running app reproduction and verification" in roles
    assert "run-and-drive skill (for example `control`)" in roles
    assert "displayless Desktop and headless browser modes only" in roles
    research = section(skill, "## Research with closedloop-graph")
    assert "resolve tickets to screen map entries when the repo publishes them" in research
    assert "Shared entries count as overlap across files" in research
    pushback = section(skill, "## Pushback")
    assert "reserved writer policy for generated files" in pushback
    assert "A generator change follows the repo's explicit exception" in pushback
    assert "Where: <screen map entry ids when available, plus URLs or component story ids>" in VISUAL_TEMPLATE.read_text()
