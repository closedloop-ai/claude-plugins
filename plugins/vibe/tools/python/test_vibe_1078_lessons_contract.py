"""Contract coverage for the vibe 1.0.78 release."""

import re
from pathlib import Path

from vibe_contract_text import flat, hook_guard_routed


PLUGIN = Path(__file__).resolve().parents[2]
FLEET = PLUGIN / "skills" / "fleet-orchestrator"


def test_the_lessons_loop_measures_instruction_words_at_the_final_head() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "instruction-words.mjs --base <last release> --changelog CHANGELOG.md --version <x.y.z>" in skill
    assert (FLEET / "scripts" / "instruction-words.mjs").exists()


MONITOR = PLUGIN / "skills" / "codex-fleet-monitor"
WORK_DIR_USAGE = re.compile(r"Usage:.*<(?:orchDir|workDir)>")


def test_every_script_that_takes_a_work_dir_resolves_it_through_the_fleet_home() -> None:
    scripts = [
        path
        for folder in (FLEET / "scripts", MONITOR / "scripts")
        for path in sorted(folder.iterdir())
        if path.suffix in {".mjs", ".sh"} and not path.name.endswith(".test.mjs") and WORK_DIR_USAGE.search(path.read_text())
    ]
    assert len(scripts) >= 10
    for path in scripts:
        text = path.read_text()
        assert "work-dir.mjs" in text or "resolveWorkDir" in text, path.name


def test_a_new_chat_resumes_from_the_fleet_home() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    state = flat((FLEET / "references" / "state.md").read_text())
    assert "All state lives in one fleet home" in skill
    assert "`board.mjs status` fails on state written outside it" in skill
    for wired in ("fleet-home.mjs resume", "NO-ACTIVE-PROGRAM", "WATCHER-LIVE <pid>", "RELAUNCH <writer> <prompt>", "fleet-home.mjs check", "standing-rulings.md", "fleet-home.mjs migrate"):
        assert wired in state, wired
    setup = flat((FLEET / "references" / "setup.md").read_text())
    assert "REMOTE_FLEET_HOME" in setup and "LOCAL_STATE_DIR=" not in setup


def test_the_2026_10_22_open_lessons_are_wired() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "scheduled review bots post under teammates' accounts" in skill
    assert "Vibe's merge guard refuses `gh pr merge` on another author's pull request" in skill
    assert "a Sonnet watcher" in skill and "starts an Opus fixer" in skill
    assert "run the full e2e suites on main yourself" in skill
    assert "--skip-ruling" in skill
    assert "once that PR's ticket, PRD and design rulings show the change was not asked for (a requested change is accepted and cited)" in skill
    assert "One review round per PR (operator ruling) holds only in the delivery phase" in skill
    assert "--single-review-ruling" in flat((PLUGIN / "skills" / "handoff" / "SKILL.md").read_text())
    assert "only while an operator's single-review ruling is in force" in flat((PLUGIN / "skills" / "vibe" / "SKILL.md").read_text())
    assert "`prs-ignore.txt` or another program's `prs.txt`" in flat((MONITOR / "SKILL.md").read_text())
    assert hook_guard_routed(PLUGIN, "PreToolUse", "merge-guard", tool="Bash")


def test_green_watch_fixes_bind_clean_and_dirty_e2e_evidence_to_real_inputs() -> None:
    skill = flat((FLEET / "SKILL.md").read_text())
    assert "a vibe writer (Claude `vibe:vibe`, Codex `$vibe`) briefed by `GREEN_WATCH_AGENT`" in skill
    assert "`gh pr view <n> --json author,headRefName`, never a worker's word" in skill
    assert "e2e-lock.mjs run --head <sha>" in skill
    environment = flat((PLUGIN / "agents" / "vibe-environment-worker.md").read_text())
    assert "pr-preflight.mjs --title" in environment
    reviewer = flat((PLUGIN / "agents" / "vibe-guardrails-reviewer.md").read_text())
    assert "whose old value `rg` still finds anywhere in the repo" in reviewer
    scripts = PLUGIN / "skills" / "vibe" / "scripts"
    lanes = (scripts / "pre-pr-lanes.mjs").read_text()
    lock = (scripts / "e2e-lock.mjs").read_text()
    identity = (scripts / "tested-head.mjs").read_text()
    verifier = flat((PLUGIN / "agents" / "vibe-verify-worker.md").read_text())
    assert "testedSource" in lock, "local E2E must bind HEAD plus dirty-tree identity"
    assert "sameSource(enteredSource, source)" in lock, "queued edits must invalidate E2E evidence"
    assert "testedSource" in lanes and "testedHead" in lanes, "dirty candidate and clean captured-main boundaries stay distinct"
    assert "DIRTY-WORKTREE" in identity and "export function testedHead" in identity
    assert "external `e2e-slot.sh --head <HEAD> <owner> <command...>`" in verifier
    assert "imported `testedHead` enforces that boundary" in verifier


def test_new_controls_and_visual_baselines_need_surface_specific_sources() -> None:
    writer = flat((PLUGIN / "agents" / "vibe-change-worker.md").read_text())
    reviewer = flat((PLUGIN / "agents" / "vibe-guardrails-reviewer.md").read_text())
    verifier = flat((PLUGIN / "agents" / "vibe-verify-worker.md").read_text())
    handoff = flat((PLUGIN / "skills" / "handoff" / "SKILL.md").read_text())
    fleet = flat((FLEET / "SKILL.md").read_text())
    environment = flat((PLUGIN / "agents" / "vibe-environment-worker.md").read_text())
    assert '"preserve X" in one mode does not add X in another' in writer
    assert "Control: <file>: <prop or mount>: <surface>: <ticket AC or ruling>" in writer
    assert "it must name that control on that surface" in reviewer
    assert '"plausibly intended" is blocking' in reviewer
    assert "report every control with no source on that surface" in verifier
    assert "rendered-control inventory flags anything with no sourced requirement" in handoff
    assert '"plausibly intended" never passes' in fleet
    assert "Baseline inventory:" in environment and "--base <inventory.baseCommit>" in environment
