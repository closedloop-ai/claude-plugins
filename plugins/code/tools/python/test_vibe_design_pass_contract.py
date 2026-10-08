"""Contract checks for how vibe places shared behavior, uses closedloop-graph,
commits, and treats tests.

The build loop stays fast: a prep step picks the owner by rule (behavior two
screens share goes in their shared parent as a generic slot, screens opt in)
and every inspection waits for handoff. closedloop-graph is required and every
code worker reports its calls in a Graph block. No worker commits; the
orchestrator does. No worker writes or edits a test unless the person asks for
a pull request, and no pull request path exists.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
DESIGN_PASS = REFERENCES / "design-pass.md"
GRAPH = REFERENCES / "closedloop-graph.md"
GUARDRAILS = REFERENCES / "guardrails.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
SEED_SKILL = PLUGIN_ROOT / "skills" / "vibe-seed-refresh" / "SKILL.md"

PREP_FIELDS = (
    "- Screens:",
    "- Gates:",
    "- Shared parent:",
    "- Existing components:",
    "- Earlier work:",
    "- Memory:",
    "- Owner:",
    "- Rule:",
)
DESIGN_FIELDS = ("- Owner:", "- Shape:", "- Rejected:", "- Red flags:", "- Sweep:")
RED_FLAGS = ("Shallow module", "Information leakage", "Temporal decomposition", "Pass-through", "Copy")
REQUIRED_GRAPH_CALLS = ("code_symbols", "code_callers", "code_importers", "blast_radius_tickets")
CODE_WORKERS = (
    "vibe-change-worker",
    "vibe-backend-worker",
    "vibe-guardrails-reviewer",
    "vibe-adversarial-reviewer",
    "vibe-storybook-decomposer",
    "vibe-handoff-summarizer",
    "vibe-verify-worker",
    "vibe-primitive-worker",
    "vibe-prototype-worker",
    "vibe-requirements-worker",
)
# Every agent that the vibe, handoff, or vibe-seed-refresh skills dispatch.
VIBE_AGENTS = sorted(path.stem for path in AGENTS.glob("vibe-*.md"))
NON_GENERIC_NAMES = ("Sessions", "Branches", "GridTableListSurface", "bulk select", "ISS-12137")


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same level, flattened."""
    level = heading.split(" ", 1)[0]
    start = text.index(heading)
    rest = text[start + len(heading) :]
    end = rest.find(f"\n{level} ")
    return flat(rest if end == -1 else rest[:end])


def agent(name: str) -> str:
    return (AGENTS / f"{name}.md").read_text()


def fenced_block(text: str, first_line: str) -> str:
    start = text.index(f"```\n{first_line}")
    return text[start : text.index("```", start + 3)]


def test_owner_rules_put_shared_behavior_in_the_parent_as_a_generic_slot() -> None:
    rules = section(DESIGN_PASS.read_text(), "## Owner rules")

    assert "two or more screens or surfaces that render a shared parent goes into that parent" in rules
    assert "generic, domain-free slot or extension point" in rules
    assert "each screen opts in (one prop or one hook call) instead of reimplementing it" in rules
    assert "domain wiring (data hooks, API calls, nouns, labels) stays in the owning feature package" in rules
    assert "never copy it" in rules
    assert "never copied" in rules
    assert "Nobody asks the person where code goes" in rules


def test_prep_is_a_bounded_lookup_with_defined_fields() -> None:
    text = DESIGN_PASS.read_text()
    prep = section(text, "## Prep (build loop, one or two minutes)")
    block = fenced_block(text, "Prep:")

    assert "not a design session: no second design, no questions, no approval" in prep
    assert "`pnpm control feature show <id>`" in prep
    assert "`.claude/skills/control/feature-map.json`" in prep
    assert "`packages/design-system/storybook/component-catalog.ts`" in prep
    assert "`workflow-memory query --summary-only --repo symphony-alpha" in prep
    assert "`packages/app/AGENTS.md`" in prep
    assert "`Prep: trivial`" in prep
    for field in PREP_FIELDS:
        assert field in block, field
    assert "Graph:" in block


def test_build_loop_has_no_review_step_and_handoff_carries_the_depth() -> None:
    text = DESIGN_PASS.read_text()
    intro = flat(text[: text.index("## Owner rules")])
    red_flags = section(text, "### Red flags")
    restructure = section(text, "### Restructuring")
    design = fenced_block(text, "Design:")

    assert "every inspection (the red-flag screen, restructuring, the sibling sweep, reviews, running tests) waits for handoff" in intro
    assert "Nothing here waits on a ticket, a PRD, or a written plan" in intro
    for flag in RED_FLAGS:
        assert f"- {flag}:" in red_flags, flag
    assert "the strongest alternative rejected" in restructure
    assert "Sibling sweep" in restructure
    assert "no test is written or edited" in restructure
    for field in DESIGN_FIELDS:
        assert field in design, field
    assert "- Tests:" not in design
    assert "vibe-change-checker" not in text
    assert not (AGENTS / "vibe-change-checker.md").exists()
    assert not (AGENTS / "vibe-design-worker.md").exists()


def test_guidance_names_no_specific_screen_or_component() -> None:
    for path in (DESIGN_PASS, GRAPH):
        text = path.read_text()
        for name in NON_GENERIC_NAMES:
            assert name not in text, (path.name, name)
    rule = section(GUARDRAILS.read_text(), "## Where code goes")
    for name in NON_GENERIC_NAMES:
        assert name not in rule, name


def test_change_worker_preps_by_rule_and_names_the_owner_it_built_in() -> None:
    worker = flat(agent("vibe-change-worker"))

    assert "Run the prep step in `design-pass.md`" in worker
    assert "It takes a minute or two; it is not a design session and asks nobody anything." in worker
    assert "an opt-in slot other screens do not pass is not that question" in worker
    assert "Implement at the Prep's `Owner`" in worker
    assert "`PLAN` (plan dispatch): the Prep block (or `Prep: trivial`), the Graph block" in worker
    assert "`Owner: <path it built in>`, and the Graph block" in worker
    assert "the Prep's `Owner` and `Rule`" in worker


def test_graph_is_required_with_a_graph_block_and_no_routine_fallback() -> None:
    graph = GRAPH.read_text()
    required = section(graph, "## Required calls")
    unreachable = section(graph, "## When the server is unreachable")

    assert "It is required." in graph
    assert '"I didn\'t need it" is never a reason to skip it.' in flat(graph)
    change_row = next(line for line in graph.splitlines() if line.startswith("| `vibe-change-worker`"))
    for call in REQUIRED_GRAPH_CALLS:
        assert call in change_row, call
    for name in CODE_WORKERS:
        assert f"`{name}`" in required, name
    assert "exceptional setup problem, not a routine path" in unreachable
    assert "Only a connection failure counts" in unreachable
    assert "Graph: unreachable (<the exact connection error>)" in graph
    assert "dispatches `vibe-setup-worker` to restore the connection" in unreachable
    assert "optional" not in graph.lower()


def test_every_code_worker_ends_with_the_graph_block() -> None:
    for name in CODE_WORKERS:
        text = flat(agent(name))
        assert "Graph block" in text, name
        assert "whether closedloop-graph was available" not in text, name
        assert "Fall back to `rg` when it is unavailable" not in text, name


def test_orchestrators_send_back_a_result_without_graph_evidence() -> None:
    vibe = flat(VIBE_SKILL.read_text())
    handoff = flat(HANDOFF_SKILL.read_text())
    install = flat((VIBE / "INSTALL.md").read_text())
    setup = flat(agent("vibe-setup-worker"))

    for text in (vibe, handoff):
        assert "dispatch the worker again saying" in text
        assert "`vibe-setup-worker` to restore" in text
    assert "closedloop-graph is optional" not in vibe
    assert "closedloop-graph (ticket and code intelligence) is required" in install
    assert "closedloop-graph unreachable" in setup


def test_no_worker_commits_and_the_orchestrators_do() -> None:
    commit_phrases = ("make one commit", "commit with message", "commit, and push", "commit that one file")
    for name in VIBE_AGENTS:
        text = flat(agent(name))
        for phrase in commit_phrases:
            assert phrase not in text, (name, phrase)
    for name in ("vibe-change-worker", "vibe-backend-worker", "vibe-primitive-worker"):
        assert "the orchestrator commits" in flat(agent(name)), name
    environment = flat(agent("vibe-environment-worker"))
    assert "never commit: the orchestrator commits" in environment
    assert "`NEEDS_COMMIT`" in environment
    assert "never commits" in flat(agent("vibe-seed-pr-worker")).lower()
    assert "You never commit or push" in flat(agent("vibe-seed-fix-worker"))
    assert "`NEEDS_COMMIT`" in flat(agent("vibe-prototype-worker"))

    redeploy = section(VIBE_SKILL.read_text(), "## 6. Redeploy")
    assert "`node scripts/commit-worktree.mjs --worktree" in redeploy
    assert redeploy.index("commit-worktree.mjs") < redeploy.index("`vibe-environment-worker` in redeploy mode")
    upload = section(HANDOFF_SKILL.read_text(), "## 7. Upload the last changes")
    assert "`node ../vibe/scripts/commit-worktree.mjs --worktree" in upload
    assert upload.index("commit-worktree.mjs") < upload.index("`vibe-environment-worker` in redeploy mode")
    assert "commit-worktree.mjs" in flat(SEED_SKILL.read_text())


def test_build_loop_redeploy_runs_no_tests_but_handoff_still_does() -> None:
    environment = flat(agent("vibe-environment-worker"))
    handoff = HANDOFF_SKILL.read_text()

    assert "Only when the dispatch comes from handoff, run the tests before pushing" in environment
    assert "A build-loop redeploy runs no tests; they wait for handoff." in environment
    assert "Lighter: dispatch `vibe-verify-worker` in checks mode" in section(handoff, "## 5. Checks")
    assert "Backend: dispatch `vibe-verify-worker` in full-suite mode" in section(handoff, "## 5. Checks")


def test_tests_are_never_written_unless_a_pull_request_is_asked_for() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")

    assert "No worker in vibe or handoff writes or edits a test, in the build loop or at handoff" in rule
    assert "Tests are engineering's job" in rule
    assert "an existing test is never edited, weakened, or skipped" in rule
    assert "The only exception: when the person explicitly asks for a pull request to be raised" in rule
    assert "full tests for all of the session's changes are written before the pull request is opened" in rule
    assert "Neither vibe nor handoff opens a pull request today" in rule

    for skill in (VIBE_SKILL, HANDOFF_SKILL):
        assert "writes or edits a test" in flat(skill.read_text()), skill.name
    assert "a finding that asks for a new or changed test is not sent to a fixing worker" in flat(
        HANDOFF_SKILL.read_text()
    )


def test_no_vibe_or_handoff_worker_has_a_test_writing_step() -> None:
    writing_steps = (
        "tests in `packages/design-system/__tests__/`",
        "its tests go in",
        "route and service tests for every row",
        "migration DDL test",
        "update that assertion",
        "is fixed by writing that test",
    )
    for path in [AGENTS / f"{name}.md" for name in VIBE_AGENTS if not name.startswith("vibe-seed-")] + [
        GUARDRAILS,
        DESIGN_PASS,
        VIBE_SKILL,
        HANDOFF_SKILL,
    ]:
        text = flat(path.read_text())
        for step in writing_steps:
            assert step not in text, (path.name, step)
    for name in ("vibe-change-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-storybook-decomposer", "vibe-verify-worker"):
        assert "Never write" in flat(agent(name)) or "never write" in flat(agent(name)), name


def test_reviewers_flag_placement_red_flags_and_test_edits() -> None:
    guardrails = flat(agent("vibe-guardrails-reviewer"))
    adversarial = flat(agent("vibe-adversarial-reviewer"))

    for flag in ("shallow module", "information leakage", "temporal decomposition", "pass-through", "copy"):
        assert flag in guardrails, flag
    assert "each implement the same behavior is blocking" in guardrails
    assert "any added or changed test file" in guardrails
    assert "the person is not involved" in guardrails
    assert "find an input on which the copies already behave differently" in adversarial


def test_ticket_carries_design_decisions_and_no_test_edit_field() -> None:
    handoff = section(TICKET_TEMPLATE.read_text(), "## Handoff")

    assert "- Design decisions:" in handoff
    assert "old-UI assertions were updated" not in handoff
    assert "left for engineering to update (vibe never edits tests)" in handoff


def test_new_files_use_no_emdashes_or_double_hyphen_dashes() -> None:
    for path in (DESIGN_PASS, GRAPH, VIBE / "scripts" / "commit-worktree.mjs"):
        text = path.read_text()
        assert "—" not in text, path.name
        assert " -- " not in text, path.name
