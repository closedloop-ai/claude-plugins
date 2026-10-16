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
