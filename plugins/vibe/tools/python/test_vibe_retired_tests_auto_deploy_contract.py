"""Contract checks for Daniel Ochoa's 2026-10-13 follow-up rulings to the lean build loop.

1. Retired-only tests may be deleted. The writer may delete a test file or case
   that covers only code the request itself retires, citing the ticket or PRD
   that retires it and recording the deletion so the ticket lists it next to
   Missing tests. A test of live behavior is only repaired. The inventory admits
   a deleted test file outside a pull request only with that record, and the
   guardrails reviewer verifies the deleted test covered only retired code.
2. Auto-deploy. After each change in the build loop the orchestrator commits
   and deploys without being asked, then tells the person it is ready to look
   at; "redeploy" still works, and changes arriving during a deploy go out
   together in the next one.
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
ENVIRONMENT = REFERENCES / "environment.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
INVENTORY = PLUGIN_ROOT / "skills" / "handoff" / "scripts" / "handoff-inventory.mjs"
RECORDER = VIBE / "scripts" / "retired-tests.mjs"
WORKERS_SRC = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src"
LAUNCHER_BUNDLE = VIBE / "scripts" / "dist" / "claude-worker.mjs"
DEPLOY = "## 6. Deploy each change"
LAUNCHER_DELETION = "Delete a test file or case only when it covers nothing but code the request retires"


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


def test_only_tests_of_retired_code_may_be_deleted() -> None:
    rule = section(GUARDRAILS.read_text(), "### Retired-only tests may be deleted")
    for required in ("may delete a test file or test case that covers ONLY code the request itself retires",
                     "citing the ticket or PRD that retires that code",
                     "deleting its test is the complete and correct outcome",
                     "A test that still covers any live behavior is only repaired, never deleted",
                     "delete only the retired cases and repair the rest",
                     "retired-tests.mjs record", "--retired-by", "--covers", "`retiredTests`",
                     "`vibe-guardrails-reviewer` verifies each one covered only retired code",
                     "Retired tests deleted line next to Missing tests"):
        assert required in rule, required
    assert "no deleted test of live behavior" in section(GUARDRAILS.read_text(), "## Tests")
    writer = section(agent("vibe-change-worker"), "## Tests: repair, don't author")
    for required in ("only when it covers nothing but code the request itself retires",
                     "retired-tests.mjs record", "citing the ticket or PRD that retires that code",
                     "A test that still covers any live behavior is only repaired"):
        assert required in writer, required
    assert "retired-tests.mjs" in section(QUALITY.read_text(), "## Tests: repair, don't author")


def test_the_recorder_and_inventory_gate_deletions_outside_a_pull_request() -> None:
    recorder = RECORDER.read_text()
    assert 'const RETIRING_DOCUMENT = /^(?:ISS|PRD|FEA)-\\d+$/;' in recorder
    assert '"vibe-retired-tests.json"' in recorder
    inventory = INVENTORY.read_text()
    assert "readRetiredTests(worktree)" in inventory
    assert 'file.status === "D" && retiredFiles.has(file.path)' in inventory
    assert "retiredTests," in inventory


def test_reviewers_verify_deleted_tests_covered_only_retired_code() -> None:
    guardrails = flat(agent("vibe-guardrails-reviewer"))
    for required in ("A retired-only deletion (the inventory's `retiredTests`) is allowed",
                     "confirm everything it exercised is code this session removed and the cited ticket or PRD retires",
                     "A deletion that covered any live behavior is blocking",
                     "a deleted test or case with no entry there"):
        assert required in guardrails, required
    assert "a deleted test that still covered live behavior" in flat(agent("vibe-adversarial-reviewer"))
    assert "recorded deletion of a test that covered only retired code" in flat(agent("vibe-verify-worker"))
    check = section(HANDOFF_SKILL.read_text(), "## 3. Guardrail check")
    assert "`retiredTests` whose deleted files or cases it confirms covered only code the request retires" in check


def test_the_ticket_lists_retired_test_deletions_next_to_missing_tests() -> None:
    handoff = TICKET_TEMPLATE.read_text()
    missing = handoff.index("- Missing tests (engineering scope):")
    retired = handoff.index("- Retired tests deleted:")
    following = handoff.index("- Pre-existing failures not touched by this work:")
    assert missing < retired < following
    line = flat(handoff[retired:following])
    for required in ("`retiredTests`", "the retired code it covered", "the ticket or PRD that retired it", '"None"'):
        assert required in line, required
    assert "Retired tests deleted lists every `retiredTests` entry" in flat(agent("vibe-ticket-worker"))
    assert "the inventory's `retiredTests`" in section(HANDOFF_SKILL.read_text(),
                                                       "## 8. Choose who picks it up, then check the ticket")


def test_the_launcher_names_the_retired_only_deletion() -> None:
    assert LAUNCHER_DELETION in (WORKERS_SRC / "claude-worker.ts").read_text()
    assert LAUNCHER_DELETION in LAUNCHER_BUNDLE.read_text()


def test_each_change_deploys_without_being_asked() -> None:
    skill = VIBE_SKILL.read_text()
    deploy = section(skill, DEPLOY)
    for required in ("deploys every change in the build loop without being asked",
                     "as soon as the writer finishes a request", "tell the person it's ready to look at",
                     'The person no longer has to say "redeploy"', "run these same steps",
                     "One deploy runs at a time",
                     "Requests that arrive while a deploy is running wait in the writer's queue until it finishes",
                     "one deploy after the last of them carries them all",
                     "tell them it's ready to look at",
                     "Never deploy a change before the writer's quick checks pass"):
        assert required in deploy, required
    loop = section(skill, "## 5. Build loop")
    assert "deploy it under section 6 without being asked" in loop
    assert "go out together after the last of them" in loop
    expectations = section(skill, "## 4. Set expectations")
    assert 'Say "redeploy"' not in expectations
    assert "Each change goes to your app on its own" in expectations
    lean = section(QUALITY.read_text(), "## Lean build loop")
    assert "deploys through the existing publication gate without being asked" in lean
    assert "batching changes that arrive while a deploy runs into the next one" in lean
    redeploying = section(ENVIRONMENT.read_text(), "## Redeploying")
    assert "After each change the build loop finishes, without the person asking" in redeploying
    assert "Only when the person asks" not in redeploying
    for path in (VIBE_SKILL, QUALITY, ENVIRONMENT, HANDOFF_SKILL):
        text = flat(path.read_text())
        assert "Never redeploy unless the person asked" not in text, path.name
        assert "when the person asks to redeploy" not in text, path.name
