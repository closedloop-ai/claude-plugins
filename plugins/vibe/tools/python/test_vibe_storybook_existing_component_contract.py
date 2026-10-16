"""Contract checks for the 2026-10-15 design rulings on existing components' stories.

1. In the placement owner's decision order, a change to an existing component
   (new states or variants, a column action, a footer) comes first: it never
   retitles, re-tags or moves the existing story file. A v1.0 story file is
   frozen and never edited beyond a compile-only repair
   (test_vibe_v1_compile_only_repair_contract.py), so the new states go in a new v2.0 entry holding
   only them, named descriptively per the taxonomy doc without a version
   number; any other existing file takes them as extra stories, its title,
   tag and story names unchanged. Otherwise only a new component or a sibling
   replacement gets a new entry and v2.0 placement. This outranks the
   "touched story takes v2.0" reading.
2. The guardrails and design-pass placement rules carry it as a one-liner, and
   no role still sends touched stories to v2.0 or adds stories to a v1.0 file.
3. The guardrails reviewer blocks an edited or moved v1.0 story file, and a
   retitled, re-tagged or moved non-v1.0 one unless it is a recorded
   replacement; the handoff inventory finds both mechanically (its node tests
   prove the checks themselves).
4. The provenance is the design ruling, unattributed to a person.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, paragraph


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
FROZEN = "A v1.0 story file is frozen and never edited"


def test_existing_components_come_first_in_the_placement_owners_decision_order() -> None:
    order = paragraph(agent("vibe-storybook-decomposer"), "4. Decide in this order")
    for required in (
        f"4. Decide in this order. First ({RULING}): a change to an existing component",
        "(new states or variants, an extra column action, a new footer)",
        f"{CANONICAL}.",
        "Storybook builds story IDs from the title path, so a retitle breaks every link to those stories",
        f"{FROZEN}, not even to add a story: the new states go in a new v2.0 entry for that component "
        "holding only the new states, its name descriptive, permanent, per `apps/storybook/TAXONOMY.md` and "
        "without a version number, and the v1.0 stories stay where they are.",
        "Any other existing story file takes the new states as extra stories, its title, tag and existing "
        "story names unchanged",
        "Otherwise only a new component, or a sibling replacement such as a V3, gets a new entry and v2.0 placement",
        "This outranks reading a touched story file as taking the v2.0 version.",
    ):
        assert required in order, required
    assert "even in a v1.0 root" not in order
    assert order.index(f"First ({RULING})") < order.index("Then (")
    placement = flat(agent("vibe-storybook-decomposer"))
    assert "an existing file's title and tag unchanged, a v1.0 file not edited beyond a compile-only repair (step 4)" in placement
    assert "which places every new story:" in placement
    assert "An existing component's story file keeps its title and tag (\"Precedent search\", step 4)." in placement


def test_the_rule_is_stated_in_full_once() -> None:
    for canonical in (CANONICAL, FROZEN):
        holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if canonical in flat(path.read_text())]
        assert holders == ["vibe-storybook-decomposer.md"], canonical


def test_guardrails_and_design_pass_carry_the_one_liner() -> None:
    guardrails = paragraph(GUARDRAILS.read_text(), "- New states or variants of an existing component")
    for required in (
        "never retitle, re-tag or move its existing story file, since story IDs come from the title",
        "A v1.0 story file is never edited beyond a compile-only repair (prop renames, imports, types; no story, "
        "title, tag or visual change): its component's new states go in a new v2.0 entry holding only them.",
        "Any other existing file takes them as extra stories.",
        "Otherwise only a new component or a sibling replacement (a V3) gets a new entry",
        f"({RULING}; `vibe-storybook-decomposer.md`, \"Precedent search\" step 4)",
    ):
        assert required in guardrails, required
    design = paragraph(DESIGN_PASS.read_text(), "6. Placement:")
    assert (
        "New states of an existing component go in a new v2.0 entry holding only them when its story file is "
        "v1.0, which is never edited beyond a compile-only repair, and otherwise in its existing story file, title "
        "and tag unchanged; only a "
        f"new component or a sibling replacement otherwise gets a new entry ({RULING})."
    ) in design


def test_no_role_still_sends_touched_stories_to_v2() -> None:
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        text = flat(path.read_text())
        for retired in ("new or touched story", "New and touched stories", "every new or touched story"):
            assert retired not in text, (path.name, retired)
    writer = flat(agent("vibe-change-worker"))
    assert (
        "new states of an existing component go in a new v2.0 entry holding only them when its story file is "
        "v1.0, which you never edit beyond a compile-only repair, and otherwise in its existing story file, title "
        "and tag unchanged"
    ) in writer
    handoff = flat(HANDOFF_SKILL.read_text())
    assert (
        "a v1.0 story file is never edited beyond a compile-only repair and any other existing story file keeps "
        "its title and tag"
    ) in handoff
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        text = flat(path.read_text())
        for retired in ("even in a v1.0 root", "an existing v1.0 file keeps"):
            assert retired not in text, (path.name, retired)


def test_the_reviewer_blocks_an_edited_v1_file_and_a_retitled_one_unless_it_is_a_replacement() -> None:
    check = paragraph(agent("vibe-guardrails-reviewer"), "10. Storybook taxonomy")
    for required in (
        "or any edit or move of a story file that is v1.0 on main (the inventory's `v1Stories`, reason `frozen`), "
        "is blocking; that component's new states belong in a new v2.0 entry holding only them, with no version "
        "number in its name",
        "An existing non-v1.0 story file (on main) retitled, re-tagged or moved breaks every link to its stories "
        "and is blocking",
        "(the inventory's `retitledStories` for a title) unless recorded as a sibling replacement's entry",
        "confirm the recorded `replacement` is one, not new states of the same component",
    ):
        assert required in check, required


def test_the_inventory_freezes_v1_files_and_admits_only_recorded_replacements_for_retitles() -> None:
    inventory = INVENTORY.read_text()
    for required in (
        '...(base !== undefined && isV1Story(base) ? ["frozen"] : []),',
        "existingStoryTitlesKept: retitledStories.every((story) => story.replacement !== null),",
        "const STORY_META_START = ",
        '"--diff-filter=R"',
        "record?.storyReplacements",
    ):
        assert required in inventory, required
    guardrails = flat(GUARDRAILS.read_text())
    assert "and any other edit or move of a v1.0 story file (`v1Stories`, `storiesInV2Taxonomy`)" in guardrails
    assert "an existing non-v1.0 one whose title changed (`retitledStories`, `existingStoryTitlesKept`)" in guardrails
    assert "`vibe-sessions.mjs story-replacement --worktree <wt> --path <story file> --replacement <component>`" in guardrails
    sessions = SESSIONS.read_text()
    assert 'case "story-replacement":' in sessions
    readme = flat(README.read_text())
    for required in (
        "A v1.0 story file is never edited beyond a compile-only repair, so new states of its component go in a "
        "new v2.0 entry holding only them.",
        "New states of any other existing component go in its existing story file under the same title and tag",
        "handoff blocks any other edit of a v1.0 story file except a compile-only repair, and a retitle unless it "
        "is a sibling replacement's entry",
        "Story files under the `Start Here/` root are exempt from the v1.0 freeze and the title, tag and retitle "
        "checks (design ruling, 2026-10-06).",
    ):
        assert required in readme, required


def test_the_ruling_names_no_person() -> None:
    attributed = re.compile(r"\b[A-Z][a-z]+(?: [A-Z][a-z]+)*'s (?:design )?ruling, 2026-10-15")
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if path.is_file() and path.suffix in {".md", ".mjs", ".py"}:
            assert not attributed.search(path.read_text()), path.name
