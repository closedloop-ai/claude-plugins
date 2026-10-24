"""Contracts for the vibe 1.0.80 targeted pre-PR evidence gate."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def test_handoff_requires_final_diff_inventory_before_pr_creation() -> None:
    handoff = read("skills/handoff/SKILL.md")
    verify = read("agents/vibe-verify-worker.md")
    environment = read("agents/vibe-environment-worker.md")
    assert "`pre-pr` mode on final\nHEAD" in handoff
    assert "read the final committed diff, never the plan" in verify
    assert "Run `pnpm test:lanes`" in verify
    assert "post-merge-only lane" in verify
    assert "rerun only that failed case" in verify
    assert "pr-evidence-comment.mjs" in environment
    assert "blocking.prEvidence" in environment


def test_e2e_tiers_and_operator_override_are_owned_rules() -> None:
    verify = read("agents/vibe-verify-worker.md")
    for text in ("Tier A:", "Tier B:", "Tier C:", "git config --bool vibe.noNativeE2e"):
        assert text in verify
    assert "not run locally, covered by CI" in verify
    assert "Never silently skip E2E" in verify


def test_running_writer_triggers_nonauthoring_parallel_prep() -> None:
    quality = read("skills/vibe/references/quality-loop.md")
    handoff = read("skills/handoff/SKILL.md")
    assert "parallel-prep.mjs --writer-state running --pull-request" in quality
    assert "Draft the targeted inventory from the live\ndiff" in quality
    assert "prebuild app images" in quality
    assert "covered-file hashes" in quality
    assert "visual QA overlaps tests" in quality
    assert "never edit source or start a writer" in handoff
    assert (ROOT / "skills/handoff/scripts/parallel-prep.mjs").exists()
