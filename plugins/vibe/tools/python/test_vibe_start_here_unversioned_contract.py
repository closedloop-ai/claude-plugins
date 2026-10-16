"""Contract checks for the unversioned Start Here root (design ruling, 2026-10-06).

1. Story files under the `Start Here/` root are exempt from the v1.0 freeze
   and the title, tag and retitle checks, because Start Here is unversioned
   and its Version History is edited by every Storybook release. Guardrails,
   the placement owner's v1.0 rule and the handoff Storybook paragraph each
   state it in one line where the freeze is stated.
2. The handoff inventory bases the exemption on the meta title's root, not a
   file name, and applies it to both `v1Stories` and `retitledStories` (its
   node tests prove the behavior).
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, paragraph, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
GUARDRAILS = PLUGIN_ROOT / "skills" / "vibe" / "references" / "guardrails.md"
DECOMPOSER = PLUGIN_ROOT / "agents" / "vibe-storybook-decomposer.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
TAXONOMY_SCRIPT = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "storybook-taxonomy.mjs"
EXEMPTION = (
    "Story files under the `Start Here/` root are exempt from the v1.0 freeze and the title, tag and retitle "
    "checks (design ruling, 2026-10-06): Start Here is unversioned and its Version History is edited by every "
    "Storybook release."
)


def test_guardrails_state_the_exemption_beside_the_freeze() -> None:
    taxonomy = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    assert EXEMPTION in taxonomy
    assert taxonomy.index("A v1.0 story file (under a `<Level> v1.0/` root or tagged `deprecated`) is never edited") < taxonomy.index(
        EXEMPTION
    )


def test_the_placement_owner_states_the_exemption_in_its_v1_rule() -> None:
    order = paragraph(DECOMPOSER.read_text(), "4. Decide in this order")
    assert EXEMPTION in order
    assert order.index("is frozen and never edited, not even to add a story") < order.index(EXEMPTION)


def test_the_handoff_storybook_paragraph_states_the_exemption() -> None:
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert EXEMPTION in storybook
    assert storybook.index("the inventory's `v1Stories` and `retitledStories` block handoff") < storybook.index(
        EXEMPTION
    )


def test_each_holder_states_the_exemption_once() -> None:
    holders = sorted(
        path.relative_to(PLUGIN_ROOT).as_posix()
        for path in PLUGIN_ROOT.rglob("*.md")
        if flat(path.read_text()).count(EXEMPTION) == 1
    )
    assert holders == [
        "agents/vibe-storybook-decomposer.md",
        "skills/handoff/SKILL.md",
        "skills/vibe/references/guardrails.md",
    ]


def test_the_inventory_exempts_the_start_here_title_root_from_both_checks() -> None:
    inventory = INVENTORY.read_text()
    taxonomy = TAXONOMY_SCRIPT.read_text()
    assert 'export const UNVERSIONED_STORY_ROOT = "Start Here";' in taxonomy
    assert "storyTitleRoot(source) === UNVERSIONED_STORY_ROOT" in taxonomy
    assert 'return storyMetaTitle(source)?.split("/")[0].trim();' in taxonomy
    for script in (inventory, taxonomy):
        assert "start-here-version-history" not in script
    for check in ("function findV1Stories(files)", "function findRetitledStories(files)"):
        start = inventory.index(check)
        body = inventory[start : inventory.index("\n}\n", start)]
        assert "isUnversionedStory(base)" in body
        assert "isUnversionedStory(source)" in body
