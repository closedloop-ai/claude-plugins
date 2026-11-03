"""Contract coverage for the vibe 1.0.75 lessons release."""

import re
from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
PLUGINS = PLUGIN.parent
VIBE = PLUGIN / "skills" / "vibe"
FLEET = PLUGIN / "skills" / "fleet-orchestrator"
MONITOR = PLUGIN / "skills" / "codex-fleet-monitor"

TOP_LEVEL_MAIN = re.compile(r"^(?:if \(.*\)\s*)?await main\(")
TOP_LEVEL_DECLARATION = re.compile(r"^(?:export\s+)?(?:const|let|class)\s+(\w+)")


def _text(path: Path) -> str:
    return flat(path.read_text())


def declarations_after_top_level_await(text: str) -> list[str]:
    """Top-level const, let or class declarations below a top-level `await main()`.

    A top-level await pauses module evaluation, so main runs while those are
    still uninitialized; liveness.mjs printed READFAIL for every failed turn.
    """
    lines = text.splitlines()
    start = next((index for index, line in enumerate(lines) if TOP_LEVEL_MAIN.match(line)), None)
    if start is None:
        return []
    return [match.group(1) for line in lines[start + 1:] if (match := TOP_LEVEL_DECLARATION.match(line))]


def test_no_plugin_script_declares_a_constant_below_its_top_level_await_main() -> None:
    offenders = {
        str(path.relative_to(PLUGINS)): found
        for path in sorted(PLUGINS.rglob("*.mjs"))
        if "node_modules" not in path.parts and (found := declarations_after_top_level_await(path.read_text()))
    }
    assert offenders == {}


def test_the_top_level_await_scan_catches_the_shape_that_hid_usage_limits() -> None:
    assert declarations_after_top_level_await("if (isEntryPoint(import.meta.url)) await main();\n\nexport const Failure = {};\n") == ["Failure"]
    assert declarations_after_top_level_await("const A = 1;\nawait main();\n") == []
    assert declarations_after_top_level_await("async function main() {\n  await main();\n  const inner = 1;\n}\n") == []


def test_the_watcher_flags_model_drift_wider_questions_and_a_second_copy() -> None:
    snapshot = (MONITOR / "scripts" / "snapshot.sh").read_text()
    assert snapshot.count("CODEX_MODEL=${CODEX_MODEL:-}") == 2, "local and remote liveness both get the configured model"
    assert "watch.lock" in (MONITOR / "scripts" / "watch.sh").read_text()
    assert "BLOCKED(unresolved threads)" in snapshot
    monitor = _text(MONITOR / "SKILL.md")
    for wired in ("BLOCKED(unresolved threads)", "MODEL(<model>/<effort>!=<want>)", "`notLoaded`", "permission, authorization or approval", "never with `&`", "resets"):
        assert wired in monitor, wired


def test_fleet_orchestrator_runs_each_new_check() -> None:
    skill = _text(FLEET / "SKILL.md")
    for wired in (
        "checked in code: <file>:<line>",
        "refuses to start without a model or an effort",
        "`MODEL(...)`",
        "resets=<n>",
        "move its busiest writers to Claude writers",
        "board.mjs <orchDir> duty <duty> --owner",
        "`UNOWNED-DUTY`",
        "--runtime codex|claude",
        "A `SLOW` row",
        "never with `&`",
        "one umbrella ticket",
        "Work outside the program goes to its owner",
        "lessons-pr.mjs --repo <owner/repo>",
        "executed-check.mjs --kind prd",
        "--children",
    ):
        assert wired in skill, wired
    assert "checked in code: <file>:<line>" in _text(FLEET / "references" / "templates.md")
    for script in ("lessons-pr.mjs", "board.mjs", "helpers.mjs", "review-page-check.mjs"):
        assert (FLEET / "scripts" / script).exists(), script


def test_vibe_writers_never_wait_for_authorization_on_in_scope_work() -> None:
    assert "Never stop for authorization on in-scope work" in _text(PLUGIN / "agents" / "vibe-change-worker.md")
    assert "permission to do in-scope work" in _text(VIBE / "SKILL.md")
    assert "asksLeaveForInScopeWork" in (VIBE / "scripts" / "session-questions.mjs").read_text()
    assert "executed-check.mjs --kind plan" in _text(PLUGIN / "agents" / "vibe-ticket-worker.md")


def test_a_plan_no_human_approved_is_never_a_scope_ruling() -> None:
    assert "planProblems" in (PLUGIN / "skills" / "handoff" / "scripts" / "rulings-check.mjs").read_text()
    assert "rulings-check.mjs --plan <json> --plan-body <text>" in _text(PLUGIN / "agents" / "vibe-ticket-worker.md")
    assert "--plan <each linked PLN's get-document JSON>" in _text(PLUGIN / "skills" / "handoff" / "SKILL.md")
    assert "rulings-check.mjs --plan <json> --plan-body <text>" in _text(FLEET / "SKILL.md")
    templates = _text(FLEET / "references" / "templates.md")
    assert templates.count("Inherited scope: trace every exclusion") == 2, "takeover preamble and resume prompt"
    assert "SELF_APPROVED_MARKER}" in (VIBE / "scripts" / "session-plan.mjs").read_text()
    assert "starts with the `Self-approved` line" in _text(PLUGIN / "agents" / "vibe-ticket-worker.md")
    assert "A self-approved plan or a handoff note never counts" in _text(FLEET / "SKILL.md")
