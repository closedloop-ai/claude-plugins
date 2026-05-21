"""Structural coverage tests for the Claude -> Codex plugin conversion.

For every plugin, every Claude-side agent, skill, and command must have a
corresponding Codex-side artifact. Naming conventions:

    plugins/<plugin>/agents/<name>.md       -> codex/<plugin>/.codex/agents/<name>.toml
    plugins/<plugin>/skills/<name>/         -> codex/<plugin>/.agents/skills/<name>/
    plugins/<plugin>/commands/<name>.md     -> codex/<plugin>/.agents/skills/cmd-<name>/

No exemptions: any missing destination fails the test.
Reverse coverage (orphan Codex artifacts) is intentionally out of scope.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


class Plugin(StrEnum):
    BOOTSTRAP = "bootstrap"
    CODE = "code"
    CODE_REVIEW = "code-review"
    JUDGES = "judges"
    PLATFORM = "platform"
    SELF_LEARNING = "self-learning"


@dataclass(frozen=True)
class ClaudeArtifacts:
    agents: frozenset[str]
    skills: frozenset[str]
    commands: frozenset[str]


@dataclass(frozen=True)
class CodexArtifacts:
    agents: frozenset[str]
    skills: frozenset[str]


def _stems(directory: Path, suffix: str) -> frozenset[str]:
    if not directory.is_dir():
        return frozenset()
    return frozenset(p.stem for p in directory.glob(f"*{suffix}"))


def _subdir_names(directory: Path) -> frozenset[str]:
    if not directory.is_dir():
        return frozenset()
    return frozenset(p.name for p in directory.iterdir() if p.is_dir())


def claude_artifacts(plugin: Plugin) -> ClaudeArtifacts:
    root = REPO_ROOT / "plugins" / plugin.value
    return ClaudeArtifacts(
        agents=_stems(root / "agents", ".md"),
        skills=_subdir_names(root / "skills"),
        commands=_stems(root / "commands", ".md"),
    )


def codex_artifacts(plugin: Plugin) -> CodexArtifacts:
    root = REPO_ROOT / "codex" / plugin.value
    return CodexArtifacts(
        agents=_stems(root / ".codex" / "agents", ".toml"),
        skills=_subdir_names(root / ".agents" / "skills"),
    )


def expected_codex_skill_names(claude: ClaudeArtifacts) -> frozenset[str]:
    """Skills + commands both land in Codex's skills/ tree.

    Commands are prefixed with `cmd-` to disambiguate from native skills.
    """
    return claude.skills | frozenset(f"cmd-{c}" for c in claude.commands)


@pytest.mark.parametrize("plugin", list(Plugin), ids=lambda p: p.value)
def test_every_claude_agent_has_codex_counterpart(plugin: Plugin) -> None:
    claude = claude_artifacts(plugin)
    codex = codex_artifacts(plugin)
    missing = claude.agents - codex.agents
    assert not missing, (
        f"{plugin.value}: {len(missing)} Claude agent(s) missing from "
        f"codex/{plugin.value}/.codex/agents/: {sorted(missing)}"
    )


@pytest.mark.parametrize("plugin", list(Plugin), ids=lambda p: p.value)
def test_every_claude_skill_and_command_has_codex_counterpart(plugin: Plugin) -> None:
    claude = claude_artifacts(plugin)
    codex = codex_artifacts(plugin)
    expected = expected_codex_skill_names(claude)
    missing = expected - codex.skills
    assert not missing, (
        f"{plugin.value}: {len(missing)} Claude skill(s)/command(s) missing from "
        f"codex/{plugin.value}/.agents/skills/: {sorted(missing)}"
    )
