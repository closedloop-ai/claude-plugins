"""Tests for build_judge_input.py."""

from __future__ import annotations

import contextlib
import json
from pathlib import Path
from typing import Any

import pytest

from build_judge_input import ArtifactType, build_judge_input

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def workdir(tmp_path: Path) -> Path:
    """Provide a temporary workdir with baseline plan files."""
    (tmp_path / "prd.md").write_text("# PRD\n")
    (tmp_path / "plan.json").write_text(json.dumps({"tasks": []}))
    return tmp_path


@pytest.fixture()
def plan_context_workdir(workdir: Path) -> Path:
    """Workdir with plan-context.json present (normal plan mode)."""
    (workdir / "plan-context.json").write_text(json.dumps({"compressed": True}))
    return workdir


@pytest.fixture()
def code_context_workdir(workdir: Path) -> Path:
    """Workdir with code-context.json present (code mode)."""
    (workdir / "code-context.json").write_text(json.dumps({"diff": "..."}))
    return workdir


# ---------------------------------------------------------------------------
# Scenario definitions
# ---------------------------------------------------------------------------

BuildScenario = tuple[
    ArtifactType,        # artifact_type
    str,                 # workdir fixture name
    bool,                # compatibility_mode
    contextlib.AbstractContextManager[object],  # expectation
    dict[str, Any] | None,  # expected_fields (None when expecting error)
]

scenarios: dict[str, BuildScenario] = {
    "plan_normal": (
        ArtifactType.PLAN,
        "plan_context_workdir",
        False,
        contextlib.nullcontext(),
        {
            "evaluation_type": "plan",
            "primary_artifact.id": "plan_context",
            "fallback_mode.active": False,
        },
    ),
    "plan_normal_with_investigation_log": (
        ArtifactType.PLAN,
        "plan_context_workdir",
        False,
        contextlib.nullcontext(),
        {
            "evaluation_type": "plan",
            "primary_artifact.id": "plan_context",
            "has_investigation_log_supporting": True,
        },
    ),
    "plan_compatibility": (
        ArtifactType.PLAN,
        "workdir",
        True,
        contextlib.nullcontext(),
        {
            "evaluation_type": "plan",
            "primary_artifact.id": "plan_json",
            "fallback_mode.active": True,
        },
    ),
    "plan_missing_context_no_compat": (
        ArtifactType.PLAN,
        "workdir",
        False,
        pytest.raises(FileNotFoundError, match="plan-context.json not found"),
        None,
    ),
    "code_normal": (
        ArtifactType.CODE,
        "code_context_workdir",
        False,
        contextlib.nullcontext(),
        {
            "evaluation_type": "code",
            "primary_artifact.id": "code_context",
            "fallback_mode.active": False,
        },
    ),
    "code_missing_context": (
        ArtifactType.CODE,
        "workdir",
        False,
        pytest.raises(FileNotFoundError, match="code-context.json not found"),
        None,
    ),
}


# ---------------------------------------------------------------------------
# Parametrized test
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario_name",
    [pytest.param(name, id=name) for name in scenarios],
)
def test_build_judge_input(
    request: pytest.FixtureRequest,
    scenario_name: str,
) -> None:
    artifact_type, fixture_name, compat, expectation, expected_fields = scenarios[
        scenario_name
    ]

    w: Path = request.getfixturevalue(fixture_name)

    if scenario_name == "plan_normal_with_investigation_log":
        (w / "investigation-log.md").write_text("# Investigation\n")

    with expectation:
        result = build_judge_input(artifact_type, w, compatibility_mode=compat)

        assert expected_fields is not None
        for key, expected_val in expected_fields.items():
            if key == "has_investigation_log_supporting":
                supporting_ids = [a["id"] for a in result["supporting_artifacts"]]
                assert ("investigation_log" in supporting_ids) == expected_val
            elif "." in key:
                parts = key.split(".")
                val = result
                for p in parts:
                    val = val[p]
                assert val == expected_val
            else:
                assert result[key] == expected_val


# ---------------------------------------------------------------------------
# Structural validation
# ---------------------------------------------------------------------------


def test_envelope_has_required_contract_fields(plan_context_workdir: Path) -> None:
    """Verify all fields from judge-input-contract.md are present."""
    result = build_judge_input(ArtifactType.PLAN, plan_context_workdir)

    required_keys = {
        "evaluation_type",
        "task",
        "primary_artifact",
        "supporting_artifacts",
        "source_of_truth",
        "fallback_mode",
        "metadata",
    }
    assert required_keys.issubset(set(result.keys()))
    assert "run_id" in result["metadata"]
    assert "generated_at" in result["metadata"]


def test_artifact_descriptor_shape(plan_context_workdir: Path) -> None:
    """Verify primary_artifact has all required descriptor fields."""
    result = build_judge_input(ArtifactType.PLAN, plan_context_workdir)
    primary = result["primary_artifact"]

    for field in ("id", "path", "type", "required", "description"):
        assert field in primary, f"Missing field: {field}"
