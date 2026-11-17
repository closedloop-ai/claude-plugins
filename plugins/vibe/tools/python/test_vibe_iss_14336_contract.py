"""Prevention contract for the nine ISS-14336 handoff-review misses."""

from pathlib import Path

import skill_split


ROOT = Path(__file__).resolve().parents[2]
PROVIDER_ROOT = ROOT.parent / "vibe-closedloop-provider"
CHANGE = skill_split.read(ROOT / "agents" / "vibe-change-worker.md")
PROVIDER_CHANGE = (PROVIDER_ROOT / "skills" / "closedloop-provider" / "references" / "agents" / "vibe-change-worker.md").read_text()
GUARDRAILS = skill_split.read(ROOT / "agents" / "vibe-guardrails-reviewer.md")
ADVERSARIAL = skill_split.read(ROOT / "agents" / "vibe-adversarial-reviewer.md")
PREMISES = skill_split.read(ROOT / "skills" / "vibe" / "references" / "review-premises.md")
GATE = (ROOT / "skills" / "handoff" / "scripts" / "guardrails-gate.mjs").read_text()
DIFF_RULES = (ROOT / "skills" / "handoff" / "scripts" / "diff-rules.mjs").read_text()


def test_shared_consumers_and_new_stories_run_their_cross_package_checks() -> None:
    assert "repository's\nwhole-diff test selector and its consumer tests" in CHANGE
    assert "code_tests_for_changes" in PROVIDER_CHANGE
    assert "including unedited contract tests" in CHANGE
    assert "all-stories jsdom sweep and follow its existing browser-only tag precedent" in CHANGE
    assert "consumer pack" in ADVERSARIAL


def test_stale_comments_casts_and_oversize_growth_are_blocked() -> None:
    assert "correct nearby\ncomments, docstrings and docs" in CHANGE
    assert "AS_CAST" in GATE and "`as` cast" in GATE
    assert "base line count" in CHANGE and "`Debt:` reason" in CHANGE


def test_required_handoff_records_are_mechanical() -> None:
    for marker in ("Frozen render unchanged", "Story entry:"):
        assert marker in DIFF_RULES
        assert marker in CHANGE
    assert "flag-keys.mjs record" in CHANGE


def test_scope_cause_and_human_provenance_claims_require_primary_evidence() -> None:
    assert "Claims that something is the only production mount" in PREMISES
    assert "primary importer, caller or measured probe evidence" in PREMISES
    assert "never an operator ruling" in PREMISES
    assert "labels an orchestrator or reviewer decision as an\n    `operator ruling`" in GUARDRAILS
    assert "importer/caller evidence or a measured probe is\n    required" in GUARDRAILS
