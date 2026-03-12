"""Tests for validate_judge_report.py."""

import json
from pathlib import Path

import pytest

from conftest import create_valid_casescore
from judge_report_contract import (
    CaseScore,
    get_default_manifest_path,
    validate_case_score,
    validate_report,
)

MANIFEST_PATH = get_default_manifest_path()
MANIFEST_JSON = json.loads(MANIFEST_PATH.read_text())
JUDGE_REGISTRY = {
    category: set(config["judges"])
    for category, config in MANIFEST_JSON["categories"].items()
}

COMPAT_MANIFEST_JSON = {
    "version": MANIFEST_JSON["version"],
    "categories": {
        category: {
            "output_file": config["output_file"],
            "report_id_suffix": config["report_id_suffix"],
            "judges": config["judges"],
        }
        for category, config in MANIFEST_JSON["categories"].items()
    },
}


@pytest.fixture(scope="module")
def compat_manifest_path(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Compat manifest path for tests; pytest manages cleanup unconditionally."""
    path = tmp_path_factory.mktemp("compat_manifest") / "judge-manifest.json"
    path.write_text(json.dumps(COMPAT_MANIFEST_JSON, indent=2))
    return path


def expected_judge_count_message(category: str) -> str:
    """Return the success message fragment for a category count."""
    return f"{len(JUDGE_REGISTRY[category])} judge results"


def validate_report_with_register(
    report_path: Path, manifest_path: Path, category: str = "plan"
) -> tuple[bool, str]:
    """Validate report using compatibility manifest derived from judge register."""
    return validate_report(
        report_path,
        category=category,
        manifest_path=manifest_path,
    )


def create_evaluation_report(report_id: str, judge_ids: list[str]) -> dict:
    """Create a complete EvaluationReport dictionary.

    Args:
        report_id: The report_id (e.g., 'run-123-judges')
        judge_ids: List of judge case_ids to include

    Returns:
        A valid EvaluationReport dict
    """
    return {
        "report_id": report_id,
        "timestamp": "2025-02-11T12:00:00Z",
        "stats": [create_valid_casescore(judge_id) for judge_id in judge_ids],
    }


class TestBackwardCompatibility:
    """Tests verifying regression prevention for existing plan judge behavior."""

    def test_category_plan_accepts_manifest_judges(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify that category='plan' validates all manifest plan judges."""
        # Create valid report with all manifest plan judges
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-plan-judges", plan_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True, f"Expected valid report, got: {message}"
        assert expected_judge_count_message("plan") in message

    def test_legacy_report_id_suffix(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify backward compatibility with legacy '-judges' suffix (no '-plan' prefix)."""
        # Create valid report with legacy report_id format
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True, (
            f"Expected valid report with legacy suffix, got: {message}"
        )

    def test_no_category_flag_validates_manifest_plan_judges(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify default behavior validates all manifest plan judges."""
        # Create valid report with all manifest plan judges
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Call validate_report WITHOUT category parameter (uses default='plan')
        valid, message = validate_report_with_register(report_path, compat_manifest_path)
        assert valid is True, (
            f"Expected valid report with default category, got: {message}"
        )
        assert expected_judge_count_message("plan") in message

    def test_manifest_plan_judges_validation(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify validation passes with exactly the current manifest plan judges."""

        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-xyz-plan-judges", plan_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True
        assert expected_judge_count_message("plan") in message

    def test_plan_report_rejects_code_judges(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify category='plan' rejects reports with only code judge subset."""
        # Create report using only code judges so plan-only judges are missing.
        code_judges = sorted(JUDGE_REGISTRY["code"])
        report = create_evaluation_report("run-20250211-judges", code_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False, (
            "Expected rejection when code judges used with plan category"
        )
        assert "Missing expected" in message
        # Check that the missing plan-specific judges are mentioned
        missing_judges = JUDGE_REGISTRY["plan"] - JUDGE_REGISTRY["code"]
        for judge in missing_judges:
            assert judge in message, f"Missing judge {judge} should be in error message"


class TestConsolidatedJudgeMetrics:
    """Tests verifying the CaseScore schema for consolidated judge metrics."""

    def test_design_principles_judge_multi_metric_casescore(self) -> None:
        """Verify CaseScore validates correctly for design-principles-judge with 3 metrics."""
        casescore_dict = {
            "type": "case_score",
            "case_id": "design-principles-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "dry",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Excellent DRY adherence.",
                },
                {
                    "metric_name": "kiss",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Excellent simplicity.",
                },
                {
                    "metric_name": "ssot",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Excellent SSOT adherence.",
                },
            ],
        }
        result = CaseScore.from_dict(casescore_dict)
        assert result.case_id == "design-principles-judge"
        assert len(result.metrics) == 3

    def test_code_quality_judge_multi_metric_casescore(self) -> None:
        """Verify CaseScore validates correctly for code-quality-judge with 4 consolidated metrics."""
        casescore_dict = {
            "type": "case_score",
            "case_id": "code-quality-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "goal_alignment_score",
                    "threshold": 0.85,
                    "score": 0.9,
                    "justification": "Plan fully addresses all critical goal components.",
                },
                {
                    "metric_name": "technical_accuracy_score",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "All API calls, language features, algorithms, and terminology are correct.",
                },
                {
                    "metric_name": "test_quality_score",
                    "threshold": 0.7,
                    "score": 1.0,
                    "justification": "Excellent coverage, assertions, structure, and best practices.",
                },
                {
                    "metric_name": "code_organization_score",
                    "threshold": 0.7,
                    "score": 1.0,
                    "justification": "Consistent naming, clear boundaries, separation of concerns, and intuitive navigation.",
                },
            ],
        }
        result = CaseScore.from_dict(casescore_dict)
        assert result.case_id == "code-quality-judge"
        assert len(result.metrics) == 4

    def test_solid_principles_judge_multi_metric_casescore(self) -> None:
        """Verify CaseScore validates correctly for solid-principles-judge with 4 metrics."""
        casescore_dict = {
            "type": "case_score",
            "case_id": "solid-principles-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "interface_segregation_principle",
                    "threshold": 0.75,
                    "score": 1.0,
                    "justification": "Interfaces are focused and client-specific with no pollution.",
                },
                {
                    "metric_name": "dependency_inversion_principle",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Dependencies point toward abstractions and are injected.",
                },
                {
                    "metric_name": "open_closed_principle",
                    "threshold": 0.75,
                    "score": 1.0,
                    "justification": "Clear extension points exist with appropriate patterns.",
                },
                {
                    "metric_name": "liskov_substitution_principle",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Contracts maintained and derived classes are substitutable.",
                },
            ],
        }
        result = CaseScore.from_dict(casescore_dict)
        assert result.case_id == "solid-principles-judge"
        assert len(result.metrics) == 4


class TestCategoryCodeValidation:
    """Tests for validating code category reports."""

    def test_accepts_valid_manifest_code_report(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Valid code report with all manifest judges passes validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])

        report = create_evaluation_report("run-20250211-code-judges", code_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="code")
        assert valid is True, f"Expected valid code report, got: {message}"
        assert expected_judge_count_message("code") in message

    def test_rejects_missing_judges(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Report missing required code judges fails validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        removed_judges = code_judges[:2]
        incomplete_judges = [j for j in code_judges if j not in set(removed_judges)]
        assert len(incomplete_judges) == len(code_judges) - len(removed_judges)

        report = create_evaluation_report("run-20250211-code-judges", incomplete_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="code")
        assert valid is False
        assert "Missing expected judges for category 'code'" in message
        assert any(judge in message for judge in removed_judges)

    def test_rejects_wrong_report_id_suffix(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Report with wrong suffix fails validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Use invalid suffix (not -judges or -plan-judges)
        report = create_evaluation_report("run-20250211-wrong-suffix", code_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="code")
        assert valid is False
        assert "report_id should end with one of" in message
        assert "-judges" in message

    def test_category_in_error_messages(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Error messages include category context."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Remove judges to trigger missing judges error.
        keep_count = max(1, len(code_judges) - 1)
        incomplete_judges = code_judges[:keep_count]

        report = create_evaluation_report("run-20250211-code-judges", incomplete_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="code")
        assert valid is False
        assert "category 'code'" in message, (
            "Error message should mention the category being validated"
        )
        assert "Missing expected judges" in message

    def test_code_report_extra_judge(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify code report passes when extra judges are present (not currently rejected)."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Add a plan-only judge dynamically from manifest-derived category delta.
        extra_candidates = sorted(JUDGE_REGISTRY["plan"] - JUDGE_REGISTRY["code"])
        if not extra_candidates:
            pytest.skip("No plan-only judges available to test extra-judge behavior")
        extra_judges = code_judges + [extra_candidates[0]]

        report = create_evaluation_report("run-20250211-code-judges", extra_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Note: Current validation only checks for missing judges, not extra ones
        # This test documents current behavior - validation passes with extra judges
        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="code")
        assert valid is True, "Extra judges should not cause validation failure"


class TestSchemaValidation:
    """Tests for strict dataclass-based schema validation."""

    def test_extra_field_ignored(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify strict validation ignores extra fields (only known keys are parsed)."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Add extra field to CaseScore - should be ignored, not rejected
        report["stats"][0]["extra_data"] = "this_gets_ignored"

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Strict validation parses only known keys; extra fields are ignored
        assert valid is True

    def test_threshold_type_mismatch(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify threshold field type validation (must be float, not string)."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Set threshold as string instead of float
        report["stats"][0]["metrics"][0]["threshold"] = "0.8"

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "Validation failed" in message

    @pytest.mark.parametrize("invalid_status", [0, 4, -1])
    def test_invalid_final_status_values(
        self, tmp_path: Path, compat_manifest_path: Path, invalid_status: int
    ) -> None:
        """Verify final_status field validator rejects invalid values."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["final_status"] = invalid_status

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "Validation failed" in message

    def test_empty_metrics_array(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify semantic validation fails when metrics array is empty."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"] = []

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "has no metrics" in message

    @pytest.mark.parametrize("missing_field", ["case_id", "final_status", "metrics"])
    def test_missing_required_field(
        self, tmp_path: Path, compat_manifest_path: Path, missing_field: str
    ) -> None:
        """Verify strict validation fails when required fields are missing."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Remove required field from CaseScore
        del report["stats"][0][missing_field]

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "Validation failed" in message


class TestManifestConfiguration:
    """Tests for manifest-driven judge configuration and fail-fast behavior."""

    def test_missing_manifest_fails_fast(self, tmp_path: Path) -> None:
        """Validation fails immediately when manifest file is missing."""
        report = create_evaluation_report("run-123-judges", sorted(JUDGE_REGISTRY["plan"]))
        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        missing_manifest = tmp_path / "missing-manifest.json"
        valid, message = validate_report(
            report_path, category="plan", manifest_path=missing_manifest
        )
        assert valid is False
        assert "Manifest validation failed" in message

    def test_invalid_manifest_json_fails_fast(self, tmp_path: Path) -> None:
        """Validation fails immediately when manifest JSON is malformed."""
        report = create_evaluation_report("run-123-judges", sorted(JUDGE_REGISTRY["plan"]))
        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        bad_manifest = tmp_path / "judge-manifest.json"
        bad_manifest.write_text("{ invalid json")
        valid, message = validate_report(
            report_path, category="plan", manifest_path=bad_manifest
        )
        assert valid is False
        assert "Manifest validation failed" in message

    def test_category_judge_set_comes_from_manifest(self, tmp_path: Path) -> None:
        """Validation uses judge sets derived from manifest categories."""
        custom_manifest = {
            "version": 1,
            "categories": {
                "plan": {
                    "output_file": "judges.json",
                    "report_id_suffix": "-judges",
                    "judges": ["alpha-judge"],
                },
                "code": {
                    "output_file": "code-judges.json",
                    "report_id_suffix": "-code-judges",
                    "judges": ["beta-judge"],
                },
            },
        }
        manifest_path = tmp_path / "judge-manifest.json"
        manifest_path.write_text(json.dumps(custom_manifest, indent=2))

        report = create_evaluation_report("run-123-judges", ["alpha-judge"])
        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(
            report_path, category="plan", manifest_path=manifest_path
        )
        assert valid is True
        assert "1 judge results" in message


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_file_not_found(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify validation handles missing report file gracefully."""
        report_path = tmp_path / "nonexistent.json"

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "does not exist" in message

    def test_invalid_json(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify validation handles malformed JSON gracefully."""
        report_path = tmp_path / "invalid.json"
        report_path.write_text("{ invalid json content")

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "Invalid JSON" in message

    def test_empty_stats_array(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify validation fails when stats array is empty."""
        report = {
            "report_id": "run-123-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": [],
        }

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is False
        assert "no judge results" in message

    def test_invalid_category_parameter(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Verify validation fails with helpful message for invalid category."""
        report = create_evaluation_report("run-123-judges", ["test-judge"])

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="invalid")
        assert valid is False
        assert "Invalid category" in message
        assert "plan" in message and "code" in message


class TestBoundaryValues:
    """Tests for boundary value handling in numeric fields."""

    def test_score_zero(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Score of 0.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 0.0

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_score_one(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Score of 1.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 1.0

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_score_negative(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Negative scores are allowed by schema (no range validation)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = -0.5

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Schema doesn't restrict negative scores
        assert valid is True

    def test_score_above_one(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Scores above 1.0 are allowed by schema (no range validation)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 1.5

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Schema doesn't restrict scores > 1.0
        assert valid is True

    @pytest.mark.parametrize("status", [1, 2, 3])
    def test_valid_final_status_values(
        self, tmp_path: Path, compat_manifest_path: Path, status: int
    ) -> None:
        """Valid final_status values (1=pass, 2=fail, 3=error) are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["final_status"] = status

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_threshold_zero(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Threshold of 0.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["threshold"] = 0.0

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_threshold_null(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Threshold of None/null is valid (optional field)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["threshold"] = None

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_multiple_metrics_per_judge(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Judge with multiple metrics passes validation."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"] = [
            {
                "metric_name": "metric1",
                "threshold": 0.7,
                "score": 0.85,
                "justification": "Good metric1",
            },
            {
                "metric_name": "metric2",
                "threshold": None,
                "score": 0.92,
                "justification": "Great metric2",
            },
        ]

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True


class TestUnicodeHandling:
    """Tests for Unicode character handling in text fields."""

    def test_unicode_in_justification(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Unicode characters in justification field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["justification"] = (
            "Excellent quality ✓ 优秀的代码质量 très bien"
        )

        report_path = tmp_path / "judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_emoji_in_justification(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Emoji characters in justification field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["justification"] = "Great work! 🎉 👍 ✨"

        report_path = tmp_path / "judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_unicode_in_metric_name(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Unicode characters in metric_name field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["metric_name"] = "测试指标_test_métrique"

        report_path = tmp_path / "judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True

    def test_unicode_in_report_id(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Unicode characters in report_id (though not recommended) are handled."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-测试-judges", plan_judges)

        report_path = tmp_path / "judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Should pass schema validation and semantic checks (has valid suffix and all judges)
        assert valid is True

    def test_unicode_in_case_id_fails_judge_matching(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Unicode in case_id fails judge name matching."""
        report = create_evaluation_report("run-123-judges", ["test-judge-中文"])

        report_path = tmp_path / "judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Will fail because it won't match expected judge names
        assert valid is False
        assert "Missing expected judges" in message


class TestIntegration:
    """Integration tests for documented behavior."""

    def test_plan_judges_workflow_unchanged(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Integration test: Existing plan judge workflows remain unchanged."""
        # Simulate a complete plan judge validation workflow
        plan_judges = sorted(JUDGE_REGISTRY["plan"])

        # Test with new suffix format
        report_new = create_evaluation_report("run-20250211-plan-judges", plan_judges)
        report_path_new = tmp_path / "judges-new.json"
        report_path_new.write_text(json.dumps(report_new, indent=2))
        valid_new, _ = validate_report_with_register(report_path_new, compat_manifest_path, category="plan")
        assert valid_new is True

        # Test with legacy suffix format
        report_legacy = create_evaluation_report("run-20250211-judges", plan_judges)
        report_path_legacy = tmp_path / "judges-legacy.json"
        report_path_legacy.write_text(json.dumps(report_legacy, indent=2))
        valid_legacy, _ = validate_report_with_register(report_path_legacy, compat_manifest_path, category="plan")
        assert valid_legacy is True

        # Test without category parameter (default)
        valid_default, _ = validate_report_with_register(report_path_legacy, compat_manifest_path)
        assert valid_default is True


class TestJudgeRegistryContents:
    """Tests verifying JUDGE_REGISTRY is a manifest-backed register."""

    def test_registry_categories_match_manifest(self) -> None:
        """Registry category keys should match manifest categories exactly."""
        assert set(JUDGE_REGISTRY.keys()) == set(MANIFEST_JSON["categories"].keys())

    @pytest.mark.parametrize("category", ["plan", "code"])
    def test_registry_judges_match_manifest(self, category: str) -> None:
        """Registry judges for each category should mirror manifest judge lists."""
        assert JUDGE_REGISTRY[category] == set(MANIFEST_JSON["categories"][category]["judges"])

    def test_registry_values_are_deduplicated(self) -> None:
        """Each category register should be deduplicated compared to manifest list length."""
        for category, config in MANIFEST_JSON["categories"].items():
            assert len(JUDGE_REGISTRY[category]) <= len(config["judges"])


class TestConsolidatedJudgeEndToEnd:
    """End-to-end integration tests for consolidated judge reports."""

    def test_full_plan_report_with_consolidated_judge_multi_metrics(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Full plan report with realistic consolidated judge CaseScores validates successfully."""
        # Build a report using realistic multi-metric outputs from each consolidated judge
        design_principles_casescore = {
            "type": "case_score",
            "case_id": "design-principles-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "dry",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "No significant DRY violations found.",
                },
                {
                    "metric_name": "kiss",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Architecture is appropriately simple.",
                },
                {
                    "metric_name": "ssot",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Single source of truth maintained throughout.",
                },
            ],
        }
        code_quality_casescore = {
            "type": "case_score",
            "case_id": "code-quality-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "goal_alignment_score",
                    "threshold": 0.85,
                    "score": 0.9,
                    "justification": "Plan fully addresses the goal.",
                },
                {
                    "metric_name": "technical_accuracy_score",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "All API calls, language features, algorithms, and terminology are correct.",
                },
                {
                    "metric_name": "test_quality_score",
                    "threshold": 0.7,
                    "score": 1.0,
                    "justification": "Excellent coverage, assertions, structure, and best practices.",
                },
                {
                    "metric_name": "code_organization_score",
                    "threshold": 0.7,
                    "score": 1.0,
                    "justification": "Consistent naming, clear boundaries, separation of concerns, and intuitive navigation.",
                },
            ],
        }
        solid_principles_casescore = {
            "type": "case_score",
            "case_id": "solid-principles-judge",
            "final_status": 1,
            "metrics": [
                {
                    "metric_name": "interface_segregation_principle",
                    "threshold": 0.75,
                    "score": 1.0,
                    "justification": "Interfaces are focused and client-specific with no pollution.",
                },
                {
                    "metric_name": "dependency_inversion_principle",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Dependencies point toward abstractions and are injected.",
                },
                {
                    "metric_name": "open_closed_principle",
                    "threshold": 0.75,
                    "score": 1.0,
                    "justification": "Clear extension points exist with appropriate patterns.",
                },
                {
                    "metric_name": "liskov_substitution_principle",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "Contracts maintained and derived classes are substitutable.",
                },
            ],
        }
        report = {
            "report_id": "run-abc123-plan-judges",
            "timestamp": "2025-03-01T10:00:00Z",
            "stats": [
                design_principles_casescore,
                code_quality_casescore,
                solid_principles_casescore,
                create_valid_casescore("plan-evaluation-judge"),
            ],
        }
        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True, f"Full plan report with consolidated judges failed: {message}"
        assert f"{len(report['stats'])} judge results" in message

    def test_plan_report_accepts_final_status_2_fail_casescore(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Validate that a plan report with a failing (final_status=2) consolidated judge is accepted.

        The validate_report function only checks structure and completeness, not whether
        individual judges passed. A final_status=2 is a valid score value.
        """
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-xyz-judges", plan_judges)
        # Set the first judge to fail (final_status=2)
        report["stats"][0]["final_status"] = 2

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        # Structure is valid; individual pass/fail doesn't affect report validity
        assert valid is True, (
            f"Report with failed judge (final_status=2) should still be structurally valid: {message}"
        )

    def test_plan_report_accepts_final_status_3_error_casescore(
        self, tmp_path: Path, compat_manifest_path: Path
    ) -> None:
        """Validate that a plan report with an error (final_status=3) consolidated judge is accepted.

        The validate_report function validates structure only. An error CaseScore with
        final_status=3 is a valid structural state (judge execution failed).
        """
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-xyz-judges", plan_judges)
        # Simulate a judge that errored out (e.g., missing input files)
        report["stats"][0]["final_status"] = 3
        report["stats"][0]["metrics"][0]["score"] = 0.0
        report["stats"][0]["metrics"][0]["justification"] = (
            "Error: judge-input.json not found in WORKDIR"
        )

        report_path = tmp_path / "judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report_with_register(report_path, compat_manifest_path, category="plan")
        assert valid is True, (
            f"Report with error judge (final_status=3) should be structurally valid: {message}"
        )

    def test_design_principles_judge_fail_status_when_any_metric_below_threshold(
        self,
    ) -> None:
        """Verify design-principles-judge final_status=2 when any of DRY/KISS/SSOT is below 0.8.

        This test documents the agent's pass/fail semantics from the agent definition.
        The CaseScore schema itself does not enforce this logic - it is implemented
        by the judge agent. This test verifies the schema accepts fail-status outputs.
        """
        casescore_dict = {
            "type": "case_score",
            "case_id": "design-principles-judge",
            "final_status": 2,
            "metrics": [
                {
                    "metric_name": "dry",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "No DRY violations.",
                },
                {
                    "metric_name": "kiss",
                    "threshold": 0.8,
                    "score": 0.0,
                    "justification": "Over-engineering detected in 3 tasks.",
                },
                {
                    "metric_name": "ssot",
                    "threshold": 0.8,
                    "score": 1.0,
                    "justification": "SSOT maintained.",
                },
            ],
        }
        result = CaseScore.from_dict(casescore_dict)
        assert result.final_status == 2
        assert result.case_id == "design-principles-judge"
        assert len(result.metrics) == 3
        assert result.metrics[1].score == 0.0

    def test_solid_principles_judge_error_status_accepted_by_schema(self) -> None:
        """Verify solid-principles-judge error CaseScore (final_status=3) is schema-valid.

        When a judge cannot complete evaluation (missing files, malformed input),
        it returns final_status=3 with score=0.0 for all metrics.
        """
        error_casescore = {
            "type": "case_score",
            "case_id": "solid-principles-judge",
            "final_status": 3,
            "metrics": [
                {
                    "metric_name": "interface_segregation_principle",
                    "threshold": 0.75,
                    "score": 0.0,
                    "justification": "Error: judge-input.json not found in WORKDIR.",
                },
            ],
        }
        result = CaseScore.from_dict(error_casescore)
        assert result.final_status == 3
        assert result.case_id == "solid-principles-judge"
        assert result.metrics[0].score == 0.0


class TestCaseScoreValidationMode:
    """Tests for single-judge CaseScore validation mode."""

    def test_valid_casescore_file_passes(self, tmp_path: Path) -> None:
        case_path = tmp_path / "judge.json"
        case_path.write_text(json.dumps(create_valid_casescore("code-quality-judge")))

        valid, message = validate_case_score(
            case_path, expected_case_id="code-quality-judge"
        )
        assert valid is True
        assert "Valid CaseScore for judge 'code-quality-judge'" in message

    def test_invalid_casescore_shape_fails(self, tmp_path: Path) -> None:
        case_path = tmp_path / "judge.json"
        case_path.write_text(json.dumps({"case_id": "code-quality-judge"}))

        valid, message = validate_case_score(case_path)
        assert valid is False
        assert "CaseScore validation failed" in message

    def test_expected_case_id_mismatch_fails(self, tmp_path: Path) -> None:
        case_path = tmp_path / "judge.json"
        case_path.write_text(json.dumps(create_valid_casescore("solid-principles-judge")))

        valid, message = validate_case_score(
            case_path, expected_case_id="code-quality-judge"
        )
        assert valid is False
        assert "case_id mismatch" in message

    def test_wrapped_result_payload_is_supported(self, tmp_path: Path) -> None:
        case_path = tmp_path / "judge.json"
        case_path.write_text(
            json.dumps({"judge_id": "code-quality-judge", "result": create_valid_casescore("code-quality-judge")})
        )

        valid, message = validate_case_score(case_path)
        assert valid is True
        assert "Valid CaseScore for judge 'code-quality-judge'" in message
