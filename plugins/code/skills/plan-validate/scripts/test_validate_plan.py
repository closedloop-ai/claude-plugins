"""Tests for validate_plan.py."""
from validate_plan import validate_schema_fields


def _minimal_plan() -> dict:
    """Return a plan dict with all required fields populated with valid values."""
    return {
        "content": "some content",
        "acceptanceCriteria": [],
        "pendingTasks": [],
        "completedTasks": [],
        "openQuestions": [],
        "answeredQuestions": [],
        "gaps": [],
    }


def test_validate_schema_accepts_canonical_repositories() -> None:
    """validate_schema_fields must accept the canonical multi-repo shape.

    Each 'repositories' entry carries only `path` and `isPrimary` — the two
    fields the schema defines after the `type` field was removed. A
    primary+secondary shape exercises both isPrimary branches.
    """
    plan = _minimal_plan()
    plan["repositories"] = {
        "primary": {"path": "/abs/primary", "isPrimary": True},
        "frontend": {"path": "/abs/frontend", "isPrimary": False},
    }

    issues = validate_schema_fields(plan)

    assert issues == [], f"expected no issues but got: {issues}"
