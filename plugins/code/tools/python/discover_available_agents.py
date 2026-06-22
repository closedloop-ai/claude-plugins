#!/usr/bin/env python3
"""Discover repo-level and plugin-provided agents available to the orchestrator."""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

# Cache layout is <cache>/<owner>/<plugin>/<version>/.claude-plugin/plugin.json.
# Only directories whose name starts with a digit are treated as version dirs.
_VERSION_DIR_RE = re.compile(r"^\d+\.")


# Agents honour the implementation contract (emit IMPLEMENTATION_VERIFIED, run
# the four gates) by activating this shared skill. Selection keys on this marker
# rather than on the freeform tools string, so write-capable critic/plan/review
# agents and agents rendered as `tools: inherited` are classified correctly.
_IMPLEMENTATION_SKILL = "implementation-self-check"

# Lower rank = higher precedence when the orchestrator falls back to a generalist.
_TRUST_RANK = {"repo": 0, "workspace-plugin": 1, "cache": 2}


@dataclass(frozen=True)
class AgentDescriptor:
    """Structured implementation-capability record used for agent selection."""

    invocation: str
    description: str
    tools: str
    implementation_capable: bool
    file_patterns: str
    domains: str
    trust_source: str
    fallback_rank: int

    def as_record(self) -> dict[str, object]:
        """Return the JSON record the orchestrator prompt consumes."""
        return {
            "invocation": self.invocation,
            "description": self.description,
            "tools": self.tools,
            "implementation_capable": self.implementation_capable,
            "file_patterns": self.file_patterns,
            "domains": self.domains,
            "trust_source": self.trust_source,
            "fallback_rank": self.fallback_rank,
        }


def _parse_frontmatter(path: Path) -> dict[str, str] | None:
    """Parse simple flat YAML frontmatter used by agent markdown files."""
    try:
        content = path.read_text(encoding="utf-8")
    except OSError:
        return None

    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None

    metadata: dict[str, str] = {}
    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if not stripped or stripped.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        value = value.strip()
        if value:
            metadata[key.strip()] = value

    if "name" not in metadata or "description" not in metadata:
        return None
    return metadata


def _build_descriptor(
    invocation: str, metadata: dict[str, str], trust_source: str
) -> AgentDescriptor:
    """Construct a structured capability record from parsed frontmatter."""
    skills = metadata.get("skills", "")
    return AgentDescriptor(
        invocation=invocation,
        description=metadata["description"],
        tools=metadata.get("tools", "inherited"),
        implementation_capable=_IMPLEMENTATION_SKILL in skills,
        file_patterns=metadata.get("file_patterns", ""),
        domains=metadata.get("domains", ""),
        trust_source=trust_source,
        fallback_rank=_TRUST_RANK.get(trust_source, len(_TRUST_RANK)),
    )


def _load_plugin_name(plugin_root: Path) -> str | None:
    manifest_path = plugin_root / ".claude-plugin" / "plugin.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    plugin_name = manifest.get("name")
    if not isinstance(plugin_name, str) or not plugin_name.strip():
        return None
    return plugin_name.strip()


def _discover_repo_agents(workspace_root: Path) -> list[AgentDescriptor]:
    agents_dir = workspace_root / ".claude" / "agents"
    if not agents_dir.is_dir():
        return []

    agents: list[AgentDescriptor] = []
    for path in sorted(agents_dir.glob("*.md")):
        metadata = _parse_frontmatter(path)
        if metadata is None:
            continue
        agents.append(_build_descriptor(metadata["name"], metadata, "repo"))
    return agents


def _iter_workspace_plugin_roots(workspace_root: Path) -> Iterable[Path]:
    plugins_dir = workspace_root / "plugins"
    if not plugins_dir.is_dir():
        return

    for plugin_root in sorted(path for path in plugins_dir.iterdir() if path.is_dir()):
        if (plugin_root / ".claude-plugin" / "plugin.json").is_file():
            yield plugin_root


def _parse_version(name: str) -> tuple[int, ...]:
    """Parse a version directory name into an integer tuple for comparison."""
    parts = re.findall(r"\d+", name)
    return tuple(int(p) for p in parts) if parts else (0,)


def _latest_version_root(plugin_dir: Path) -> Path | None:
    """Return the highest-semver version dir under a plugin that holds a manifest."""
    candidates: list[tuple[tuple[int, ...], Path]] = []
    try:
        version_dirs = list(plugin_dir.iterdir())
    except OSError:
        return None

    for version_dir in version_dirs:
        if not version_dir.is_dir() or not _VERSION_DIR_RE.match(version_dir.name):
            continue
        if (version_dir / ".claude-plugin" / "plugin.json").is_file():
            candidates.append((_parse_version(version_dir.name), version_dir))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[-1][1]


def _iter_cached_plugin_roots(plugin_cache_root: Path) -> Iterable[Path]:
    """Yield the latest cached version root for each ``<owner>/<plugin>``.

    Traverses only the expected cache layout
    (``<cache>/<owner>/<plugin>/<version>/.claude-plugin/plugin.json``) instead
    of recursively walking the whole cache tree, and selects the highest
    semantic version per plugin so stale cached versions are never surfaced.
    The fixed three-level descent bounds traversal regardless of how deep or
    oversized the cache tree happens to be.
    """
    if not plugin_cache_root.is_dir():
        return

    for owner_dir in sorted(plugin_cache_root.iterdir()):
        if not owner_dir.is_dir():
            continue
        for plugin_dir in sorted(owner_dir.iterdir()):
            if not plugin_dir.is_dir():
                continue
            latest = _latest_version_root(plugin_dir)
            if latest is not None:
                yield latest


def _discover_plugin_agents(
    plugin_roots: Iterable[tuple[Path, str]],
) -> list[AgentDescriptor]:
    discovered: dict[str, AgentDescriptor] = {}

    for plugin_root, trust_source in plugin_roots:
        plugin_name = _load_plugin_name(plugin_root)
        agents_dir = plugin_root / "agents"
        if plugin_name is None or not agents_dir.is_dir():
            continue

        for path in sorted(agents_dir.glob("*.md")):
            metadata = _parse_frontmatter(path)
            if metadata is None:
                continue

            invocation = f"{plugin_name}:{metadata['name']}"
            # First match wins: roots are supplied in precedence order
            # (current plugin, workspace plugins, then cache).
            if invocation in discovered:
                continue

            discovered[invocation] = _build_descriptor(
                invocation, metadata, trust_source
            )

    return sorted(discovered.values(), key=lambda agent: agent.invocation)


def discover_available_agents(
    workspace_root: Path,
    plugin_root: Path | None,
    plugin_cache_root: Path,
) -> tuple[list[AgentDescriptor], list[AgentDescriptor]]:
    """Discover repo-level and plugin agents with stable precedence."""
    repo_agents = _discover_repo_agents(workspace_root)

    plugin_roots: list[tuple[Path, str]] = []
    if plugin_root is not None:
        plugin_roots.append((plugin_root, "workspace-plugin"))
    plugin_roots.extend(
        (root, "workspace-plugin")
        for root in _iter_workspace_plugin_roots(workspace_root)
    )
    plugin_roots.extend(
        (root, "cache") for root in _iter_cached_plugin_roots(plugin_cache_root)
    )

    plugin_agents = _discover_plugin_agents(plugin_roots)
    return repo_agents, plugin_agents


def render_discovery_output(
    repo_agents: list[AgentDescriptor], plugin_agents: list[AgentDescriptor]
) -> str:
    """Render the structured capability record consumed by the orchestrator.

    Emits JSON so the prompt consumes typed fields (``implementation_capable``,
    ``file_patterns``, ``domains``, ``trust_source``, ``fallback_rank``) instead
    of parsing a freeform description/tools string.
    """
    payload = {
        "repo_agents": [agent.as_record() for agent in repo_agents],
        "plugin_agents": [agent.as_record() for agent in plugin_agents],
    }
    return json.dumps(payload, indent=2)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--workspace",
        default=".",
        help="Workspace root whose .claude/agents and plugins/ tree should be scanned.",
    )
    parser.add_argument(
        "--plugin-root",
        default=None,
        help="Resolved CLAUDE_PLUGIN_ROOT for the current plugin instance.",
    )
    parser.add_argument(
        "--plugin-cache-root",
        default=str(Path.home() / ".claude" / "plugins" / "cache"),
        help="Root of the Claude plugin cache used to discover installed plugin agents.",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    plugin_root = Path(args.plugin_root).resolve() if args.plugin_root else None
    repo_agents, plugin_agents = discover_available_agents(
        workspace_root=Path(args.workspace).resolve(),
        plugin_root=plugin_root,
        plugin_cache_root=Path(args.plugin_cache_root).resolve(),
    )
    print(render_discovery_output(repo_agents, plugin_agents))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
