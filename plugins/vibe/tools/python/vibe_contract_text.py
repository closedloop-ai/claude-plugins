"""Shared text helpers for the vibe plugin's prose contract tests."""

from __future__ import annotations

import re


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def paragraph(text: str, marker: str) -> str:
    """The blank-line-delimited paragraph or list item block containing `marker`, flattened."""
    for block in re.split(r"\n\s*\n|\n(?=\d+\. )|\n(?=- )", text):
        if marker in flat(block):
            return flat(block)
    raise AssertionError(marker)
