"""Contracts for WS4 review consolidation (PRD-823: ISS-13352, ISS-13353, ISS-13354, ISS-13355)."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
HANDOFF = ROOT / "skills" / "handoff"
SCRIPTS = HANDOFF / "scripts"
FLEET = ROOT / "skills" / "fleet-orchestrator"
VIBE_SCRIPTS = ROOT / "skills" / "vibe" / "scripts"
FIXTURE = SCRIPTS / "fixtures" / "guardrails-findings.sample.json"

FINDING_KEYS = {"id", "check", "file", "line", "severity", "message", "evidence"}
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def read(path: Path) -> str:
    return path.read_text()


def test_findings_fixture_pins_the_guardrails_findings_contract() -> None:
    doc = json.loads(read(FIXTURE))
    assert set(doc) == {"schema", "head", "base", "findings", "checks_run", "checks_skipped"}
    assert doc["schema"] == "vibe.guardrails-findings/1"
    assert doc["findings"]
    for finding in doc["findings"]:
        assert set(finding) == FINDING_KEYS
        assert finding["severity"] in {"high", "medium", "low"}
        assert finding["line"] is None or isinstance(finding["line"], int)
    assert all(isinstance(name, str) for name in doc["checks_run"])
    assert doc["checks_skipped"] == []


def test_review_scope_consumes_exactly_that_contract() -> None:
    script = read(SCRIPTS / "review-scope.mjs")
    assert 'FINDINGS_SCHEMA = "vibe.guardrails-findings/1"' in script
    for key in FINDING_KEYS | {"checks_run", "checks_skipped"}:
        assert key in script, key


@needs_node
def test_review_scope_treats_skipped_checks_and_missing_files_as_not_checked(tmp_path: Path) -> None:
    probe = tmp_path / "probe.mjs"
    probe.write_text(
        f'import {{ validateFindings, loadFindings }} from "{(SCRIPTS / "review-scope.mjs").as_uri()}";\n'
        f'import {{ readFileSync }} from "node:fs";\n'
        f'const doc = JSON.parse(readFileSync("{FIXTURE}", "utf8"));\n'
        'const skipped = { ...doc, checks_skipped: [{ name: "reuse", reason: "no graph" }] };\n'
        "console.log(JSON.stringify([validateFindings(doc).status, validateFindings(skipped).status,"
        ' loadFindings("/nonexistent/findings.json").status]));\n'
    )
    result = subprocess.run(["node", str(probe)], capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == ["valid", "not-checked", "not-checked"]


def test_consolidated_review_is_off_by_default_and_falls_back_to_the_existing_reviewers() -> None:
    script = read(SCRIPTS / "review-scope.mjs")
    assert 'process.env.VIBE_CONSOLIDATED_REVIEW === "1"' in script
    assert "consolidated-review-disabled" in script
    skill = read(HANDOFF / "SKILL.md")
    assert "off unless `VIBE_CONSOLIDATED_REVIEW=1`" in skill
    assert "the existing reviewers run unchanged" in skill
    assert "`review-soul` on a requested pull request's tests" in skill
    # the existing step 3 and step 6 reviewers are still named
    for kept in ("`vibe-guardrails-reviewer`", "`vibe-adversarial-reviewer`", "`workflow-code-review`"):
        assert kept in skill


def test_escalation_numbers_live_in_one_exported_defaults_object() -> None:
    script = read(SCRIPTS / "review-scope.mjs")
    assert script.count("REVIEW_SCOPE_DEFAULTS = Object.freeze(") == 1
    for key in ("maxFiles", "maxChangedLines", "escalateOnBackend", "escalateOnSharedComponent"):
        assert key in script
    # no numeric threshold literal outside the defaults object
    body = script.split("export function resolveThresholds", 1)[1]
    assert not re.search(r"(?:>|<)\s*\d{2,}", body)


def test_consolidated_reviewer_reads_the_two_reviewers_checklists_instead_of_copying_them() -> None:
    agent = read(ROOT / "agents" / "vibe-consolidated-reviewer.md")
    assert "name: vibe-consolidated-reviewer" in agent
    assert "tools: Read, Grep, Glob, Bash, Skill" in agent
    for named in ("vibe-guardrails-reviewer.md", "vibe-adversarial-reviewer.md", "NOT-CHECKED", "checks_skipped"):
        assert named in agent
    assert "Edit" not in re.search(r"^tools:.*$", agent, re.MULTILINE).group(0)
