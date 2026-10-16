"""Text helpers shared by the vibe contract tests."""

from __future__ import annotations

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
