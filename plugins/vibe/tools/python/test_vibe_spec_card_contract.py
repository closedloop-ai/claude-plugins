"""Contract checks for the Spec Card, fork checkpoint, file justification check, freshness, assumptions and evidence matrix.

1. The rule lives once, in `references/spec-card.md`; the skills and workers point at it, and each rule has a script.
2. The decision table stays mandatory, full and authored by the SAME writer; the card only seeds it.
3. The fork checkpoint is off by default and changes no default behavior.
4. The file check is a justification, never a cap: it never blocks and never removes required scope.
5. The handoff Assumptions field is generated from the card and required by the live ticket check; the
   evidence matrix extends `criteria-audit.mjs` with the audit's own MET/PARTIAL/MISSED words.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from vibe_contract_text import agent, flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
HANDOFF = PLUGIN_ROOT / "skills" / "handoff"
SPEC_CARD = VIBE / "references" / "spec-card.md"
QUALITY = VIBE / "references" / "quality-loop.md"
POINTER = "spec-card.md"


def rule() -> str:
    return flat(SPEC_CARD.read_text())


def test_the_rule_is_canonical_and_leaves_the_decision_table_whole() -> None:
    text = rule()
    assert "This file is the one canonical statement of the card" in text
    assert "The card does not replace the session decision table" in text
    assert "The table stays mandatory, full and authored only by the SAME writer" in text
    assert "it never stands in for its rows, edge cases or alignment passes" in text
    assert "a rule without its script is not in force" in text


def test_the_fork_checkpoint_is_off_by_default_with_the_open_decision_named() -> None:
    text = flat(section(SPEC_CARD.read_text(), "## Fork checkpoint"))
    for required in (
        "The checkpoint is off by default (open decision, not ruled)",
        "Until it is made nothing changes",
        "`VIBE_FORK_CHECKPOINT=1`",
        "2 to 3 options and a `recommendation`",
        "An unverified assumption that is not product-impacting never counts",
        "A `technical-fork` is not asked of the person",
        "six-step research order and the necessity gate in `quality-loop.md`",
        "in `plain-words.md` terms",
    ):
        assert required in text, required
    script = (VIBE / "scripts" / "spec-card.mjs").read_text()
    assert 'export const CHECKPOINT_ENV = "VIBE_FORK_CHECKPOINT";' in script
    assert "return flag === true || env[CHECKPOINT_ENV] === \"1\";" in script


def test_the_file_check_is_a_justification_and_never_a_cap() -> None:
    text = flat(section(SPEC_CARD.read_text(), "## File justification check (diff budget)"))
    assert "There is no cap on files or lines" in text
    assert "it never blocks" in text
    assert "A file that cites one is in scope whatever the count" in text
    assert "The check never removes a requirement-driven addition and never fails the change." in text
    assert "always exits 0" in text
    script = (VIBE / "scripts" / "spec-card.mjs").read_text()
    assert "blocks: false," in script
    assert "extra-files" not in script


def test_freshness_runs_its_own_fetch() -> None:
    text = flat(section(SPEC_CARD.read_text(), "## Freshness"))
    assert "a cached `origin/main` is never evidence" in text
    assert "leaves `originMain` null and exits 1" in text
    assert (VIBE / "scripts" / "freshness.mjs").is_file()


def test_assumptions_are_generated_never_upgraded_and_required_on_the_ticket() -> None:
    text = flat(section(SPEC_CARD.read_text(), "## Assumptions at handoff"))
    assert "generated from the card, never written freehand" in text
    assert "handoff never upgrades it to grounded" in text
    template = flat((VIBE / "references" / "ticket-template.md").read_text())
    assert "- Assumptions: <generated from the session's Spec Card by `node scripts/spec-card.mjs assumptions <card> --worktree <wt> --base <sha>`" in template
    check = (HANDOFF / "scripts" / "live-ticket-check.mjs").read_text()
    assert "Handoff: [[/^- Assumptions: \\S/m," in check
    ticket = flat(agent("vibe-ticket-worker"))
    assert "Fill the Handoff Assumptions line from the session's Spec Card, never freehand" in ticket


def test_the_evidence_matrix_reuses_the_audit_vocabulary() -> None:
    text = flat(section(SPEC_CARD.read_text(), "## Evidence matrix"))
    assert "`MET`, `PARTIAL` or `MISSED` (no other status words)" in text
    assert "a planned test is not evidence" in text
    audit = (HANDOFF / "scripts" / "criteria-audit.mjs").read_text()
    assert 'import { EVIDENCE_TYPES } from "../../vibe/scripts/spec-card.mjs";' in audit
    assert "!values.evidence" in audit
    assert "REMOTE_PENDING" not in audit and "NOT_APPLICABLE" not in audit


def test_skills_and_workers_point_at_the_rule() -> None:
    assert POINTER in flat((VIBE / "SKILL.md").read_text())
    assert POINTER in flat(QUALITY.read_text())
    assert "--matrix <matrix> --evidence <evidence>`" in flat((HANDOFF / "SKILL.md").read_text())
    requirements = flat(agent("vibe-requirements-worker"))
    assert POINTER in requirements
    assert "freshness.mjs --worktree <repo path>" in requirements
    change = flat(agent("vibe-change-worker"))
    assert POINTER in change
    assert "`spec-card.mjs budget`" in change
    assert "`VIBE_FORK_CHECKPOINT=1`" in change
    assert "freshness.mjs" in change
    assert "Seed the table's `## Acceptance Criteria` section from the card's criteria." in change


def test_the_quality_loop_adds_no_new_question_gate_and_keeps_the_table() -> None:
    text = flat(QUALITY.read_text())
    assert "it adds no question this section would not allow" in text
    assert "it never replaces the table, its rows or its passes" in text
    assert "The named core decision-table workflow is mandatory for every Vibe request" in text


def test_no_strict_status_vocabulary_was_added() -> None:
    for path in (SPEC_CARD, VIBE / "scripts" / "spec-card.mjs", HANDOFF / "scripts" / "criteria-audit.mjs"):
        assert "REMOTE_PENDING" not in path.read_text()


def test_the_scripts_run_from_the_plugin() -> None:
    card = {
        "version": 1,
        "criteria": [{"id": "AC-1", "text": "x", "source": "ISS-1", "evidence": "test"}],
    }
    path = VIBE / "scripts" / "spec-card.mjs"
    result = subprocess.run(
        ["node", str(path), "check", "/dev/stdin"],
        input=json.dumps(card),
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["ok"] is True
