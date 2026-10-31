"""Contract checks for role-neutral vibe text (ISS-13292, operator ruling, 2026-10-28).

vibe is for executives, designers, product managers and engineers. Plain words stay the default for
everyone; when the person explicitly asks for technical detail (the plan, files changed, a diff or
commands), that one reply gives it, and the next message goes back to plain words.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from vibe_contract_text import flat, section


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
PLAIN_WORDS = VIBE / "references" / "plain-words.md"
QUALITY_LOOP = VIBE / "references" / "quality-loop.md"
NON_ENGINEER = re.compile(r"non-engineer|not an engineer|does not use git", re.IGNORECASE)
RULE = "When the person asks for technical detail"


def plugin_text_files() -> list[Path]:
    return [
        *PLUGIN_ROOT.glob("skills/**/*.md"),
        *PLUGIN_ROOT.glob("agents/*.md"),
        *PLUGIN_ROOT.glob("evals/*/graders/*.md"),
        PLUGIN_ROOT / ".codex-plugin" / "plugin.json",
    ]


def test_no_vibe_text_assumes_the_person_is_not_an_engineer() -> None:
    offenders = [str(path.relative_to(PLUGIN_ROOT)) for path in plugin_text_files() if NON_ENGINEER.search(path.read_text())]
    assert offenders == []


def test_descriptions_name_every_role() -> None:
    skill = (VIBE / "SKILL.md").read_text()
    long_description = json.loads((PLUGIN_ROOT / ".codex-plugin" / "plugin.json").read_text())["interface"]["longDescription"]
    for text in (skill.split("---", 2)[1], long_description):
        for role in ("executive", "designer", "product manager", "engineer"):
            assert role in text


def test_technical_detail_is_given_only_in_the_reply_that_asked() -> None:
    rule = section(PLAIN_WORDS.read_text(), "## " + RULE)
    assert "explicitly asks for technical detail, such as the plan, the files changed, the diff or the commands" in rule
    assert "give it in that reply" in rule
    assert "Only that reply carries it. The next message goes back to plain words" in rule
    assert "an update the person did not ask for never carries technical detail" in rule
    assert "never asking the person to approve it" in rule
    assert "Plain words are the default for everyone" in flat(PLAIN_WORDS.read_text())


def test_skill_and_quality_loop_point_at_the_rule() -> None:
    for path in (VIBE / "SKILL.md", QUALITY_LOOP):
        assert RULE in flat(path.read_text())
