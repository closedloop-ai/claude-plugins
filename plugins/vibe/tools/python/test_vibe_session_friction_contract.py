"""Contract checks for the 2026-10-15 product-manager session's friction (operator ruling, 2026-10-15).

1. Setup: Claude Code workers launch through the owned launcher, never the native Agent tool, with
   `agentRoot` left out; a signed-out or expired Claude sign-in becomes one plain step, never
   `claude /login` (which opened an interactive session with a permission-rule dump and an MCP prompt).
2. Questions: every question goes through `session-questions.mjs`, so none is asked twice; the
   sample-data question is plain, behind the necessity gate, and never names a company after the
   person's email.
3. Tools: no plugin file bounds a command with GNU `timeout`, which macOS lacks; workers are told
   to use `run-bounded.mjs`.
4. Words: one banned-terms list with plain replacements, referenced by both skills.
5. Processes and state (operator lessons, 2026-10-19): no plugin script stops a process by name or
   pattern, every instruction naming `pkill` forbids it, session scripts keep no state in the temp
   folder, and a dependency on an open pull request never idles the session.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
PLAIN_WORDS = VIBE / "references" / "plain-words.md"
PREFLIGHT = VIBE / "references" / "preflight.md"
LAUNCHER_BUNDLE = VIBE / "scripts" / "dist" / "claude-worker.mjs"
LAUNCHER_SOURCE = PLUGIN_ROOT.parents[1] / "tools" / "vibe-workers" / "src" / "claude-preflight.ts"
AGENTS = PLUGIN_ROOT / "agents"
SESSION_TERMS = ("handoff", "the branch to merge", "branch", "MCP", "storybook server", "seeded")
GNU_TIMEOUT = re.compile(r"(?:^|[\s;&|(`$])g?timeout\s+(?:-[A-Za-z]+\s+\S+\s+)*\d")


def banned_terms() -> list[str]:
    rows = [line for line in PLAIN_WORDS.read_text().splitlines() if line.startswith("| ") and "---" not in line]
    return [term.strip().strip("`") for row in rows[1:] for term in row.split("|")[1].split(",")]


def test_one_banned_terms_list_covers_every_term_the_person_saw() -> None:
    terms = [term.lower() for term in banned_terms()]
    for seen in SESSION_TERMS:
        assert seen.lower() in terms, seen
    table = PLAIN_WORDS.read_text()
    assert "| Never say to the person | Say instead |" in table
    assert "Never use the person's email address as the name of a company" in flat(table)


def test_both_skills_and_the_person_facing_workers_reference_the_list() -> None:
    role = section(VIBE_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    assert "Every word the person sees follows `references/plain-words.md`" in role
    assert "`../vibe/references/plain-words.md`" in flat(HANDOFF_SKILL.read_text())
    assert "plain-words.md" in flat((AGENTS / "vibe-setup-worker.md").read_text())


def test_every_question_is_recorded_and_never_asked_twice() -> None:
    rule = section(VIBE_SKILL.read_text(), "### Questions are asked once")
    for required in (
        "No question reaches the person twice (operator ruling, 2026-10-15).",
        "node scripts/session-questions.mjs ask --key <topic>",
        "Ask only when it returns `\"ask\": true`.",
        "it is already waiting: do not repeat it, remind the person of it, or add it to another message",
        "node scripts/session-questions.mjs answer --key <topic>",
        "`session-questions.mjs list --worktree \"<wt>\"`",
        "`node scripts/session-questions.mjs reset` before the first question",
    ):
        assert required in rule, required
    assert "`scripts/session-questions.mjs`" in section(VIBE_SKILL.read_text(), "## Your role: orchestrate, never do the work")
    assert "`../vibe/scripts/session-questions.mjs`" in flat(HANDOFF_SKILL.read_text())


def test_the_sample_data_question_is_plain_gated_and_never_uses_the_email() -> None:
    skill = VIBE_SKILL.read_text()
    starting = section(skill, "### Starting new")
    assert "same necessity gate as any other question" in starting
    assert "In every other case record `seeded` and ask nothing." in starting
    assert ("\"Should your copy of the app start with an example company that already has people and "
            "work in it, or start empty so you can set it up yourself?\"") in starting
    assert "Never name the example company after the person's email" in starting
    for text in (skill, (AGENTS / "vibe-environment-worker.md").read_text()):
        assert "<email> Co" not in text
    question = re.search(r'ask once, in these words: "([^"]+)"', starting)
    assert question
    for term in banned_terms():
        if term and not term.startswith("("):
            assert not re.search(rf"\b{re.escape(term)}\b", question.group(1), re.I), term


def test_claude_workers_launch_through_the_owned_launcher_without_a_guessed_root() -> None:
    notes = section(VIBE_SKILL.read_text(), "## Harness notes")
    for required in (
        "Launch every worker through `scripts/dist/claude-worker.mjs`, never through the native Agent tool",
        "with no ClosedLoop or closedloop-graph tools",
        "Leave `agentRoot` out",
        "`STALE_PLUGIN_ROOT`",
        "`MISSING_CAPABILITIES`",
        "`CLAUDE_SIGN_IN_NEEDED`: send the person its `personAction` once, word for word",
        "Never tell them to run `claude /login`",
        "`MCP_TOOLS_MISSING`",
        "`register` and `acquire-record` bind the installed plugin root",
    ):
        assert required in notes, required


def test_the_sign_in_step_is_one_plain_instruction_shared_by_preflight_and_launcher() -> None:
    row = next(line for line in PREFLIGHT.read_text().splitlines() if line.startswith("| `claude-auth-login` |"))
    instruction = re.search(r'Return `NEEDS_PERSON` with exactly: "([^"]+)"', row)
    assert instruction
    text = instruction.group(1)
    assert "claude auth login" in text
    assert "/login" not in text.replace("auth login", "")
    for term in ("MCP", "OAuth", "CLI", "token"):
        assert term not in text, term
    source = LAUNCHER_SOURCE.read_text()
    constant = "".join(re.findall(r'"([^"]*)"', source[source.index("SIGN_IN_PERSON_ACTION ="):source.index(";\n", source.index("SIGN_IN_PERSON_ACTION ="))]))
    assert constant == text
    assert text in LAUNCHER_BUNDLE.read_text().replace('" + "', "")


def test_no_plugin_file_bounds_a_command_with_gnu_timeout() -> None:
    offenders = []
    for path in PLUGIN_ROOT.rglob("*"):
        if path.suffix not in {".md", ".sh", ".mjs", ".yaml"} or "dist" in path.parts or "evals" in path.parts:
            continue
        for number, line in enumerate(path.read_text().splitlines(), 1):
            if GNU_TIMEOUT.search(line):
                offenders.append(f"{path.relative_to(PLUGIN_ROOT)}:{number}")
    assert offenders == []
    for text in (section(VIBE_SKILL.read_text(), "## Harness notes"),
                 flat((AGENTS / "vibe-setup-worker.md").read_text()),
                 flat((AGENTS / "vibe-verify-worker.md").read_text())):
        assert "macOS has no `timeout` or `gtimeout`" in text
        assert "run-bounded.mjs" in text

    for seen in ("timeout 60 claude mcp list", "F=x; timeout 560 bash -c \"until ...\"", "gtimeout 5 pnpm test"):
        assert GNU_TIMEOUT.search(seen), seen
    for allowed in ("raise a timeout or update a snapshot", "`timeout` or `gtimeout` command", "timeout: 30_000"):
        assert not GNU_TIMEOUT.search(allowed), allowed


PROCESS_KILL = re.compile(r"\b(?:pkill|killall)\b")
NEGATION = re.compile(r"\b(?:never|not|no)\b", re.IGNORECASE)


def _plugin_files(*suffixes: str) -> list[Path]:
    roots = [PLUGIN_ROOT, LAUNCHER_SOURCE.parent]
    return [path for root in roots for path in root.rglob("*")
            if path.is_file() and path.suffix in suffixes and "node_modules" not in path.parts]


def test_no_script_stops_a_process_by_name_or_pattern() -> None:
    offenders = [f"{path.name}:{number}" for path in _plugin_files(".mjs", ".js", ".ts", ".sh")
                 for number, line in enumerate(path.read_text().splitlines(), 1) if PROCESS_KILL.search(line)]
    assert offenders == []
    for path in _plugin_files(".md"):
        for paragraph in re.split(r"\n\s*\n|\n(?=- )", path.read_text()):
            if PROCESS_KILL.search(paragraph):
                assert NEGATION.search(paragraph), f"{path.name}: {flat(paragraph)[:160]}"
    rules = section((VIBE / "references" / "guardrails.md").read_text(), "## Processes and state")
    assert "Never `pkill`, `killall` or `kill` by name or pattern" in rules
    assert "never stop a process by name or pattern" in flat((AGENTS / "vibe-setup-worker.md").read_text())
    assert "never with `pkill`, `killall`" in flat((AGENTS / "vibe-verify-worker.md").read_text())


def test_session_scripts_keep_no_state_in_the_temp_folder() -> None:
    scripts = [path for folder in (VIBE / "scripts", PLUGIN_ROOT / "skills" / "handoff" / "scripts")
               for path in folder.glob("*.mjs") if not path.name.endswith(".test.mjs") and path.name != "test-fixtures.mjs"]
    assert [path.name for path in scripts if "tmpdir(" in path.read_text()] == []
    assert '".codex", "vibe", "precedent"' in (VIBE / "scripts" / "precedent-check.mjs").read_text()
    rules = section((VIBE / "references" / "guardrails.md").read_text(), "## Processes and state")
    assert "never `/tmp` or the system temp folder" in rules


def test_a_dependency_on_an_open_pull_request_never_idles_the_session() -> None:
    rule = flat((VIBE / "references" / "quality-loop.md").read_text())
    assert "**A dependency on an open pull request never idles the session**" in rule
    assert "Never pause, wait for the merge, or ask the person to restart anything" in rule
    assert "commits every change that compiles without the unmerged code, so only the dependent import waits" in rule
    assert "`gh pr view <number> --json state,mergedAt,headRefOid` at every resume" in rule
