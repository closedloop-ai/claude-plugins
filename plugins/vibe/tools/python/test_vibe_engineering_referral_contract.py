"""Every vibe Markdown surface keeps tooling defects from becoming referrals."""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import flat


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
PREMATURE_REFERRAL = re.compile(
    r"(?:this|that|you|they|people|PMs?|executives?|the person|the work) (?:need(?:s)? an engineer|is blocked on engineering)|"
    r"message engineering|ask engineering to|"
    r"engineering (?:needs|must|has to|should) (?:fix|repair|stabilize|do|take)|"
    r"return `?BLOCKED`? for engineering",
    re.IGNORECASE,
)
TOOLING_STOP = re.compile(
    r"when continuing needs a fix to the vibe tooling, stop|"
    r"(?:if|when) (?:the )?(?:vibe(?:'s)? )?(?:tooling|checker) (?:needs? (?:a )?fix|is broken)"
    r"[^.!?]{0,100}\b(?:stop|block|return `?BLOCKED`?|handover|hand(?: the work)? off|pass(?:-on| it| the work)?)|"
    r"a tooling problem stops the session|"
    r"(?:a|the) (?:vibe )?tooling (?:problem|defect|issue|failure) [^.!?]{0,100}"
    r"\b(?:stop|block|return `?BLOCKED`?|handover|hand(?: the work)? off|pass(?:-on| it| the work)?)|"
    r"return `?BLOCKED`? when vibe's checker is broken|"
    r"a needed vibe tooling fix returns? `?BLOCKED`?|"
    r"(?:handover|hand(?: the work)? off|pass(?:-on| it| the work)?) [^.!?]{0,90}"
    r"(?:vibe )?tooling (?:fix|problem|defect|stop)|"
    r"(?:vibe )?tooling (?:fix|problem|defect|stop) [^.!?]{0,90}"
    r"(?:handover|hand(?: the work)? off|pass(?:-on| it| the work)?)",
    re.IGNORECASE,
)
HISTORICAL_STOP_PROMPTS = {
    "evals/pm-is-engineer-next-step/prompt.md": "Each stop cites this guardrail text",
    "evals/pm-tooling-rerun-continues/prompt.md": "The record cites this guardrail text",
}
COMMAND_WORKERS = {
    f"agents/vibe-{name}-worker.md" for name in ("change", "environment", "setup", "verify")
}


def all_vibe_markdown() -> list[Path]:
    """Return every Markdown file in the plugin, including eval fixtures."""
    return sorted(PLUGIN_ROOT.rglob("*.md"))


def allowed_context(path: Path, text: str, match: re.Match[str]) -> bool:
    """Admit only historical quotes, negative graders, and proven safe stops."""
    relative = path.relative_to(PLUGIN_ROOT).as_posix()
    phrase = match.group(0)
    nearby = text[max(0, match.start() - 260) : match.end() + 120]
    if "/graders/" in relative and text.startswith("--- type: regex match: not_contains"):
        parts = path.read_text().split("---")
        return len(parts) == 3 and not parts[2].strip() and match.start() > text.index("pattern:")
    if relative in HISTORICAL_STOP_PROMPTS:
        return (
            "When continuing needs a fix to the vibe tooling, stop" in phrase
            and HISTORICAL_STOP_PROMPTS[relative] in nearby
        )
    if relative == "skills/vibe/references/quality-loop.md":
        return phrase == "message engineering" and "never tells the person to message engineering about it" in nearby
    if relative == "skills/vibe/SKILL.md":
        return phrase == "they need an engineer" and "Do not tell the person they need an engineer" in nearby
    if relative == "skills/vibe/references/guardrails.md":
        return phrase in {
            "A vibe tooling defect alone does not stop",
            "tooling defect follows the path above, with no handover",
            'A vibe tooling defect follows "Plugins and tooling" above; it does not stop',
        }
    if (
        relative in COMMAND_WORKERS
        and phrase.startswith("a tooling defect and keep using the supported paths there; return `BLOCKED` only")
        and "return `BLOCKED` only for a verified engineering-only blocker after those paths" in nearby
    ):
        return True
    if relative == "agents/vibe-change-worker.md":
        return (
            "return `BLOCKED` for engineering" in phrase
            and "only fix to a live test would change what it asserts" in nearby
        )
    return False


def unexpected_matches(path: Path, pattern: re.Pattern[str]) -> list[str]:
    text = flat(path.read_text())
    return [match.group(0) for match in pattern.finditer(text) if not allowed_context(path, text, match)]


def test_person_facing_templates_have_no_unconditional_engineering_referral() -> None:
    for path in all_vibe_markdown():
        for pattern in (PREMATURE_REFERRAL, TOOLING_STOP):
            for phrase in unexpected_matches(path, pattern):
                raise AssertionError(f"{path.relative_to(PLUGIN_ROOT)}: {phrase!r}")


def test_single_reply_rule_requires_exhaustion_and_supported_handover() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    handoff = flat((PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md").read_text())
    assert skill.count("Before any reply, including handoff or relayed worker text") == 1
    assert "all available paths are exhausted" in skill
    assert "When the person says they are the engineer or asks what" in skill
    assert "Only after both the worker and vibe root tried their safe paths" in guardrail
    assert "genuinely need a human-only decision, access or credentials only a person has" in guardrail
    assert "A recoverable tooling defect follows the path above, with no handover" in guardrail
    assert 'Use an engineering referral only for that last category' in guardrail
    assert "A stop or wait alone is never the final reply" in skill
    assert "Never end with only a stop or wait" in guardrail
    assert "human-only blocker remains after both worker and vibe root exhausted safe paths" in handoff
    assert "offer to pass saved or pushed work to a named next owner now" in handoff
    assert "Never end that reply with only a stop or wait" in handoff
    assert "`vibe-environment-worker` in handover mode" in guardrail
    assert "Never edit vibe's checker to force a pass, waive a check" in guardrail


def test_tooling_fix_alone_never_stops_vibe_handoff_or_workers() -> None:
    for path in all_vibe_markdown():
        for phrase in unexpected_matches(path, TOOLING_STOP):
            raise AssertionError(f"{path.relative_to(PLUGIN_ROOT)}: {phrase!r}")
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    assert "Only after both the worker and vibe root tried their safe paths" in guardrail
    assert "`vibe-environment-worker` in handover mode" in guardrail


def test_own_install_artifact_is_restored_only_after_ownership_proof() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    assert "For accidental drift proven to come from the check-run install, back up" in skill
    assert "Ask about restoration only for an earlier or person-owned edit" in skill
    assert "Keep a lockfile change required by an intended manifest edit" in skill
    assert "capture the tracked and staged state of each install-managed file and its owning dependency manifest" in guardrail
    assert "preserve that manifest and lockfile together" in guardrail
    assert "Restore a committed install-managed file only when an install ran as part of a check" in guardrail
    assert "no intended dependency manifest change requires the result" in guardrail
    assert "the receipt or a bounded reproduction establishes that the session's own check-run install changed it" in guardrail
    assert "save the exact changed file in the session's private Git metadata before restoring" in guardrail
    assert "A later person edit, an earlier change, or uncertain attribution is never session owned" in guardrail
    assert "preserve it and ask one plain question with a recommendation before any overwrite" in guardrail
    assert "use the shipped `e2eLeftForCi` path and the re-pinned CI reader" in guardrail


def test_check_retry_is_bounded_and_alternatives_are_named_in_existing_summaries() -> None:
    skill = flat((VIBE / "SKILL.md").read_text())
    guardrail = flat((VIBE / "references" / "guardrails.md").read_text())
    handoff = flat((PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md").read_text())
    writer = flat((PLUGIN_ROOT / "agents" / "vibe-change-worker.md").read_text())
    assert "A failed check gets at most one rerun" in skill
    assert "If it still fails, narrow that check or use an accepted CI path" in skill
    assert "Rerun a failed check at most once" in guardrail
    assert "If it still fails, narrow that check or use an accepted remote lane or CI path" in guardrail
    assert "Name a narrowed or CI-deferred check in the existing progress or handoff summary" in skill
    assert "When a check is narrowed or left for CI, name that check in the existing progress or handoff summary" in guardrail
    assert "check narrowed or left for CI is named in the existing progress or handoff summary" in handoff
    assert "Name any check narrowed or left for CI in the existing progress or handoff summary" in writer
