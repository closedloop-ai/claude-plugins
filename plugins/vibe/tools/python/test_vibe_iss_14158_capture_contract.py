"""Contracts for ISS-14158: when to capture screenshots and when visual QA is enough.

The operator-approved criterion 1 text lives in one canonical block in vibe's visual QA reference,
and fleet-orchestrator points at it; no main-merge re-baseline wording is left; and every ETA the
fleet states is computed from the remaining queue count.
"""

from __future__ import annotations

from pathlib import Path

import skill_split
from vibe_contract_text import agent, flat, section

PLUGIN = Path(__file__).resolve().parents[2]
SKILLS = PLUGIN / "skills"
VISUAL_QA = SKILLS / "vibe" / "references" / "quality-loop-visual-qa.md"
QUALITY = SKILLS / "vibe" / "references" / "quality-loop.md"
FLEET = SKILLS / "fleet-orchestrator" / "SKILL.md"
FLEET_QA_GATE = SKILLS / "fleet-orchestrator" / "references" / "fleet-qa-gate.md"
TEMPLATES = SKILLS / "fleet-orchestrator" / "references" / "templates.md"
HANDOFF = SKILLS / "handoff" / "SKILL.md"

# ISS-14158 version 2, criterion 1, approved by the operator 2026-11-13 ~22:25Z ("yes that's fine").
APPROVED = (
    "Screenshots were never a standing requirement, and nothing here adds one.",
    "Default: one visual-qa reviewer reads the diff, plus the Storybook stories where they exist. That covers"
    " most UI changes: a new control, copy reuse, styling, a single page or component.",
    "Capture screenshots only when: (a) a shared component that renders on several pages changes its pixels:"
    " capture the affected pages once, on the branch, against one main baseline taken at the start; (b) the"
    " ticket's acceptance criteria or an operator ruling ask for visual proof, such as the PRD grouped-unit"
    " per-page check (ruling 2026-11-10); (c) the visual-qa reviewer cannot settle a finding from code and"
    " stories: then take targeted shots of just that state, never a sweep.",
    "Limits when screenshots are justified: one main baseline per ticket, never retaken because main moved."
    " After a fix, recapture only the states the fix can reach. A final check is never a new capture: it is"
    " one visual-qa pass scoped to the changes since the last reviewed capture.",
)
FLEET_POINTER = (
    "> Read `../vibe/references/quality-loop-visual-qa.md` (block `when-to-capture`) before any screenshot"
    " capture or visual QA pass, in the loop or at handoff."
)
VIBE_POINTER = (
    "> Read `references/quality-loop-visual-qa.md` (block `when-to-capture`) before any screenshot capture or"
    " visual QA pass, in the loop or at handoff."
)


def _stub_block(path: Path, pointer: str) -> str:
    """The block a file's pointer line resolves to, read the way the skill-split loader reads it."""
    text = skill_split.raw(path)
    assert pointer in text.split("\n"), path
    match = skill_split.STUB.search(pointer)
    assert match is not None
    return skill_split.block_text(skill_split.skill_root(path), match.group(1), match.group(2))


def test_ac1_the_canonical_block_holds_the_approved_text_verbatim() -> None:
    block = flat(skill_split.block_text(SKILLS / "vibe", "references/quality-loop-visual-qa.md", "when-to-capture"))
    for sentence in APPROVED:
        assert sentence in block, sentence[:60]
    assert block.startswith("### When to capture screenshots")


def test_ac1_fleet_and_vibe_point_at_the_one_block_and_copy_none_of_it() -> None:
    canonical = skill_split.block_text(SKILLS / "vibe", "references/quality-loop-visual-qa.md", "when-to-capture")
    assert _stub_block(FLEET_QA_GATE, FLEET_POINTER) == canonical
    assert _stub_block(QUALITY, VIBE_POINTER) == canonical
    gate = skill_split.raw(FLEET_QA_GATE)
    assert gate.index(FLEET_POINTER) < gate.index("<!-- block: qa-gate-rules -->"), "read before the fleet QA gate rules"
    canonical_file = flat(skill_split.raw(VISUAL_QA))
    for sentence in APPROVED:
        assert canonical_file.count(sentence) == 1, sentence[:40]
    for path in sorted(PLUGIN.rglob("*.md")):
        if path == VISUAL_QA:
            continue
        text = flat(skill_split.raw(path))
        for sentence in APPROVED:
            assert sentence not in text, (path.relative_to(PLUGIN).as_posix(), sentence[:40])


def test_ac1_the_final_visual_check_after_fixes_is_one_pass_scoped_to_the_changes() -> None:
    handoff = flat(HANDOFF.read_text())
    assert ("Then steps 3 to 6 run again on the result, with visual QA as one pass scoped to the changes since"
            " the last reviewed capture") in handoff
    verify = flat(agent("vibe-verify-worker"))
    assert ("`pnpm control capture --name <id>-after` when the session has a reference image for that screen, or when"
            " `../skills/vibe/references/quality-loop-visual-qa.md`, \"When to capture screenshots\", calls for one, after"
            " `capture-guard.mjs begin` admits it and with `capture-guard.mjs end` after it") in verify


def test_ac2_no_main_merge_rebaseline_wording_is_left() -> None:
    for path in sorted(PLUGIN.rglob("*.md")):
        text = flat(skill_split.raw(path))
        assert "merge-base or current main" not in text, path.relative_to(PLUGIN).as_posix()
    gate = flat(skill_split.raw(FLEET_QA_GATE))
    assert ("uses the ticket's one main baseline (`../vibe/scripts/capture-guard.mjs status`), never an unrelated"
            " branch and never a new baseline because main moved") in gate
    block = flat(skill_split.block_text(SKILLS / "vibe", "references/quality-loop-visual-qa.md", "when-to-capture"))
    assert ("Merging or rebasing onto main never triggers a re-baseline capture; differences that come from main"
            " are not reviewed as the ticket's.") in block


def test_ac3_ac4_the_fleet_slot_declares_captures_to_the_guard() -> None:
    machines = flat(section(FLEET.read_text(), "## Machines and CPU"))
    assert ("A screenshot capture through a slot passes `--capture <spec.json>` (`ticket`, `ref`, `pages`, `states`,"
            " optional `override`) after the worktree path; `scripts/fleet.sh` runs `../vibe/scripts/capture-guard.mjs`"
            " first and refuses it (exit 79) as `../vibe/references/quality-loop-visual-qa.md`, block `when-to-capture`,"
            " says; only an operator ruling recorded for that ticket in the program rulings, carrying `capture-guard override:"
            " baseline` or `capture-guard override: budget` for the refusal it lifts and quoted in the spec's `override`, lets it"
            " run.") in machines
    assert "read `../vibe/scripts/capture-guard.mjs status --ticket <slug> --ledger <orchDir>/captures`" in machines
    fleet_sh = (SKILLS / "fleet-orchestrator" / "scripts" / "fleet.sh").read_text()
    assert "vibe/scripts/capture-guard.mjs" in fleet_sh.split("ship=(", 1)[1].split(")", 1)[0], "shipped to remote hosts"


def test_ac5_every_eta_is_computed_from_the_remaining_queue_count() -> None:
    reporting = flat(section(FLEET.read_text(), "## Reporting to the operator"))
    assert ("Every ETA for queued work is computed from the remaining queue: state how many runs are still queued"
            " or running and each one's estimate, and restate the ETA the moment a step adds more than 30 minutes.") in reporting
    template = flat(TEMPLATES.read_text().split("## Remaining work report\n", 1)[1].split("\n## ", 1)[0])
    assert ("Name the remaining queue count (runs still queued or running, each with its estimate) and compute the"
            " ETA from it; restate the ETA the moment a step adds more than 30 minutes.") in template
