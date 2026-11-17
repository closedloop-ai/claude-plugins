"""Mandatory reviewer roles know the graph-use condition before receipt capture."""

from pathlib import Path

import skill_split


ROOT = Path(__file__).resolve().parents[2]


def test_storybook_and_verify_roles_call_an_available_graph_before_returning() -> None:
    for name in ("vibe-storybook-decomposer", "vibe-verify-worker"):
        text = skill_split.read(ROOT / "agents" / f"{name}.md")
        assert "When ROOT supplied any graph read capability" in text
        assert "make at least one graph call" in text
        assert "receipt rejects" in text
