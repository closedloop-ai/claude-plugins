"""Contract checks for ISS-14227: a verify worker's proof commit never bypasses a hook.

In the ISS-14191 session a vibe-verify-worker made a scratch proof commit with `git commit --no-verify`
after the pre-commit hook failed on a real typecheck error. A failing hook means the candidate is not ready.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import PROVIDER_REFERENCES, flat, paragraph
import skill_split


AGENTS = Path(__file__).resolve().parents[2] / "agents"
NO_BYPASS = ("Never pass `--no-verify` (or `git commit -n`), set `core.hooksPath`, or bypass a commit hook any "
             "other way, for a proof or scratch commit too.")
FAILED_HOOK = "A proof commit whose hook fails is not made; report not ready with the hook output."


def test_the_verify_worker_never_bypasses_a_hook_and_reports_a_failed_one_as_not_ready() -> None:
    worker = AGENTS / "vibe-verify-worker.md"
    for text in (flat(skill_split.generic(worker)), flat(skill_split.read(worker))):
        rule = paragraph(text, "Never commit, push or create a worktree/branch.")
        assert NO_BYPASS in rule
        assert FAILED_HOOK in rule


def test_the_remote_e2e_tier_carries_the_same_rule_where_it_amends_and_transfers_a_commit() -> None:
    tier = paragraph(skill_split.raw(PROVIDER_REFERENCES / "agents" / "vibe-verify-worker.md"), "3. Tier C:")
    assert "the still-unpushed commit is amended and transferred" in tier
    assert NO_BYPASS in tier
    assert FAILED_HOOK in tier
