"""Reads a vibe prompt file the way a reader of a vibe release sees it.

A split stub is one line, ``> Read `references/x.md` (block `id`) ...``; the block it names lives in that file
between ``<!-- block: id -->`` and ``<!-- end: id -->`` and is the original text, moved without change.
The path is relative to the skill folder (the nearest folder above the file that holds a SKILL.md).

A provider stub, ``> Provider `<capability>` (block `id` of `file`)``, names a block of the optional provider's
references, which the ClosedLoop vibe carries in place: tools/vibe-closedloop-build builds it at release from
plugins/vibe and the provider. `built` reads a file as that build prints it from the current sources, so a change to a
vibe file or a provider block shows here before any rebuild, with each section the build moved to a cold file (its
pointer line, build.json `coldPointer`) put back; `generic` reads it as the generic vibe renders it with no provider
bound (vibe-core's provider.mjs `assembleProviderText`). Both put each split stub's block back where it stood.
"""

from __future__ import annotations

import functools
import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path

STUB = re.compile(r"^> Read `([^`]+)` \(block `([^`]+)`\)[^\n]*$", re.MULTILINE)
PROVIDER_STUB = re.compile(r"^> Provider `([a-z+]+)` \(block `([a-z0-9-]+)` of `([^`]+)`\)[^\n]*$", re.MULTILINE)
GENERIC = re.compile(r"^<!-- generic: ([a-z0-9-]+) -->\n(.*?)\n<!-- end generic: \1 -->\n", re.MULTILINE | re.DOTALL)
REPO = Path(__file__).resolve().parents[4]
VIBE = REPO / "plugins" / "vibe"
BUILD = REPO / "tools" / "vibe-closedloop-build" / "build.mjs"
BUILD_DATA = REPO / "plugins" / "vibe-closedloop-provider" / "build.json"
PROVIDER_MODULE = REPO / "plugins" / "vibe-core" / "lib" / "vibe" / "scripts" / "provider.mjs"
GENERIC_SCRIPT = (
    "const { assembleProviderText } = await import(process.argv[1]);"
    "const { readFileSync } = await import('node:fs');"
    "process.stdout.write(assembleProviderText(readFileSync(process.argv[2], 'utf8'), null));"
)


def raw(path: Path) -> str:
    """The file's own text, stubs left in place."""
    return path.read_text()


def skill_root(path: Path) -> Path:
    return next(folder for folder in [path.parent, *path.parents] if (folder / "SKILL.md").exists())


def block_text(root: Path, reference: str, block: str) -> str:
    return _block(raw(root / reference), reference, block)


def has_stubs(text: str) -> bool:
    return STUB.search(text) is not None or PROVIDER_STUB.search(text) is not None


def read(path: Path) -> str:
    """What a contract test reads for `path`: `built` for a vibe file with stubs, else the file's own text."""
    text = raw(path)
    return built(path) if path.suffix == ".md" and has_stubs(text) and path.resolve().is_relative_to(VIBE) else text


def built(path: Path) -> str:
    """The vibe file at `path` as the ClosedLoop build prints it from the current sources, split stubs put back."""
    text = _with_splits(path, _built(path.resolve().relative_to(VIBE).as_posix()), built)
    return _cold_pointer().sub(lambda pointer: built(path.parent / pointer.group(1)), text)


def generic(path: Path) -> str:
    """The vibe file at `path` as the generic vibe renders it with no provider bound, split stubs put back."""
    return _with_splits(path, _generic(str(path.resolve())), generic)


@functools.cache
def _built(relative: str) -> str:
    return subprocess.run(["node", str(BUILD), "--print", relative], check=True, capture_output=True, text=True, cwd=REPO).stdout


@functools.cache
def _generic(path: str) -> str:
    return subprocess.run(["node", "--input-type=module", "-e", GENERIC_SCRIPT, PROVIDER_MODULE.as_uri(), path],
                          check=True, capture_output=True, text=True).stdout


@functools.cache
def _cold_pointer() -> re.Pattern[str]:
    before, after = json.loads(BUILD_DATA.read_text())["coldPointer"].split("{path}")
    return re.compile(r"^%s(.+?)%s$" % (re.escape(before), re.escape(after)), re.MULTILINE)


def _with_splits(path: Path, text: str, read: Callable[[Path], str]) -> str:
    if STUB.search(text) is None:
        return text
    root = skill_root(path)
    return STUB.sub(lambda stub: _block(read(root / stub.group(1)), stub.group(1), stub.group(2)), text)


def _block(text: str, reference: str, block: str) -> str:
    found = re.search(r"<!-- block: %s -->\n(.*?)\n<!-- end: %s -->" % (re.escape(block), re.escape(block)), text, re.DOTALL)
    if found is None:
        raise AssertionError(f"{reference} has no block {block}")
    return found.group(1)
