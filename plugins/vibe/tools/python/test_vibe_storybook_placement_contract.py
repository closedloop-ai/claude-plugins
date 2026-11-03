"""Contract checks for the 2026-10-14 operator ruling on Storybook placement.

1. `vibe-storybook-decomposer` owns Storybook placement. It stays read-only
   and runs during `$vibe` (the writer's `NEEDS_STORYBOOK`) before a story is
   created, retitled or moved or a shared component is added, and again at
   handoff.
2. Its precedent search finds every place a sibling entity already has the
   capability, through the graph and the built Storybook index, and reports
   all of it. The repo's Storybook docs decide where they say how; otherwise
   the precedent's structure is mirrored, never its root or version, and
   disagreeing precedents are broken by one stated tiebreak order.
   Placement never invents a location.
3. A conflict carries an audience and goes on the live ticket once: design
   conflicts under Design Review, everything else (or unclear) on the
   Engineering checklist, never in the Handoff section. Placement has no
   path that asks the person running the session.
4. The writer's owner prep looks for the precedent first and points at the
   repo's AGENTS.md shared-parent rule rather than restating it.
5. The page-scoped story check stays judgment-only in the guardrails
   reviewer; the handoff inventory gains no mechanical version of it.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section


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
        "every existing story that exercises it, with its title, story names, lifecycle tag and file",
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
        "Then: where the repo's "
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
        "the doc's Composites row, \"a section of a page\"",
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
    assert "Never route one to the person running the session." in flat(TICKET_TEMPLATE.read_text())
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
        'the repo\'s `AGENTS.md` ("Shared behavior belongs in the shared parent")',
        "mirror the precedent's ownership, component and Storybook structure, never its root or version",
        "already say how, follow them; where they do not",
    ):
        assert required in precedent, required
    assert "review-owned, no gate" not in text
    prep = flat(text)
    assert "- Precedent: <" in prep
    assert "- Placement: <the decomposer's Owner, Stories, Fixtures, Names and Conflict lines" in prep
    assert "or `precedent`>" in prep
    writer = flat(agent("vibe-change-worker"))
    assert "(`design-pass.md`, Prep step 5)" in writer


def test_handoff_and_ticket_record_the_placement() -> None:
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert "checked against the Placement blocks in the writer's local plan" in storybook
    assert "the live ticket's Storybook placement line" in storybook
    ticket = paragraph(TICKET_TEMPLATE.read_text(), "- Storybook placement:")
    assert "its placement and the doc section or precedent it follows, from the writer's Placement blocks" in ticket


def test_page_scoped_story_check_is_judgment_only() -> None:
    reviewer = agent("vibe-guardrails-reviewer")
    check = paragraph(reviewer, "11. Storybook placement")
    for required in (
        "judgment only; every finding here is advisory",
        "a new page-scoped story or page-specific composite for a capability a shared design-system component already provides",
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


MIRROR_STRUCTURE_ONLY = (
    "Mirroring copies structure only, never location or lifecycle: the root, lifecycle tag and "
    f"tree position always come from {TAXONOMY_DOC}, and a precedent in a v1.0 root never puts new work in v1.0."
)
TIEBREAK = (
    "mirror one precedent, chosen in this order: built on the same providing component, then already in the "
    "current roots, then most recently changed (the latest commit on main to its story file)"
)
CONFLICTS_RULE = '("Conflicts")'


def test_mirroring_copies_structure_never_root_or_version() -> None:
    search = section(agent("vibe-storybook-decomposer"), "## Precedent search")
    assert MIRROR_STRUCTURE_ONLY in search
    assert (
        "mirror the precedent: the same owner, the same way of consuming it, the component that carries its "
        "stories, how granular they are and which states get variants."
    ) in search
    assert "stories where its stories for that capability live" not in search
    assert "root and tag per <TAXONOMY.md section>, structure per <doc section> or mirroring <precedent>" in search
    assert "Storybook structure, never its root or version" in flat(DESIGN_PASS.read_text())
    assert "Storybook structure, never its root or version" in flat(agent("vibe-change-worker"))
    assert "the structure a sibling entity's precedent set, never its root or version" in flat(GUARDRAILS.read_text())
    for path in sorted(PLUGIN_ROOT.rglob("*.md")):
        assert "ownership, component and Storybook placement" not in flat(path.read_text()), path.name


def test_the_precedent_tiebreak_order_is_stated_once() -> None:
    conflict = paragraph(agent("vibe-storybook-decomposer"), "5. A precedent that disagrees")
    assert TIEBREAK in conflict
    assert conflict.index("same providing component") < conflict.index("current roots") < conflict.index("most recently changed")
    holders = [
        path.name
        for path in sorted(PLUGIN_ROOT.rglob("*.md"))
        if any(phrase in flat(path.read_text()) for phrase in ("same providing component", "most recently changed"))
    ]
    assert holders == ["vibe-storybook-decomposer.md"]


def test_the_template_routes_design_conflicts_to_design_review_and_the_rest_to_engineering() -> None:
    template = TICKET_TEMPLATE.read_text()
    rule = paragraph(template, "- Conflicts:")
    for required in (
        "goes in exactly one section, by its audience",
        "`design` (Storybook sidebar placement, taxonomy and story granularity, visual or UX choices) goes on Design Review's Design conflicts line",
        "`engineering` (everything else, including code ownership, which package or shared parent owns behavior, and duplication), and any entry without a clear audience, goes at the end of the Engineering checklist as",
        "`- [ ] Resolve conflict: <what disagreed>; decided: <how>; evidence: <doc section or precedent paths>`",
        "Each states the conflict, how the session decided it, and its evidence.",
    ):
        assert required in rule, required
    review = section(template, "## Design Review")
    assert "- Design conflicts: <each `design` conflict from the change log: what disagreed, how the session decided it, and the evidence (doc section or precedent paths)>" in review
    assert "| Engineering checklist | `vibe-ticket-worker` | session start; handoff appends engineering conflicts, forbidden-path needs, compile-only v1.0 repairs, engineering decisions and known main failures |" in template


def test_the_handoff_section_no_longer_collects_conflicts() -> None:
    handoff = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    assert "conflict" not in handoff.lower()
    assert "for engineering and design" not in handoff
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert "each placement and Conflict goes on the live ticket's Storybook placement line" not in storybook


def test_producers_carry_the_audience() -> None:
    decomposer = agent("vibe-storybook-decomposer")
    assert "- Conflict: <each disagreement: audience `design` or `engineering`, both sides quoted" in decomposer
    conflict = paragraph(decomposer, "5. A precedent that disagrees")
    assert f"its audience, `design` or `engineering`, by `../skills/vibe/references/ticket-template.md` {CONFLICTS_RULE}" in conflict
    assert "when unsure it is `engineering`" in conflict
    writer = paragraph(agent("vibe-change-worker"), "return `NEEDS_STORYBOOK` with the capability")
    for required in (
        "Log each Conflict (the block's Conflict line, or a precedent that disagrees with the owner rules in Prep step 5)",
        "`Conflict (design|engineering): <what disagreed>; decided: <how>; evidence: <doc section or precedent paths>`",
        f"`../skills/vibe/references/ticket-template.md` {CONFLICTS_RULE}, `engineering` when unsure",
    ):
        assert required in writer, required
    skill = paragraph(VIBE_SKILL.read_text(), "returns `NEEDS_STORYBOOK` with the capability")
    assert "logs a Conflict in it with its audience, `design` or `engineering`" in skill


def test_consumers_place_each_conflict_once_by_audience() -> None:
    ticket = flat(agent("vibe-ticket-worker"))
    for required in (
        "Place each `Conflict` entry in the change log once, by its audience (`../skills/vibe/references/ticket-template.md`, \"Conflicts\")",
        "`design` on Design Review's Design conflicts line; anything else, or no clear audience, as an unchecked item at the end of the Engineering checklist",
        "Never in the Handoff section, never in both, and never to the person.",
    ):
        assert required in ticket, required
    storybook = section(HANDOFF_SKILL.read_text(), "## 4. Storybook")
    assert "the ticket worker places it by that audience (`../vibe/references/ticket-template.md`, \"Conflicts\")" in storybook
    readme = paragraph(README.read_text(), "the read-only `vibe-storybook-decomposer` places it")
    assert "design conflicts under Design Review and everything else on the Engineering checklist" in readme
