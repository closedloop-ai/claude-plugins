"""Contract checks for ISS-13321: vibe gates a person could never clear.

Operator ruling, 2026-10-28: fix every one in one change. A gate the session cannot clear ends
with a supported hand-off; the person is only asked to do what only a human can do. The scripts'
own tests cover the mechanical gates; these pin the prose paths that used to dead-end.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
REFERENCES = VIBE / "references"
HANDOFF = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
AGENTS = PLUGIN_ROOT / "agents"


def test_the_desktop_e2e_lane_is_left_for_the_post_merge_run_and_holds_nothing() -> None:
    handoff = flat(HANDOFF.read_text())
    assert "comes back under `e2eLeftForCi` instead and does not hold it" in handoff
    assert "A Desktop lane under `e2eLeftForCi` is not such a gap." in handoff
    environment = flat((REFERENCES / "environment.md").read_text())
    assert "publishes `desktop-e2e/validated`, and it does not hold `requiredE2eComplete`" in environment
    writer = flat((AGENTS / "vibe-change-worker.md").read_text())
    assert "it does not hold `requiredE2eComplete`" in writer


def test_a_requested_pull_request_says_which_e2e_lanes_ci_covers() -> None:
    worker = flat((AGENTS / "vibe-environment-worker.md").read_text())
    assert "records the Desktop e2e lane not run the same way" in worker
    assert "`MAIN-PREEXISTING-LANE`" in worker
    assert "list each in the body under a `Known main failures` line" in worker


def test_a_tooling_stop_pushes_the_work_and_offers_to_pass_it_on() -> None:
    tooling = section((REFERENCES / "guardrails.md").read_text(), "## Plugins and tooling")
    assert "The work never stays only on their machine" in tooling
    assert "Only a verified engineering-only blocker after every available path has been tried" in tooling
    assert "Record the exact blocker and paths tried in the session ledger" in tooling
    assert "then dispatch `vibe-environment-worker` in handover mode" in tooling
    assert "name the exact block and the paths tried, and offer to pass the saved work to someone now" in tooling
    assert "Give no engineering repair task to the person" in tooling
    assert "`- [ ] Vibe tooling blocker: <what stopped, technically>; evidence: <the refusal's first line or the finding>`" in tooling
    handover = section((AGENTS / "vibe-environment-worker.md").read_text(), "## Handover mode")
    assert "No main sync, no validation transaction and no environment request" in handover
    assert "Never `--no-verify`, `SKIP_PREPUSH_GATES` or a force push." in handover
    pull_request_stop = flat(HANDOFF.read_text())
    assert "Check for a safe retry or accepted alternative first" in pull_request_stop
    assert "When it remains a verified engineering-only block, offer to pass the pushed work to someone now" in pull_request_stop


def test_the_person_is_only_asked_to_do_what_only_a_human_can() -> None:
    words = section((REFERENCES / "plain-words.md").read_text(), "## What the person is asked to do")
    assert "The person is only ever asked to do what only a human can do" in words
    assert "never relayed to the person as a step" in words
    skill = flat((VIBE / "SKILL.md").read_text())
    assert "never reach the person as something to do unless only a human can do it" in skill
    handoff = flat(HANDOFF.read_text())
    assert "A finding's `fix` is written for the writer, never relayed to the person as a step" in handoff
    assert "A deferred finding and its remedy (render the frozen stories, pause an animation) are never relayed to the person" in skill
    decomposer = flat((AGENTS / "vibe-storybook-decomposer.md").read_text())
    assert "never phrase it as something the person running the session does" in decomposer


def test_a_check_that_times_out_on_main_too_is_this_machines_limit() -> None:
    loop = section((REFERENCES / "quality-loop.md").read_text(), "## Failures already on main")
    assert "`machine-limited`: it ran out of its time limit on the session commit and on the captured main alike" in loop
    template = flat((REFERENCES / "ticket-template.md").read_text())
    assert "`- [ ] Check ran out of time on this machine: <check>; also on captured main <mainSha>; limit <minutes> min; run it on a faster machine or CI`" in template


def test_a_reserved_storybook_version_or_a_moving_main_never_blocks_the_pull_request() -> None:
    handoff = flat(HANDOFF.read_text())
    assert "never sync main again only to chase a newer Storybook release" in handoff
    assert "Take the next free version, say so in the pull request packet" in handoff
    assert "not permission to silently choose a different version" not in handoff
    verify = flat((AGENTS / "vibe-verify-worker.md").read_text())
    assert "A duplicate reservation, stale base or count mismatch is blocking evidence" not in verify
    ticket = flat((AGENTS / "vibe-ticket-worker.md").read_text())
    assert "A stale comparison, duplicate version or conflicting count returns `NEEDS_CHANGE`" not in ticket


def test_passing_it_on_carries_criteria_that_wait_on_another_ticket() -> None:
    handoff = flat(HANDOFF.read_text())
    assert "is marked `not met yet: waits on <ticket>`" in handoff
    assert "A requested pull request still needs every criterion met." in handoff
    ticket = flat((AGENTS / "vibe-ticket-worker.md").read_text())
    assert "`Aligned except criteria waiting on <tickets>`" in ticket
    template = flat((REFERENCES / "ticket-template.md").read_text())
    assert "`- [ ] Criterion waits on <ticket>: <criterion>; not met until it ships`" in template


def test_release_smoke_is_an_optional_diagnostic_not_a_release_or_pr_gate() -> None:
    repo = PLUGIN_ROOT.parents[1]
    agents = flat((repo / "AGENTS.md").read_text())
    contributing = flat((repo / "CONTRIBUTING.md").read_text())
    changelog = flat((repo / "CHANGELOG.md").read_text())
    assert "vibe release smoke is optional" in agents
    assert "vibe release smoke (optional)" in contributing
    assert "vibe release smoke is optional" in changelog
    assert "required for every `plugins/vibe` change" not in contributing
    assert "require `node tools/vibe-release-smoke/smoke.mjs`" not in changelog
    assert (repo / "tools/vibe-release-smoke/smoke.mjs").is_file()
