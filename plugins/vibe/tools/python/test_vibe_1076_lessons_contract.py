"""Contract coverage for the vibe 1.0.76 lessons release: each new check is wired where its mistake happens."""

from pathlib import Path

from vibe_contract_text import flat


PLUGIN = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN / "agents"
SKILLS = PLUGIN / "skills"
VIBE = SKILLS / "vibe"
HANDOFF = SKILLS / "handoff"
FLEET = SKILLS / "fleet-orchestrator"
MONITOR = SKILLS / "codex-fleet-monitor"


def _text(path: Path) -> str:
    return flat(path.read_text())


def test_questions_carry_a_default_and_the_fleet_keeps_a_heartbeat() -> None:
    assert "--default" in _text(VIBE / "SKILL.md") and "--deadline-minutes" in _text(VIBE / "SKILL.md")
    fleet = _text(FLEET / "SKILL.md")
    for wired in ("`HEARTBEAT`", "`WATCHER-MISSING`", "recurring schedule", "resumes an idle Codex writer on its default"):
        assert wired in fleet, wired
    assert "If no answer by" in _text(FLEET / "references" / "templates.md")
    monitor = _text(MONITOR / "SKILL.md")
    for wired in ("HEARTBEAT_SECONDS", "proceeded-on-default", "If no answer by <ISO time>: <default>"):
        assert wired in monitor, wired
    assert "HEARTBEAT" in (MONITOR / "scripts" / "watch.sh").read_text()
    assert "seq 1 200" not in (MONITOR / "scripts" / "watch.sh").read_text(), "a 6.7 hour watcher is not a heartbeat"


def test_takeovers_reverify_done_claims() -> None:
    templates = _text(FLEET / "references" / "templates.md")
    assert "Re-verify: each Done claim with a test or a measurement" in templates
    assert 'Re-verify every "done" claim' in templates
    assert "REVERIFY" in (FLEET / "scripts" / "codex-session.mjs").read_text()


def test_a_migration_is_tested_before_its_first_push() -> None:
    environment = _text(AGENTS / "vibe-environment-worker.md")
    assert "migration-publish.mjs --worktree" in environment
    guardrails = _text(VIBE / "references" / "guardrails.md")
    assert "Pushing a migration publishes it" in guardrails and "`Scale test:`" in guardrails
    assert "migrationProblems" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text(), "handoff runs the same check"


def test_a_spec_or_criterion_changes_only_with_a_human_source() -> None:
    assert "checkSpecChanges" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "--criteria-before" in _text(AGENTS / "vibe-ticket-worker.md")
    assert "`spec-change`" in _text(AGENTS / "vibe-guardrails-reviewer.md")


def test_every_path_that_sets_a_ticket_done_checks_its_criteria_first() -> None:
    for path in (
        AGENTS / "vibe-ticket-worker.md",
        SKILLS / "cl-execute" / "references" / "monitoring-merge-completion.md",
        SKILLS / "cl-sweep" / "references" / "open-pr-lifecycle.md",
    ):
        assert "executed-check.mjs --kind ticket" in _text(path), path.name
    fleet = _text(FLEET / "SKILL.md")
    assert "`UNCHECKED`" in fleet and "A merge alone never makes a ticket DONE" in fleet


def test_the_shepherd_stops_on_review_threads() -> None:
    assert "an unresolved review thread the writer has not answered last" in _text(HANDOFF / "SKILL.md")
    assert '"threads"' in (VIBE / "scripts" / "shepherd.mjs").read_text()
