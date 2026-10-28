"""Contract checks for ISS-13258: restoring a ClosedLoop connection is steps the setup worker runs.

A vibe user on Codex was told to "connect the ClosedLoop connector in Codex
Settings: open Settings and click Connect". The step named no section or
label, and they could not find it. The fix:

1. `preflight.md`, "Restoring a connection", is the one procedure: the setup
   worker runs the Codex CLI commands the installation guide uses, the person
   only signs in in the browser, and a new chat is asked for only when the
   connection still fails in this chat or was just added (checked 2026-10-28
   against the app's own Codex app server and Claude Code 2.1.308).
2. The orchestrator and the setup worker point at it for both connections.
3. No vibe or fleet-orchestrator instruction sends the person into the app's
   Settings; the one macOS path left names its real labels.
4. A command the Codex sandbox refuses is run again with an escalation
   request (the person clicks Allow once), never handed to the person.
5. GitHub sign-in is run by the agent; the person only finishes the page.
6. vibe and fleet-orchestrator show a setup check block once per conversation.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
PREFLIGHT = VIBE / "references" / "preflight.md"
RESTORE = "## Restoring a connection"
# Engineering words `plain-words.md` keeps from the person, plus the app section the person could not find.
PERSON_BANNED = re.compile(r"\b(?:MCP|OAuth|CLI|token|connector|Settings|server)\b")
# The only places an instruction file may name the word Settings: the verified macOS path
# (System Settings > Privacy & Security > Files & Folders) and the rule that forbids the app's Settings.
ALLOWED_SETTINGS = (
    "System Settings, Privacy & Security, Files & Folders",
    "never send the person into the app's Settings",
)
SETTINGS = re.compile(r"\bSettings\b")
VAGUE_CONNECT = re.compile(r"\bclick Connect\b|\bconnect the [\w-]+ connector\b", re.IGNORECASE)


def instruction_files() -> list[Path]:
    """Every Markdown instruction file in vibe's skills and agents (fleet-orchestrator included), evals excluded."""
    return sorted(path for folder in (PLUGIN_ROOT / "skills", PLUGIN_ROOT / "agents")
                  for path in folder.rglob("*.md") if "evals" not in path.parts)


def person_lines(text: str) -> list[str]:
    return re.findall(r'(?:with|Send) exactly: "([^"]+)"', flat(text))


def test_no_instruction_sends_the_person_into_the_app_settings() -> None:
    offenders = []
    for path in instruction_files():
        text = flat(path.read_text())
        for allowed in ALLOWED_SETTINGS:
            text = re.sub(re.escape(allowed), "", text, flags=re.IGNORECASE)
        for found in [*SETTINGS.finditer(text), *VAGUE_CONNECT.finditer(text)]:
            offenders.append(f"{path.relative_to(PLUGIN_ROOT)}: ...{text[max(0, found.start() - 80):found.end() + 40]}...")
    assert offenders == []


def test_the_guard_rejects_the_reported_step_and_a_mislabeled_path() -> None:
    reported = ("If it fails, the person needs to connect the ClosedLoop connector in Codex Settings: "
                "ask them to open Settings and click Connect, then complete sign-in in the browser.")
    mislabeled = "they allow it in System Settings, Privacy & Security, Files and Folders, under Codex."
    for text in (reported, mislabeled):
        stripped = text
        for allowed in ALLOWED_SETTINGS:
            stripped = re.sub(re.escape(allowed), "", stripped, flags=re.IGNORECASE)
        assert SETTINGS.search(stripped) or VAGUE_CONNECT.search(stripped), text
    assert VAGUE_CONNECT.search(reported)


def test_restoring_a_connection_is_commands_the_worker_runs() -> None:
    restore = section(PREFLIGHT.read_text(), RESTORE)
    install = flat((VIBE / "INSTALL.md").read_text())
    add = re.search(r'"\$CODEX" (mcp add closedloop --url \S+)', install)
    assert add, "INSTALL.md adds the ClosedLoop connection with the Codex CLI"
    for command in (
        '"<codex>" mcp list',
        f'"<codex>" {add.group(1)}',
        '"<codex>" mcp login <name>',
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
        "nohup",
        "claude mcp get <name>",
    ):
        assert command in restore, command
    for column in ("`Not logged in`", "`OAuth`", "`disabled`"):
        assert column in restore, column
    assert "Never type, paste or ask for a password, code or token" in restore
    assert "Quitting the app is not needed" in restore
    assert "It opens the ClosedLoop sign-in itself; no `mcp login` follows it" in restore


def test_the_person_only_signs_in_and_is_asked_for_a_new_chat_in_plain_words() -> None:
    restore = section(PREFLIGHT.read_text(), RESTORE)
    lines = person_lines(restore)
    assert len(lines) == 3
    sign_in, new_chat, claude_link = lines
    assert "sign-in page just opened in your browser" in sign_in and "your own ClosedLoop account" in sign_in
    assert "click New chat in the sidebar and type $vibe" in new_chat
    assert "Open this link to sign in to ClosedLoop with your own ClosedLoop account" in claude_link
    for line in person_lines(PREFLIGHT.read_text()):
        assert not PERSON_BANNED.search(line), line


def test_orchestrator_and_setup_worker_use_the_procedure_for_both_connections() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    worker = flat(agent("vibe-setup-worker"))
    beyond = section(PREFLIGHT.read_text(), "## Beyond the script")
    assert "If either does not answer, dispatch `vibe-setup-worker` to restore that connection" in skill
    assert '"Restoring a connection"' in skill
    assert 'then start a new chat only when "Restoring a connection" step 5 says so' in skill
    assert '`preflight.md`, "Restoring a connection", exactly' in worker
    assert "ClosedLoop's `get-me` failed" in worker and "closedloop-graph's `sync_status` failed" in worker
    assert "dispatch `vibe-setup-worker` to restore the `closedloop` connection" in beyond


def test_a_new_chat_is_asked_for_only_when_this_chat_still_fails_or_the_connection_was_added() -> None:
    # Checked 2026-10-28: after `codex mcp login`, a chat whose connection failed when it started
    # reconnects at the next message; a chat whose sign-in ran out mid-chat, or one opened before
    # `codex mcp add`, never sees the new connection. The old text asked for a new chat every time.
    step5 = section(PREFLIGHT.read_text(), RESTORE).split("5. The orchestrator then finds out whether this chat has the connection.", 1)
    assert len(step5) == 2, "step 5 belongs to the orchestrator"
    step5 = step5[1].split("On Claude Code", 1)[0]
    assert "After `login` or no command: call `get-me` (or `sync_status`) again in this chat" in step5
    assert "carry on, with no new chat" in step5
    assert "It still fails, or the command was `add`" in step5
    assert step5.index("carry on, with no new chat") < step5.index("click New chat in the sidebar")
    restore = section(PREFLIGHT.read_text(), RESTORE)
    assert "A connection added, signed in or repaired while this chat is open reaches only a new chat" not in restore
    skill = flat((VIBE / "SKILL.md").read_text())
    assert "When it returns `DONE`, do that section's step 5 yourself: call the tool again in this chat" in skill
    assert "Ask for a new chat only when it still fails or the connection was just added, never as a precaution." in skill
    worker = flat(agent("vibe-setup-worker"))
    assert "whether a new chat is needed is the orchestrator's step 5, never yours" in worker
    assert "starts a new chat, each returned as `NEEDS_PERSON`" not in worker


def test_claude_code_restore_uses_the_conversations_own_sign_in_tool() -> None:
    claude = section(PREFLIGHT.read_text(), RESTORE).split("On Claude Code", 1)[1]
    assert "`mcp__<name>__authenticate`" in claude
    assert "the connection works in this same conversation" in claude
    assert "`claude mcp login` needs a terminal, so no worker can run it" in claude
    assert "The smallest one is `/exit` and then `claude --continue` in the same folder, which keeps the conversation" in claude
    assert "never `/clear`, which drops it" in claude
    assert "a connection's own `authenticate` tool" in flat((VIBE / "SKILL.md").read_text())


SANDBOX = "## Commands the sandbox blocks"
GITHUB = "## Signing in to GitHub"
# Person-facing lines that send the person to the Terminal app. Only the Claude sign-in, which the
# agent cannot run for them (`claude auth login` needs the person's terminal), may do that.
PERSON_QUOTE = re.compile(r'(?:exactly|NEEDS_PERSON[^"]{0,60}|tell (?:the person|them|the operator)[^"]{0,40}):?\s*"([^"]{1,600})"', re.IGNORECASE)
TERMINAL = re.compile(r"\bTerminal\b")
ALLOWED_TERMINAL = ("Your Claude sign-in on this Mac has run out",)


def test_a_command_the_sandbox_refuses_is_escalated_never_handed_to_the_person() -> None:
    sandbox = section(PREFLIGHT.read_text(), SANDBOX)
    for phrase in (
        "failed to persist config ... Operation not permitted",
        '`sandbox_permissions: "require_escalated"`',
        "\"Allow ChatGPT to run this command?\"",
        "click Allow once",
        "In \"Full access\" mode there is no prompt",
        "This holds for a spawned worker too",
        "Never hand such a command to the person or send them to the Terminal app.",
    ):
        assert phrase in sandbox, phrase
    assert '"I\'m reconnecting <ClosedLoop|GitHub> for you. If ChatGPT asks whether it can run a command, click Allow once."' in sandbox
    for name in (RESTORE, GITHUB):
        assert 'requesting escalation as "Commands the sandbox blocks" says' in section(PREFLIGHT.read_text(), name), name
    assert '`preflight.md`, "Commands the sandbox blocks"' in flat(agent("vibe-setup-worker"))
    skill = flat((VIBE / "SKILL.md").read_text())
    assert 'click Allow once when Codex asks to run a setup command' in skill
    assert ('send the one heads-up line from `references/preflight.md`, "Commands the sandbox blocks", '
            'before you dispatch it for a sign-in (ClosedLoop or GitHub)') in skill
    assert "dispatch it again to rerun that command with an escalation request, never handing the command to the person" in skill


def test_github_sign_in_is_run_by_the_agent() -> None:
    github = section(PREFLIGHT.read_text(), GITHUB)
    for phrase in (
        "gh auth login --hostname github.com --git-protocol https --web",
        "< /dev/null &",
        "it opens no browser",
        "`open https://github.com/login/device`",
        "`gh auth status --hostname github.com` must pass",
        "Then run `gh auth setup-git`",
        "A GitHub sign-in never needs a new chat.",
    ):
        assert phrase in github, phrase
    (line,) = person_lines(github)
    assert line.startswith("A GitHub page just opened in your browser.") and "enter the code <code>" in line
    row = next(r for r in PREFLIGHT.read_text().splitlines() if r.startswith("| `gh-auth-login` |"))
    assert 'Follow "Signing in to GitHub" below' in row and "Never send the person to the Terminal app" in row


def test_no_person_line_sends_the_person_to_the_terminal_for_something_the_agent_can_run() -> None:
    offenders = []
    for path in instruction_files():
        if path.name == "INSTALL.md":  # written for the engineer who installs vibe, not the person
            continue
        for found in PERSON_QUOTE.finditer(flat(path.read_text())):
            if TERMINAL.search(found.group(1)) and not found.group(1).startswith(ALLOWED_TERMINAL):
                offenders.append(f"{path.relative_to(PLUGIN_ROOT)}: {found.group(1)[:120]}")
    assert offenders == []


def test_the_terminal_guard_rejects_the_reported_github_step() -> None:
    reported = ('Return `NEEDS_PERSON` with exactly: "In Terminal, run `gh auth login --hostname github.com '
                '--git-protocol https --web`, complete the browser sign-in, then run `gh auth setup-git`."')
    found = PERSON_QUOTE.search(reported)
    assert found and TERMINAL.search(found.group(1)) and not found.group(1).startswith(ALLOWED_TERMINAL)


def test_vibe_and_the_fleet_show_the_setup_check_once_per_conversation() -> None:
    check = section((VIBE / "SKILL.md").read_text(), "### Setup check")
    for phrase in (
        "Once per conversation, right after the version check",
        "`node scripts/plugin-version.mjs status --closedloop <state> --graph <state>`",
        "`connected` only when that call answered in this conversation",
        "never assume either",
        "opens your first reply word for word, before the version question or the endings line",
        "`\"print\":false` means this conversation already showed it",
        "A `not connected` line starts \"Restoring a connection\" at once",
    ):
        assert phrase in check, phrase
    assert 'the setup check block, once per conversation (section 1, "Setup check")' in flat((VIBE / "SKILL.md").read_text())
    fleet = section((PLUGIN_ROOT / "skills" / "fleet-orchestrator" / "SKILL.md").read_text(), "## Setup")
    for phrase in (
        "Setup check, once per chat, right after the version check",
        "run it as vibe's [Setup check](../vibe/SKILL.md#setup-check) says (both connection calls first, then `plugin-version.mjs status`), adding `--state <orchDir>/plugin-version.json`",
        "never handed to the operator",
    ):
        assert phrase in fleet, phrase
    new_chat = section((PLUGIN_ROOT / "skills" / "fleet-orchestrator" / "references" / "state.md").read_text(), "## A new chat")
    assert "Then show the setup check block (SKILL.md, Setup) once." in new_chat
