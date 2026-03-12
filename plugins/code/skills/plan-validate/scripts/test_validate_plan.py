"""Tests for validate_plan.py module."""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from validate_plan import (
    empty_result,
    extract_data,
    validate_required_sections,
    validate_schema_fields,
    validate_sync,
    validate_task_checkboxes,
)


def _minimal_valid_plan() -> dict:
    """Return a minimal valid plan structure for testing."""
    return {
        "content": """## Summary
Brief summary.

## Acceptance Criteria
- [ ] AC-001: Criterion one

## Architecture Fit
Fits.

## Tasks
- [ ] **T-1.1**: Task one
- [x] **T-1.2**: Task two

## API & Data Impacts
None.

## Risks & Constraints
None.

## Test Plan
Unit tests.

## Rollback
Revert.

## Open Questions
- [ ] Q-001: Question?

## Gaps
""",
        "acceptanceCriteria": [{"id": "AC-001", "criterion": "Criterion one", "source": "PRD"}],
        "pendingTasks": [
            {"id": "T-1.1", "description": "Task one", "acceptanceCriteria": ["AC-001"]}
        ],
        "completedTasks": [
            {"id": "T-1.2", "description": "Task two", "acceptanceCriteria": ["AC-001"]}
        ],
        "openQuestions": [{"id": "Q-001", "question": "Question?"}],
        "answeredQuestions": [],
        "gaps": [],
    }


@pytest.mark.parametrize(
    ("status", "issues", "expected_issues"),
    [
        ("EMPTY_FILE", None, []),
        ("EMPTY_FILE", ["File not found"], ["File not found"]),
        ("FORMAT_ISSUES", ["Missing field"], ["Missing field"]),
    ],
    ids=["empty_no_issues", "empty_with_issues", "format_issues"],
)
def test_empty_result(status: str, issues: list[str] | None, expected_issues: list[str]) -> None:
    """empty_result returns correct status and issues."""
    result = empty_result(status, issues)
    assert result["status"] == status
    assert result["issues"] == expected_issues
    assert result["pending_tasks"] == []
    assert result["completed_tasks"] == []
    assert result["manual_tasks"] == []


@pytest.mark.parametrize(
    ("field", "expected_issue"),
    [
        ("content", "Missing required field: content"),
        ("acceptanceCriteria", "Missing required field: acceptanceCriteria"),
        ("pendingTasks", "Missing required field: pendingTasks"),
        ("openQuestions", "Missing required field: openQuestions"),
        ("gaps", "Missing required field: gaps"),
    ],
    ids=["content", "acceptanceCriteria", "pendingTasks", "openQuestions", "gaps"],
)
def test_validate_schema_fields_missing_field(field: str, expected_issue: str) -> None:
    """validate_schema_fields reports missing required fields."""
    data = _minimal_valid_plan()
    del data[field]
    issues = validate_schema_fields(data)
    assert expected_issue in issues


def test_validate_schema_fields_content_not_string() -> None:
    """validate_schema_fields rejects non-string content."""
    data = _minimal_valid_plan()
    data["content"] = 123
    issues = validate_schema_fields(data)
    assert any("content" in i and "string" in i for i in issues)


def test_validate_schema_fields_invalid_task_id() -> None:
    """validate_schema_fields rejects invalid task ID format."""
    data = _minimal_valid_plan()
    data["pendingTasks"] = [{"id": "bad-id", "description": "x", "acceptanceCriteria": []}]
    issues = validate_schema_fields(data)
    assert any("Invalid task ID" in i for i in issues)


def test_validate_schema_fields_valid() -> None:
    """validate_schema_fields returns no issues for valid data."""
    data = _minimal_valid_plan()
    issues = validate_schema_fields(data)
    assert issues == []


@pytest.mark.parametrize(
    ("line", "expect_issue"),
    [
        ("- **T-1.1**: No checkbox", True),
        ("- [ ] **T-1.1**: With checkbox", False),
        ("- [x] **T-1.2**: Completed", False),
    ],
    ids=["no_checkbox", "pending_checkbox", "completed_checkbox"],
)
def test_validate_task_checkboxes(line: str, expect_issue: bool) -> None:
    """validate_task_checkboxes flags lines missing checkbox prefix."""
    issues = validate_task_checkboxes(line)
    assert (len(issues) > 0) == expect_issue


def test_validate_required_sections_missing() -> None:
    """validate_required_sections reports missing ## sections."""
    content = "## Summary\n\n## Acceptance Criteria\n"
    issues = validate_required_sections(content)
    assert len(issues) > 0
    assert any("Tasks" in i for i in issues)


def test_validate_required_sections_all_present() -> None:
    """validate_required_sections returns no issues when all sections exist."""
    data = _minimal_valid_plan()
    issues = validate_required_sections(data["content"])
    assert issues == []


def test_validate_sync_pending_mismatch() -> None:
    """validate_sync reports when pendingTasks has ID not in content."""
    data = _minimal_valid_plan()
    data["pendingTasks"].append(
        {"id": "T-9.9", "description": "Ghost", "acceptanceCriteria": []}
    )
    issues = validate_sync(data, data["content"])
    assert any("T-9.9" in i and "pendingTasks" in i for i in issues)


def test_validate_sync_completed_mismatch() -> None:
    """validate_sync reports when content has completed task not in array."""
    data = _minimal_valid_plan()
    data["content"] += "\n- [x] **T-2.1**: Extra completed"
    issues = validate_sync(data, data["content"])
    assert any("T-2.1" in i for i in issues)


def test_validate_sync_valid() -> None:
    """validate_sync returns no issues when arrays match content."""
    data = _minimal_valid_plan()
    issues = validate_sync(data, data["content"])
    assert issues == []


def test_extract_data_returns_valid_structure() -> None:
    """extract_data returns VALID status with extracted tasks and questions."""
    data = _minimal_valid_plan()
    result = extract_data(data)
    assert result["status"] == "VALID"
    assert len(result["pending_tasks"]) == 1
    assert result["pending_tasks"][0]["id"] == "T-1.1"
    assert len(result["completed_tasks"]) == 1
    assert result["completed_tasks"][0]["id"] == "T-1.2"
    assert result["has_unanswered_questions"] is True
    assert len(result["unanswered_questions"]) == 1


def _script_path() -> Path:
    """Path to validate_plan.py script."""
    return Path(__file__).resolve().parent / "validate_plan.py"


def test_main_emits_empty_file_when_missing(tmp_path: Path) -> None:
    """main prints EMPTY_FILE when plan.json does not exist."""
    workdir = str(tmp_path)
    proc = subprocess.run(
        [sys.executable, str(_script_path()), workdir],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert out["status"] == "EMPTY_FILE"
    assert "File not found" in out["issues"][0] or "empty" in out["issues"][0].lower()


def test_main_emits_invalid_json(tmp_path: Path) -> None:
    """main prints INVALID_JSON when plan.json is malformed."""
    plan_path = tmp_path / "plan.json"
    plan_path.write_text("{ invalid json")
    proc = subprocess.run(
        [sys.executable, str(_script_path()), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert out["status"] == "INVALID_JSON"


def test_main_emits_valid_for_good_plan(tmp_path: Path) -> None:
    """main prints VALID with extracted data for a valid plan.json."""
    data = _minimal_valid_plan()
    plan_path = tmp_path / "plan.json"
    plan_path.write_text(json.dumps(data))
    proc = subprocess.run(
        [sys.executable, str(_script_path()), str(tmp_path)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert out["status"] == "VALID"
    assert len(out["pending_tasks"]) == 1
    assert len(out["completed_tasks"]) == 1
