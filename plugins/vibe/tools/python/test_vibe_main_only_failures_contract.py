"""Contract checks for the 2026-10-16 operator ruling on failures already on main.

When a handoff validation check fails, handoff reruns that same check on the
main the session captured. If it also fails there, the session did not cause
it: it goes once on the live ticket's Engineering checklist as a Known main
failure and blocks neither publication nor assignment. Only a failure that
passes on the captured main and fails on the session's commit blocks. The rule
holds in both harnesses, and the person-facing message stays plain.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
REFERENCES = PLUGIN_ROOT / "skills" / "vibe" / "references"
QUALITY = REFERENCES / "quality-loop.md"
GUARDRAILS = REFERENCES / "guardrails.md"
ENVIRONMENT = REFERENCES / "environment.md"
TICKET_TEMPLATE = REFERENCES / "ticket-template.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
WORKERS_SRC = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src"
MAIN_SYNC_BUNDLE = PLUGIN_ROOT / "skills" / "vibe" / "scripts" / "dist" / "main-sync.mjs"
RULING = "operator ruling, 2026-10-16"
TICKET_LINE = "- [ ] Known main failure: <check>; fails on captured main <mainSha>; evidence:"


def test_quality_loop_states_the_classification_once() -> None:
    rule = section(QUALITY.read_text(), "## Failures already on main")
    for required in (
        "Operator ruling, 2026-10-16",
        "Codex and Claude Code alike",
        "runs that same check on the main the session captured",
        "disposable checkout",
        "`.closedloop-ai/loops-setup.sh`",
        "A check that passed is never rerun",
        "`scripts/run-bounded.mjs`",
        "`main-preexisting`: it fails on the captured main too",
        "it blocks neither publication nor assignment",
        "`session-caused`: it passes on the captured main and fails again on one rerun of the session's commit. It blocks",
        "`flaky`: it passes on the captured main and on that one rerun",
        "cannot run on the captured main",
        "the conservative reading, and blocks",
        "never a reason to stop the handoff and never a question for the person",
        "never presents it as a stop",
    ):
        assert required in rule, required
    tests = section(QUALITY.read_text(), "## Tests: repair, don't author")
    assert "classifies `main-preexisting` is not the session's to fix" in tests


def test_a_main_only_failure_is_not_a_needed_tooling_fix() -> None:
    tooling = section(GUARDRAILS.read_text(), "## Plugins and tooling")
    assert "also fails on the main the session captured is not a needed fix and never stops the handoff" in tooling
    assert RULING in tooling
    handoff = flat(HANDOFF_SKILL.read_text())
    assert "A check that also fails on the main the session captured is not a needed fix and never stops the handoff" in handoff
    assert "Only a failure the session caused blocks." in handoff


def test_handoff_publishes_and_routes_main_preexisting_failures_to_the_ticket() -> None:
    upload = section(HANDOFF_SKILL.read_text(), "## 7. Upload the last changes")
    for required in (
        "`mainPreexistingFailures` still has `publicationReady: true`",
        "carry every entry to step 8's ticket worker as a Known main failure",
        "never send it to the writer as a fix, never stop and never ask the person about it",
        "error says `session-caused`",
        "blocks as before and goes back to the SAME writer",
        RULING,
    ):
        assert required in upload, required
    choose = section(HANDOFF_SKILL.read_text(), "## 8. Choose who picks it up, then check the ticket")
    assert "every `mainPreexistingFailures` entry from step 7 with its main run's log" in choose


def test_the_ticket_places_each_known_main_failure_once_on_the_engineering_checklist() -> None:
    template = flat(TICKET_TEMPLATE.read_text())
    assert "Known main failures: each entry of handoff's `mainPreexistingFailures`" in template
    assert TICKET_LINE in template
    assert "Not on the Handoff section's Pre-existing failures line, never in both, and never routed to the person running the session" in template
    assert "engineering decisions and known main failures |" in template
    assert 'reads "fails on main too, see Engineering checklist"' in template
    ticket = flat(agent("vibe-ticket-worker"))
    assert "every `mainPreexistingFailures` entry the final validation returned" in section(agent("vibe-ticket-worker"), "## Inputs")
    assert "Place each `mainPreexistingFailures` entry once, as an unchecked item at the end of the Engineering checklist" in ticket
    assert TICKET_LINE in ticket
    assert "it never blocks assignment" in ticket


def test_the_writer_and_the_environment_worker_do_not_block_on_main_preexisting_failures() -> None:
    writer = flat(agent("vibe-change-worker"))
    assert "return its `mainPreexistingFailures` to ROOT unchanged, publication still ready" in writer
    assert "never fix, skip or weaken such a check" in writer
    assert "a `session-caused` refusal is yours to fix" in writer
    assert "also fails on the captured main is not yours to fix" in section(agent("vibe-change-worker"), "## Tests: repair, don't author")
    redeploy = section(agent("vibe-environment-worker"), "## Redeploy mode")
    assert "returned under `mainPreexistingFailures`" in redeploy
    assert "does not block: push and request as usual" in redeploy
    assert "including one the executor called `session-caused`" in redeploy
    environment = section(ENVIRONMENT.read_text(), "## Main-sync before publication")
    assert "one that also fails there is `main-preexisting` and does not block publication" in environment


def test_the_shared_executor_owns_the_classification_for_both_harnesses() -> None:
    checks = (WORKERS_SRC / "main-sync-checks.ts").read_text()
    assert 'value.purpose === "handoff" ? new CapturedMainComparison(' in checks
    assert 'comparison.classification === "session-caused"' in checks
    comparison = (WORKERS_SRC / "main-sync-main-comparison.ts").read_text()
    assert 'new URL("../run-bounded.mjs", import.meta.url)' in comparison
    assert '"worktree", "add", "--detach"' in comparison
    assert '"worktree", "remove", "--force"' in comparison
    bundle = MAIN_SYNC_BUNDLE.read_text()
    for marker in ("mainPreexistingFailures", "main-preexisting", "session-caused", "vibe-captured-main-"):
        assert marker in bundle, marker
