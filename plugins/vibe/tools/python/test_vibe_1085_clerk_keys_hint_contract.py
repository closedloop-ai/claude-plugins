"""Contracts for the vibe 1.0.85 release: the setup worker points a missing Clerk key at `just clerk-keys`."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_setup_worker_sends_missing_clerk_keys_to_the_person() -> None:
    text = " ".join((ROOT / "agents" / "vibe-setup-worker.md").read_text().split())
    assert "never fetch or type the secrets yourself" in text
    assert "`! just clerk-keys`" in text
    assert "`aws sso login --profile <their stage profile>`" in text
