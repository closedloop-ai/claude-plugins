"""Contract checks for ISS-14228: a worker deletes only the exact scratch paths it created.

In the ISS-14191 session an orchestrator brief told a verify worker to "delete stale /tmp/vibe-14191/e2e3.* first"
in a scratch directory the orchestrator shared, so the glob could take files the worker never made.
One rule, the same words in every brief template, the fleet skill and each worker that keeps scratch.
"""

from __future__ import annotations

import re
from pathlib import Path

from vibe_contract_text import agent, flat, paragraph, section
import skill_split


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
FLEET = PLUGIN_ROOT / "skills" / "fleet-orchestrator"
SCRATCH_CLEANUP = PLUGIN_ROOT.parent / "vibe-core" / "lib" / "fleet-orchestrator" / "scripts" / "scratch-cleanup.mjs"
RULE = ("Each worker gets its own scratch directory named with its worker id (`<scratch>/<worker-id>/`), creates its "
        "files there, and deletes only exact paths it created; an orchestrator brief never asks a worker to delete "
        "by prefix or glob.")
COMMENT_PREFIX = re.compile(r"^// ?", re.MULTILINE)


def test_every_brief_template_carries_the_scratch_rule() -> None:
    templates = skill_split.read(FLEET / "references" / "templates.md")
    for heading in ("## Worker preamble", "## Resume prompt", "## Disjoint helper branch brief"):
        assert f"Scratch files: {RULE}" in section(templates, heading), heading


def test_every_vibe_worker_brief_carries_the_scratch_rule() -> None:
    rules = paragraph(skill_split.read(PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"), "Every worker brief says:")
    assert f"It also carries this line: Scratch files: {RULE}" in rules


def test_the_fleet_skill_states_the_scratch_rule_beside_its_scratch_stacks() -> None:
    assert f"Scratch files: {RULE}" in section(skill_split.read(FLEET / "SKILL.md"), "## Claude workers")


def test_each_worker_that_keeps_scratch_carries_the_same_rule() -> None:
    for name in ("vibe-change-worker", "vibe-verify-worker", "vibe-setup-worker"):
        assert f"Scratch files: {RULE}" in flat(agent(name)), name


def test_the_docker_scratch_cleanup_says_files_follow_the_same_rule() -> None:
    header = SCRATCH_CLEANUP.read_text(encoding="utf-8").split("\nimport ", 1)[0]
    text = flat(COMMENT_PREFIX.sub("", header))
    assert "Covers Docker scratch stacks only; scratch files follow the same ownership rule." in text
    assert RULE in text
