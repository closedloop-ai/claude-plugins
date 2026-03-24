"""Tests for validate_sync() in validate_plan.py."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "skills" / "plan-validate" / "scripts"))

from validate_plan import validate_sync  # noqa: E402


def make_minimal_data(**overrides: object) -> dict:
    """Build a base-valid plan dict with empty arrays."""
    data: dict = {
        "content": "",
        "acceptanceCriteria": [],
        "pendingTasks": [],
        "completedTasks": [],
        "openQuestions": [],
        "answeredQuestions": [],
        "gaps": [],
        "manualTasks": [],
    }
    data.update(overrides)
    return data


def test_ac_in_array_missing_from_content() -> None:
    """AC in acceptanceCriteria array but no matching row in content."""
    data = make_minimal_data(
        acceptanceCriteria=[{"id": "AC-001", "criterion": "x", "source": "PRD"}]
    )
    content = "No AC table row here."
    issues = validate_sync(data, content)
    assert any("AC-001" in issue and "AC" in issue for issue in issues), (
        f"Expected an issue about AC-001, got: {issues}"
    )


def test_ac_in_content_missing_from_array() -> None:
    """Content has an AC table row but acceptanceCriteria array is empty."""
    data = make_minimal_data(acceptanceCriteria=[])
    content = "| AC-001 | foo | PRD |"
    issues = validate_sync(data, content)
    assert any("AC-001" in issue for issue in issues), (
        f"Expected an issue about AC-001, got: {issues}"
    )


def test_gap_in_array_missing_from_content() -> None:
    """Gap in gaps array but no **GAP-001** reference in content."""
    data = make_minimal_data(
        gaps=[{"id": "GAP-001", "description": "x", "addressed": False}]
    )
    content = "No gap reference here."
    issues = validate_sync(data, content)
    assert any("GAP-001" in issue for issue in issues), (
        f"Expected an issue about GAP-001, got: {issues}"
    )


def test_manual_task_without_manual_line() -> None:
    """manualTasks array has T-8.1 but content line lacks [MANUAL] marker."""
    data = make_minimal_data(
        manualTasks=[{"id": "T-8.1", "description": "x", "acceptanceCriteria": []}]
    )
    # Task line exists but without [MANUAL] -- matches PENDING_TASK_RE, not MANUAL_TASK_RE
    content = "- [ ] **T-8.1**: foo"
    issues = validate_sync(data, content)
    assert any("T-8.1" in issue for issue in issues), (
        f"Expected an issue about T-8.1, got: {issues}"
    )


def test_valid_plan_all_fields_in_sync() -> None:
    """A plan where all arrays and content are in sync produces no issues."""
    content = (
        "| AC-001 | Acceptance criterion text | PRD |\n"
        "**GAP-001** description\n"
        "- [ ] **T-1.1**: pending task\n"
        "- [x] **T-2.1**: completed task\n"
        "- [ ] **T-3.1** [MANUAL]: manual task\n"
        "- [ ] Q-001: open question\n"
        "- [x] Q-002: answered question\n"
    )
    data = make_minimal_data(
        content=content,
        acceptanceCriteria=[{"id": "AC-001", "criterion": "x", "source": "PRD"}],
        gaps=[{"id": "GAP-001", "description": "x", "addressed": False}],
        pendingTasks=[{"id": "T-1.1", "description": "pending", "acceptanceCriteria": []}],
        completedTasks=[{"id": "T-2.1", "description": "done", "acceptanceCriteria": []}],
        manualTasks=[{"id": "T-3.1", "description": "manual", "acceptanceCriteria": []}],
        openQuestions=[{"id": "Q-001", "question": "q", "blockingTask": None}],
        answeredQuestions=[{"id": "Q-002", "question": "q", "answer": "a"}],
    )
    assert validate_sync(data, content) == []
