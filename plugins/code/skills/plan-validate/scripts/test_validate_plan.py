"""Tests for validate_plan.py."""
import pytest

from validate_plan import extract_data, validate_schema_fields


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


def test_decision_table_absent_is_valid() -> None:
    """Plans without a decisionTable field are valid (field is optional)."""
    plan = _minimal_plan()

    issues = validate_schema_fields(plan)

    assert issues == [], f"expected no issues but got: {issues}"


def test_decision_table_valid_shape() -> None:
    """A well-formed decisionTable with path + status='pending' validates clean."""
    plan = _minimal_plan()
    plan["decisionTable"] = {
        "path": ".closedloop-ai/decision-tables/pln-001.md",
        "status": "pending",
    }

    issues = validate_schema_fields(plan)

    assert issues == [], f"expected no issues but got: {issues}"


def test_decision_table_invalid_status() -> None:
    """A decisionTable with a status outside the enum surfaces an issue."""
    plan = _minimal_plan()
    plan["decisionTable"] = {
        "path": ".closedloop-ai/decision-tables/pln-001.md",
        "status": "unknown",
    }

    issues = validate_schema_fields(plan)

    assert any("status" in issue for issue in issues), (
        f"expected an issue mentioning 'status', got: {issues}"
    )


def test_extract_data_surfaces_decision_table() -> None:
    """extract_data exposes decisionTable.path and .status as flat keys."""
    plan = _minimal_plan()
    plan["decisionTable"] = {
        "path": ".closedloop-ai/decision-tables/pln-001.md",
        "status": "pending",
    }

    result = extract_data(plan)

    assert result["decision_table_path"] == ".closedloop-ai/decision-tables/pln-001.md"
    assert result["decision_table_status"] == "pending"


def test_extract_data_decision_table_absent() -> None:
    """When decisionTable is absent, extract_data returns empty strings for both keys."""
    plan = _minimal_plan()

    result = extract_data(plan)

    assert result["decision_table_path"] == ""
    assert result["decision_table_status"] == ""


# (input plan overrides, expected simple_mode, expected plan_was_imported)
# Covers: both true, both false, absent (legacy plans → default False), and
# non-bool values coerced via bool(). extract_data is the recovery channel the
# fresh execute-implementation session reads to decide whether to skip Phase 5.5.
_MODE_FLAG_CASES = [
    ({"simple_mode": True, "plan_was_imported": True}, True, True),
    ({"simple_mode": False, "plan_was_imported": False}, False, False),
    ({}, False, False),
    ({"simple_mode": True}, True, False),
    ({"plan_was_imported": True}, False, True),
    ({"simple_mode": 1, "plan_was_imported": 0}, True, False),
]


@pytest.mark.parametrize(
    ("overrides", "expected_simple", "expected_imported"), _MODE_FLAG_CASES
)
def test_extract_data_surfaces_mode_flags(
    overrides: dict, expected_simple: bool, expected_imported: bool
) -> None:
    """extract_data surfaces simple_mode/plan_was_imported as booleans (default False)."""
    plan = _minimal_plan()
    plan.update(overrides)

    result = extract_data(plan)

    assert result["simple_mode"] is expected_simple
    assert result["plan_was_imported"] is expected_imported
