"""Contract checks for Daniel Ochoa's 2026-10-14 ruling on Storybook placement.

1. `vibe-storybook-decomposer` owns Storybook placement. It stays read-only
   and runs during `$vibe` (the writer's `NEEDS_STORYBOOK`) before a story is
   created, retitled or moved or a shared component is added, and again at
   handoff.
2. Its precedent search finds every place a sibling entity already has the
   capability, through the graph and the built Storybook index, and reports
   all of it. The repo's Storybook docs decide where they say how; otherwise
   the precedent is mirrored. Placement never invents a location.
3. A conflict is recorded for engineering and design; placement has no path
   that asks the person running the session.
4. The writer's owner prep looks for the precedent first and points at the
   repo's AGENTS.md shared-parent rule rather than restating it.
5. The page-scoped story check stays judgment-only in the guardrails
   reviewer; the handoff inventory gains no mechanical version of it.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = PLUGIN_ROOT.parents[1]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
VIBE_SKILL = VIBE / "SKILL.md"
DESIGN_PASS = VIBE / "references" / "design-pass.md"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"
GUARDRAILS = VIBE / "references" / "guardrails.md"
TICKET_TEMPLATE = VIBE / "references" / "ticket-template.md"
GRAPH = VIBE / "references" / "closedloop-graph.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
README = PLUGIN_ROOT / "README.md"
CONTRACTS = REPO_ROOT / "tools" / "vibe-workers" / "src" / "contracts.ts"
CLAUDE_WORKER_DIST = VIBE / "scripts" / "dist" / "claude-worker.mjs"
TAXONOMY_DOC = "`apps/storybook/TAXONOMY.md`"
STORYBOOK_SKILL = "`.claude/skills/storybook/`"
BEFORE_PLACING = "creates, retitles or moves a story or adds a shared component"

ASK_THE_PERSON = (
    re.compile(r"(?<!never a `)NEEDS_PERSON"),
    re.compile(r"\bask(s|ed|ing)?\b[^.]*\bperson\b", re.IGNORECASE),
    re.compile(r"\bsurfaces?\b[^.]*\bperson\b", re.IGNORECASE),
    re.compile(r"\bperson (decides|chooses|picks)\b", re.IGNORECASE),
)


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def paragraph(text: str, marker: str) -> str:
    """The blank-line-delimited paragraph or list item block containing `marker`, flattened."""
    for block in re.split(r"\n\s*\n|\n(?=\d+\. )", text):
        if marker in flat(block):
            return flat(block)
    raise AssertionError(marker)


def agent(name: str) -> str:
    return (AGENTS / f"{name}.md").read_text()


def frontmatter(text: str) -> str:
    return text.split("---")[1]


def placement_passages() -> dict[str, str]:
    """Every passage that tells a role how Storybook placement is decided."""
    decomposer = agent("vibe-storybook-decomposer")
    return {
        "decomposer": section(decomposer, "## Precedent search") + section(decomposer, "## Modes"),
        "vibe skill": paragraph(VIBE_SKILL.read_text(), "returns `NEEDS_STORYBOOK` with the capability"),
        "writer": paragraph(agent("vibe-change-worker"), "return `NEEDS_STORYBOOK` with the capability"),
        "design pass": paragraph(DESIGN_PASS.read_text(), "5. Precedent:")
        + paragraph(DESIGN_PASS.read_text(), "6. Placement:"),
        "handoff": section(HANDOFF_SKILL.read_text(), "## 4. Storybook"),
        "guardrails": paragraph(GUARDRAILS.read_text(), "is `vibe-storybook-decomposer`'s Placement"),
        "ticket": paragraph(TICKET_TEMPLATE.read_text(), "- Storybook placement:"),
        "readme": paragraph(README.read_text(), "the read-only `vibe-storybook-decomposer` places it"),
    }


def test_the_existing_decomposer_owns_placement_and_stays_read_only() -> None:
    text = agent("vibe-storybook-decomposer")
    meta = frontmatter(text)
    assert "name: vibe-storybook-decomposer" in meta
    assert "Read-only Storybook placement owner" in flat(meta)
    assert "tools: Read, Grep, Glob, Bash\n" in meta
    assert "Write" not in meta and "Edit" not in meta
    body = flat(text)
    assert "You own Storybook placement" in body
    assert "You are READ-ONLY and never edit code, stories, tests or catalog files." in body
    assert "the SAME persistent writer" in body
    modes = section(text, "## Modes")
    assert "`placement`, during `$vibe`: the writer returned `NEEDS_STORYBOOK`" in modes
    assert BEFORE_PLACING in modes
    assert "`handoff`:" in modes
    duplicates = [path.name for path in AGENTS.glob("*.md") if "## Precedent search" in path.read_text()]
    assert duplicates == ["vibe-storybook-decomposer.md"]


def test_precedent_search_reports_everything_from_the_graph_and_the_built_index() -> None:
    search = section(agent("vibe-storybook-decomposer"), "## Precedent search")
    for required in (
        "Do this first, in both modes.",
        "Name the capability without the entity",
        "already exists for a sibling entity",
        "`code_symbols` on its names and `code_importers` on the component that provides it",
        "the built Storybook index, not a title grep",
        "`<storybookUrl>/index.json`",
        "`packages/design-system/storybook/component-catalog.ts` and the story files on main",
        "Match story names as well as titles",
        "every story file that renders the providing component or passes the capability's prop",
        "Leave out the session's own stories.",
        "Report everything found, not a pick",
        "how each host consumes it",
        "every existing story that exercises it, with its title, story names, version tag and file",
        "Never invent a placement",
    ):
        assert required in search, required
    for line in ("- Capability:", "- Precedents:", "- Owner:", "- Stories:", "- Conflict:"):
        assert line in search, line
    graph = flat(GRAPH.read_text())
    assert "`code_importers` on the precedent's providing component" in graph


def test_repo_docs_decide_first_then_the_precedent() -> None:
    search = section(agent("vibe-storybook-decomposer"), "## Precedent search")
    order = (
        "Decide in this order (Daniel Ochoa's ruling, 2026-10-14): where the repo's "
        f"{TAXONOMY_DOC} or {STORYBOOK_SKILL} already say how, follow them; "
        "where they do not, mirror the precedent"
    )
    assert order in search
    assert "A precedent that disagrees with those docs, or precedents that disagree with each other, is a Conflict." in search
    assert "Decide it by the same order" in search


def test_stories_document_consumed_components_not_internal_pieces() -> None:
    text = agent("vibe-storybook-decomposer")
    order = paragraph(text, "4. Decide in this order")
    for required in (
        "Either way, stories document the components consumers actually render, one story per state, never internal render pieces",
        "a shared capability's generic mechanics stay in the shared component's existing stories",
        "the page-level component consumers render gets variants showing only its domain-specific configuration",
        "the doc's v2.0 Composites row, \"a section of a page\"",
    ):
        assert required in order, required
    stories = paragraph(text, "2. Stories.")
    assert "of the component consumers render (\"Precedent search\", step 4)" in stories
    check = paragraph(agent("vibe-guardrails-reviewer"), "11. Storybook placement")
    assert "a story for an internal render piece instead of the component consumers render" in check
    assert "a page-level story repeating a shared component's generic mechanics" in check
    assert "(`vibe-storybook-decomposer.md`, \"Precedent search\" step 4)" in check


def test_placement_has_no_ask_the_person_path() -> None:
    passages = placement_passages()
    for name, text in passages.items():
        for pattern in ASK_THE_PERSON:
            assert not pattern.search(text), (name, pattern.pattern)
    assert "it is never a question for the person running the session" in passages["decomposer"]
    assert "never a question for the person" in passages["vibe skill"]
    assert "it is never a `NEEDS_PERSON` question" in passages["writer"]
    assert "never to the person" in passages["handoff"]
    assert "for engineering and design" in passages["ticket"]
    assert "never to the person" in passages["readme"]


def test_vibe_runs_the_placement_owner_before_stories_like_its_other_advisors() -> None:
    skill = VIBE_SKILL.read_text()
    assert "| `vibe-storybook-decomposer` | read-only Storybook placement owner" in skill
    assert "`NEEDS_PRIMITIVE`, `NEEDS_BACKEND` or `NEEDS_STORYBOOK` can request read-only guidance only" in flat(skill)
    step = paragraph(skill, "returns `NEEDS_STORYBOOK` with the capability")
    for required in (
        f"Before it {BEFORE_PLACING}",
        "dispatch read-only `vibe-storybook-decomposer` in placement mode",
        "resume the SAME writer with its Placement block",
        "records in its local plan before writing",
        "a read-only lookup in quick prep, not a review",
    ):
        assert required in step, required
    assert step.index("NEEDS_STORYBOOK") < step.index("STORIES_READY")
    loop = section(QUALITY_LOOP.read_text(), "## Lean build loop")
    assert "read-only `vibe-storybook-decomposer` placement advice" in loop
    writer = flat(agent("vibe-change-worker"))
    assert "Before you create, retitle or move a story or add a shared component, return `NEEDS_STORYBOOK`" in writer
    assert "copy it into the local plan, and build to it" in writer
    assert "`NEEDS_STORYBOOK` asks for placement advice and continues the same request" in writer


def test_the_launcher_accepts_the_placement_status() -> None:
    assert '"NEEDS_STORYBOOK"' in CONTRACTS.read_text()
    assert '"NEEDS_STORYBOOK"' in CLAUDE_WORKER_DIST.read_text()


def test_owner_prep_looks_for_the_precedent_first_and_points_at_the_repo_rule() -> None:
    text = DESIGN_PASS.read_text()
    precedent = paragraph(text, "5. Precedent:")
    for required in (
        "where the same capability already exists for a sibling entity",
        "how its hosts consume it, and where its stories live",
        'the repo\'s `AGENTS.md` ("Shared behavior belongs in the shared parent (ISS-12135)")',
        "mirror the precedent's ownership, component and Storybook placement",
        "Daniel Ochoa's ruling, 2026-10-14",
    ):
        assert required in precedent, required
    assert "review-owned, no gate" not in text
    prep = flat(text)
    assert "- Precedent: <" in prep
    assert "- Placement: <the decomposer's Owner, Stories and Conflict lines" in prep
    assert "or `precedent`>" in prep
    writer = flat(agent("vibe-change-worker"))
    assert "(`design-pass.md`, Prep step 5)" in writer


def test_handoff_and_ticket_record_the_placement() -> None:
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert "checked against the Placement blocks in the writer's local plan" in storybook
    assert "the live ticket's Storybook placement line" in storybook
    ticket = paragraph(TICKET_TEMPLATE.read_text(), "- Storybook placement:")
    assert "each Conflict between a precedent and the repo docs, or between precedents" in ticket


def test_page_scoped_story_check_is_judgment_only() -> None:
    reviewer = agent("vibe-guardrails-reviewer")
    check = paragraph(reviewer, "11. Storybook placement")
    for required in (
        "judgment only; every finding here is advisory",
        "a new page-scoped story or page-specific composite for a capability a shared `packages/design-system` component already provides",
        "This is not a mechanical check",
    ):
        assert required in check, required
    assert "blocking" not in check
    assert "precedent placement" in frontmatter(reviewer)
    inventory = INVENTORY.read_text()
    assert "precedent" not in inventory.lower()
    assert "pageScoped" not in inventory


def test_placement_owner_uses_the_repo_storybook_skill_instead_of_restating_it() -> None:
    inputs = section(agent("vibe-storybook-decomposer"), "## Inputs")
    for required in (
        "`references/governance.md` (\"Taxonomy\") and `workflows/curate-sidebar.md` step 2, before every placement",
        "use an existing group before inventing one",
        "`workflows/plan-structure.md`, only when no existing group fits",
        "`scripts/index-diff.mjs` at handoff, the session's built index against main's",
        "`scripts/sidebar-audit.mjs` for the load it adds",
        "`references/docs-and-ai-context.md` for an internal piece that keeps a story: `!autodocs` and `!manifest`",
    ):
        assert required in inputs, required
    copied = ("Top-level entries", "Children per group", "Atomic design", "collapsedRoots", "no-title-property-in-meta")
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        text = path.read_text()
        for phrase in copied:
            assert phrase not in text, (path.name, phrase)


def test_same_area_means_same_capability_not_same_folder() -> None:
    rule = paragraph(GUARDRAILS.read_text(), "is `vibe-storybook-decomposer`'s Placement")
    assert (
        'The "existing story files in the same area" that the repo skill\'s `workflows/author-stories.md` step 1 '
        "says to match are the stories for the same capability that block reports, read with "
        f"{TAXONOMY_DOC}, never the neighbors in the same folder."
    ) in rule
    pointer = '(`../skills/vibe/references/guardrails.md`, "Storybook taxonomy")'
    decomposer = flat(agent("vibe-storybook-decomposer"))
    assert f"are the same capability's, not the same folder's {pointer}" in decomposer
    writer = flat(agent("vibe-change-worker"))
    assert "The story files you match are the same capability's, not the same folder's (same section)." in writer
    holders = [path.name for path in sorted(PLUGIN_ROOT.rglob("*.md")) if "never the neighbors in the same folder" in flat(path.read_text())]
    assert holders == ["guardrails.md"]
