"""Text helpers shared by the vibe contract tests."""

from __future__ import annotations

import json
import re
from pathlib import Path


AGENTS = Path(__file__).resolve().parents[2] / "agents"


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
    """Whether hooks.json's one `event` command runs `guard` (for `tool`, when given, through its matcher and route)."""
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
