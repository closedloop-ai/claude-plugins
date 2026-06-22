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


def test_selects_latest_cached_version_and_ignores_stale_versions(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "workspace"
    plugin_cache_root = tmp_path / "cache"

    # Three cached versions of the same plugin; only the highest semver wins.
    for version, description in (
        ("1.2.0", "stale schema-helper v1.2.0"),
        ("1.10.0", "current schema-helper v1.10.0"),
        ("1.9.0", "stale schema-helper v1.9.0"),
    ):
        cached_root = plugin_cache_root / "closedloop-ai" / "db" / version
        _write_plugin(cached_root, plugin_name="db")
        _write_agent(
            cached_root / "agents" / "schema-helper.md",
            name="schema-helper",
            description=description,
        )

    _, plugin_agents = discover_available_agents(
        workspace_root=workspace_root,
        plugin_root=None,
        plugin_cache_root=plugin_cache_root,
    )

    assert [agent.invocation for agent in plugin_agents] == ["db:schema-helper"]
    assert plugin_agents[0].description == "current schema-helper v1.10.0"


def test_ignores_non_version_and_manifestless_cache_entries(tmp_path: Path) -> None:
    workspace_root = tmp_path / "workspace"
    plugin_cache_root = tmp_path / "cache"

    # A loose file at the owner level and a non-version directory must be ignored
    # rather than walked, so discovery is insensitive to junk in the cache tree.
    (plugin_cache_root / "closedloop-ai").mkdir(parents=True)
    (plugin_cache_root / "closedloop-ai" / "README.md").write_text(
        "not a plugin\n", encoding="utf-8"
    )
    stray = plugin_cache_root / "closedloop-ai" / "db" / "not-a-version"
    _write_agent(
        stray / "agents" / "ghost.md",
        name="ghost",
        description="should not be discovered",
    )
    # A version dir without a manifest must also be skipped.
    (plugin_cache_root / "closedloop-ai" / "db" / "2.0.0" / "agents").mkdir(parents=True)

    _, plugin_agents = discover_available_agents(
        workspace_root=workspace_root,
        plugin_root=None,
        plugin_cache_root=plugin_cache_root,
    )

    assert plugin_agents == []
