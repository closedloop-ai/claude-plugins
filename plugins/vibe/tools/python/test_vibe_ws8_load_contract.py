"""Contract checks for Load-aware execution (PRD-823, ISS-13584 to ISS-13587).

1. run-bounded.mjs is the one choke point; the budget, admission and pool scripts are wired in.
2. Every default lives in ONE frozen object, and every new behavior has an environment switch
   that restores the previous one.
3. A failure is never turned into a pass: the retry's own exit code is the result, a failing
   assertion is classified final, and the pool keeps the evidence contract.
4. The handoff skill starts the background lane run before the summary and reviews and joins it
   before Final Alignment, PLN approval and ready (checked on the SKILL's heading structure).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from vibe_contract_text import agent, flat

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = PLUGIN_ROOT / "skills" / "vibe" / "scripts"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
NEW_SCRIPTS = ("heavy-budget.mjs", "load-admission.mjs", "lane-pool.mjs", "verify-background.mjs")
SWITCHES = ("VIBE_HEAVY_BUDGET", "VIBE_HEAVY_MAX_WAIT_SECONDS", "VIBE_HEAVY_RETRIES", "VIBE_VERIFY_POOL_SIZE")
DEFAULT_KEYS = ("targetUtilisation", "minWorkers", "maxWaitSeconds", "pollSeconds", "retries", "retryWorkerDivisor", "poolSize", "highLoadPerCore")


def source(name: str) -> str:
    return (SCRIPTS / name).read_text()


def headings(text: str) -> list[tuple[int, str, int]]:
    """(level, title, offset) for every markdown heading outside code fences."""
    found = []
    fenced = False
    offset = 0
    for line in text.split("\n"):
        if line.startswith("```"):
            fenced = not fenced
        match = re.match(r"^(#{1,6}) (.+)$", line)
        if match and not fenced:
            found.append((len(match.group(1)), match.group(2).strip(), offset))
        offset += len(line) + 1
    return found


def body_of(text: str, title: str) -> str:
    """The text under the heading `title`, up to the next heading of the same or a higher level."""
    all_headings = headings(text)
    index = next(i for i, (_, name, _) in enumerate(all_headings) if name == title)
    level, _, start = all_headings[index]
    end = next((offset for lvl, _, offset in all_headings[index + 1 :] if lvl <= level), len(text))
    return text[start:end]


def parent_of(text: str, title: str) -> str:
    all_headings = headings(text)
    index = next(i for i, (_, name, _) in enumerate(all_headings) if name == title)
    level = all_headings[index][0]
    return next(name for lvl, name, _ in reversed(all_headings[:index]) if lvl < level)


def test_every_new_script_has_node_tests_and_run_bounded_is_the_choke_point() -> None:
    for name in NEW_SCRIPTS:
        assert (SCRIPTS / name.replace(".mjs", ".test.mjs")).exists(), name
    bounded = source("run-bounded.mjs")
    assert 'from "./heavy-budget.mjs"' in bounded
    assert 'from "./load-admission.mjs"' in bounded
    assert "isHeavyCommand" in bounded
    verify = source("verify-run.mjs")
    for dependency in ("./lane-pool.mjs", "./verify-background.mjs", "./run-bounded.mjs"):
        assert dependency in verify, dependency


def test_defaults_are_one_frozen_object_and_defined_nowhere_else() -> None:
    budget = source("heavy-budget.mjs")
    block = re.search(r"export const DEFAULTS = Object\.freeze\(\{(.*?)\n\}\);", budget, re.DOTALL)
    assert block, "DEFAULTS must be one frozen object"
    for key in DEFAULT_KEYS:
        assert re.search(rf"\b{key}:\s*[\d.]+,", block.group(1)), key
    for name in NEW_SCRIPTS + ("run-bounded.mjs", "verify-run.mjs"):
        if name == "heavy-budget.mjs":
            continue
        for key in DEFAULT_KEYS:
            assert not re.search(rf"^\s*{key}:\s*[\d.]+,", source(name), re.MULTILINE), f"{name} redefines {key}"


def test_every_new_behavior_has_a_switch_that_restores_the_previous_one() -> None:
    combined = "\n".join(source(name) for name in NEW_SCRIPTS + ("verify-run.mjs", "run-bounded.mjs"))
    for switch in SWITCHES:
        assert switch in combined, switch
    budget = source("heavy-budget.mjs")
    assert 'off: "VIBE_HEAVY_BUDGET"' in budget
    assert "budgetDisabled(env) || !isHeavyCommand" in source("run-bounded.mjs")
    assert "strictlySerial" in source("verify-run.mjs")


def test_a_failure_is_never_turned_into_a_pass() -> None:
    admission = source("load-admission.mjs")
    assert "exitCode: result.code" in admission
    assert "Signature.Assertion" in admission
    # The assertion check runs before any load signature.
    classify = admission[admission.index("export function classifyLoadFailure") :]
    assert classify.index("ASSERTION.test") < classify.index("SIGKILL_EXIT")
    assert "attempt <= settings.retries" in admission
    verify = source("verify-run.mjs")
    assert "evidenceOk" in verify and "Status.Passed || check.status === Status.Cached" in verify
    pool = source("lane-pool.mjs")
    assert "unknown lanes default to serial" in pool
    assert "e2e-lock.mjs" in pool


def test_background_runs_never_read_a_dead_or_stale_run_as_passed() -> None:
    text = source("verify-background.mjs")
    for state in ("Orphaned", "HeadMoved", "Failed", "Running"):
        assert f"RunState.{state}" in text, state
    exits = json.loads(json.dumps(re.findall(r"\[RunState\.(\w+)\]: (\d)", text)))
    zero = [name for name, code in exits if code == "0"]
    assert zero == ["Passed"]


def test_handoff_starts_the_lane_run_before_the_reviews_and_joins_it_before_alignment() -> None:
    text = HANDOFF_SKILL.read_text()
    start_title = "Start the lane run in the background"
    join_title = "Join the background lane run"
    titles = [name for _, name, _ in headings(text)]
    assert parent_of(text, start_title) == "1. Internal checklist"
    assert parent_of(text, join_title) == "6. Independent integrated review"
    order = [titles.index(name) for name in (start_title, "2. Summarize internally", "3. Guardrail check", "6. Independent integrated review", join_title)]
    assert order == sorted(order), "start must precede the summary and guardrail steps; the join sits in step 6"
    start = flat(body_of(text, start_title))
    for needle in ("verify-run.mjs", "--background", "run id", "never skipped"):
        assert needle in start, needle
    join = flat(body_of(text, join_title))
    for needle in ("--wait", "Final Alignment Status: Aligned", "PLN", "ready", "state: passed", "orphaned", "head-moved", "head under review"):
        assert needle in join, needle
    # The join gates the alignment: it is stated before the alignment may be recorded, not after.
    assert join.removeprefix(f"### {join_title}").strip().startswith("Before `Final Alignment Status: Aligned`")


def test_the_flags_the_skill_uses_exist_in_verify_run_and_the_worker_can_join() -> None:
    verify = source("verify-run.mjs")
    for flag in ("background", "status", "wait", "wait-seconds", "run-id"):
        assert re.search(rf'["\']?{re.escape(flag)}["\']?: \{{ type', verify), flag
    worker = flat(agent("vibe-verify-worker"))
    assert "--wait <run id>" in worker
    assert "Without the script, run the checks below unchanged." in worker


def test_current_version_and_prior_release_notes() -> None:
    for manifest in (".claude-plugin", ".codex-plugin"):
        assert json.loads((PLUGIN_ROOT / manifest / "plugin.json").read_text())["version"] == "1.1.68", manifest
    assert "Version `1.1.68`" in (PLUGIN_ROOT / "README.md").read_text()
    changelog = (PLUGIN_ROOT.parents[1] / "CHANGELOG.md").read_text()
    assert "### vibe v1.1.68" in changelog
    assert "### vibe v1.1.61" in changelog
    assert "### vibe v1.1.54" in changelog
    assert "Load-aware execution" in changelog
    assert "### vibe v1.1.45" in changelog
    assert "raw PNG bytes" in changelog
