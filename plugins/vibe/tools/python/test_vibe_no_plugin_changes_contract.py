"""Contract checks for the 2026-10-13 operator ruling that a vibe or handoff session never changes plugins.

1. The orchestrators and every worker never install, update, reinstall,
   uninstall or repoint a plugin, change a plugin marketplace, or modify a
   plugin cache, in Codex or Claude Code, and never clone or vendor the
   plugin's own repository to run a different version of its tooling.
2. A needed vibe tooling fix stops the session: the blocker is recorded in the
   session ledger and the live ticket's Progress and reported to engineering,
   never asked of the person.
3. Writer migration stays allowed only after a human or the engineering
   orchestrator installed the new release.
4. The rule lives once, in `guardrails.md`; the skills, the migration section,
   the preflight fixes and the command-running workers point at it.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
GUARDRAILS = VIBE / "references" / "guardrails.md"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"
PREFLIGHT = VIBE / "references" / "preflight.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
COMMAND_WORKERS = tuple(
    PLUGIN_ROOT / "agents" / f"vibe-{name}-worker.md" for name in ("setup", "environment", "change", "verify")
)
SECTION_NAME = '"Plugins and tooling"'
WORKER_POINTER = (
    "Plugins, plugin marketplaces, plugin caches and the plugin's own repository are off limits "
    f"(`../skills/vibe/references/guardrails.md`, {SECTION_NAME}); a needed vibe tooling fix returns `BLOCKED`."
)


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def rule() -> str:
    return section(GUARDRAILS.read_text(), "## Plugins and tooling")


def test_the_rule_binds_both_orchestrators_and_every_worker_in_both_harnesses() -> None:
    text = rule()
    assert "Operator ruling, 2026-10-13" in text
    assert "binds the vibe and handoff orchestrators and every worker, in Codex and Claude Code" in text
    assert "this section is its one canonical statement" in text


def test_plugins_marketplaces_caches_and_the_plugin_repository_are_off_limits() -> None:
    text = rule()
    assert (
        "Never install, update, reinstall, uninstall or repoint a plugin, change a plugin marketplace, "
        "or modify a plugin cache." in text
    )
    assert (
        "Never clone or vendor the plugin's own repository (claude-plugins) to run a different version "
        "of its tooling." in text
    )


def test_a_needed_tooling_fix_stops_and_is_recorded_and_reported_never_asked() -> None:
    text = rule()
    for required in (
        "When continuing needs a fix to the vibe tooling, stop.",
        "the request stays `BLOCKED` in the session ledger with the reason",
        "a line in the live ticket's Progress names it",
        "Report it to engineering",
        "message engineering with the session slug",
        "It is never a question for the person.",
    ):
        assert required in text, required


def test_writer_migration_waits_for_a_human_or_engineering_install() -> None:
    text = rule()
    assert "Writer migration through `writer-state.mjs migrate`" in text
    assert "stays allowed, but only after a human or the engineering orchestrator installed the new release" in text
    migration = section(QUALITY_LOOP.read_text(), "### Recorded definition migration")
    assert "only after a human or the engineering orchestrator installed that release" in migration
    assert f"(`guardrails.md`, {SECTION_NAME})" in migration


def test_both_skills_point_at_the_canonical_rule() -> None:
    vibe_role = section(VIBE_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    assert "You and every worker leave plugins, plugin marketplaces and plugin caches alone" in vibe_role
    assert f"(`references/guardrails.md`, {SECTION_NAME})" in vibe_role
    handoff_role = section(HANDOFF_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    assert "You and every worker leave plugins, plugin marketplaces and plugin caches alone" in handoff_role
    assert f"(`../vibe/references/guardrails.md`, {SECTION_NAME})" in handoff_role


def test_every_command_running_worker_points_at_the_canonical_rule() -> None:
    for worker in COMMAND_WORKERS:
        assert WORKER_POINTER in flat(worker.read_text()), worker.name


def test_the_rule_is_stated_once_and_not_restated_elsewhere() -> None:
    canonical = "Never install, update, reinstall, uninstall or repoint a plugin"
    files = sorted(PLUGIN_ROOT.rglob("*.md"))
    holders = [path.name for path in files if canonical in flat(path.read_text())]
    assert holders == ["guardrails.md"]


def test_preflight_never_installs_a_plugin_itself() -> None:
    text = flat(PREFLIGHT.read_text())
    assert "Run the exact install command printed in `fix`" not in text
    assert "add Browser, and continue" not in text
    assert (
        f"| `<Codex CLI> plugin add closedloop-core@closedloop-ai` | Stop; never run it (`guardrails.md`, {SECTION_NAME})."
        in text
    )
    assert f"stop; a human adds it (`guardrails.md`, {SECTION_NAME})." in text
