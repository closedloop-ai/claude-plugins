"""Reads a prompt file with its split-out blocks put back where its stubs are.

A stub is one line, ``> Read `references/x.md` (block `id`) ...``; the block it names lives in that file
between ``<!-- block: id -->`` and ``<!-- end: id -->`` and is the original text, moved without change.
The path is relative to the skill folder (the nearest folder above the file that holds a SKILL.md).

A provider stub, ``> Provider `<capability>` (block `id` of `file`)``, names a block of the same form in the
optional provider plugin's references folder: text vibe follows only when a provider with that capability is
bound. The generic text it replaces, when there is any, sits just above it between
``<!-- generic: id -->`` and ``<!-- end generic: id -->``. Assembled for the provider, a file reads as it did
before the text moved; assembled without one, it reads as a generic session sees it.
"""

from __future__ import annotations

import re
from pathlib import Path

STUB = re.compile(r"^> Read `([^`]+)` \(block `([^`]+)`\)[^\n]*$", re.MULTILINE)
PROVIDER_STUB = re.compile(r"^> Provider `([a-z+]+)` \(block `([a-z0-9-]+)` of `([^`]+)`\)[^\n]*$", re.MULTILINE)
GENERIC = re.compile(r"^<!-- generic: ([a-z0-9-]+) -->\n(.*?)\n<!-- end generic: \1 -->\n", re.MULTILINE | re.DOTALL)
# The one line a file with provider stubs adds for a reader of the raw file; assembled text needs no such pointer.
PROVIDER_RULE = re.compile(r"^Lines that start `> Provider` follow `[^`]*provider-text\.md`\.(?: [^\n]*)?\n\n", re.MULTILINE)
PROVIDER_REFERENCES = (Path(__file__).resolve().parents[3] / "vibe-closedloop-provider" / "skills" / "closedloop-provider"
                       / "references")
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


def provider_block(reference: str, block: str) -> str:
    """Block `block` of provider reference `reference` (relative to the provider's references folder)."""
    text = raw(PROVIDER_REFERENCES / reference)
    found = re.search(r"<!-- block: %s -->\n(.*?)\n<!-- end: %s -->" % (re.escape(block), re.escape(block)), text, re.DOTALL)
    if found is None:
        raise AssertionError(f"provider {reference} has no block {block}")
    return found.group(1)


def has_stubs(text: str) -> bool:
    return STUB.search(text) is not None or PROVIDER_STUB.search(text) is not None


def assembled(path: Path, provider: bool = True) -> str:
    """The file's text with every stub replaced by the block it names; `provider` decides the provider stubs."""
    text = raw(path)
    if STUB.search(text) is not None:
        root = skill_root(path)
        text = STUB.sub(lambda stub: block_text(root, stub.group(1), stub.group(2)), text)
    text = PROVIDER_RULE.sub("", text) if has_stubs(text) else text
    if provider:
        text = GENERIC.sub("", text)
        return PROVIDER_STUB.sub(lambda stub: provider_block(stub.group(3), stub.group(2)), text)
    text = GENERIC.sub(lambda region: region.group(2) + "\n", text)
    return re.sub(PROVIDER_STUB.pattern + r"\n?", "", text, flags=re.MULTILINE)
