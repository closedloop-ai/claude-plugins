"""Strict frontmatter checks for every closedloop-core skill.

Some harnesses tolerate loose YAML in a SKILL.md header and others reject it,
so each skill's frontmatter must load with a strict YAML parser and carry a
string name matching its folder and a string description within 1024
characters.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_FILES = sorted((PLUGIN_ROOT / "skills").glob("*/SKILL.md"))


def test_skill_files_are_found() -> None:
    assert SKILL_FILES


@pytest.mark.parametrize("path", SKILL_FILES, ids=lambda path: path.parent.name)
def test_frontmatter_is_strict_yaml(path: Path) -> None:
    name = path.relative_to(PLUGIN_ROOT)
    text = path.read_text()
    assert text.startswith("---\n"), f"{name}: no frontmatter"
    raw = text.split("---", 2)[1]
    try:
        frontmatter = yaml.safe_load(raw)
    except yaml.YAMLError as error:
        pytest.fail(f"{name}: frontmatter is not valid YAML: {error}")
    assert isinstance(frontmatter, dict), f"{name}: frontmatter is not a mapping"
    assert frontmatter.get("name") == path.parent.name, f"{name}: name"
    description = frontmatter.get("description")
    assert isinstance(description, str) and description, f"{name}: description"
    assert len(description) <= 1024, f"{name}: description over 1024 characters"
