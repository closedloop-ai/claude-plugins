"""Tests for discover_available_agents.py."""

from __future__ import annotations

import json
from pathlib import Path

from discover_available_agents import discover_available_agents, render_discovery_output


def _write_agent(
    path: Path,
    *,
    name: str,
    description: str,
    tools: str | None = None,
) -> None:
    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
        "model: sonnet",
        "color: blue",
    ]
    if tools is not None:
        lines.append(f"tools: {tools}")
    lines.extend(["---", "", "Body"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_plugin(plugin_root: Path, *, plugin_name: str) -> None:
    manifest_dir = plugin_root / ".claude-plugin"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    (manifest_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": plugin_name,
                "description": f"{plugin_name} plugin",
                "version": "1.0.0",
                "author": {"name": "ClosedLoop"},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def test_discovers_repo_and_plugin_agents_across_workspace_and_cache(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    plugin_cache_root = tmp_path / "cache"

    _write_agent(
        workspace_root / ".claude" / "agents" / "repo-agent.md",
        name="repo-agent",
        description="Repo specialist",
        tools="Read, Edit",
    )

    code_plugin_root = workspace_root / "plugins" / "code"
    _write_plugin(code_plugin_root, plugin_name="code")
    _write_agent(
        code_plugin_root / "agents" / "implementation-subagent.md",
        name="implementation-subagent",
        description="General implementation fallback",
        tools="Read, Write, Edit",
    )

    cached_plugin_root = plugin_cache_root / "closedloop-ai" / "db" / "1.2.3"
    _write_plugin(cached_plugin_root, plugin_name="db")
    _write_agent(
        cached_plugin_root / "agents" / "schema-helper.md",
        name="schema-helper",
        description="Database schema specialist",
    )

    repo_agents, plugin_agents = discover_available_agents(
        workspace_root=workspace_root,
        plugin_root=code_plugin_root,
        plugin_cache_root=plugin_cache_root,
    )

    assert [agent.invocation for agent in repo_agents] == ["repo-agent"]
    assert [agent.invocation for agent in plugin_agents] == [
        "code:implementation-subagent",
        "db:schema-helper",
    ]
    assert plugin_agents[1].tools == "inherited"


def test_prefers_current_or_workspace_plugin_agents_over_cached_duplicates(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    plugin_cache_root = tmp_path / "cache"

    code_plugin_root = workspace_root / "plugins" / "code"
    _write_plugin(code_plugin_root, plugin_name="code")
    _write_agent(
        code_plugin_root / "agents" / "implementation-subagent.md",
        name="implementation-subagent",
        description="Local workspace implementation agent",
        tools="Read, Write, Edit, Skill",
    )
    (code_plugin_root / "agents" / "AGENT_FORMAT.md").write_text(
        "# Not an agent\n", encoding="utf-8"
    )

    cached_plugin_root = plugin_cache_root / "closedloop-ai" / "code" / "9.9.9"
    _write_plugin(cached_plugin_root, plugin_name="code")
    _write_agent(
        cached_plugin_root / "agents" / "implementation-subagent.md",
        name="implementation-subagent",
        description="Cached implementation agent",
        tools="Read",
    )

    repo_agents, plugin_agents = discover_available_agents(
        workspace_root=workspace_root,
        plugin_root=code_plugin_root,
        plugin_cache_root=plugin_cache_root,
    )
    rendered = render_discovery_output(repo_agents, plugin_agents)

    assert repo_agents == []
    assert len(plugin_agents) == 1
    assert plugin_agents[0].description == "Local workspace implementation agent"
    assert "@code:implementation-subagent | Local workspace implementation agent" in rendered
    assert "Cached implementation agent" not in rendered
