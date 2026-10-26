"""Contract coverage for the vibe 1.0.76 lessons release: each new check is wired where its mistake happens."""

from pathlib import Path

from vibe_contract_text import flat, hook_guard_routed


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
    assert "an unresolved round-one review thread the writer has not answered last" in _text(HANDOFF / "SKILL.md")
    assert '"threads"' in (VIBE / "scripts" / "shepherd.mjs").read_text()


def test_claude_sessions_run_the_kill_guard_on_every_bash_command() -> None:
    assert hook_guard_routed(PLUGIN, "PreToolUse", "kill-guard", tool="Bash")
    assert "kill-guard.mjs own <pid>" in _text(VIBE / "references" / "guardrails.md")


def test_stale_prs_and_unanswered_questions_are_flagged_and_answered() -> None:
    assert "STALE-PR" in (MONITOR / "scripts" / "snapshot.sh").read_text()
    assert "QUESTION-UNANSWERED" in (MONITOR / "scripts" / "classify.sh").read_text()
    monitor = _text(MONITOR / "SKILL.md")
    for wired in ("STALE-PR(...)", "QUESTION-UNANSWERED(15m+)", "STALE_PR_SECONDS", "QUESTION_SECONDS"):
        assert wired in monitor, wired
    fleet = _text(FLEET / "SKILL.md")
    assert "On `STALE-PR`" in fleet and "ask the owning writer for an ETA, unblock it, or reassign it" in fleet
    assert "every 45 minutes" in fleet and "never hold one for optional evidence" in fleet
    assert "A question never holds a pull request" in _text(VIBE / "SKILL.md")
    assert "board.mjs <orchDir> question" in _text(FLEET / "references" / "templates.md")


def test_one_review_round_with_one_follow_up_ticket() -> None:
    for path in (VIBE / "SKILL.md", HANDOFF / "SKILL.md", FLEET / "SKILL.md"):
        assert "review-followup.mjs" in _text(path), path.name
    assert "--round-one-fixed-at" in _text(HANDOFF / "SKILL.md")
    assert "follow-ups from #<PR> review" in _text(FLEET / "SKILL.md")


def test_program_practices_and_rollout_gate_are_wired() -> None:
    fleet = _text(FLEET / "SKILL.md")
    for wired in ("## Program practices", "`MISSING-DUTY`", "MAX_LOAD_PER_CORE", "REPO_MEMORY_CMD", "Deadline mode", "Runtime choice"):
        assert wired in fleet, wired
    assert "--criteria <ticket body>" in fleet and "--scope <ticket>,<PRD>" in fleet
    assert "rollout-gate.mjs --worktree" in _text(HANDOFF / "SKILL.md")
    assert "load-check.sh" in (FLEET / "scripts" / "fleet.sh").read_text()


def test_the_requirements_worker_never_reads_public_help_material() -> None:
    import re

    worker = (AGENTS / "vibe-requirements-worker.md").read_text()
    sentences = re.split(r"(?<=[.!?])\s+", flat(worker))
    public = re.compile(r"help cent(?:er|re)|public documentation|release notes|web search", re.IGNORECASE)
    offenders = [sentence for sentence in sentences if public.search(sentence) and not re.search(r"\bnever\b|\bnot\b", sentence, re.IGNORECASE)]
    assert offenders == [], offenders
    assert "NEEDS_PERSON" in flat(worker) and "signed-in browser" in flat(worker)


def test_ready_heads_green_watch_claude_usage_and_status_sweep_are_wired() -> None:
    fleet = _text(FLEET / "SKILL.md")
    for wired in ("push-check <writer> --head <sha>", "green-watch.mjs --repo", "claude -p \"/usage\"", "`status-sweep` duty", "`PLAN-OPEN`", "`ABSORBED-OPEN`"):
        assert wired in fleet, wired
    assert "the monitor cannot read Claude usage" not in fleet
    assert "claude-usage.mjs" in (MONITOR / "scripts" / "snapshot.sh").read_text()
    assert "--ready <sha>" in _text(FLEET / "references" / "templates.md")
