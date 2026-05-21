"""Shared discovery and parsing helpers for Codex conversion tests.

Both `test_conversion_coverage.py` (structural) and `test_semantic_coverage.py`
(semantic) import from this module so pair discovery, frontmatter parsing, and
TOML loading have a single source of truth.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any, Literal

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]

CMD_PREFIX = "cmd-"


class Plugin(StrEnum):
    BOOTSTRAP = "bootstrap"
    CODE = "code"
    CODE_REVIEW = "code-review"
    JUDGES = "judges"
    PLATFORM = "platform"
    SELF_LEARNING = "self-learning"


PLUGIN_NAMES: frozenset[str] = frozenset(p.value for p in Plugin)


ArtifactKind = Literal["agent", "skill", "command"]


@dataclass(frozen=True)
class ClaudeArtifacts:
    agents: frozenset[str]
    skills: frozenset[str]
    commands: frozenset[str]


@dataclass(frozen=True)
class CodexArtifacts:
    agents: frozenset[str]
    skills: frozenset[str]


@dataclass(frozen=True)
class ArtifactPair:
    plugin: Plugin
    kind: ArtifactKind
    name: str
    claude_path: Path
    codex_path: Path


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
    return claude.skills | frozenset(f"{CMD_PREFIX}{c}" for c in claude.commands)


def codex_skill_universe() -> frozenset[str]:
    """Every Codex skill across all plugins as `plugin:skill-id` strings.

    The `cmd-` prefix is preserved here — callers comparing against a Claude
    `skills:` frontmatter reference must not strip it, since Claude code
    references commands using their original name (no prefix). Use
    `codex_skill_universe_normalized()` if you want both prefixed and
    unprefixed forms in the same set.
    """
    universe: set[str] = set()
    for plugin in Plugin:
        skills_dir = REPO_ROOT / "codex" / plugin.value / ".agents" / "skills"
        if not skills_dir.is_dir():
            continue
        for d in skills_dir.iterdir():
            if d.is_dir():
                universe.add(f"{plugin.value}:{d.name}")
    return frozenset(universe)


def codex_skill_universe_normalized() -> frozenset[str]:
    """Universe of Codex skill IDs with the `cmd-` prefix optionally stripped.

    Claude `skills:` frontmatter references commands by their original name
    (e.g. `code:plan-with-codex`), but the Codex destination directory is
    `cmd-plan-with-codex`. Include both forms so a Claude-side reference can
    resolve to either a native skill or a converted command.
    """
    base = codex_skill_universe()
    extra = frozenset(
        ref.replace(f":{CMD_PREFIX}", ":", 1)
        for ref in base
        if f":{CMD_PREFIX}" in ref
    )
    return base | extra


def parse_yaml_frontmatter(path: Path) -> dict[str, Any]:
    """Return parsed frontmatter plus the body under key `_body`.

    Raises ValueError if the file has no `---` frontmatter delimiters.
    """
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError(f"{path}: no YAML frontmatter")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError(f"{path}: malformed frontmatter")
    data = yaml.safe_load(parts[1]) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path}: frontmatter is not a mapping")
    data["_body"] = parts[2].lstrip("\n")
    return data


def parse_yaml_frontmatter_optional(path: Path) -> dict[str, Any] | None:
    """Like `parse_yaml_frontmatter` but returns None instead of raising on
    files without frontmatter. Use when a Claude-side artifact is allowed to
    be frontmatter-less (e.g. AGENT_FORMAT.md, code-review-guidelines.md —
    doc-shaped files that happen to live in agents/ directories)."""
    try:
        return parse_yaml_frontmatter(path)
    except ValueError:
        return None


def parse_codex_agent(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _claude_agent_path(plugin: Plugin, name: str) -> Path:
    return REPO_ROOT / "plugins" / plugin.value / "agents" / f"{name}.md"


def _codex_agent_path(plugin: Plugin, name: str) -> Path:
    return REPO_ROOT / "codex" / plugin.value / ".codex" / "agents" / f"{name}.toml"


def _claude_skill_path(plugin: Plugin, name: str) -> Path:
    return REPO_ROOT / "plugins" / plugin.value / "skills" / name / "SKILL.md"


def _codex_skill_path(plugin: Plugin, name: str) -> Path:
    return REPO_ROOT / "codex" / plugin.value / ".agents" / "skills" / name / "SKILL.md"


def _claude_command_path(plugin: Plugin, name: str) -> Path:
    return REPO_ROOT / "plugins" / plugin.value / "commands" / f"{name}.md"


def all_pairs(kind: ArtifactKind | None = None) -> list[ArtifactPair]:
    """Discover every Claude→Codex pair that has both source and destination."""
    pairs: list[ArtifactPair] = []
    for plugin in Plugin:
        claude = claude_artifacts(plugin)
        codex = codex_artifacts(plugin)
        if kind in (None, "agent"):
            for name in sorted(claude.agents & codex.agents):
                pairs.append(
                    ArtifactPair(
                        plugin=plugin,
                        kind="agent",
                        name=name,
                        claude_path=_claude_agent_path(plugin, name),
                        codex_path=_codex_agent_path(plugin, name),
                    )
                )
        if kind in (None, "skill"):
            for name in sorted(claude.skills & codex.skills):
                pairs.append(
                    ArtifactPair(
                        plugin=plugin,
                        kind="skill",
                        name=name,
                        claude_path=_claude_skill_path(plugin, name),
                        codex_path=_codex_skill_path(plugin, name),
                    )
                )
        if kind in (None, "command"):
            for name in sorted(claude.commands):
                codex_skill_name = f"{CMD_PREFIX}{name}"
                if codex_skill_name in codex.skills:
                    pairs.append(
                        ArtifactPair(
                            plugin=plugin,
                            kind="command",
                            name=name,
                            claude_path=_claude_command_path(plugin, name),
                            codex_path=_codex_skill_path(plugin, codex_skill_name),
                        )
                    )
    return pairs


def pair_id(pair: ArtifactPair) -> str:
    """Pytest parametrize ID — `plugin/kind/name` for readable failure output."""
    return f"{pair.plugin.value}/{pair.kind}/{pair.name}"


def parse_claude_tools(value: Any) -> list[str]:
    """Claude frontmatter `tools:` is comma-separated string OR YAML list."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(t).strip() for t in value if str(t).strip()]
    if isinstance(value, str):
        return [t.strip() for t in value.split(",") if t.strip()]
    raise TypeError(f"unexpected tools value: {value!r}")
