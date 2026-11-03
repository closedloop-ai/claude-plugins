"""Contracts for the prompt split (PRD-823 C1 to C4): text moved out of a skill or reference file is the
same text, lives in exactly one file, and loads under the condition the original text already gave."""

from __future__ import annotations

import re
from pathlib import Path

import skill_split
from vibe_contract_text import flat

PLUGIN = Path(__file__).resolve().parents[2]
SKILLS = PLUGIN / "skills"

# (file holding the stub, moved file, block id): the whole split, so a block cannot be dropped or added unseen.
SPLIT = {
    ("handoff/SKILL.md", "references/handoff-ui.md", "step-4-storybook"),
    ("handoff/SKILL.md", "references/handoff-ui.md", "running-app-verification"),
    ("handoff/SKILL.md", "references/handoff-pr.md", "requested-pull-request"),
    ("handoff/SKILL.md", "references/handoff-pr.md", "step-9-pull-request"),
    ("handoff/SKILL.md", "references/handoff-pr.md", "section-10-changes"),
    ("vibe/SKILL.md", "references/vibe-harness-codex.md", "codex-invoke-and-workers"),
    ("vibe/SKILL.md", "references/vibe-harness-codex.md", "codex-hooks-and-compaction"),
    ("vibe/SKILL.md", "references/vibe-harness-claude.md", "claude-launcher"),
    ("vibe/SKILL.md", "references/vibe-mockup.md", "mockup-flow"),
    ("vibe/references/quality-loop.md", "references/quality-loop-recovery.md", "migration-steps"),
    ("vibe/references/quality-loop.md", "references/quality-loop-visual-qa.md", "visual-qa-body"),
    ("vibe/references/guardrails.md", "references/guardrails-ui.md", "ui-rules"),
    ("fleet-orchestrator/SKILL.md", "references/fleet-qa-gate.md", "qa-gate-rules"),
    ("fleet-orchestrator/SKILL.md", "references/fleet-recovery.md", "recovery-rules"),
    ("fleet-orchestrator/SKILL.md", "references/fleet-codex-sessions.md", "codex-sessions-rules"),
}

# Headings the split files keep or carry, so a citation by heading still finds its section.
HEADINGS = {
    "handoff/SKILL.md": ["## A requested pull request", "## 4. Storybook", "### Running app verification", "## 9. Hand it over", "## 10. Changes on the open pull request"],
    "vibe/SKILL.md": ["## Harness notes", "### Mockup sessions"],
    "vibe/references/quality-loop.md": ["### Recorded definition migration", "## Visual QA during the session", "### What it checks", "### When it is offered", "### When the person asks for polish"],
    "vibe/references/guardrails.md": ["## Missing primitives", "## Storybook taxonomy", "## Tokens and styling", "## Making something look better", "## Copy"],
    "fleet-orchestrator/SKILL.md": ["## Quality gates and QA", "## Moving work between runtimes and accounts", "## Codex sessions"],
}

# What stays in the always-loaded file because it decides whether the moved text applies.
DECIDERS = {
    "handoff/SKILL.md": ["I'll get the PR merged", "raise a PR", "any `awaitingReply` thread starts section 10", "please fix the review comments", "Its `serverOnly` true skips step 4"],
    "vibe/SKILL.md": ["Codex reads files through shell output", "Use `--runtime codex` on every preflight call in Codex", "If they clearly want a mockup"],
    "vibe/references/quality-loop.md": ["When the recorded definition is missing (`ENOENT`)", "The persistent system binding is phase-neutral"],
    "vibe/references/guardrails.md": ["## Where code goes", "## Reuse first", "## Feature docs at handoff"],
    "fleet-orchestrator/SKILL.md": ["## Pushback", "## Reporting to the operator", "## Principles"],
}


def stubs() -> list[tuple[str, str, str]]:
    found = []
    for source in sorted(SKILLS.rglob("*.md")):
        for match in skill_split.STUB.finditer(skill_split.raw(source)):
            found.append((source.relative_to(SKILLS).as_posix(), match.group(1), match.group(2)))
    return found


def test_the_split_is_exactly_these_blocks_each_with_one_stub() -> None:
    assert sorted(stubs()) == sorted(SPLIT)


def test_every_block_exists_once_and_is_paired() -> None:
    for source, reference, block in SPLIT:
        root = SKILLS / source.split("/")[0]
        text = skill_split.raw(root / reference)
        assert text.count(f"<!-- block: {block} -->\n") == 1, (reference, block)
        assert text.count(f"\n<!-- end: {block} -->") == 1, (reference, block)
        assert skill_split.block_text(root, reference, block).strip(), (reference, block)


def test_a_moved_block_is_not_also_left_in_its_source() -> None:
    for source, reference, block in SPLIT:
        root = SKILLS / source.split("/")[0]
        moved = skill_split.block_text(root, reference, block)
        remaining = skill_split.raw(SKILLS / source)
        for line in (line for line in moved.split("\n") if len(line.strip()) > 60):
            assert line not in remaining, (source, block, line[:60])


def test_every_substantial_moved_line_lives_in_one_file() -> None:
    holders: dict[str, list[str]] = {}
    for path in sorted(PLUGIN.rglob("*.md")):
        for line in set(skill_split.raw(path).split("\n")):
            if len(line.strip()) > 80:
                holders.setdefault(line, []).append(path.relative_to(PLUGIN).as_posix())
    for source, reference, block in SPLIT:
        root = SKILLS / source.split("/")[0]
        for line in skill_split.block_text(root, reference, block).split("\n"):
            if len(line.strip()) > 80:
                assert len(holders[line]) == 1, (block, line[:60], holders[line])


def test_assembling_a_split_file_keeps_every_heading_it_had() -> None:
    for source, headings in HEADINGS.items():
        text = skill_split.assembled(SKILLS / source)
        for heading in headings:
            assert re.search(rf"^{re.escape(heading)}$", text, re.MULTILINE), (source, heading)


def test_the_deciding_text_stays_in_the_always_loaded_file() -> None:
    for source, phrases in DECIDERS.items():
        raw = flat(skill_split.raw(SKILLS / source))
        for phrase in phrases:
            assert flat(phrase) in raw, (source, phrase)


def test_the_loader_conditions_name_inventory_flags_and_classes_that_exist() -> None:
    ui_stub = "Read `references/handoff-ui.md`"
    handoff = skill_split.raw(SKILLS / "handoff" / "SKILL.md")
    assert handoff.count("unless the inventory's `serverOnly` is true") == 2
    assert ui_stub in handoff
    assert "serverOnly:" in (SKILLS / "handoff" / "scripts" / "pr-facts.mjs").read_text()
    guardrails = skill_split.raw(SKILLS / "vibe" / "references" / "guardrails.md")
    triage = (SKILLS / "vibe" / "references" / "triage.md").read_text()
    for name in ("`backend`", "`docs-config`", "`serverOnly`"):
        assert name in guardrails
    for name in ("`backend`", "`docs-config`"):
        assert name in triage
    assert "when the person asked for a pull request" in handoff
    assert "when a handed-off session's pull request is open or the person asks for changes on it" in handoff


def test_server_only_work_keeps_the_ui_text_one_read_away() -> None:
    assembled = flat(skill_split.assembled(SKILLS / "handoff" / "SKILL.md"))
    assert "## 4. Storybook" in skill_split.assembled(SKILLS / "handoff" / "SKILL.md")
    assert "Every new story follows the repo's `apps/storybook/TAXONOMY.md`" in assembled


def test_the_split_files_are_smaller_than_the_text_they_replace() -> None:
    for source in {entry[0] for entry in SPLIT}:
        path = SKILLS / source
        assert len(skill_split.raw(path)) < len(skill_split.assembled(path)), source
