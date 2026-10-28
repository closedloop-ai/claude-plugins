"""Contract checks for ISS-13291: the five plugin bugs that stranded a PM's vibe session, and its two session-side breaches.

Operator rulings (2026-10-28): fix them in one change, deadlock first; on a machine without the
staging e2e identities, vibe skips local web e2e, records it as not run and relies on the containerized
or CI run instead of stopping.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
FLEET = PLUGIN_ROOT / "skills" / "fleet-orchestrator"
HANDOFF_SCRIPTS = PLUGIN_ROOT / "skills" / "handoff" / "scripts"
AGENTS = PLUGIN_ROOT / "agents"


def guardrail_tooling() -> str:
    return section((REFERENCES / "guardrails.md").read_text(), "## Plugins and tooling")


def test_the_tooling_stop_is_on_the_ticket_before_the_person_hears_of_it() -> None:
    text = guardrail_tooling()
    assert "Dispatch the ticket worker for that line before you reply to the person" in text


def test_the_tooling_stop_line_is_plain_and_quotes_no_rule_or_plugin_file() -> None:
    text = guardrail_tooling()
    assert '"This needs an engineer to fix vibe. Message engineering with: <summary>."' in text
    assert "never quotes a rule or a script's refusal and never names or links a plugin file" in text


def test_update_names_and_migrates_the_sessions_it_strands() -> None:
    text = flat((VIBE / "SKILL.md").read_text())
    assert "Its `sessions` names each vibe session whose writer was bound to the release it replaced" in text
    assert "`on-resume` is migrated when that session resumes" in text
    script = (VIBE / "scripts" / "plugin-version.mjs").read_text()
    assert "export function writersBoundBefore(" in script
    assert "export function migrateStrandedWriters(" in script


def test_migrate_documents_its_capability_set_and_keeps_the_recorded_one() -> None:
    text = section((REFERENCES / "quality-loop.md").read_text(), "### Recorded definition migration")
    assert "Leave `capabilities` out to keep the recorded binding's capabilities." in text
    assert "at most 48" in text
    assert "`writer-state.mjs help` lists the bindable operations" in text


def test_ignored_local_agent_and_editor_config_never_blocks_main_sync() -> None:
    text = flat((REFERENCES / "environment.md").read_text())
    assert "Ignored files under a `.codex/`, `.claude/`, `.agents/`, `.vscode/` or `.idea/` folder" in text
    assert "never block main sync" in text


def test_frozen_renders_use_the_shipped_driver_and_base_failures_do_not_block() -> None:
    assert (HANDOFF_SCRIPTS / "frozen-render.mjs").is_file()
    decomposer = flat((AGENTS / "vibe-storybook-decomposer.md").read_text())
    assert "../skills/handoff/scripts/frozen-render.mjs" in decomposer
    assert "never a capture of your own" in decomposer
    assert "`story-play-verdict.mjs`" in decomposer
    assert "Each `knownMainFailures` entry fails the same way on the base: it is not a finding" in decomposer
    template = flat((REFERENCES / "ticket-template.md").read_text())
    assert "`- [ ] Known main failure: frozen story <story ID>; fails the same way on base <base>; evidence: <its reason>`" in template


def test_local_web_e2e_is_not_run_without_the_staging_e2e_identities() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    assert "On a machine without the staging e2e identities the local web e2e lane is never run" in skill
    assert "recorded not run and the containerized or CI run covers it" in skill
    worker = flat((AGENTS / "vibe-environment-worker.md").read_text())
    assert "records the local web e2e lane not run (`NOT-RUN-LANE`)" in worker


def test_fleet_setup_asks_a_vibe_operator_or_a_single_writer_nothing() -> None:
    setup = section((FLEET / "references" / "setup.md").read_text(), "## First-run interview")
    assert "Ask nothing when the operator runs vibe" in setup
    assert "or the program is `one-writer` or `no-writer`" in setup
    assert "Write every default below and report them in one plain line" in setup
    assert "never about writers, models, effort, budget or the move threshold" in setup
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "When the operator runs vibe, or the program is `one-writer` or `no-writer`, ask nothing" in skill
