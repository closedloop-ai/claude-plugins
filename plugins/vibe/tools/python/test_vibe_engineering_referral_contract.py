"""Person-facing vibe templates require exhausted paths before an engineer referral."""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import flat


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
TEMPLATES = (
    VIBE / "SKILL.md",
    VIBE / "references" / "plain-words.md",
    VIBE / "references" / "guardrails.md",
    VIBE / "references" / "environment.md",
    VIBE / "references" / "ticket-template.md",
    PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md",
    PLUGIN_ROOT / "agents" / "vibe-setup-worker.md",
    PLUGIN_ROOT / "agents" / "vibe-change-worker.md",
    PLUGIN_ROOT / "agents" / "vibe-environment-worker.md",
    PLUGIN_ROOT / "agents" / "vibe-verify-worker.md",
)
PREMATURE_REFERRAL = re.compile(
    r"(?:this|that|you) need(?:s)? an engineer|"
    r"message engineering|ask engineering to|"
    r"engineering (?:needs|must|has to|should) (?:fix|repair|stabilize|do|take)",
    re.IGNORECASE,
)


def test_person_facing_templates_have_no_unconditional_engineering_referral() -> None:
    for path in TEMPLATES:
        assert not PREMATURE_REFERRAL.search(path.read_text()), path


def test_single_reply_rule_requires_exhaustion_and_supported_handover() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    assert skill.count("Before any reply, including handoff or relayed worker text") == 1
    assert "all available paths are exhausted" in skill
    assert "When the person says they are the engineer or asks what" in skill
    assert "Only a verified engineering-only blocker after every available path has" in guardrail
    assert "`vibe-environment-worker` in handover mode" in guardrail
    assert "Never edit vibe's checker to force a pass, waive a check" in guardrail
