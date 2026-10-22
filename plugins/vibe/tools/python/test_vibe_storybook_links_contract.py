"""Contract checks for the 2026-10-14 operator ruling on Storybook links.

1. Every Storybook link vibe or handoff gives the person, or writes on the live
   ticket, opens the full Storybook UI with its sidebar and controls:
   `<storybook-base>/?path=/story/<story-id>`, never the bare canvas
   `<storybook-base>/iframe.html?id=<story-id>&viewMode=story`.
2. The rule lives once, in `environment.md`; the skills, the ticket template
   and the workers that produce story links point at it.
3. No plugin file builds or describes a story link in the canvas form.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
AGENTS = PLUGIN_ROOT / "agents"
VIBE = PLUGIN_ROOT / "skills" / "vibe"
ENVIRONMENT = VIBE / "references" / "environment.md"
TICKET_TEMPLATE = VIBE / "references" / "ticket-template.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
FULL_UI = "`<storybook-base>/?path=/story/<story-id>`"
CANVAS = "`<storybook-base>/iframe.html?id=<story-id>&viewMode=story`"
AGENT_POINTER = (
    f"Every Storybook link opens the full Storybook UI, {FULL_UI}, never the bare `iframe.html` canvas "
    '(`../skills/vibe/references/environment.md`, "Storybook links").'
)
LINK_WORKERS = ("vibe-ticket-worker", "vibe-storybook-decomposer", "vibe-handoff-summarizer", "vibe-primitive-worker")
TEXT_SUFFIXES = {".md", ".mjs", ".mts", ".js", ".ts", ".py", ".json", ".yaml"}
CANVAS_LINK = re.compile(r"iframe\.html\?id=")
STORY_PATH = re.compile(r"(.{0,12})/story/")


def plugin_text_files() -> list[Path]:
    return [
        path
        for path in sorted(PLUGIN_ROOT.rglob("*"))
        if path.is_file() and path.suffix in TEXT_SUFFIXES and "assets" not in path.parts and path.name != Path(__file__).name
    ]


def test_the_rule_requires_the_full_storybook_ui() -> None:
    text = section(ENVIRONMENT.read_text(), "## Storybook links")
    for required in (
        "Every Storybook link given to the person or written on the live ticket opens the full Storybook UI, "
        "with its sidebar and controls",
        f"the Storybook base alone, or {FULL_UI} for one story",
        "the verified Vercel `storybookUrl` or the local `storybookUrl` in the session's stack",
        f"Never give the bare canvas, {CANVAS}, which shows the story without the sidebar or controls",
        "story without the sidebar or controls. This section is the rule's one canonical statement",
        "This section is the rule's one canonical statement",
    ):
        assert required in text, required


def test_the_skills_and_ticket_template_point_at_the_rule() -> None:
    notices = section(VIBE_SKILL.read_text(), "### Notices that never wait")
    assert "`<storybookUrl>/?path=/story/<id>`" in notices
    assert '(never the bare `iframe.html` canvas; `references/environment.md`, "Storybook links")' in notices
    handoff = flat(HANDOFF_SKILL.read_text())
    assert (
        "IDs/direct links (full Storybook UI links, never the bare `iframe.html` canvas; "
        '`../vibe/references/environment.md`, "Storybook links")' in handoff
    )
    assert 'the Storybook link (the full Storybook UI per `../vibe/references/environment.md`, "Storybook links")' in handoff
    inventory = section(TICKET_TEMPLATE.read_text(), "## Design Review")
    assert f'each {FULL_UI} and never the bare `iframe.html` canvas (`environment.md`, "Storybook links")' in inventory


def test_every_worker_that_reports_story_links_points_at_the_rule() -> None:
    for name in LINK_WORKERS:
        assert AGENT_POINTER in flat((AGENTS / f"{name}.md").read_text()), name


def test_no_plugin_file_uses_the_canvas_link_form_except_the_rule_itself() -> None:
    holders = [path.name for path in plugin_text_files() if CANVAS_LINK.search(path.read_text())]
    assert holders == ["environment.md"]


def test_every_story_path_uses_the_full_ui_form() -> None:
    for path in plugin_text_files():
        for prefix in STORY_PATH.findall(path.read_text()):
            assert prefix.endswith("?path="), (path.name, prefix)
