"""Version contract for vibe 1.1.2 (ISS-13279: worker sessions out of desktop app sidebars)."""

from __future__ import annotations

import json
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]


def test_release_and_both_manifests_are_112() -> None:
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads((PLUGIN_ROOT / manifest).read_text())["version"] == "1.1.2"
