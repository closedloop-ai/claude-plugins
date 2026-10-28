"""Contract checks for the WS0 measurement tooling (replay corpus, runner, scorer, telemetry).

1. Worker launches are counted by the one PostToolUse hook script, routed for
   Agent only, and that guard never speaks to the model.
2. Session telemetry is defined once, in `session-telemetry.mjs`, and a measure
   nobody recorded is null, not zero.
3. `vibe-sessions.mjs telemetry` is the command that records the rest, and the
   heavy-slot lock records its wait through the same module.
4. The replay needs at least three runs per ticket and keeps the pull request,
   its files and its tests out of the brief an arm is given.
5. The replay folder is not an eval case (the runners discover `*/prompt.md`)
   and its graders use the existing `evals/<case>/graders` format.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import hook_guard_routed

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = PLUGIN_ROOT / "skills" / "vibe" / "scripts"
REPLAY = PLUGIN_ROOT / "evals" / "replay"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_launches_are_counted_by_the_one_post_tool_use_hook() -> None:
    assert hook_guard_routed(PLUGIN_ROOT, "PostToolUse", "telemetry-launch", tool="Agent")
    assert not hook_guard_routed(PLUGIN_ROOT, "PostToolUse", "telemetry-launch", tool="Bash")
    guard = read(PLUGIN_ROOT / "hooks" / "telemetry-launch.mjs")
    assert "inVibeSession" in guard
    assert "return null" in guard


def test_telemetry_defaults_are_null_and_defined_once() -> None:
    owner = read(SCRIPTS / "session-telemetry.mjs")
    for field in ("workerLaunches", "tokens", "wallTimeMs", "environmentMinutes", "slotWaitMs"):
        assert f"{field}: null" in owner or f"{field}: null," in owner
    for other in ("e2e-lock.mjs", "vibe-sessions.mjs", "post-tool-use.mjs"):
        source = read(SCRIPTS / other) if (SCRIPTS / other).exists() else read(PLUGIN_ROOT / "hooks" / other)
        assert "emptyTelemetry" not in source


def test_telemetry_is_recorded_by_the_session_script_and_the_lock() -> None:
    sessions = read(SCRIPTS / "vibe-sessions.mjs")
    assert 'case "telemetry":' in sessions
    assert "withTokens" in sessions
    lock = read(SCRIPTS / "e2e-lock.mjs")
    assert "withSlotWait" in lock
    assert "updateSessionTelemetry" in lock


def test_replay_needs_three_runs_and_hides_the_human_change() -> None:
    runner = read(REPLAY / "runner.mjs")
    assert "MIN_RUNS = 3" in runner
    for key in ('"pr"', '"testFiles"', '"mergeBaseSha"', '"mergeSha"', '"files"'):
        assert key in runner


def test_replay_is_not_an_eval_case_and_reads_the_grader_format() -> None:
    assert not (REPLAY / "prompt.md").exists()
    graders = read(REPLAY / "graders.mjs")
    for token in ("type: regex", "not_contains", "judge"):
        assert token in graders or token.split(":")[0] in graders
