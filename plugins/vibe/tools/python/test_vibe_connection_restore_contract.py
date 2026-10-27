"""Contract checks for ISS-13258: restoring a ClosedLoop connection is steps the setup worker runs.

A vibe user on Codex was told to "connect the ClosedLoop connector in Codex
Settings: open Settings and click Connect". The step named no section or
label, and they could not find it. The fix:

1. `preflight.md`, "Restoring a connection", is the one procedure: the setup
   worker runs the Codex CLI commands the installation guide uses, the person
   only signs in in the browser and then starts a new chat.
2. The orchestrator and the setup worker point at it for both connections.
3. No vibe or fleet-orchestrator instruction sends the person into the app's
   Settings; the one macOS path left names its real labels.
"""

from __future__ import annotations

import json
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
    return re.findall(r'with exactly: "([^"]+)"', flat(text))


def test_release_and_both_manifests_are_112() -> None:
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads((PLUGIN_ROOT / manifest).read_text())["version"] == "1.1.2"


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
    assert "quitting the app is not needed" in restore


def test_the_person_signs_in_then_clicks_new_chat_in_plain_words() -> None:
    lines = person_lines(section(PREFLIGHT.read_text(), RESTORE))
    assert len(lines) == 2
    sign_in, new_chat = lines
    assert "sign-in page just opened in your browser" in sign_in and "your own ClosedLoop account" in sign_in
    assert "click New chat in the sidebar and type $vibe" in new_chat
    for line in person_lines(PREFLIGHT.read_text()):
        assert not PERSON_BANNED.search(line), line


def test_orchestrator_and_setup_worker_use_the_procedure_for_both_connections() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    worker = flat(agent("vibe-setup-worker"))
    beyond = section(PREFLIGHT.read_text(), "## Beyond the script")
    assert "If either does not answer, dispatch `vibe-setup-worker` to restore that connection" in skill
    assert '"Restoring a connection"' in skill
    assert "start a new chat when the setup worker says so" in skill
    assert '`preflight.md`, "Restoring a connection", exactly' in worker
    assert "ClosedLoop's `get-me` failed" in worker and "closedloop-graph's `sync_status` failed" in worker
    assert "dispatch `vibe-setup-worker` to restore the `closedloop` connection" in beyond
