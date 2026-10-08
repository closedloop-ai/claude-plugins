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
    assert "one workflow-memory query when available" in worker
    assert "behavior shared by children belongs in the generic shared parent" in worker
    assert "domain wiring stays in its feature package" in worker
    assert "owning parent first, then child opt-ins" in worker
    assert "Return `PLAN` with its local path, Prep and Graph blocks" in worker
    assert "Owner/Rule, files" in worker
    assert "required Graph block" in worker


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
    for name in ("vibe-change-worker", "vibe-primitive-worker"):
        assert "the orchestrator commits" in flat(agent(name)), name
    assert "Never commit" in flat(agent("vibe-backend-worker"))
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
    checks = section(handoff, "## 5. Checks and handoff-only tests")
    assert "Lighter: read-only verify checks mode" in checks
    assert "Backend: full-suite mode" in checks
    assert "Resume the SAME writer with an explicit handoff continuation" in checks
    assert "The verify worker never writes or fixes tests" in checks


def test_tests_are_authored_only_at_handoff_without_weakening_expectations() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")

    assert "No build-loop worker writes or edits a test" in rule
    assert "Test writing happens only at handoff through the SAME persistent `vibe-change-worker` in handoff mode" in rule
    assert "Record phase, criteria and test paths" in rule
    assert "exact human behavior ruling" in rule
    assert "retain coverage of every still-live contract" in rule
    assert "Never loosen, skip or remove a valid test" in rule
    assert "No PR is opened by either vibe or handoff" in rule

    assert "Existing tests may run; none are authored yet" in flat(VIBE_SKILL.read_text())
    assert "Reject early/unrecorded edits" in flat(HANDOFF_SKILL.read_text())
    assert "Missing handoff coverage is written only by that writer" in flat(HANDOFF_SKILL.read_text())


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
    for name in ("vibe-primitive-worker", "vibe-storybook-decomposer"):
        assert "Never write" in flat(agent(name)) or "never write" in flat(agent(name)), name
    assert "never create/edit code, migrations, seeds, tests" in flat(agent("vibe-backend-worker"))
    tests_mode = section(agent("vibe-change-worker"), "## Handoff tests in this same context")
    assert "Only an explicit handoff continuation authorizes you" in tests_mode
    assert "production wiring" in tests_mode
    assert "No skips, loosened assertions, raised tolerances/timeouts" in tests_mode
    assert "never create/edit implementation code, tests" in flat(agent("vibe-verify-worker"))


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
    planning = section(QUALITY.read_text(), "## Local plan and separate review")
    assert "`$plan-structure` in Codex" in planning
    assert "`/closedloop-core:plan-structure` in Claude Code" in planning
    assert "from that skill's own folder" in planning
    assert "use its exact headings and order" in planning
    assert "`.closedloop-ai/vibe-plans/<request-id>.md`" in planning
    assert "Never copy the template between plugins" in planning
    assert "never commit, deploy, paste it into the ticket or upload it" in planning
    assert "refuses a plan already in HEAD" in planning
    for name in ("vibe-environment-worker", "vibe-prototype-worker"):
        worker = flat(agent(name))
        assert "local-plans.mjs --worktree" in worker
        assert "publishes nothing" in worker or "publish nothing" in worker or "blocks publication" in worker


def test_plan_review_precedes_same_writer_build_and_implementation_review_precedes_completion() -> None:
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert loop.index("writes the canonical core-template plan locally") < loop.index("separate read-only adversarial plan reviewer")
    assert loop.index("Recheck confirmed corrections before implementation") < loop.index("Resume that writer to implement")
    assert loop.index("independent read-only implementation reviews") < loop.index("whole requested feature passed")
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
        assert f"closedloop-core:{skill}" in text or f"named core {skill}" in text


def test_one_persistent_writer_keeps_a_serial_queue_and_serial_record_owners() -> None:
    queue = section(QUALITY.read_text(), "## One persistent writer and a serial queue")
    assert "same writer in order" in queue
    assert "Keep one active request" in queue
    assert "does not authorize starting the next queued request or a fresh writer" in queue
    assert "Researchers and independent reviewers may run in parallel, read-only" in queue
    assert "Never dispatch another source or test writer" in queue
    assert "Serialize session JSON, ticket and change-log mutations" in queue
    assert "Deployment waits for the writer, reviews and the orchestrator's commit" in queue
    assert "explicit serial record continuation" in section(VIBE_SKILL.read_text(), "## 5. Build loop")
    for name in ("vibe-backend-worker", "vibe-primitive-worker", "vibe-storybook-decomposer", "vibe-verify-worker"):
        frontmatter = yaml.safe_load(agent(name).split("---", 2)[1])
        allowed = {tool.strip() for tool in frontmatter["tools"].split(",")}
        assert "Write" not in allowed and "Edit" not in allowed, name


def test_questions_are_researched_and_technical_updates_never_reach_andy() -> None:
    communication = section(QUALITY.read_text(), "## Communication and product questions")
    for route in ("ticket_detail", "fts_search", "search_memory_facts"):
        assert route in communication
    assert "live ClosedLoop" in communication
    assert "Apply settled decisions; never ask them again" in communication
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
    assert start.index("independent current-result review/checks") < start.index("orchestrator commits")
    assert start.index("orchestrator commits") < start.index("operational share mode")
    assert "Do not spawn a separate prototype source writer" in start
    prototype = flat(agent("vibe-prototype-worker"))
    assert "return `NEEDS_REVIEW` or `NEEDS_COMMIT` and change no source" in prototype
    assert "current-result evidence" in prototype
    assert "does not follow steps that create another worktree, source writer or technical-plan approval" in prototype
    assert "Preserve genuine visual/product approval" in prototype
    handoff = section(HANDOFF_SKILL.read_text(), "### Owned prototype sessions")
    assert "`NEEDS_REVIEW`/`NEEDS_COMMIT` returns to the same writer/root sequence" in handoff
    assert "Source generation or metadata fixes resume this SAME writer" in handoff
    assert "Preserve the already completed design-review outcome" in handoff
    assert "require every gate, including current publication" in handoff


def test_handoff_cannot_relabel_early_tests_and_displayless_coverage_is_not_silently_skipped() -> None:
    guardrail_check = section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    assert "never retrospectively relabel" in guardrail_check
    assert "before test authoring" in guardrail_check.lower()
    verify = flat(agent("vibe-verify-worker"))
    assert "except Desktop e2e" not in verify
    assert "documented supported displayless harness" in verify
    assert "never a visible fallback" in verify
    assert "Never trigger CI/reviews manually" in verify
    assert "All modes involving code or coverage end with the required Graph block" in verify
    adversarial = flat(agent("vibe-adversarial-reviewer"))
    assert "needed new-test coverage is recorded in the local plan for handoff" in adversarial
    assert "not an instruction to author tests early" in adversarial
