"""Contract checks for the 2026-10-15 design ruling on existing components' stories.

1. In the placement owner's decision order, a change to an existing component
   (new states or variants, a column action, a footer) comes first: it never
   retitles, re-tags or moves the existing story file, whose title, tag and
   story names stay as they are, and the new states go in as extra stories in
   it. Only a new component or a sibling replacement gets a new entry and
   v2.0 placement. This outranks the "touched story takes v2.0" reading.
2. The guardrails and design-pass placement rules carry it as a one-liner, and
   no role still sends touched stories to v2.0.
3. The guardrails reviewer blocks a retitled, re-tagged or moved existing story
   file unless it is a recorded replacement, and the handoff inventory finds
   the retitle mechanically (its node tests prove the check itself).
4. The provenance is the design ruling, unattributed to a person.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
GUARDRAILS = VIBE / "references" / "guardrails.md"
DESIGN_PASS = VIBE / "references" / "design-pass.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
SESSIONS = VIBE / "scripts" / "vibe-sessions.mjs"
README = PLUGIN_ROOT / "README.md"
RULING = "design ruling, 2026-10-15"
CANONICAL = "never retitles, re-tags or moves its existing story file"


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def paragraph(text: str, marker: str) -> str:
    """The blank-line-delimited paragraph or list item block containing `marker`, flattened."""
    for block in re.split(r"\n\s*\n|\n(?=\d+\. )|\n(?=- )", text):
        if marker in flat(block):
            return flat(block)
    raise AssertionError(marker)


def agent(name: str) -> str:
    return (AGENTS / f"{name}.md").read_text()


def test_existing_components_come_first_in_the_placement_owners_decision_order() -> None:
    order = paragraph(agent("vibe-storybook-decomposer"), "4. Decide in this order")
    for required in (
        f"4. Decide in this order. First ({RULING}): a change to an existing component",
        "(new states or variants, an extra column action, a new footer)",
        f"{CANONICAL}, even in a v1.0 root",
        "the new states go in as extra stories in that file, its title, tag and existing story names unchanged",
        "Storybook builds story IDs from the title path, so a retitle breaks every link to those stories",
        "Only a new component, or a sibling replacement such as a V3, gets a new entry and v2.0 placement",
        "This outranks reading a touched story file as taking the v2.0 version.",
    ):
        assert required in order, required
    assert order.index(f"First ({RULING})") < order.index("Then (")
    placement = flat(agent("vibe-storybook-decomposer"))
    assert "an existing file's title and tag unchanged (step 4)" in placement
    assert "which places every new story:" in placement
    assert "An existing component's story file keeps its title and tag (\"Precedent search\", step 4)." in placement


def test_the_rule_is_stated_in_full_once() -> None:
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if CANONICAL in flat(path.read_text())]
    assert holders == ["vibe-storybook-decomposer.md"]


def test_guardrails_and_design_pass_carry_the_one_liner() -> None:
    guardrails = paragraph(GUARDRAILS.read_text(), "- New states or variants of an existing component")
    for required in (
        "go in as extra stories in its existing story file, never retitling, re-tagging or moving it",
        "only a new component or a sibling replacement (a V3) gets a new entry",
        f"({RULING}; `vibe-storybook-decomposer.md`, \"Precedent search\" step 4)",
    ):
        assert required in guardrails, required
    design = paragraph(DESIGN_PASS.read_text(), "6. Placement:")
    assert (
        "New states of an existing component stay in its existing story file, title and tag unchanged; "
        f"only a new component or a sibling replacement gets a new entry ({RULING})."
    ) in design


def test_no_role_still_sends_touched_stories_to_v2() -> None:
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        text = flat(path.read_text())
        for retired in ("new or touched story", "New and touched stories", "every new or touched story"):
            assert retired not in text, (path.name, retired)
    writer = flat(agent("vibe-change-worker"))
    assert "new states of an existing component go in its existing story file, title and tag unchanged" in writer
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "an existing story file keeps its title and tag" in handoff


def test_the_reviewer_blocks_a_retitled_existing_story_file_unless_it_is_a_replacement() -> None:
    check = paragraph(agent("vibe-guardrails-reviewer"), "10. Storybook taxonomy")
    for required in (
        "An existing story file (on main) retitled, re-tagged or moved breaks every link to its stories and is blocking",
        "(the inventory's `retitledStories` for a title) unless recorded as a sibling replacement's entry",
        "confirm the recorded `replacement` is one, not new states of the same component",
    ):
        assert required in check, required


def test_the_inventory_compares_meta_titles_against_the_base_and_admits_only_recorded_replacements() -> None:
    inventory = INVENTORY.read_text()
    for required in (
        "existingStoryTitlesKept: retitledStories.every((story) => story.replacement !== null),",
        "const STORY_META_START = ",
        '"--diff-filter=R"',
        "record?.storyReplacements",
    ):
        assert required in inventory, required
    guardrails = flat(GUARDRAILS.read_text())
    assert "(`retitledStories`, `existingStoryTitlesKept`)" in guardrails
    assert "`vibe-sessions.mjs story-replacement --worktree <wt> --path <story file> --replacement <component>`" in guardrails
    sessions = SESSIONS.read_text()
    assert 'case "story-replacement":' in sessions
    readme = flat(README.read_text())
    assert "New states of an existing component go in its existing story file under the same title and tag" in readme


def test_the_ruling_names_no_person() -> None:
    attributed = re.compile(r"\b[A-Z][a-z]+(?: [A-Z][a-z]+)*'s (?:design )?ruling, 2026-10-15")
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if path.is_file() and path.suffix in {".md", ".mjs", ".py"}:
            assert not attributed.search(path.read_text()), path.name
