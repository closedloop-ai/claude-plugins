"""Contract tests for PRD/Feature judge prompt input loading."""

from __future__ import annotations

import re
from pathlib import Path


SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parents[4]
AGENTS_DIR = REPO_ROOT / "plugins/judges/agents"

PRD_FEATURE_JUDGES = {
    "feature-completeness-judge",
    "prd-auditor",
    "prd-dependency-judge",
    "prd-scope-judge",
    "prd-testability-judge",
}

LEGACY_EVIDENCE_TOKENS = (
    "$CLOSEDLOOP_WORKDIR/prd.md",
    "$CLOSEDLOOP_WORKDIR/plan.md",
)

LEGACY_FIRST_PATTERNS = (
    re.compile(r"Read the (?:PRD|Feature) from `?\$CLOSEDLOOP_WORKDIR/prd\.md`?"),
    re.compile(r"PRD to audit is located at `\$CLOSEDLOOP_WORKDIR/prd\.md`"),
    re.compile(r"file named `prd\.md` or similar"),
)


def _agent_name(content: str) -> str:
    match = re.search(r"^name:\s*(?P<name>[A-Za-z0-9_-]+)\s*$", content, re.MULTILINE)
    return match.group("name") if match else ""


def _prd_feature_agent_files() -> dict[str, Path]:
    discovered: dict[str, Path] = {}
    for path in AGENTS_DIR.glob("*.md"):
        content = path.read_text(encoding="utf-8")
        name = _agent_name(content)
        if name in PRD_FEATURE_JUDGES:
            discovered[name] = path
    return discovered


def test_discovers_all_prd_feature_judge_prompts() -> None:
    discovered = _prd_feature_agent_files()
    assert set(discovered) == PRD_FEATURE_JUDGES


def test_prd_feature_judges_read_judge_input_before_legacy_paths() -> None:
    for judge_name, path in _prd_feature_agent_files().items():
        content = path.read_text(encoding="utf-8")
        judge_input_index = content.find("judge-input.json")
        assert judge_input_index != -1, f"{judge_name} must mention judge-input.json"

        legacy_indexes = [
            content.find(token)
            for token in LEGACY_EVIDENCE_TOKENS
            if content.find(token) != -1
        ]
        if legacy_indexes:
            assert judge_input_index < min(legacy_indexes), (
                f"{judge_name} presents a legacy path before judge-input.json"
            )


def test_prd_feature_judges_require_source_of_truth_ordering() -> None:
    for judge_name, path in _prd_feature_agent_files().items():
        content = path.read_text(encoding="utf-8")
        assert "source_of_truth" in content, (
            f"{judge_name} must instruct agents to load source_of_truth order"
        )
        assert "primary_artifact" in content, (
            f"{judge_name} must use the mapped primary artifact"
        )
        assert "supporting_artifacts" in content, (
            f"{judge_name} must treat supporting descriptors as evidence"
        )


def test_prd_feature_judges_limit_prd_plan_paths_to_absent_or_invalid_fallback() -> None:
    for judge_name, path in _prd_feature_agent_files().items():
        content = path.read_text(encoding="utf-8")
        assert "absent or invalid" in content, (
            f"{judge_name} must restrict legacy paths to absent-or-invalid fallback"
        )
        assert "legacy" in content.lower() and "fallback" in content.lower(), (
            f"{judge_name} must describe legacy fallback semantics"
        )
        for pattern in LEGACY_FIRST_PATTERNS:
            assert not pattern.search(content), (
                f"{judge_name} still contains legacy-first evidence wording"
            )
