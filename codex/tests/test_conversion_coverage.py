"""Structural coverage tests for the Claude -> Codex plugin conversion.

For every plugin, every Claude-side agent, skill, and command must have a
corresponding Codex-side artifact. Naming conventions:

    plugins/<plugin>/agents/<name>.md       -> codex/plugins/<plugin>/.codex/agents/<name>.toml
    plugins/<plugin>/skills/<name>/         -> codex/plugins/<plugin>/.agents/skills/<name>/
    plugins/<plugin>/commands/<name>.md     -> codex/plugins/<plugin>/.agents/skills/cmd-<name>/

No exemptions: any missing destination fails the test.
Reverse coverage (orphan Codex artifacts) is intentionally out of scope.

Discovery helpers and the Plugin enum live in `helpers.py` so the semantic
coverage suite shares them.
"""

from __future__ import annotations

import pytest

from helpers import (
    Plugin,
    claude_artifacts,
    codex_artifacts,
    expected_codex_skill_names,
)


@pytest.mark.parametrize("plugin", list(Plugin), ids=lambda p: p.value)
def test_every_claude_agent_has_codex_counterpart(plugin: Plugin) -> None:
    claude = claude_artifacts(plugin)
    codex = codex_artifacts(plugin)
    missing = claude.agents - codex.agents
    assert not missing, (
        f"{plugin.value}: {len(missing)} Claude agent(s) missing from "
        f"codex/plugins/{plugin.value}/.codex/agents/: {sorted(missing)}"
    )


@pytest.mark.parametrize("plugin", list(Plugin), ids=lambda p: p.value)
def test_every_claude_skill_and_command_has_codex_counterpart(plugin: Plugin) -> None:
    claude = claude_artifacts(plugin)
    codex = codex_artifacts(plugin)
    expected = expected_codex_skill_names(claude)
    missing = expected - codex.skills
    assert not missing, (
        f"{plugin.value}: {len(missing)} Claude skill(s)/command(s) missing from "
        f"codex/plugins/{plugin.value}/.agents/skills/: {sorted(missing)}"
    )
