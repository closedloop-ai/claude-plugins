"""Contract checks for how vibe places shared behavior, uses closedloop-graph,
commits, and treats tests.

The prep step picks the owner by rule (behavior the
children of a shared parent share goes in that parent as a generic slot, and
each child keeps only what is specific to it)
and the quality loop uses internal local plans and independent reviews before
handoff. Daniel's ISS-12135 ruling moves test authoring to handoff only and
keeps technical communication internal. Existing tests may run while building.
Graph evidence, worker commit ownership and shared-owner rules remain unchanged.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
DESIGN_PASS = REFERENCES / "design-pass.md"
QUALITY = REFERENCES / "quality-loop.md"
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
    where = section(GUARDRAILS.read_text(), "## Where code goes")

    for text in (rules, where):
        assert "any component that composes or inherits from a shared parent" in text.lower()
        assert "a child keeps only what is specific to that child" in text
        assert "generic, domain-free slot or extension point" in text
    assert "Behavior that the children of a shared parent share goes into that parent" in rules
    assert "each child opts in (one prop or one hook call) instead of reimplementing it" in rules
    assert "two or more screens" not in rules
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


def test_build_loop_reviews_before_handoff_and_preserves_design_depth() -> None:
    text = DESIGN_PASS.read_text()
    intro = flat(text[: text.index("## Owner rules")])
    red_flags = section(text, "### Red flags")
    restructure = section(text, "### Restructuring")
    design = fenced_block(text, "Design:")

    assert "separate plan review and implementation corrections internal and before handoff" in intro
    assert "Existing tests may run during building" in intro
    assert "test writing happens only at handoff" in intro
    for flag in RED_FLAGS:
        assert f"- {flag}:" in red_flags, flag
    assert "the strongest alternative rejected" in restructure
    assert "Sibling sweep" in restructure
    assert "test writing waits for handoff" in restructure
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
    assert "an opt-in slot other children do not pass is not that question" in worker
    assert "only child-specific behavior in the child" in worker
    assert "Implement at the Prep's `Owner`" in worker
    assert "`PLAN` (plan dispatch): the local plan path, Prep block (or `Prep: trivial`), Graph block" in worker
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


def test_build_loop_runs_existing_checks_and_handoff_adds_tests() -> None:
    environment = flat(agent("vibe-environment-worker"))
    handoff = HANDOFF_SKILL.read_text()

    assert "Run the existing affected tests before pushing" in environment
    assert "Never write or edit tests in deployment mode" in environment
    assert "Lighter: dispatch `vibe-verify-worker` in checks mode" in section(handoff, "## 5. Checks")
    assert "Backend: dispatch `vibe-verify-worker` in full-suite mode" in section(handoff, "## 5. Checks")
    assert "`tests` mode with explicit phase `handoff`" in section(handoff, "## 5. Checks")


def test_tests_are_authored_only_at_handoff_without_weakening_expectations() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")

    assert "No build-loop worker writes or edits a test" in rule
    assert "Test writing happens only at handoff through `vibe-verify-worker` in `tests` mode" in rule
    assert "explicit handoff phase" in rule
    assert "exact human behavior ruling" in rule
    assert "retain coverage of every still-live contract" in rule
    assert "Never loosen, skip or remove a valid test" in rule
    assert "No PR is opened by either vibe or handoff" in rule

    assert "No build-loop worker writes or edits a test" in flat(VIBE_SKILL.read_text())
    assert "Build-loop workers never write or edit tests" in flat(HANDOFF_SKILL.read_text())
    assert "confirmed missing-test finding to `vibe-verify-worker` in `tests` mode" in flat(HANDOFF_SKILL.read_text())


def test_build_workers_do_not_author_tests_and_handoff_tests_mode_is_explicit() -> None:
    writing_steps = (
        "tests in `packages/design-system/__tests__/`",
        "its tests go in",
        "route and service tests for every row",
        "migration DDL test",
        "update that assertion",
        "is fixed by writing that test",
    )
    for path in [AGENTS / f"{name}.md" for name in VIBE_AGENTS if not name.startswith("vibe-seed-")] + [
    ]:
        text = flat(path.read_text())
        for step in writing_steps:
            assert step not in text, (path.name, step)
    for name in ("vibe-change-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-storybook-decomposer"):
        assert "Never write" in flat(agent(name)) or "never write" in flat(agent(name)), name
    tests_mode = section(agent("vibe-verify-worker"), "## Tests mode (handoff only)")
    assert "If phase is not explicitly `handoff`, return `BLOCKED` without editing tests" in tests_mode
    assert "production wiring" in tests_mode
    assert "Never weaken tests or checks" in tests_mode


def test_reviewers_flag_placement_red_flags_and_test_edits() -> None:
    guardrails = flat(agent("vibe-guardrails-reviewer"))
    adversarial = flat(agent("vibe-adversarial-reviewer"))

    for flag in ("shallow module", "information leakage", "temporal decomposition", "pass-through", "copy"):
        assert flag in guardrails, flag
    assert "two children of one parent that each implement the same behavior is blocking" in guardrails
    assert "keeps only what is specific to it" in guardrails
    assert "an added or changed test file" in guardrails
    assert "only in the handoff phase" in guardrails
    assert "Early or unrecorded changes are blocking" in guardrails
    assert "the person is not involved" in guardrails
    assert "find an input on which the copies already behave differently" in adversarial


def test_ticket_carries_design_decisions_and_truthful_handoff_test_evidence() -> None:
    handoff = section(TICKET_TEMPLATE.read_text(), "## Handoff")

    assert "- Design decisions:" in handoff
    assert "old-UI assertions were updated" not in handoff
    assert "Tests authored at handoff" in handoff
    assert "exact human behavior ruling" in handoff


def test_new_files_use_no_emdashes_or_double_hyphen_dashes() -> None:
    for path in (DESIGN_PASS, GRAPH, QUALITY, VIBE / "scripts" / "commit-worktree.mjs", VIBE / "scripts" / "local-plans.mjs"):
        text = path.read_text()
        assert "—" not in text, path.name
        assert " -- " not in text, path.name


def test_local_plan_uses_core_by_name_and_never_becomes_a_ticket_or_deployment() -> None:
    planning = section(QUALITY.read_text(), "## Local plan and adversarial plan review")
    assert "`$plan-structure` in Codex" in planning
    assert "`/closedloop-core:plan-structure` in Claude Code" in planning
    assert "from that loaded skill's own folder" in planning
    assert "Use its exact headings and order" in planning
    assert "`.closedloop-ai/vibe-plans/<request-id>.md`" in planning
    assert "Never copy the template into this plugin" in planning
    assert "put its body in the ticket or upload it" in planning
    assert "commit script refuses a plan already in HEAD" in planning
    for name in ("vibe-environment-worker", "vibe-prototype-worker"):
        worker = flat(agent(name))
        assert "local-plans.mjs --worktree" in worker
        assert "publishes nothing" in worker or "publish nothing" in worker


def test_plan_review_precedes_parallel_build_and_implementation_review_precedes_completion() -> None:
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert loop.index("in plan mode") < loop.index("separate `vibe-adversarial-reviewer` in plan mode")
    assert loop.index("recheck the revision before implementing") < loop.index("independent planned units in parallel")
    assert loop.index("implementation reviews, corrections") < loop.index("whole feature passes these gates")
    review = section(agent("vibe-adversarial-reviewer"), "## Plan mode")
    assert "separate reviewer rechecks confirmed plan corrections before code is built" in review
    assert "PLAN_REVIEW: CLEAN" in review
    assert "PLAN_REVIEW: NEEDS_CHANGE" in review


def test_registered_claude_plan_callers_can_invoke_the_named_core_skill() -> None:
    callers = {
        "vibe-change-worker": "plan-structure",
        "vibe-prototype-worker": "plan-structure",
        "vibe-adversarial-reviewer": "plan-structure",
        "vibe-backend-worker": "decision-table",
    }
    for name, skill in callers.items():
        frontmatter = yaml.safe_load(agent(name).split("---", 2)[1])
        allowed = {tool.strip() for tool in frontmatter["tools"].split(",")}
        assert "Skill" in allowed, name
        text = flat(agent(name))
        assert f"closedloop-core:{skill}" in text or f"named core {skill} skill" in text


def test_parallel_work_keeps_one_frozen_plan_and_serial_record_owners() -> None:
    parallel = section(QUALITY.read_text(), "## Parallel implementation and corrections")
    assert "writer ownership does not overlap" in parallel
    assert "Wait for prerequisites before dependent units" in parallel
    assert "reviewed plan is stable during an implementation wave" in parallel
    assert "Aggregate all wave results before revising it or recording progress" in parallel
    assert "at most one setup, environment, prototype or ticket worker" in parallel
    assert "Different source files do not make generator/publication writes independent" in parallel
    assert "`deferRecords` true" in parallel
    for name in ("vibe-change-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-prototype-worker"):
        assert "deferRecords" in agent(name), name
    assert "in record mode" in section(VIBE_SKILL.read_text(), "## 5. Build loop")


def test_questions_are_researched_and_technical_updates_never_reach_andy() -> None:
    communication = section(QUALITY.read_text(), "## Communication and product questions")
    for route in ("ticket_detail", "fts_search", "search_memory_facts"):
        assert route in communication
    assert "live ClosedLoop" in communication
    assert "A settled decision is applied, never asked again" in communication
    assert "absolutely necessary unresolved product question, one at a time with full context" in communication
    assert "Do not show or ask the person to approve a technical plan" in communication
    assert "Updates say only which requested feature is complete" in communication
    for name in ("vibe-requirements-worker", "vibe-change-worker", "vibe-backend-worker", "vibe-primitive-worker", "vibe-prototype-worker", "vibe-ticket-worker", "vibe-setup-worker", "vibe-environment-worker"):
        assert "quality-loop.md" in agent(name), name
    summary = section(HANDOFF_SKILL.read_text(), "## 2. Summarize internally")
    assert "Keep the summary internal" in summary
    assert "ask them to confirm" not in summary


def test_initial_prototype_commit_and_share_require_independent_quality_evidence() -> None:
    start = section(VIBE_SKILL.read_text(), "## 2. Start or resume")
    assert "On `NEEDS_REVIEW`, dispatch the guardrails and adversarial implementation reviewers" in start
    assert "initial mockup publication bypass" in start
    prototype = flat(agent("vibe-prototype-worker"))
    assert "Stop before a canonical commit or share with `NEEDS_REVIEW`" in prototype
    assert "separate current-result implementation review and verification evidence" in prototype
    assert "Override canonical prompts asking the person to confirm a structural plan or shared-surface owner" in prototype
    assert "Preserve genuine visual/product design approvals" in prototype
    handoff = section(HANDOFF_SKILL.read_text(), "### Owned prototype sessions")
    assert "At every prototype recovery share or prepare-handoff call, route `NEEDS_REVIEW`" in handoff
    assert "Fix and recheck the current diff, then resume the same canonical worker" in handoff
    assert "keep its single completed design review" in handoff
    assert "require every gate, including publication freshness" in handoff


def test_handoff_cannot_relabel_early_tests_and_displayless_coverage_is_not_silently_skipped() -> None:
    guardrail_check = section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    assert "not retrospectively relabeled" in guardrail_check
    assert "before test authoring" in guardrail_check.lower()
    verify = flat(agent("vibe-verify-worker"))
    assert "except Desktop e2e" not in verify
    assert "supported displayless harness" in verify
    assert "never fall back to a visible window or manually dispatch CI" in verify
    assert "checks, full-suite and tests modes, end with the Graph block" in verify
    adversarial = flat(agent("vibe-adversarial-reviewer"))
    assert "needed new-test coverage is recorded in the local plan for handoff" in adversarial
    assert "not an instruction to author tests early" in adversarial
