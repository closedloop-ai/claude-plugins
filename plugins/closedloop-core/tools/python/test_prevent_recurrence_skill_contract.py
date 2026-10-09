"""Contract checks for the prevent-recurrence skill.

The skill must work for any agent in any repository, so it may not depend on
workflow-specific skills or private local files, and its links must resolve
from the skill's own folder.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = PLUGIN_ROOT / "skills" / "prevent-recurrence"
MARKDOWN_LINK_RE = re.compile(r"\]\(([^)]+)\)")
LADDER = (
    "1. Architecture or types",
    "2. Static analysis",
    "3. Guard test",
    "4. Owning AGENTS.md rule",
    "5. Memory or notes hint",
)
FORBIDDEN_DEPENDENCIES = (
    "cl-execute",
    ".closedloop-ai",
    "gardener",
    "symphony",
    "${CLAUDE_SKILL_DIR}",
    "/Users/",
    "/home/",
    "~/",
)
DASH_ONLY_CHARS = frozenset("-|: ")


def skill_files() -> list[Path]:
    return sorted(SKILL_ROOT.rglob("*.md"))


def test_frontmatter_names_the_skill_and_its_triggers() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    frontmatter = skill.split("---", 2)[1]
    assert "\nname: prevent-recurrence\n" in frontmatter
    description = next(
        line for line in frontmatter.splitlines() if line.startswith("description: ")
    )
    for trigger in ("code-review finding", "keeps happening", "post-incident"):
        assert trigger in description, trigger
    assert "Not for ordinary feature work" in description


def test_trust_ladder_table_lists_the_highest_rung_first() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    positions = [skill.index(f"| {rung} |") for rung in LADDER]
    assert positions == sorted(positions)


def test_skill_files_stay_portable() -> None:
    files = skill_files()
    assert files
    for path in files:
        text = path.read_text()
        for dependency in FORBIDDEN_DEPENDENCIES:
            assert dependency not in text, f"{path.name}: {dependency}"
        assert "\u2014" not in text, f"{path.name}: em dash"
        for line in text.splitlines():
            if line.strip() and set(line) <= DASH_ONLY_CHARS:
                continue  # frontmatter fence or table separator row
            assert "--" not in line, f"{path.name}: double hyphen in {line!r}"


def test_relative_links_resolve_inside_the_skill() -> None:
    for path in skill_files():
        for target in MARKDOWN_LINK_RE.findall(path.read_text()):
            assert not target.startswith(("/", "~", "http")), f"{path.name}: {target}"
            resolved = (path.parent / target).resolve()
            assert resolved.is_file(), f"{path.name}: {target}"
            assert resolved.is_relative_to(SKILL_ROOT), f"{path.name}: {target}"
