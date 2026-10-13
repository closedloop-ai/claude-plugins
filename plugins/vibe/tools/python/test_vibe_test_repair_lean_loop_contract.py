"""Contract checks for Daniel Ochoa's 2026-10-13 rulings after the PRD-720 live test.

1. Repair, don't author. When the session's own change breaks existing tests or
   fixtures, the writer may mechanically update them so the tree compiles and
   the hooks pass, without changing what any test asserts. No new tests or
   coverage; those stay on Missing tests. The guardrails reviewer checks the
   repairs, and the person is never asked about tests or engineering choices.
2. Lean build loop. Quick prep, build, the quick checks the commit hooks need,
   the orchestrator's commit, deploy, show the person. Browser E2E, visual QA,
   logical QA, Metal Andrew, the adversarial and guardrails reviews and other
   heavy validation run only at handoff. The two notices stay as they are.
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
DESIGN_PASS = REFERENCES / "design-pass.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
WORKERS_SRC = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src"
LAUNCHER_BUNDLE = VIBE / "scripts" / "dist" / "claude-worker.mjs"
NO_ENGINEERING_QUESTIONS = "Never ask the person about tests or any other engineering choice"
HEAVY_VALIDATION = ("Browser E2E", "visual QA", "logical QA", "Metal Andrew")
QA_SKILLS = ("/visual-qa", "/logical-qa", "/metal-andrew")


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


def repair_modes(source: str) -> set[str]:
    match = re.search(r"TEST_REPAIR_MODES(?::[^=]+)? = (?:/\* @__PURE__ \*/ )?new Set\(\[([^\]]*)\]\)", source)
    assert match, "TEST_REPAIR_MODES is missing"
    return set(re.findall(r'"([a-z-]+)"', match.group(1)))


def test_guardrails_allow_repairs_that_change_no_assertion() -> None:
    rule = section(GUARDRAILS.read_text(), "### Repair, don't author")
    for required in ("breaks an EXISTING test or test fixture",
                     "an import, a renamed or retired symbol, setup, a type error",
                     "mechanically updates that existing file so the tree compiles and the commit hooks pass",
                     "in the build loop or at handoff", "after the PRD-720 live test",
                     "A repair never changes what any test asserts", "no weakened or deleted assertion",
                     "no changed expected value or snapshot", "no new skip",
                     "no loosened matcher, tolerance or timeout",
                     "It adds no test file, no case and no coverage; new tests still go on Missing tests",
                     "records each repaired file in the session change log as a repair", "`testRepairs`",
                     "`vibe-guardrails-reviewer` checks that every repair left each assertion unchanged",
                     "that is not a repair: the test stays unedited", "the blocked commit goes to engineering",
                     NO_ENGINEERING_QUESTIONS):
        assert required in rule, required
    tests = section(GUARDRAILS.read_text(), "## Tests")
    assert "No worker authors a test in vibe or handoff" in tests
    assert "and no deleted test" in tests


def test_no_surface_asks_the_person_about_tests() -> None:
    for path in (VIBE_SKILL, HANDOFF_SKILL, QUALITY, GUARDRAILS):
        text = flat(path.read_text())
        assert NO_ENGINEERING_QUESTIONS in text or "never ask the person about tests" in text.lower(), path.name
    writer = section(agent("vibe-change-worker"), "## Tests: repair, don't author")
    assert "Never return `NEEDS_PERSON` about a test or any other engineering choice" in writer
    assert "return `BLOCKED` for engineering" in writer
    escalation = section(VIBE_SKILL.read_text(), "## 6. Redeploy")
    assert "this part needs engineering" in escalation
    assert "never ask them to decide it" in escalation


def test_the_writer_repairs_in_loop_and_handoff_turns_and_records_each_repair() -> None:
    writer = section(agent("vibe-change-worker"), "## Tests: repair, don't author")
    for required in ("Never author tests, fixtures or snapshots while building or at handoff",
                     "repair it in a request, fix or handoff turn",
                     "Change only what makes it compile; never what it asserts",
                     "Record each repaired file in the change log as a repair"):
        assert required in writer, required
    loop = section(QUALITY.read_text(), "## Tests: repair, don't author")
    assert "repairs an existing test or fixture its own change broke" in loop
    assert "without changing what any test asserts" in loop


def test_the_inventory_lists_repairs_and_rejects_authored_test_files() -> None:
    inventory = INVENTORY.read_text()
    assert "testRepairs," in inventory
    assert 'file.status === "M" && isTestFile(file.path) && !SNAPSHOT_PATTERN.test(file.path)' in inventory
    assert 'isTestRepair(file) || (values.phase === "pull-request" && isPullRequestTest(file))' in inventory


def test_the_launcher_grants_repair_authority_separately_from_test_authoring() -> None:
    launcher = (WORKERS_SRC / "claude-worker.ts").read_text()
    assert 'testAuthoringAuthorized: persistent && input.mode === "pull-request"' in launcher
    assert "testRepairAuthorized: persistent && TEST_REPAIR_MODES.has(input.mode)" in launcher
    assert repair_modes(launcher) == {"request", "fix", "handoff", "pull-request"}
    bundle = LAUNCHER_BUNDLE.read_text()
    assert "testRepairAuthorized: persistent && TEST_REPAIR_MODES.has(input.mode)" in bundle
    assert repair_modes(bundle) == {"request", "fix", "handoff", "pull-request"}
    assert "may only repair existing tests and fixtures your own change broke" in bundle
    envelope = section(QUALITY.read_text(), "## One persistent writer and a serial queue")
    assert "`authority.testRepairAuthorized`" in envelope
    assert "Plan, record and every other role's turns carry neither" in envelope


def test_reviewers_check_that_repairs_changed_no_assertion() -> None:
    guardrails = flat(agent("vibe-guardrails-reviewer"))
    for required in ("A test repair (the inventory's `testRepairs`", "Read each repair's diff against its base",
                     "any changed assertion, expected value, matcher, case, skip, tolerance or timeout is blocking",
                     "a repair the change log does not record as one"):
        assert required in guardrails, required
    assert "a repair that changes what a test asserts" in flat(agent("vibe-adversarial-reviewer"))
    assert "recorded repair that changes no assertion" in flat(agent("vibe-verify-worker"))
    check = section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    assert "except the inventory's `testRepairs` whose diffs it confirms changed no assertion" in check
    assert "the inventory's `testRepairs`" in section(HANDOFF_SKILL.read_text(), "## 6. Independent integrated review")


def test_the_build_loop_is_lean() -> None:
    lean = section(QUALITY.read_text(), "## Lean build loop")
    for required in ("quick prep, the build, the quick checks the commit hooks need, the orchestrator's commit, "
                     "deploy, and showing the person", "with no plan review",
                     "Biome on the changed files, the affected typecheck and the source gates",
                     "the guardrails and adversarial reviews", "`workflow-code-review`",
                     "run only at `$handoff`, never during the loop", "handoff runs them",
                     "notices (`SKILL.md`, section 5, \"Notices that never wait\") stay as they are"):
        assert required in lean, required
    for heavy in HEAVY_VALIDATION:
        assert heavy in lean, heavy
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    for required in ("There is no plan review",
                     "The writer runs only the quick checks the commit hooks need",
                     "handoff runs them", "independent reviews come at handoff"):
        assert required in loop, required
    for retired in ("adversarial plan reviewer", "On `NEEDS_REVIEW`, run independent",
                    "passed its required checks and independent reviews"):
        assert retired not in loop, retired
    for skill in QA_SKILLS:
        assert skill not in loop, skill
        assert skill not in QUALITY.read_text(), skill


def test_reviewers_run_only_at_handoff() -> None:
    for name in ("vibe-guardrails-reviewer", "vibe-adversarial-reviewer"):
        assert "never during the build loop" in flat(agent(name)), name
    assert "on demand during a vibe session" not in agent("vibe-guardrails-reviewer")
    assert "## Plan mode" not in agent("vibe-adversarial-reviewer")
    assert "## Quality depth at handoff" in DESIGN_PASS.read_text()
    assert "Both run at handoff" in flat(DESIGN_PASS.read_text())
    writer = flat(agent("vibe-change-worker"))
    assert "do not run or request them in the loop" in writer
    assert "Wait for the separate adversarial plan review" not in writer


def test_handoff_runs_the_heavy_validation_the_loop_skips() -> None:
    skill = HANDOFF_SKILL.read_text()
    qa = section(skill, "### Browser E2E and the repository's QA passes")
    assert "never in the build loop" in qa
    assert "Browser E2E runs headless" in qa
    for skill_name in QA_SKILLS:
        assert f"`{skill_name}`" in qa, skill_name
    assert "Confirmed findings resume the SAME writer" in qa
    intro = flat(skill[: skill.index("## Answers from the person")])
    for heavy in ("the guardrails and adversarial reviews", "browser E2E", "visual QA", "logical QA", "Metal Andrew"):
        assert heavy in intro, heavy


def test_the_two_notices_stay_as_they_are() -> None:
    notices = section(VIBE_SKILL.read_text(), "### Notices that never wait")
    assert "Reference product." in notices
    assert "New Storybook components." in notices
    assert "`STORIES_READY`" in notices
    assert "never approval gates" in flat(QUALITY.read_text())
