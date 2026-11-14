"""Text helpers shared by the vibe contract tests."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path


AGENTS = Path(__file__).resolve().parents[2] / "agents"
# The optional provider's references: text moved out of vibe that a provider-bound session still follows.
PROVIDER_REFERENCES = (Path(__file__).resolve().parents[3] / "vibe-closedloop-provider" / "skills" / "closedloop-provider"
                       / "references")

# The ClosedLoop provider's data (`provider.json` `data`): the recipes and rules its repository's contracts pin.
PROVIDER_DATA = json.loads((PROVIDER_REFERENCES.parents[2] / "provider.json").read_text(encoding="utf-8"))["data"]

def flat(text: str) -> str:
    """`text` with every run of whitespace collapsed to one space."""
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened.

    `heading` is matched at the start of a line: a line equal to it wins, otherwise the first line it
    begins (so "## Return" finds "## Return (under 200 words)").
    """
    level = len(heading.split(" ", 1)[0])
    escaped = re.escape(heading)
    match = re.search(r"^%s$" % escaped, text, re.MULTILINE) or re.search(r"^%s" % escaped, text, re.MULTILINE)
    if match is None:
        raise ValueError(f"heading not found: {heading}")
    rest = text[match.end() :]
    ends = [found.start() for found in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def paragraph(text: str, marker: str) -> str:
    """The blank-line-delimited paragraph or list item block containing `marker`, flattened."""
    for block in re.split(r"\n\s*\n|\n(?=\d+\. )|\n(?=- )", text):
        if marker in flat(block):
            return flat(block)
    raise AssertionError(marker)


def agent(name: str) -> str:
    """The raw text of the vibe agent definition `name`."""
    return (AGENTS / f"{name}.md").read_text()


def hook_guard_routed(plugin: Path, event: str, guard: str, tool: str | None = None) -> bool:
    """Whether vibe's hooks run `guard` for `event` (for `tool`, when given, through its matcher and route).

    `plugin` is vibe's root; its hooks ship in the vibe-core plugin beside it, whose hooks.json has one command per event.
    """
    plugin = plugin.parent / "vibe-core"
    entries = json.loads((plugin / "hooks" / "hooks.json").read_text())["hooks"][event]
    commands = [(entry.get("matcher", ""), hook["command"]) for entry in entries for hook in entry["hooks"]]
    if len(commands) != 1:
        return False
    matcher, command = commands[0]
    script = re.search(r"hooks/([\w.-]+\.mjs)", command)
    if script is None or (tool is not None and tool not in matcher.split("|")):
        return False
    source = (plugin / "hooks" / script.group(1)).read_text()
    if tool is None:
        return f'name: "{guard}"' in source
    route = re.search(rf"\b{re.escape(tool)}: Object\.freeze\(\[(.*?)\]\)", source, re.DOTALL)
    return route is not None and f'name: "{guard}"' in route.group(1)


def bound_provider_env(home: Path) -> dict[str, str]:
    """The environment of a script run as a chat the ClosedLoop provider is bound to, under the throwaway `home`."""
    chat = "fixture-chat"
    records = home / ".codex" / "vibe" / "plugin-version"
    records.mkdir(parents=True, exist_ok=True)
    binding = {"state": "bound", "name": "vibe-closedloop-provider",
               "root": str(PROVIDER_REFERENCES.parents[2]),
               "capabilities": ["tickets", "plans", "graph", "memory", "recipes"]}
    (records / f"{chat}.json").write_text(json.dumps({"conversation": chat, "status": "current", "provider": binding}))
    return {**os.environ, "HOME": str(home), "CLAUDE_CODE_SESSION_ID": chat, "CODEX_THREAD_ID": ""}
