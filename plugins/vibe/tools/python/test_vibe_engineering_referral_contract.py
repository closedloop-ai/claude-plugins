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
    assert "Only after both the worker and vibe root tried their safe paths" in guardrail
    assert "genuinely need a human-only decision, access or credentials only a person has" in guardrail
    assert "A recoverable tooling defect follows the path above, with no handover" in guardrail
    assert 'Use an engineering referral only for that last category' in guardrail
    assert "`vibe-environment-worker` in handover mode" in guardrail
    assert "Never edit vibe's checker to force a pass, waive a check" in guardrail


def test_tooling_fix_alone_never_stops_vibe_handoff_or_workers() -> None:
    old_stop = re.compile(
        r"when continuing needs a fix to the vibe tooling, stop|"
        r"a needed (?:vibe )?tooling fix (?:returns `BLOCKED`|stops the session|stops the handoff)",
        re.IGNORECASE,
    )
    for path in TEMPLATES:
        assert not old_stop.search(flat(path.read_text())), path
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    assert "Only after both the worker and vibe root tried their safe paths" in guardrail
    assert "`vibe-environment-worker` in handover mode" in guardrail


def test_own_install_artifact_is_restored_only_after_ownership_proof() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    assert "If the session caused the change, back it up in the session's private area" in skill
    assert "Ask about restoration only for an earlier or person-owned edit" in skill
    assert "capture the tracked and staged state of each install-managed file" in guardrail
    assert "the file was clean before the command" in guardrail
    assert "the receipt or a bounded reproduction establishes that the session's own command changed it" in guardrail
    assert "save the exact changed file in the session's private Git metadata before restoring" in guardrail
    assert "A later person edit, an earlier change, or uncertain attribution is never session owned" in guardrail
    assert "preserve it and ask one plain question with a recommendation before any overwrite" in guardrail
    assert "use the shipped `e2eLeftForCi` path and the re-pinned CI reader" in guardrail
