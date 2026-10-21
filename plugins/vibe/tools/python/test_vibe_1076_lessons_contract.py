"""Contract coverage for the vibe 1.0.76 lessons: each new check is wired where its reader acts."""

from pathlib import Path

from vibe_contract_text import agent, flat


PLUGIN = Path(__file__).resolve().parents[2]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"


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
