"""Contract checks for ISS-13182: two Storybook mistakes moved from handoff to placement.

The first Storybook handoff review (ISS-13167) found a new story file that
re-typed its sibling's route fixtures, stored-view clearing and tree seeding,
and story names that claimed more than their plays asserted ("every kind", a
status story that never checked the painted label). Both were caught only at
handoff, after the writer had built the stories.

1. Placement reports the setup a story file already declares and the non-story
   fixture module the new stories import it from (the Fixtures line).
2. Placement lists, for each planned story name, the assertion behind every
   claim in it (the Names line), so a name is narrowed or a play completed
   before the story is written.
3. The writer's prep records both lines, and handoff checks the result
   against them.
"""

from __future__ import annotations

import json
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
DESIGN_PASS = PLUGIN_ROOT / "skills" / "vibe" / "references" / "design-pass.md"
EVALS = PLUGIN_ROOT / "evals"


def test_release_and_both_manifests_are_111() -> None:
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads((PLUGIN_ROOT / manifest).read_text())["version"] == "1.1.1"


def placement_block() -> str:
    """The Placement block's raw lines, as the decomposer returns them."""
    text = agent("vibe-storybook-decomposer")
    start = text.index("```\nPlacement:\n") + len("```\n")
    return text[start : text.index("```", start)]


def test_placement_reports_existing_story_setup_and_its_fixture_module() -> None:
    search = flat(section(agent("vibe-storybook-decomposer"), "## Precedent search"))
    for required in (
        "Also report the setup the new stories need that a story file already declares",
        "in every existing story file for the same component, page or folder",
        "route fixtures, stored-view or storage clearing, query-cache seeding, fixture components and fixture data",
        "import that setup from a non-story fixture module",
        "the writer first moves it into such a module and imports it in both files",
        "Never re-type it in a new story file",
    ):
        assert required in search, required
    block = placement_block()
    assert "- Fixtures: <each piece of setup the new stories need that a story file already declares" in block
    assert "the non-story fixture module to import it from, or the move into one the writer makes first>, or none" in block


def test_placement_names_the_assertion_behind_every_claim_in_a_story_name() -> None:
    block = placement_block()
    assert "- Names: <each planned story name, and for every thing the name claims" in block
    for claim in ("each kind, level or state it lists", "a word such as every or all", "a painted label or status"):
        assert claim in block, claim
    assert "the play assertion that will check it" in block
    assert "a claim with no assertion is a name to narrow or a play to complete before the story is written" in block


def test_the_new_lines_sit_between_stories_and_conflict() -> None:
    lines = [line.split(":")[0] for line in placement_block().splitlines() if line.startswith("- ")]
    assert lines == ["- Capability", "- Precedents", "- Owner", "- Stories", "- Fixtures", "- Names", "- Conflict"]


def test_the_writer_records_both_lines_and_handoff_checks_against_them() -> None:
    prep = flat(DESIGN_PASS.read_text())
    assert "- Placement: <the decomposer's Owner, Stories, Fixtures, Names and Conflict lines" in prep
    verify = flat(section(agent("vibe-storybook-decomposer"), "## Verify"))
    assert "quoting the name and the story body, checked against the Placement block's Names line" in verify
    assert (
        "each top-level helper in a new or changed story file that repeats setup another story file declares, "
        "instead of importing it from the non-story fixture module the Placement block's Fixtures line names"
    ) in verify


def test_an_eval_rehearses_the_names_line_at_placement() -> None:
    case = EVALS / "pm-storybook-names-claim-what-plays-assert"
    prompt = (case / "prompt.md").read_text()
    assert "`placement`" in prompt
    assert "Priority Label On Every Kind" in prompt
    graders = sorted(path.name for path in (case / "graders").glob("*.md"))
    assert graders == ["branch-kind-unchecked.md", "status-label-unchecked.md"]


def test_placement_tags_a_surface_behind_an_off_flag_preview() -> None:
    """Operator ruling, 2026-10-27: a story whose surface is reachable only behind a flag off in production is `preview`."""
    search = flat(section(agent("vibe-storybook-decomposer"), "## Precedent search"))
    for required in (
        "The lifecycle tag of a new entry also follows its flags (operator ruling, 2026-10-27)",
        "each PostHog flag that gates the surface where it is mounted and each flag the planned stories turn on",
        "the session's production flag snapshot (the file at `flagSnapshot.file` in `vibe-sessions.mjs show`)",
        "A surface reachable only behind a flag that is off or missing there gets the `preview` tag wherever it sits in the tree, never `stable`, and its story file names that flag",
        "(a `// Preview: <flag key> is off in production` comment)",
        "With no snapshot on the session the tag cannot be decided: report it as a Conflict for `engineering`.",
    ):
        assert required in search, required
    assert "with that flag's value in the production flag snapshot (one off or missing makes the tag `preview`)" in placement_block()
    verify = flat(section(agent("vibe-storybook-decomposer"), "## Verify"))
    assert "is off or missing in the session's production flag snapshot; it is `preview` wherever it sits in the tree" in verify
    assert "only reachable behind a default-off flag" not in verify


def test_an_eval_rehearses_the_off_flag_tag_at_placement() -> None:
    case = EVALS / "pm-storybook-flag-off-is-preview"
    prompt = (case / "prompt.md").read_text()
    assert "`placement`" in prompt
    assert '"projects-portable-surface": false' in prompt
    graders = sorted(path.name for path in (case / "graders").glob("*.md"))
    assert graders == ["not-stable.md", "tag-is-preview.md"]

