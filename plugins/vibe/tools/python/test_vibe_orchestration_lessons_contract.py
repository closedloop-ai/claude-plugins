"""Contract coverage for the orchestration, resume and pull request follow-up lessons.

Ledger lessons from 2026-10-19 and 2026-10-20: an unscoped pkill on a shared
machine, orchestration state wiped from /tmp by a reboot, Codex computer use
draining the weekly limit, a dead Codex writer whose work Claude workers did
outside the session records, a session idling on an unmerged dependency,
human review threads left unanswered, and threads resolved while only partly
fixed.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN = Path(__file__).resolve().parents[2]
REPO = PLUGIN.parents[1]
VIBE = PLUGIN / "skills" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff"
GUARDRAILS = (VIBE / "references" / "guardrails.md").read_text()
QUALITY_LOOP = (VIBE / "references" / "quality-loop.md").read_text()
HANDOFF_SKILL = (HANDOFF / "SKILL.md").read_text()
PROCESS_KILL = re.compile(r"\b(?:pkill|killall)\b")
NEGATION = re.compile(r"\b(?:never|not|no)\b", re.IGNORECASE)


def _plugin_files(*suffixes: str) -> list[Path]:
    roots = [PLUGIN, REPO / "tools" / "vibe-workers" / "src"]
    return [
        path
        for root in roots
        for path in root.rglob("*")
        if path.is_file() and path.suffix in suffixes and "node_modules" not in path.parts
    ]


def test_no_script_stops_a_process_by_name_or_pattern() -> None:
    offenders = [
        f"{path.relative_to(REPO)}:{number}"
        for path in _plugin_files(".mjs", ".js", ".ts", ".sh", ".py")
        if path.name != Path(__file__).name
        for number, line in enumerate(path.read_text().splitlines(), 1)
        if PROCESS_KILL.search(line)
    ]
    assert offenders == []


def test_every_instruction_naming_pkill_forbids_it() -> None:
    for path in _plugin_files(".md"):
        for paragraph in re.split(r"\n\s*\n", path.read_text()):
            if PROCESS_KILL.search(paragraph):
                assert NEGATION.search(paragraph), f"{path.relative_to(REPO)}: {flat(paragraph)[:160]}"


def test_session_scripts_keep_no_state_in_the_temp_folder() -> None:
    scripts = [
        path
        for folder in (VIBE / "scripts", HANDOFF / "scripts")
        for path in folder.glob("*.mjs")
        if not path.name.endswith(".test.mjs") and path.name != "test-fixtures.mjs"
    ]
    assert scripts
    offenders = [str(path.relative_to(REPO)) for path in scripts if "tmpdir(" in path.read_text()]
    assert offenders == []
    precedent = (VIBE / "scripts" / "precedent-check.mjs").read_text()
    assert '".codex", "vibe", "precedent"' in precedent


def test_processes_and_state_rules_bind_every_worker() -> None:
    rules = section(GUARDRAILS, "## Processes and state")
    for phrase in (
        "Stop only processes this session started",
        "Never `pkill`, `killall` or `kill` by name or pattern",
        "reported as a blocker, never stopped",
        "Never keep a session record, writer or queue state",
        "`/tmp`",
        "no computer use",
        "only through `gh`, never a browser tab",
        "written request",
        "owned launcher (`scripts/dist/claude-worker.mjs`",
        "stays `not met yet`",
    ):
        assert phrase in rules, phrase
    harness = section((VIBE / "SKILL.md").read_text(), "## Harness notes")
    assert '"Processes and state"' in harness
    assert "`harnessSwitch`" in harness
    assert "pkill" in flat(agent("vibe-verify-worker"))
    assert "never stop a process by name or pattern" in flat(agent("vibe-setup-worker"))


def test_codex_paths_use_no_computer_use() -> None:
    for path in [*(PLUGIN / "agents").glob("*.md"), *(VIBE / "references").glob("*.md"), VIBE / "SKILL.md", VIBE / "INSTALL.md", HANDOFF / "SKILL.md"]:
        for paragraph in re.split(r"\n\s*\n|\n(?=- )|\n(?=\| )", path.read_text()):
            if "Computer Use" in paragraph or "computer use" in paragraph:
                assert NEGATION.search(paragraph), f"{path.name}: {flat(paragraph)[:160]}"
    precedent = section(QUALITY_LOOP, "### Precedent before asking")
    assert "never the in-app Browser or the Computer Use plugin" in precedent
    after_deploy = flat((VIBE / "references" / "environment.md").read_text())
    assert "never a screenshot of the in-app Browser tab" in after_deploy


def test_dead_codex_writer_moves_to_claude_through_the_ledger() -> None:
    switch = section(QUALITY_LOOP, "### Recorded definition migration")
    for phrase in (
        "**A writer whose runtime cannot run.**",
        "never has a Claude worker do the writer's work outside the session records",
        '`"status": "FAILED"`',
        '"harnessSwitch": { "to": "claude", "cause": "usage-limit"',
        "refuses a running source or record turn, a retained record grant, a writer refusal",
    ):
        assert phrase in switch, phrase
    bundle = (VIBE / "scripts" / "dist" / "writer-state.mjs").read_text()
    assert '"harness-switch"' in bundle
    assert "harnessSwitch" in bundle


def test_a_dependency_on_an_open_pull_request_never_idles_the_session() -> None:
    rule = flat(QUALITY_LOOP)
    assert "**A dependency on an open pull request never idles the session**" in rule
    assert "Never pause, wait for the merge, or ask the person to restart anything" in rule
    assert "`gh pr view <number> --json state,mergedAt,headRefOid` at every resume" in rule


def test_human_review_threads_are_read_on_every_look() -> None:
    step0 = section(HANDOFF_SKILL, "## 0. Pick the session")
    assert "`reviewThreads: read` on every such look, whatever the person asked" in step0
    assert "`awaitingReply`" in step0
    assert "without waiting for the person to ask" in step0
    assert "`awaitingReply`" in flat(agent("vibe-environment-worker"))
    assert "`$gh-monitor-pr`" in flat(HANDOFF_SKILL)


def test_a_thread_is_resolved_only_after_independent_verification() -> None:
    changes = section(HANDOFF_SKILL, "## 10. Changes on the open pull request")
    assert "`partial` with what remains" in changes
    assert "the writer's own report is never that verification" in changes
    assert "`scripts/review-threads.mjs check` lists under `resolve`" in changes
    assert "flag-off behavior to main" in changes
    environment = flat(agent("vibe-environment-worker"))
    assert "review-threads.mjs check --results" in environment
    assert "only a thread the check lists under `resolve`" in environment
    script = (HANDOFF / "scripts" / "review-threads.mjs").read_text()
    assert "a fix is verified by a reviewer other than the writer" in script
