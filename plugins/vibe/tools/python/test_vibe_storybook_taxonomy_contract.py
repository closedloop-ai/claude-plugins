"""Contract checks for the 2026-10-14 operator ruling on Storybook taxonomy,
as translated to symphony-alpha's lifecycle scheme (#8867, ISS-12610; design
ruling, 2026-10-16).

1. The writer follows symphony-alpha's `apps/storybook/TAXONOMY.md` for every
   new story: the plain current roots, the page tree, one lifecycle tag and
   the Storybook release bump, never a frozen `<Level> v1.0/` root or the
   `deprecated` tag. A session on a base older than #8867 keeps that base's
   `<Level> v2.0/` rule. The plugin points at the doc and restates only that
   minimum.
2. The rule lives once, in `guardrails.md`; the writer, the Storybook and
   primitive advisors, the handoff skill and the guardrails reviewer point at it.
3. The handoff inventory blocks a new story titled under or tagged
   for a v1.0 root by the scheme its base declares (its node tests prove the
   check itself, on both schemes).
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
GUARDRAILS = PLUGIN_ROOT / "skills" / "vibe" / "references" / "guardrails.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
TAXONOMY_SCRIPT = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "storybook-taxonomy.mjs"
TAXONOMY_DOC = "`apps/storybook/TAXONOMY.md`"
POINTER = '"Storybook taxonomy"'


def test_the_rule_defers_to_the_repo_taxonomy_doc_and_states_only_the_minimum() -> None:
    text = section(GUARDRAILS.read_text(), "## Storybook taxonomy")
    for required in (
        f"Read the repo's {TAXONOMY_DOC} and follow it",
        "that doc is the authority, so its rules are not copied here",
        "so its rules are not copied here. The bare minimum:",
        "New stories go in the current roots, titled under the plain level "
        "(`Foundations/`, `Primitives/`, `Composites/`, `Patterns/`, `Surfaces/`)",
        "never in the frozen v1.0 roots (`Foundations v1.0/`, `Primitives v1.0/`, `Composites v1.0/`, "
        "`Surfaces v1.0/`), whose story files are all tagged `deprecated`",
        "placed in the page tree the doc describes",
        "Each story file carries exactly one lifecycle tag in its own meta",
        "`stable` for a shipped surface, `preview` for anything under `Labs`, `experimental` for a design-only "
        "preview or anything under `Not In The Live App`; never `deprecated`, which only the v1.0 roots carry",
        "(`tags: [\"!stable\", \"experimental\"]`)",
        "Adding, moving or renaming stories is a Storybook release",
        "A session whose base predates this scheme (Storybook before 3.0.0) follows that base's "
        "own `TAXONOMY.md`: there the plain roots and the `v1.0` tag are v1.0, and new work goes under "
        "`<Level> v2.0/` tagged `v2.0`",
        "The handoff inventory judges story files by the scheme of the session's base (`storybookScheme`",
        "(`v1Stories`, `storiesInV2Taxonomy`)",
        "the retitles a main import brought are never the session's own",
    ):
        assert required in text, required
    for retired in ("New stories go in a v2.0 root", "Each story file carries the `v2.0` version tag"):
        assert retired not in text, retired
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
    assert (
        'Stories follow "Storybook taxonomy" below: a current root, the page tree and a lifecycle tag, never a v1.0 root.'
        in primitives
    )


def test_the_guardrails_reviewer_blocks_v1_placement() -> None:
    reviewer = flat(agent("vibe-guardrails-reviewer"))
    for required in (
        f"10. Storybook taxonomy (`guardrails.md`, {POINTER})",
        "the inventory's `storybookScheme` names that base's scheme",
        "titled under or tagged for a frozen v1.0 root (a `<Level> v1.0/` root or the `deprecated` tag; on a "
        "version-scheme base, a plain root or the `v1.0` tag), or any edit or move of a story file that is v1.0 "
        "on main (the inventory's `v1Stories`, reason `frozen`), is blocking",
        "a title still under a `<Level> v2.0/` root",
        "a story file without exactly one lifecycle tag in its meta or with the wrong one for its place",
        "without the release bump the doc names",
    ):
        assert required in reviewer, required
    assert "Storybook taxonomy placement" in reviewer.split("---")[1]


def test_handoff_blocks_on_the_inventory_check() -> None:
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert f"(`../vibe/references/guardrails.md`, {POINTER})" in storybook
    assert "the inventory's `v1Stories` and `retitledStories` block handoff, judged by the scheme of the session's base" in storybook
    inventory = INVENTORY.read_text()
    assert "storiesInV2Taxonomy: v1Stories.length === 0," in inventory
    assert "storybookSchemeOf(readBaseFile(STORY_GROUP_ORDER_PATH))" in inventory
    taxonomy = TAXONOMY_SCRIPT.read_text()
    assert "(?:Foundations|Primitives|Composites|Surfaces)\\//" in taxonomy
    assert "const\\s+StorybookLifecycle" in taxonomy
    assert "const\\s+storybookBaselineVersion" in taxonomy


def test_the_rule_is_stated_once() -> None:
    canonical = "New stories go in the current roots, titled under the plain level"
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if canonical in flat(path.read_text())]
    assert holders == ["guardrails.md"]


def test_every_role_judges_a_session_by_the_scheme_its_base_uses() -> None:
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert (
        "Read that doc as the session's base has it: on a base older than the lifecycle scheme it still places "
        "new work under `<Level> v2.0/` with the `v2.0` tag."
    ) in decomposer
    writer = flat(agent("vibe-change-worker"))
    assert (
        "after a main sync your own new entries move to the plain root with a lifecycle tag, which is not a retitle"
    ) in writer
    readme = flat((PLUGIN_ROOT / "README.md").read_text())
    assert (
        "Handoff judges story files by the scheme of the session's base, read from that base's "
        "`apps/storybook/story-group-order.ts`, so a session still based before symphony-alpha #8867 keeps the "
        "`v1.0`/`v2.0` rules until it syncs main, and a sync is never blamed for the renames it imported."
    ) in readme
    inventory = INVENTORY.read_text()
    assert "  storybookScheme: storybookScheme.summary,\n" in inventory
    assert "...(storybookSchemeUnreadable ? { storybookSchemeRecognized: false } : {})," in inventory
