"""Contract coverage for the combined vibe 1.0.74 lessons release."""

import json
from pathlib import Path

from vibe_contract_text import agent, flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
FLEET = PLUGIN / "skills" / "fleet-orchestrator"
MONITOR = PLUGIN / "skills" / "codex-fleet-monitor"


def _text(path: Path) -> str:
    return flat(path.read_text())


def test_fleet_board_ruling_and_checkpoint_delivery_are_run_from_the_skill() -> None:
    skill = _text(FLEET / "SKILL.md")
    templates = _text(FLEET / "references" / "templates.md")
    assert (FLEET / "scripts" / "board.mjs").exists()
    for wired in ("board.mjs <orchDir> writer", "--kind ruling --reference", "--kind checkpoint", "board.mjs <orchDir> status"):
        assert wired in skill, wired
    assert "app-server-orchestrator skill's send" in templates
    assert "through SendMessage" in templates


def test_human_qa_defaults_to_zero_and_reruns_never_use_the_handed_stack() -> None:
    skill = _text(FLEET / "SKILL.md")
    assert (FLEET / "scripts" / "qa-plan-check.mjs").exists()
    assert "zero human checkpoints by default" in skill
    assert "qa-plan-check.mjs --plan" in skill
    assert "hand <stack> --to <guide>" in skill


def test_helpers_record_and_end_their_processes_and_the_watcher_is_checked() -> None:
    skill = _text(FLEET / "SKILL.md")
    monitor = _text(MONITOR / "SKILL.md")
    assert "helpers.mjs <orchDir> pid <name> <pid...>" in skill
    assert "`--group` only for one it spawned detached" in skill
    assert "watcher.mjs <orchDir>" in skill
    assert "scripts/watcher.mjs <workDir>" in monitor
    assert "never `launchctl kickstart -k`" in monitor


def test_push_cadence_and_shepherding_are_wired() -> None:
    assert "pushDue" in (VIBE / "scripts" / "commit-worktree.mjs").read_text()
    assert "`pushDue: true`" in _text(VIBE / "SKILL.md")
    assert "shepherd.mjs --pr <n> --repo <owner/repo>" in _text(HANDOFF / "SKILL.md")
    assert "every 45 minutes" in _text(FLEET / "SKILL.md"), "operator ruling 2026-10-22 moved the cadence from 90 to 45 minutes"


def test_migration_order_compose_projects_precedent_and_path_gates_are_wired() -> None:
    assert "migrationOrderProblems" in (VIBE / "scripts" / "vibe-sessions.mjs").read_text()
    assert "scripts/migration-order.mjs" in _text(VIBE / "references" / "environment.md")
    assert "its own compose project" in _text(HANDOFF / "SKILL.md")
    assert "precedent-check.mjs check --report <report>" in _text(VIBE / "references" / "quality-loop.md")
    assert "pathGateTests" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert ".vibe/path-gates.json" in flat(agent("vibe-verify-worker"))


def test_criteria_audit_and_rulings_check_gate_the_handoff() -> None:
    handoff = _text(HANDOFF / "SKILL.md")
    for script in ("criteria-audit.mjs", "rulings-check.mjs"):
        assert (HANDOFF / "scripts" / script).exists()
        assert f"scripts/{script}" in handoff, script
    assert "fresh-context reviewer given only the ticket's criteria and the diff" in handoff
    assert '- Ruling <date> (<who>): "' in (VIBE / "references" / "ticket-template.md").read_text()


def test_findings_reach_a_writer_with_their_evidence() -> None:
    assert "finding-brief.mjs <orchDir> --findings" in _text(FLEET / "SKILL.md")
    assert "$prompt.evidence" in (FLEET / "scripts" / "fleet.sh").read_text()


def test_precedent_disputed_behaviors_and_review_gap_rules_are_wired() -> None:
    assert '--behavior "<the interaction to perform>"' in _text(VIBE / "references" / "quality-loop.md")
    rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "checkComparators" in rules
    assert "checkUnusedExports" in rules


def test_story_plays_are_judged_by_the_verdict_helper() -> None:
    assert (VIBE / "scripts" / "story-play-verdict.mjs").exists()
    assert "playVerdictProblems" in (HANDOFF / "scripts" / "pr-facts.mjs").read_text()
    worker = flat(agent("vibe-verify-worker"))
    assert "story-play-verdict.mjs" in worker
    assert "never by `storyFinished`'s status" in worker


def test_shared_component_changes_require_every_hosts_suites() -> None:
    assert "sharedComponentTests" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "flagStates" in (HANDOFF / "scripts" / "pr-facts.mjs").read_text()
    assert 'with `flag: "on"` or `flag: "off"`' in flat(agent("vibe-verify-worker"))


def test_status_audit_runs_at_every_merge_and_writer_assignment() -> None:
    assert (FLEET / "scripts" / "status-audit.mjs").exists()
    skill = _text(FLEET / "SKILL.md")
    assert "At every writer assignment and every merge" in skill
    assert "status-audit.mjs --snapshot <file>" in skill


def test_storybook_rules_run_inside_the_handoff_diff_rules() -> None:
    diff_rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "checkStorybookRules(files, repo, logged, add);" in diff_rules
    assert "...storybookRuleTests(files, (file) => repo.head(file))" in diff_rules


def test_the_verify_worker_runs_the_declared_storybook_checks() -> None:
    assert "`checks` of its `.vibe/storybook-rules.json`" in flat(agent("vibe-verify-worker"))


def test_the_example_declaration_names_every_storybook_rule() -> None:
    example = json.loads((HANDOFF / "references" / "storybook-rules.example.json").read_text())
    for key in ("release", "frozenRoots", "tagRoots", "noOpHandler", "handRolledCells", "controlsDecision", "literalOptions", "storySupportPaths", "checks"):
        assert key in example, key


def test_program_rulings_attention_budget_and_stable_findings_are_wired() -> None:
    state = _text(FLEET / "references" / "state.md")
    templates = _text(FLEET / "references" / "templates.md")
    skill = _text(FLEET / "SKILL.md")
    for artifact in ("rulings.md", "attention.md", "review.md"):
        assert artifact in state
    assert "Per-ticket rulings still go through handoff's `rulings-check.mjs`" in state
    assert "Program rulings: read <orchDir>/rulings.md" in templates
    assert "D###" in templates and "R###" in templates
    assert "reports high Claude usage" in skill
    assert "keep `<orchDir>/attention.md` current" in skill
    assert "review-page-check.mjs <orchDir>/review.md" in skill
    assert "rulings-check.mjs --program" in skill


def test_long_commands_do_not_hide_orchestrator_messages() -> None:
    templates = _text(FLEET / "references" / "templates.md")
    skill = _text(FLEET / "SKILL.md")
    assert "more than a few minutes run in the background" in templates
    assert "board.mjs <orchDir> pending <you>" in templates
    assert "interrupt after the second unanswered delivery" in skill


def test_visual_findings_on_touched_surfaces_are_required_fixes() -> None:
    fleet = _text(FLEET / "SKILL.md")
    handoff = _text(HANDOFF / "SKILL.md")
    assert "visual-QA finding on a surface the change touches is a required fix" in fleet
    assert "findings resume the SAME writer in fix mode for every touched surface" in handoff
    assert "--require-disposition" in fleet
    assert "--require-disposition" in handoff


def test_product_questions_use_the_shared_live_precedent_order() -> None:
    quality = _text(VIBE / "references" / "quality-loop.md")
    requirements = flat(agent("vibe-requirements-worker"))
    fleet = _text(FLEET / "SKILL.md")
    for step in ("Current code and data model", "The ticket's acceptance criteria", "The product owner's recorded direction", "The approved prototype", "Live Asana"):
        assert step in quality
    assert "never a public help center or documentation page" in quality
    assert "return `NEEDS_PERSON` to the orchestrator" in requirements
    assert "do not copy or reorder it here" in fleet
    assert "--product --code-evidence" in _text(VIBE / "SKILL.md")
