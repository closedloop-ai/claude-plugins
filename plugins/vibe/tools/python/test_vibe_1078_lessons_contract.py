"""Contract coverage for the vibe 1.0.78 lesson: a repo's Storybook rules run as handoff diff rules."""

import json
from pathlib import Path

from vibe_contract_text import flat


VIBE = Path(__file__).resolve().parents[2]
HANDOFF = VIBE / "skills" / "handoff"


def test_storybook_rules_run_inside_the_handoff_diff_rules() -> None:
    diff_rules = (HANDOFF / "scripts" / "diff-rules.mjs").read_text()
    assert "checkStorybookRules(files, repo, logged, add);" in diff_rules
    assert "...storybookRuleTests(files, (file) => repo.head(file))" in diff_rules


def test_the_verify_worker_runs_the_declared_storybook_checks() -> None:
    worker = flat((VIBE / "agents" / "vibe-verify-worker.md").read_text())
    assert "`checks` of its `.vibe/storybook-rules.json`" in worker


def test_the_example_declaration_names_every_rule() -> None:
    example = json.loads((HANDOFF / "references" / "storybook-rules.example.json").read_text())
    for key in ("release", "frozenRoots", "tagRoots", "noOpHandler", "handRolledCells", "controlsDecision", "literalOptions", "storySupportPaths", "checks"):
        assert key in example, key
