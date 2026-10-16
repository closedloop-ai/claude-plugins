"""Contract checks for the 2026-10-14 operator ruling on Storybook taxonomy.

1. The writer follows symphony-alpha's `apps/storybook/TAXONOMY.md` for every
   new story: a v2.0 root under `<Level> v2.0/`, the page tree, the
   `v2.0` tag and the Storybook release bump, never a frozen v1.0 root. The
   plugin points at the doc and restates only that minimum.
2. The rule lives once, in `guardrails.md`; the writer, the Storybook and
   primitive advisors, the handoff skill and the guardrails reviewer point at it.
3. The handoff inventory blocks a new story titled under or tagged
   for a v1.0 root (its node test proves the check itself).
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
GUARDRAILS = PLUGIN_ROOT / "skills" / "vibe" / "references" / "guardrails.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
TAXONOMY_DOC = "`apps/storybook/TAXONOMY.md`"
POINTER = '"Storybook taxonomy"'


def test_the_rule_defers_to_the_repo_taxonomy_doc_and_states_only_the_minimum() -> None:
    text = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    for required in (
        f"Read the repo's {TAXONOMY_DOC} and follow it",
        "that doc is the authority, so its rules are not copied here",
        "operator ruling, 2026-10-14",
        "New stories go in a v2.0 root, titled under `<Level> v2.0/`",
        "never in the frozen v1.0 roots (`Foundations/`, `Primitives/`, `Composites/`, `Surfaces/`)",
        "placed in the page tree the doc describes",
        "the `v2.0` version tag",
        "Adding, moving or renaming stories is a Storybook release",
        "(`v1Stories`, `storiesInV2Taxonomy`)",
    ):
        assert required in text, required
    assert "V2_PLACEMENT_BY_ID" not in text
    assert "story-group-order.ts" not in text


def test_every_story_author_and_advisor_points_at_the_doc_and_the_rule() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert f"Read the repo's {TAXONOMY_DOC} and follow it" in writer
    assert f"(`../skills/vibe/references/guardrails.md`, {POINTER})" in writer
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert TAXONOMY_DOC in decomposer
    assert f"(`../skills/vibe/references/guardrails.md`, {POINTER})" in decomposer
    primitive = flat(agent("vibe-primitive-worker"))
    assert f"Place them per the repo's {TAXONOMY_DOC}" in primitive
    assert f"(`guardrails.md`, {POINTER})" in primitive
    primitives = section(GUARDRAILS.read_text(), "## Missing primitives")
    assert 'Stories follow "Storybook taxonomy" below: a v2.0 root and the page tree, never a v1.0 root.' in primitives


def test_the_guardrails_reviewer_blocks_v1_placement() -> None:
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    for required in (
        f"10. Storybook taxonomy (`guardrails.md`, {POINTER})",
        "titled under or tagged for a frozen v1.0 root, or any edit or move of a story file that is v1.0 on main "
        "(the inventory's `v1Stories`, reason `frozen`), is blocking",
        "without the `v2.0` tag",
        "without the release bump the doc names",
    ):
        assert required in reviewer, required
    assert "Storybook taxonomy placement" in reviewer.split("---")[1]


def test_handoff_blocks_on_the_inventory_check() -> None:
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert f"(`../vibe/references/guardrails.md`, {POINTER})" in storybook
    assert "the inventory's `v1Stories` and `retitledStories` block handoff" in storybook
    inventory = INVENTORY.read_text()
    assert "storiesInV2Taxonomy: v1Stories.length === 0," in inventory
    assert "(?:Foundations|Primitives|Composites|Surfaces)\\//" in inventory


def test_the_rule_is_stated_once() -> None:
    canonical = "New stories go in a v2.0 root"
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if canonical in flat(path.read_text())]
    assert holders == ["guardrails.md"]
