#!/usr/bin/env python3
"""Discover repo-level and plugin-provided agents available to the orchestrator."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class AgentDescriptor:
    """Minimal metadata needed for agent selection."""

    invocation: str
    description: str
    tools: str


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
        agents.append(
            AgentDescriptor(
                invocation=metadata["name"],
                description=metadata["description"],
                tools=metadata.get("tools", "inherited"),
            )
        )
    return agents


def _iter_workspace_plugin_roots(workspace_root: Path) -> Iterable[Path]:
    plugins_dir = workspace_root / "plugins"
    if not plugins_dir.is_dir():
        return

    for plugin_root in sorted(path for path in plugins_dir.iterdir() if path.is_dir()):
        if (plugin_root / ".claude-plugin" / "plugin.json").is_file():
            yield plugin_root


def _iter_cached_plugin_roots(plugin_cache_root: Path) -> Iterable[Path]:
    if not plugin_cache_root.is_dir():
        return

    seen: set[Path] = set()
    for manifest_path in sorted(plugin_cache_root.rglob("plugin.json")):
        if manifest_path.parent.name != ".claude-plugin":
            continue
        plugin_root = manifest_path.parent.parent
        if plugin_root in seen:
            continue
        seen.add(plugin_root)
        yield plugin_root


def _discover_plugin_agents(plugin_roots: Iterable[Path]) -> list[AgentDescriptor]:
    discovered: dict[str, AgentDescriptor] = {}

    for plugin_root in plugin_roots:
        plugin_name = _load_plugin_name(plugin_root)
        agents_dir = plugin_root / "agents"
        if plugin_name is None or not agents_dir.is_dir():
            continue

        for path in sorted(agents_dir.glob("*.md")):
            metadata = _parse_frontmatter(path)
            if metadata is None:
                continue

            invocation = f"{plugin_name}:{metadata['name']}"
            if invocation in discovered:
                continue

            discovered[invocation] = AgentDescriptor(
                invocation=invocation,
                description=metadata["description"],
                tools=metadata.get("tools", "inherited"),
            )

    return sorted(discovered.values(), key=lambda agent: agent.invocation)


def discover_available_agents(
    workspace_root: Path,
    plugin_root: Path | None,
    plugin_cache_root: Path,
) -> tuple[list[AgentDescriptor], list[AgentDescriptor]]:
    """Discover repo-level and plugin agents with stable precedence."""
    repo_agents = _discover_repo_agents(workspace_root)

    plugin_roots: list[Path] = []
    if plugin_root is not None:
        plugin_roots.append(plugin_root)
    plugin_roots.extend(_iter_workspace_plugin_roots(workspace_root))
    plugin_roots.extend(_iter_cached_plugin_roots(plugin_cache_root))

    plugin_agents = _discover_plugin_agents(plugin_roots)
    return repo_agents, plugin_agents


def render_discovery_output(
    repo_agents: list[AgentDescriptor], plugin_agents: list[AgentDescriptor]
) -> str:
    """Render the text block consumed by the orchestrator prompt."""
    lines = ["=== Repo-level agents ==="]
    if repo_agents:
        for agent in repo_agents:
            lines.append(
                f"  @{agent.invocation} | {agent.description} | tools: {agent.tools}"
            )
    else:
        lines.append("  (none found)")

    lines.append("=== Plugin agents ===")
    if plugin_agents:
        for agent in plugin_agents:
            lines.append(
                f"  @{agent.invocation} | {agent.description} | tools: {agent.tools}"
            )
    else:
        lines.append("  (none found)")

    return "\n".join(lines)


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
