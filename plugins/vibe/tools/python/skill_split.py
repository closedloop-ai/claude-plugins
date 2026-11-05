"""Reads a prompt file with its split-out blocks put back where its stubs are.

A stub is one line, ``> Read `references/x.md` (block `id`) ...``; the block it names lives in that file
between ``<!-- block: id -->`` and ``<!-- end: id -->`` and is the original text, moved without change.
The path is relative to the skill folder (the nearest folder above the file that holds a SKILL.md).
"""

from __future__ import annotations

import re
from pathlib import Path

STUB = re.compile(r"^> Read `([^`]+)` \(block `([^`]+)`\)[^\n]*$", re.MULTILINE)
_raw_read_text = Path.read_text


def raw(path: Path) -> str:
    """The file's own text, stubs left in place."""
    return _raw_read_text(path)


def skill_root(path: Path) -> Path:
    return next(folder for folder in [path.parent, *path.parents] if (folder / "SKILL.md").exists())


def block_text(root: Path, reference: str, block: str) -> str:
    text = raw(root / reference)
    found = re.search(r"<!-- block: %s -->\n(.*?)\n<!-- end: %s -->" % (re.escape(block), re.escape(block)), text, re.DOTALL)
    if found is None:
        raise AssertionError(f"{reference} has no block {block}")
    return found.group(1)


def assembled(path: Path) -> str:
    """The file's text with every stub replaced by the block it names."""
    text = raw(path)
    if STUB.search(text) is None:
        return text
    root = skill_root(path)
    return STUB.sub(lambda stub: block_text(root, stub.group(1), stub.group(2)), text)
