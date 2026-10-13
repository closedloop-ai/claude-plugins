"""Contract checks for Daniel Ochoa's 2026-10-13 handoff follow-ups.

1. Handoff docs drafts cover only existing product docs pages under
   apps/web/content/docs/; the internal engineering docs/ folder belongs to
   engineering's pull request.
2. No worker writes or edits tests in vibe or handoff. Handoff runs the
   existing tests, fixes the session's own code, and lists the missing tests on
   the ticket as engineering's scope of work. Only the person's explicit request
   for a pull request authorizes tests, and then full tests come first.
3. Handoff drives the running web app and Desktop with symphony-alpha's control
   skill for each touched screen and records that evidence apart from
   source-only claims. The build loop has no control step.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
VIBE_SKILL = VIBE / "SKILL.md"
QUALITY = REFERENCES / "quality-loop.md"
GUARDRAILS = REFERENCES / "guardrails.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
CL_EXECUTE = PLUGIN_ROOT / "skills" / "cl-execute" / "SKILL.md"
CL_EXECUTE_GATES = PLUGIN_ROOT / "skills" / "cl-execute" / "references" / "planning-and-gates.md"
WORKERS_SRC = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src"
LAUNCHER_BUNDLE = VIBE / "scripts" / "dist" / "claude-worker.mjs"
CONTROL = "### Running app verification"
CONTROL_MODE = "## Control mode"
RETIRED_TEST_PHRASES = (
    "handoff-only test",
    "tests only at handoff",
    "Tests authored at handoff",
    "writes focused tests at handoff",
    "Test writing happens only here at handoff",
    "Only an explicitly authorized handoff turn",
    "planned handoff tests",
)
# Every `pnpm control` subcommand the plugin cites; each is a real command in
# symphony-alpha's `.claude/skills/control/references/cli.md`.
CONTROL_COMMANDS = {"feature", "up", "doctor", "goto", "wait", "capture", "console", "network", "api", "ipc", "down"}


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def agent(name: str) -> str:
    return (AGENTS / f"{name}.md").read_text()


def plugin_prose() -> dict[str, str]:
    paths = [*AGENTS.glob("*.md"), *(PLUGIN_ROOT / "skills").rglob("*.md"), PLUGIN_ROOT / "README.md"]
    return {str(path.relative_to(PLUGIN_ROOT)): path.read_text() for path in paths}


def test_handoff_docs_drafts_cover_only_existing_product_docs_pages() -> None:
    docs = section(GUARDRAILS.read_text(), "## Feature docs at handoff")
    assert "only existing product docs pages under `apps/web/content/docs/`" in docs
    assert "Never edit the repo's internal engineering `docs/` folder" in docs
    assert "Internal engineering docs belong to engineering's pull request" in docs
    assert "or any `docs/` edit, as outside the allowed paths" in docs
    assert "`docs/` (`.md`)" not in docs
    step = section(HANDOFF_SKILL.read_text(), "### Existing feature docs")
    assert "product docs pages under `apps/web/content/docs/`" in step
    assert "never edits the internal engineering `docs/` folder" in step
    assert "belong to engineering's pull request" in step
    writer = flat(agent("vibe-change-worker"))
    assert "never edit the internal engineering `docs/` folder, which belongs to engineering's pull request" in writer
    assert "any edit under the internal engineering `docs/` folder is blocking" in flat(agent("vibe-guardrails-reviewer"))
    feature_docs = section(TICKET_TEMPLATE.read_text(), "## Handoff")
    assert "existing product docs page under `apps/web/content/docs/`" in feature_docs
    assert "Internal engineering docs under `docs/` are left to engineering's pull request" in feature_docs
    for name, text in plugin_prose().items():
        assert "or `docs/`" not in text, name
        assert "internal docs under `docs/`" not in text, name


def test_the_inventory_has_no_internal_docs_allowance() -> None:
    inventory = INVENTORY.read_text()
    assert 'const PRODUCT_DOCS_PREFIX = "apps/web/content/docs/";' in inventory
    assert '{ prefix: "docs/"' not in inventory
    assert "HANDOFF_DOCS" not in inventory


def test_no_worker_writes_tests_in_vibe_or_handoff() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")
    for required in ("No worker writes or edits a test in vibe or handoff",
                     "in the build loop and at handoff alike", "Daniel Ochoa's ruling, 2026-10-13",
                     "Handoff runs the existing affected tests", "fixes the session's own code, never the test",
                     "listed on the live ticket under Missing tests as engineering's scope of work",
                     "the files to cover", "Engineering writes those tests in its pull request",
                     "alongside the tests for every frozen row", "the test stays unedited"):
        assert required in rule, required
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "Handoff writes no tests" in handoff
    assert "never the test" in section(HANDOFF_SKILL.read_text(), "## 5. Checks and the missing tests list")
    loop = section(QUALITY.read_text(), "## No test writing in vibe or handoff")
    for required in ("No test writing or editing in the build loop or at handoff",
                     "runs the existing affected tests", "never the test",
                     "lists every missing test as engineering's scope of work"):
        assert required in loop, required
    assert "A handoff turn never does" in section(QUALITY.read_text(), "## One persistent writer and a serial queue")
    for name in ("vibe-verify-worker", "vibe-backend-worker", "vibe-storybook-decomposer",
                 "vibe-adversarial-reviewer", "vibe-prototype-worker", "vibe-environment-worker"):
        text = flat(agent(name)).lower()
        assert "nobody writes tests in vibe or handoff" in text or "no test" in text \
            or "never author or edit tests" in text or "never write or edit a test" in text, name
    for name, text in plugin_prose().items():
        for retired in RETIRED_TEST_PHRASES:
            assert retired.lower() not in flat(text).lower(), (name, retired)


def test_the_handoff_ticket_lists_missing_tests_as_engineering_scope() -> None:
    template = TICKET_TEMPLATE.read_text()
    handoff = section(template, "## Handoff")
    assert "- Missing tests (engineering scope):" in handoff
    for required in ("which engineering writes in its pull request", "stable row ID",
                     "the files that need coverage", "Vibe and handoff write no tests"):
        assert required in handoff, required
    checklist = section(template, "## Engineering checklist")
    assert "Write the tests listed under Missing tests in the Handoff section" in checklist
    assert "a test for every frozen row" in checklist
    ticket = flat(agent("vibe-ticket-worker"))
    assert "the writer's missing tests list" in ticket
    assert "Missing tests lists every entry of the writer's missing tests list" in ticket
    gates = section(CL_EXECUTE_GATES.read_text(), "## Vibe Frozen Behavior")
    assert "lists the session's Missing tests as engineering's scope of work" in gates
    assert "write it in this PR" in gates
    assert "write every test the ticket lists under Missing tests" in flat(CL_EXECUTE.read_text())


def test_missing_tests_never_count_as_coverage_and_do_not_block_alignment() -> None:
    table = section(QUALITY.read_text(), "## Session decision table before code")
    assert "`Missing test (engineering)` disposition" in table
    assert "never counted as coverage" in table
    assert "a row whose only gap is a listed missing test does not block it" in table
    verify = section(agent("vibe-verify-worker"), "## Coverage advice and the missing tests list")
    assert "is on the writer's missing tests list" in verify
    assert "never counted as coverage and never written here" in verify


def test_only_an_explicit_pull_request_request_authorizes_full_tests() -> None:
    rule = section(GUARDRAILS.read_text(), "## Tests")
    assert "when the person explicitly asks for a pull request to be raised" in rule
    assert "full tests for every change in the session are required before it opens" in rule
    requested = section(HANDOFF_SKILL.read_text(), "## A requested pull request")
    for required in ("explicitly asks for a pull request to be raised", "`pull-request` mode",
                     "the only turn whose envelope authorizes tests", "every entry on the missing tests list",
                     "--phase pull-request", "does not open until those tests pass",
                     "Handoff itself still opens none"):
        assert required in requested, required
    writer = section(agent("vibe-change-worker"), "## No tests in this context unless a pull request is requested")
    assert "Only a `pull-request` continuation" in writer
    assert "full tests for every change in the session" in writer


def test_the_launcher_grants_test_authority_only_to_a_pull_request_turn() -> None:
    launcher = (WORKERS_SRC / "claude-worker.ts").read_text()
    assert 'testAuthoringAuthorized: persistent && input.mode === "pull-request"' in launcher
    assert 'input.mode === "handoff" }' not in launcher
    assert '"pull-request"' in (WORKERS_SRC / "record-context.ts").read_text()
    bundle = LAUNCHER_BUNDLE.read_text()
    assert 'testAuthoringAuthorized: persistent && input.mode === "pull-request"' in bundle
    assert "Never author tests in plan, request, fix, handoff, record or build turns" in bundle


def test_handoff_verifies_running_apps_with_the_control_skill() -> None:
    step = section(HANDOFF_SKILL.read_text(), CONTROL)
    for required in ("`vibe-verify-worker` in control mode", "`<repo-root>/.claude/skills/control/SKILL.md`",
                     "`pnpm control` CLI", "for each touched screen", "follows that skill's own rules",
                     "never `--headed`", "never a visible window on the person's Mac",
                     "Desktop runs displayless", "never `--allow-write`", "`pnpm control down`",
                     "API reads and Desktop IPC reads", "before and after when a baseline exists",
                     "exact control command and the reason, never as verified",
                     "Design Review's Visual evidence", "Running app checks line",
                     "separated from source-only claims", "The build loop has no control step",
                     "Owned prototype sessions skip this check"):
        assert required in step, required
    skill = HANDOFF_SKILL.read_text()
    step_eight = section(skill, "## 8. Choose who picks it up, then check the ticket")
    assert step_eight.index(CONTROL[4:]) < step_eight.index("Design Review evidence at handoff")
    assert "step 8's running app verification" in section(skill, "## Answers from the person")
    assert "`vibe-verify-worker` (control mode)" in section(skill, "## Workers")


def test_the_verify_worker_control_mode_cites_only_real_control_commands() -> None:
    mode = section(agent("vibe-verify-worker"), CONTROL_MODE)
    for required in ("`<repo-root>/.claude/skills/control/SKILL.md`", "`references/cli.md`",
                     "`pnpm control feature show <id>`", "`pnpm control up web --isolated`",
                     "`pnpm -C apps/desktop build`", "`pnpm control up desktop --mode e2e`",
                     "`pnpm control wait --settled`", "`pnpm control capture --name <id>-after`",
                     "`pnpm control console --level error`", "`pnpm control console --level pageerror`",
                     "`pnpm control network`", "`pnpm control api GET <path>`",
                     "`pnpm control ipc <namespace.method>`", "`pnpm control down --session <name>`",
                     "Never pass `--headed`", "Never pass `--allow-write`", "never use `eval` or `eval-main`",
                     "exact control command and the reason", "There is no control step in the build loop"):
        assert required in mode, required
    cited = set(re.findall(r"pnpm control ([a-z-]+)", mode))
    assert cited <= CONTROL_COMMANDS, cited - CONTROL_COMMANDS
    assert "`control`" in flat(agent("vibe-verify-worker"))


def test_control_evidence_lands_in_design_review_and_validation_records() -> None:
    template = TICKET_TEMPLATE.read_text()
    handoff = section(template, "## Handoff")
    assert "- Running app checks:" in handoff
    for required in ("`pnpm control` commands run at handoff", "each artifact path with what it proves",
                     "Keep these apart from source-only claims", "exact control command and the reason"):
        assert required in handoff, required
    visual = section(template, "## Design Review")
    assert "`pnpm control` captures from the Handoff Running app checks" in visual
    assert "uploaded as ticket attachments because `.control/` paths are local" in visual
    ticket = flat(agent("vibe-ticket-worker"))
    assert "Running app checks and Design Review's Visual evidence carry the control artifact paths" in ticket


def test_the_build_loop_has_no_control_step() -> None:
    assert "pnpm control" not in section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert "pnpm control" not in QUALITY.read_text()
    assert "pnpm control" not in flat(agent("vibe-change-worker"))


def test_new_text_uses_no_emdashes_or_double_hyphen_dashes() -> None:
    for name, text in plugin_prose().items():
        if name.startswith(("skills/cl-", "agents/vibe-seed")):
            continue
        assert "—" not in text, name
        assert " -- " not in text, name
