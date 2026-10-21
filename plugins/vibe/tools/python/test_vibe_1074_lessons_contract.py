"""Contract coverage for the vibe 1.0.74 lessons: each new check is wired where its reader acts."""

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


def test_push_cadence_final_merge_and_shepherding_are_wired() -> None:
    assert "pushDue" in (VIBE / "scripts" / "commit-worktree.mjs").read_text()
    assert "`pushDue: true`" in _text(VIBE / "SKILL.md")
    handoff = _text(HANDOFF / "SKILL.md")
    assert "That merge waits on no e2e run" in handoff
    assert "shepherd.mjs --pr <n> --repo <owner/repo>" in handoff
    assert "every 90 minutes" in _text(FLEET / "SKILL.md")


def test_migration_order_compose_projects_precedent_and_path_gates_are_wired() -> None:
    assert "migrationOrderProblems" in (VIBE / "scripts" / "vibe-sessions.mjs").read_text()
    assert "scripts/migration-order.mjs" in _text(VIBE / "references" / "environment.md")
    assert "its own compose project" in _text(HANDOFF / "SKILL.md")
    assert "precedent-check.mjs check --report <report>" in _text(VIBE / "references" / "quality-loop.md")
    assert "pathGateTests" in (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert ".vibe/path-gates.json" in flat(agent("vibe-verify-worker"))
