"""Tests for validate_judge_report.py."""

import json

# Add scripts directory to path to import validate_judge_report module
import sys
from pathlib import Path
from typing import Optional

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from validate_judge_report import (  # type: ignore[import-not-found]
    DEFAULT_FILENAMES,
    JUDGE_REGISTRY,
    SKIP_SENTINEL,
    VALID_SUFFIXES,
    CaseScore,
    MetricStatistics,
    compute_average_excluding_errors,
    validate_report,
)


def create_valid_casescore(case_id: str) -> dict:
    """Create a valid CaseScore dictionary for testing.

    Args:
        case_id: The judge case_id (e.g., 'test-judge')

    Returns:
        A valid CaseScore dict with all required fields
    """
    return {
        "type": "case_score",
        "case_id": case_id,
        "final_status": 1,
        "metrics": [
            {
                "metric_name": "test_metric",
                "threshold": 0.8,
                "score": 0.9,
                "justification": "Test passed successfully",
            }
        ],
    }


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


def _make_skipped_casescore(case_id: str, via: str = "top_level") -> dict:
    """Create a CaseScore dict representing a skipped judge.

    Args:
        case_id: The judge case_id
        via: Where to place the SKIP_SENTINEL justification:
             'top_level' - in the CaseScore.justification field (empty metrics)
             'metric'    - in a metric's justification field
    """
    if via == "top_level":
        return {
            "type": "case_score",
            "case_id": case_id,
            "final_status": 3,
            "justification": f"{SKIP_SENTINEL} judge not applicable for this run",
            "metrics": [],
        }
    else:
        return {
            "type": "case_score",
            "case_id": case_id,
            "final_status": 3,
            "metrics": [
                {
                    "metric_name": "skip_reason",
                    "threshold": None,
                    "score": 0.0,
                    "justification": f"{SKIP_SENTINEL} judge not applicable for this run",
                }
            ],
        }


class TestBackwardCompatibility:
    """Tests verifying regression prevention for existing plan judge behavior."""

    def test_category_plan_accepts_16_judges(self, tmp_path: Path) -> None:
        """Verify that category='plan' validates all 16 plan judges successfully."""
        # Create valid report with all 16 plan judges
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-plan-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, f"Expected valid report, got: {message}"
        assert "16 judge results" in message

    def test_legacy_report_id_suffix(self, tmp_path: Path) -> None:
        """Verify backward compatibility with legacy '-judges' suffix (no '-plan' prefix)."""
        # Create valid report with legacy report_id format
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, (
            f"Expected valid report with legacy suffix, got: {message}"
        )

    def test_default_category_is_plan(self, tmp_path: Path) -> None:
        """Verify omitting category parameter defaults to plan validation with 16 judges."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path)
        assert valid is True, (
            f"Expected valid report with default category, got: {message}"
        )
        assert "16 judge results" in message

    def test_16_judges_plan_validation(self, tmp_path: Path) -> None:
        """Verify validation passes with exactly 16 expected plan judges."""
        # Verify we have exactly 16 judges in the registry (3 new brownfield/grounding/convention judges added)
        assert len(JUDGE_REGISTRY["plan"]) == 16, (
            "Plan judges count changed unexpectedly"
        )

        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-xyz-plan-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True
        assert "16 judge results" in message

    def test_plan_report_rejects_code_judges(self, tmp_path: Path) -> None:
        """Verify category='plan' rejects reports with only code judge subset."""
        # Create report with only 11 code judges (missing 4 plan-specific judges)
        code_judges = sorted(JUDGE_REGISTRY["code"])
        report = create_evaluation_report("run-20250211-judges", code_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False, (
            "Expected rejection when code judges used with plan category"
        )
        assert "Missing expected" in message
        # Check that the missing plan-specific judges are mentioned
        missing_judges = JUDGE_REGISTRY["plan"] - JUDGE_REGISTRY["code"]
        for judge in missing_judges:
            assert judge in message, f"Missing judge {judge} should be in error message"


class TestCategoryCodeValidation:
    """Tests for validating code category reports with 11 judges."""

    def test_accepts_valid_11_judge_report(self, tmp_path: Path) -> None:
        """Valid 11-judge code report passes validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        assert len(code_judges) == 11, "Code judges count should be 11"

        report = create_evaluation_report("run-20250211-code-judges", code_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="code")
        assert valid is True, f"Expected valid code report, got: {message}"
        assert "11 judge results" in message

    def test_rejects_missing_judges(self, tmp_path: Path) -> None:
        """Report missing required code judges fails validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Remove two judges to trigger missing judges error
        incomplete_judges = [
            j
            for j in code_judges
            if j not in ["technical-accuracy-judge", "ssot-judge"]
        ]
        assert len(incomplete_judges) == 9

        report = create_evaluation_report("run-20250211-code-judges", incomplete_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="code")
        assert valid is False
        assert "Missing expected judges for category 'code'" in message
        assert "technical-accuracy-judge" in message or "ssot-judge" in message

    def test_rejects_wrong_report_id_suffix(self, tmp_path: Path) -> None:
        """Report with wrong suffix fails validation."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Use invalid suffix (not -judges or -plan-judges)
        report = create_evaluation_report("run-20250211-wrong-suffix", code_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="code")
        assert valid is False
        assert "report_id should end with one of" in message
        assert "-judges" in message

    def test_category_in_error_messages(self, tmp_path: Path) -> None:
        """Error messages include category context."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Remove judges to trigger missing judges error
        incomplete_judges = code_judges[:8]  # Only 8 instead of 11

        report = create_evaluation_report("run-20250211-code-judges", incomplete_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="code")
        assert valid is False
        assert "category 'code'" in message, (
            "Error message should mention the category being validated"
        )
        assert "Missing expected judges" in message

    def test_code_report_extra_judge(self, tmp_path: Path) -> None:
        """Verify code report passes when extra judges are present (not currently rejected)."""
        code_judges = sorted(JUDGE_REGISTRY["code"])
        # Add goal-alignment-judge which is excluded from code category but included in plan
        extra_judges = code_judges + ["goal-alignment-judge"]

        report = create_evaluation_report("run-20250211-code-judges", extra_judges)

        report_path = tmp_path / "code-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Note: Current validation only checks for missing judges, not extra ones
        # This test documents current behavior - validation passes with extra judges
        valid, message = validate_report(report_path, category="code")
        assert valid is True, "Extra judges should not cause validation failure"


class TestSchemaValidation:
    """Tests for Pydantic schema validation with strict mode."""

    def test_extra_field_ignored(self, tmp_path: Path) -> None:
        """Verify Pydantic strict=True ignores extra fields (doesn't use extra='forbid')."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Add extra field to CaseScore - should be ignored, not rejected
        report["stats"][0]["extra_data"] = "this_gets_ignored"

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        # strict=True controls type coercion, not extra fields
        # Extra fields are silently ignored unless extra='forbid' is set
        assert valid is True

    def test_threshold_type_mismatch(self, tmp_path: Path) -> None:
        """Verify threshold field type validation (must be float, not string)."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Set threshold as string instead of float
        report["stats"][0]["metrics"][0]["threshold"] = "0.8"

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "Validation failed" in message

    @pytest.mark.parametrize("invalid_status", [0, 4, -1])
    def test_invalid_final_status_values(
        self, tmp_path: Path, invalid_status: int
    ) -> None:
        """Verify final_status field validator rejects invalid values."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["final_status"] = invalid_status

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "Validation failed" in message

    def test_empty_metrics_array(self, tmp_path: Path) -> None:
        """Verify semantic validation fails when metrics array is empty."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"] = []

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "has no metrics" in message

    @pytest.mark.parametrize("missing_field", ["case_id", "final_status", "metrics"])
    def test_missing_required_field(self, tmp_path: Path, missing_field: str) -> None:
        """Verify Pydantic validation fails when required fields are missing."""
        # Use all plan judges to pass judge count validation
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        # Remove required field from CaseScore
        del report["stats"][0][missing_field]

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "Validation failed" in message


class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_file_not_found(self, tmp_path: Path) -> None:
        """Verify validation handles missing report file gracefully."""
        report_path = tmp_path / "nonexistent.json"

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "does not exist" in message

    def test_invalid_json(self, tmp_path: Path) -> None:
        """Verify validation handles malformed JSON gracefully."""
        report_path = tmp_path / "invalid.json"
        report_path.write_text("{ invalid json content")

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "Invalid JSON" in message

    def test_empty_stats_array(self, tmp_path: Path) -> None:
        """Verify validation fails when stats array is empty."""
        report = {
            "report_id": "run-123-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": [],
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False
        assert "no judge results" in message

    def test_invalid_category_parameter(self, tmp_path: Path) -> None:
        """Verify validation fails with helpful message for invalid category."""
        report = create_evaluation_report("run-123-judges", ["test-judge"])

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="invalid")
        assert valid is False
        assert "Invalid category" in message
        assert "plan" in message and "code" in message


class TestBoundaryValues:
    """Tests for boundary value handling in numeric fields."""

    def test_score_zero(self, tmp_path: Path) -> None:
        """Score of 0.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 0.0

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_score_one(self, tmp_path: Path) -> None:
        """Score of 1.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 1.0

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_score_negative(self, tmp_path: Path) -> None:
        """Negative scores are allowed by schema (no range validation)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = -0.5

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        # Schema doesn't restrict negative scores
        assert valid is True

    def test_score_above_one(self, tmp_path: Path) -> None:
        """Scores above 1.0 are allowed by schema (no range validation)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["score"] = 1.5

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        # Schema doesn't restrict scores > 1.0
        assert valid is True

    @pytest.mark.parametrize("status", [1, 2, 3])
    def test_valid_final_status_values(self, tmp_path: Path, status: int) -> None:
        """Valid final_status values (1=pass, 2=fail, 3=error) are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["final_status"] = status

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_threshold_zero(self, tmp_path: Path) -> None:
        """Threshold of 0.0 is valid."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["threshold"] = 0.0

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_threshold_null(self, tmp_path: Path) -> None:
        """Threshold of None/null is valid (optional field)."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["threshold"] = None

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_multiple_metrics_per_judge(self, tmp_path: Path) -> None:
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

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True


class TestUnicodeHandling:
    """Tests for Unicode character handling in text fields."""

    def test_unicode_in_justification(self, tmp_path: Path) -> None:
        """Unicode characters in justification field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["justification"] = (
            "Excellent quality ✓ 优秀的代码质量 très bien"
        )

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_emoji_in_justification(self, tmp_path: Path) -> None:
        """Emoji characters in justification field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["justification"] = "Great work! 🎉 👍 ✨"

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_unicode_in_metric_name(self, tmp_path: Path) -> None:
        """Unicode characters in metric_name field are accepted."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-123-judges", plan_judges)
        report["stats"][0]["metrics"][0]["metric_name"] = "测试指标_test_métrique"

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

    def test_unicode_in_report_id(self, tmp_path: Path) -> None:
        """Unicode characters in report_id (though not recommended) are handled."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-测试-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, message = validate_report(report_path, category="plan")
        # Should pass schema validation and semantic checks (has valid suffix and all judges)
        assert valid is True

    def test_unicode_in_case_id_fails_judge_matching(self, tmp_path: Path) -> None:
        """Unicode in case_id fails judge name matching."""
        report = create_evaluation_report("run-123-judges", ["test-judge-中文"])

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )

        valid, message = validate_report(report_path, category="plan")
        # Will fail because it won't match expected judge names
        assert valid is False
        assert "Missing expected judges" in message


class TestIntegration:
    """Integration tests for documented behavior."""

    def test_plan_judges_workflow_unchanged(self, tmp_path: Path) -> None:
        """Integration test: Existing plan judge workflows remain unchanged."""
        # Simulate a complete plan judge validation workflow
        plan_judges = sorted(JUDGE_REGISTRY["plan"])

        # Test with new suffix format
        report_new = create_evaluation_report("run-20250211-plan-judges", plan_judges)
        report_path_new = tmp_path / "judges-new.json"
        report_path_new.write_text(json.dumps(report_new, indent=2))
        valid_new, _ = validate_report(report_path_new, category="plan")
        assert valid_new is True

        # Test with legacy suffix format
        report_legacy = create_evaluation_report("run-20250211-judges", plan_judges)
        report_path_legacy = tmp_path / "judges-legacy.json"
        report_path_legacy.write_text(json.dumps(report_legacy, indent=2))
        valid_legacy, _ = validate_report(report_path_legacy, category="plan")
        assert valid_legacy is True

        # Test without category parameter (default)
        valid_default, _ = validate_report(report_path_legacy)
        assert valid_default is True


class TestCategoryPrdValidation:
    """Tests for the prd category with 5 judges."""

    def test_accepts_valid_5_judge_report(self, tmp_path: Path) -> None:
        """Valid 5-judge prd report passes validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        assert len(prd_judges) == 5, "PRD judges count should be 5"

        report = create_evaluation_report("run-20250211-prd-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is True, f"Expected valid prd report, got: {message}"
        assert "5 judge results" in message

    def test_prd_registry_contains_expected_judges(self) -> None:
        """Verify prd JUDGE_REGISTRY contains the 5 expected PRD judges."""
        expected = {
            "feature-completeness-judge",
            "prd-auditor",
            "prd-dependency-judge",
            "prd-testability-judge",
            "prd-scope-judge",
        }
        assert JUDGE_REGISTRY["prd"] == expected, (
            f"PRD registry mismatch. Expected {expected}, got {JUDGE_REGISTRY['prd']}"
        )

    def test_prd_report_id_requires_prd_judges_suffix(self, tmp_path: Path) -> None:
        """PRD report must use -prd-judges suffix in report_id."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        report = create_evaluation_report("run-20250211-prd-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is True, (
            f"Expected valid report with -prd-judges suffix, got: {message}"
        )

    def test_prd_rejects_wrong_suffix(self, tmp_path: Path) -> None:
        """PRD report with non -prd-judges suffix fails validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        report = create_evaluation_report("run-20250211-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False, "Expected rejection for wrong suffix"
        assert "report_id should end with one of" in message
        assert "-prd-judges" in message

    def test_prd_rejects_plan_suffix(self, tmp_path: Path) -> None:
        """PRD report using plan-style suffix fails validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        report = create_evaluation_report("run-20250211-plan-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False, (
            "Expected rejection for plan suffix used with prd category"
        )
        assert "report_id should end with one of" in message

    def test_prd_rejects_code_suffix(self, tmp_path: Path) -> None:
        """PRD report using code-style suffix fails validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        report = create_evaluation_report("run-20250211-code-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False, (
            "Expected rejection for code suffix used with prd category"
        )
        assert "report_id should end with one of" in message

    def test_prd_rejects_missing_judges(self, tmp_path: Path) -> None:
        """PRD report missing required judges fails validation."""
        # Omit prd-scope-judge
        partial_judges = [
            j for j in sorted(JUDGE_REGISTRY["prd"]) if j != "prd-scope-judge"
        ]
        assert len(partial_judges) == 4

        report = create_evaluation_report("run-20250211-prd-judges", partial_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False
        assert "Missing expected judges for category 'prd'" in message
        assert "prd-scope-judge" in message

    def test_prd_error_message_includes_category(self, tmp_path: Path) -> None:
        """Error messages for prd include category context."""
        # Use only 2 judges to trigger missing judges error
        partial_judges = ["prd-auditor", "prd-dependency-judge"]

        report = create_evaluation_report("run-20250211-prd-judges", partial_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False
        assert "category 'prd'" in message

    def test_prd_report_extra_judge_passes(self, tmp_path: Path) -> None:
        """PRD report with extra judges beyond the required 5 still passes."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        extra_judges = prd_judges + ["extra-custom-judge"]

        report = create_evaluation_report("run-20250211-prd-judges", extra_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is True, "Extra judges should not cause prd validation failure"

    def test_prd_category_in_judge_registry(self) -> None:
        """Verify 'prd' is a valid key in JUDGE_REGISTRY."""
        assert "prd" in JUDGE_REGISTRY, "JUDGE_REGISTRY must contain a 'prd' key"

    def test_prd_not_accepted_for_plan_category(self, tmp_path: Path) -> None:
        """PRD judges submitted as a plan report fail because plan-specific judges are missing."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        report = create_evaluation_report("run-20250211-plan-judges", prd_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False, (
            "PRD judges should not satisfy plan category requirements"
        )
        assert "Missing expected judges" in message

    def test_default_filename_for_plan_category(self) -> None:
        """DEFAULT_FILENAMES produces 'plan-judges.json' for plan category."""
        assert DEFAULT_FILENAMES["plan"] == "plan-judges.json"

    def test_default_filename_for_prd_category(self) -> None:
        """DEFAULT_FILENAMES produces 'prd-judges.json' for prd category."""
        assert DEFAULT_FILENAMES["prd"] == "prd-judges.json"

    def test_valid_suffixes_for_prd_category(self) -> None:
        """VALID_SUFFIXES for prd contains only '-prd-judges'."""
        assert VALID_SUFFIXES["prd"] == ["-prd-judges"]


class TestPlanRegistryReconciliation:
    """Tests verifying the reconciled plan JUDGE_REGISTRY (3 new judges added, no phantom entries)."""

    def test_brownfield_accuracy_judge_in_plan_registry(self) -> None:
        """brownfield-accuracy-judge is present in plan registry."""
        assert "brownfield-accuracy-judge" in JUDGE_REGISTRY["plan"]

    def test_codebase_grounding_judge_in_plan_registry(self) -> None:
        """codebase-grounding-judge is present in plan registry."""
        assert "codebase-grounding-judge" in JUDGE_REGISTRY["plan"]

    def test_convention_adherence_judge_in_plan_registry(self) -> None:
        """convention-adherence-judge is present in plan registry."""
        assert "convention-adherence-judge" in JUDGE_REGISTRY["plan"]

    def test_plan_registry_has_no_phantom_entries(self) -> None:
        """Plan registry contains only known valid judge names (no phantom/typo entries)."""
        expected_plan_judges = {
            "brownfield-accuracy-judge",
            "codebase-grounding-judge",
            "code-organization-judge",
            "convention-adherence-judge",
            "custom-best-practices-judge",
            "dry-judge",
            "goal-alignment-judge",
            "kiss-judge",
            "readability-judge",
            "solid-isp-dip-judge",
            "solid-liskov-substitution-judge",
            "solid-open-closed-judge",
            "ssot-judge",
            "technical-accuracy-judge",
            "test-judge",
            "verbosity-judge",
        }
        assert JUDGE_REGISTRY["plan"] == expected_plan_judges, (
            f"Plan registry has unexpected entries. "
            f"Extra: {JUDGE_REGISTRY['plan'] - expected_plan_judges}, "
            f"Missing: {expected_plan_judges - JUDGE_REGISTRY['plan']}"
        )

    def test_new_plan_judges_are_absent_from_code_registry(self) -> None:
        """The 3 new plan-only judges are not included in the code registry."""
        new_plan_only_judges = {
            "brownfield-accuracy-judge",
            "codebase-grounding-judge",
            "convention-adherence-judge",
        }
        for judge in new_plan_only_judges:
            assert judge not in JUDGE_REGISTRY["code"], (
                f"{judge} should not be in code registry"
            )


class TestCategoryFeatureValidation:
    """Tests for the feature category with 3 judges."""

    def test_accepts_valid_3_judge_report(self, tmp_path: Path) -> None:
        """Valid 3-judge feature report passes validation."""
        feature_judges = sorted(JUDGE_REGISTRY["feature"])
        assert len(feature_judges) == 3, "Feature judges count should be 3"

        report = create_evaluation_report("run-20250211-feature-judges", feature_judges)

        report_path = tmp_path / "feature-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="feature")
        assert valid is True, f"Expected valid feature report, got: {message}"
        assert "3 judge results" in message

    def test_feature_registry_contains_expected_judges(self) -> None:
        """Verify feature JUDGE_REGISTRY contains the 3 expected feature judges."""
        expected = {
            "feature-completeness-judge",
            "prd-testability-judge",
            "prd-dependency-judge",
        }
        assert JUDGE_REGISTRY["feature"] == expected, (
            f"Feature registry mismatch. Expected {expected}, got {JUDGE_REGISTRY['feature']}"
        )

    def test_feature_rejects_wrong_suffix(self, tmp_path: Path) -> None:
        """Feature report with non -feature-judges suffix fails validation."""
        feature_judges = sorted(JUDGE_REGISTRY["feature"])
        # Use -judges (legacy plan suffix) which is not valid for feature
        report = create_evaluation_report("run-20250211-judges", feature_judges)

        report_path = tmp_path / "feature-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="feature")
        assert valid is False, "Expected rejection for wrong suffix"
        assert "report_id should end with one of" in message

        # Also verify -prd-judges suffix is rejected
        report2 = create_evaluation_report("run-20250211-prd-judges", feature_judges)
        report_path2 = tmp_path / "feature-judges2.json"
        report_path2.write_text(json.dumps(report2, indent=2))

        valid2, message2 = validate_report(report_path2, category="feature")
        assert valid2 is False, (
            "Expected rejection for -prd-judges suffix under feature category"
        )
        assert "report_id should end with one of" in message2

    def test_feature_rejects_missing_judges(self, tmp_path: Path) -> None:
        """Feature report missing required judges fails validation."""
        # Omit prd-testability-judge
        partial_judges = [
            j for j in sorted(JUDGE_REGISTRY["feature"]) if j != "prd-testability-judge"
        ]
        assert len(partial_judges) == 2

        report = create_evaluation_report("run-20250211-feature-judges", partial_judges)

        report_path = tmp_path / "feature-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="feature")
        assert valid is False
        assert "Missing expected judges for category 'feature'" in message
        assert "prd-testability-judge" in message

    def test_feature_error_message_includes_category(self, tmp_path: Path) -> None:
        """Error messages for feature include category context."""
        # Use only 1 judge to trigger missing judges error
        partial_judges = ["feature-completeness-judge"]

        report = create_evaluation_report("run-20250211-feature-judges", partial_judges)

        report_path = tmp_path / "feature-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="feature")
        assert valid is False
        assert "category 'feature'" in message

    def test_default_filename_for_feature_category(self) -> None:
        """DEFAULT_FILENAMES produces 'feature-judges.json' for feature category."""
        assert DEFAULT_FILENAMES["feature"] == "feature-judges.json"

    def test_feature_report_fails_under_prd_category(self, tmp_path: Path) -> None:
        """3-judge feature report with -feature-judges suffix fails prd validation."""
        feature_judges = sorted(JUDGE_REGISTRY["feature"])
        report = create_evaluation_report("run-20250211-feature-judges", feature_judges)

        report_path = tmp_path / "feature-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is False, (
            "Feature judges should not satisfy prd category requirements"
        )
        # prd requires prd-auditor and prd-scope-judge which are missing from feature set
        assert "Missing expected judges" in message
        assert "prd-auditor" in message or "prd-scope-judge" in message

    def test_prd_report_fails_under_feature_category(self, tmp_path: Path) -> None:
        """5-judge prd report with -prd-judges suffix fails feature validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        assert len(prd_judges) == 5
        report = create_evaluation_report("run-20250211-prd-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="feature")
        assert valid is False, (
            "PRD report with -prd-judges suffix should fail feature category validation"
        )
        assert "report_id should end with one of" in message


def _make_minimal_casescore(case_id: str, final_status: int = 1, error_reason: Optional[str] = None) -> CaseScore:
    """Create a minimal CaseScore instance for unit testing.

    Args:
        case_id: The judge case_id.
        final_status: Status code (1=pass, 2=fail, 3=error). Defaults to 1.
        error_reason: Optional agent-reported error context. Defaults to None.

    Returns:
        A minimal CaseScore with one dummy metric.
    """
    return CaseScore(
        case_id=case_id,
        final_status=final_status,
        metrics=[
            MetricStatistics(
                metric_name="dummy",
                threshold=0.8,
                score=0.9,
                justification="Test metric",
            )
        ],
        error_reason=error_reason,
    )


class TestCaseScoreErrorReason:
    """Tests for CaseScore.error_reason field and compute_average_excluding_errors."""

    def test_casescore_accepts_error_reason_field(self) -> None:
        """CaseScore can be constructed with an error_reason string."""
        score = _make_minimal_casescore(
            "test-judge", final_status=3, error_reason="Tool call failed"
        )
        assert score.error_reason == "Tool call failed"

    def test_casescore_defaults_error_reason_to_none(self) -> None:
        """CaseScore.error_reason defaults to None when not provided."""
        score = _make_minimal_casescore("test-judge")
        assert score.error_reason is None

    def test_compute_average_excluding_errors_excludes_errored_scores(self) -> None:
        """compute_average_excluding_errors excludes scores where final_status == 3."""
        scores = [
            _make_minimal_casescore("judge-a", final_status=1, error_reason=None),
            _make_minimal_casescore("judge-b", final_status=3, error_reason="parse error"),
        ]
        # Only judge-a contributes; judge-b is excluded. _make_minimal_casescore
        # uses a single metric with score=0.9, so the average is 0.9.
        result = compute_average_excluding_errors(scores)
        assert result == 0.9

    def test_compute_average_excluding_errors_returns_none_when_all_errored(self) -> None:
        """compute_average_excluding_errors returns None when every score has final_status=3."""
        scores = [
            _make_minimal_casescore("judge-a", final_status=3, error_reason="error 1"),
            _make_minimal_casescore("judge-b", final_status=3, error_reason="error 2"),
        ]
        result = compute_average_excluding_errors(scores)
        assert result is None

    def test_compute_average_excluding_errors_mixed_valid_and_errored(self) -> None:
        """compute_average_excluding_errors computes average only over non-errored scores."""
        scores = [
            _make_minimal_casescore("judge-a", final_status=1, error_reason=None),
            _make_minimal_casescore("judge-b", final_status=3, error_reason="tool error"),
            _make_minimal_casescore("judge-c", final_status=2, error_reason=None),
        ]
        # Valid scores: judge-a and judge-c, each with one metric score=0.9;
        # judge-b is excluded. Average = (0.9 + 0.9) / 2 = 0.9.
        result = compute_average_excluding_errors(scores)
        assert result == 0.9

    def test_compute_average_excluding_errors_averages_varied_metric_scores(self) -> None:
        """compute_average_excluding_errors averages every metric across non-errored CaseScores."""
        scores = [
            CaseScore(
                case_id="judge-a",
                final_status=1,
                metrics=[
                    MetricStatistics(metric_name="m1", threshold=0.5, score=0.4, justification="x"),
                    MetricStatistics(metric_name="m2", threshold=0.5, score=0.6, justification="y"),
                ],
                error_reason=None,
            ),
            CaseScore(
                case_id="judge-b",
                final_status=1,
                metrics=[
                    MetricStatistics(metric_name="m1", threshold=0.5, score=1.0, justification="z"),
                ],
                error_reason=None,
            ),
            CaseScore(
                case_id="judge-c",
                final_status=3,
                metrics=[
                    MetricStatistics(metric_name="m1", threshold=0.5, score=0.0, justification="w"),
                ],
                error_reason="tool error",
            ),
        ]
        # Errored judge-c is excluded. Average over (0.4, 0.6, 1.0) = 2.0/3.
        result = compute_average_excluding_errors(scores)
        assert result == pytest.approx(2.0 / 3.0)


class TestSkippedJudges:
    """Tests for skipped judge tolerance (final_status=3 with 'Skipped:' justification)."""

    def test_is_skipped_returns_true_for_status3_with_top_level_justification(self) -> None:
        """CaseScore.is_skipped() returns True for final_status=3 with top-level 'Skipped:' justification."""
        case = CaseScore(
            case_id="test-judge",
            final_status=3,
            justification="Skipped: not applicable",
            metrics=[],
        )
        assert case.is_skipped() is True

    def test_is_skipped_returns_true_for_status3_with_metric_justification(self) -> None:
        """CaseScore.is_skipped() returns True for final_status=3 with metric-level 'Skipped:' justification."""
        case = CaseScore(
            case_id="test-judge",
            final_status=3,
            metrics=[
                MetricStatistics(
                    metric_name="skip_reason",
                    threshold=None,
                    score=0.0,
                    justification="Skipped: not applicable",
                )
            ],
        )
        assert case.is_skipped() is True

    def test_is_skipped_returns_false_for_status1(self) -> None:
        """CaseScore.is_skipped() returns False when final_status is not 3."""
        case = CaseScore(
            case_id="test-judge",
            final_status=1,
            justification="Skipped: not applicable",
            metrics=[],
        )
        assert case.is_skipped() is False

    def test_is_skipped_returns_false_for_status3_without_skipped_text(self) -> None:
        """CaseScore.is_skipped() returns False for final_status=3 without 'Skipped:' text."""
        case = CaseScore(
            case_id="test-judge",
            final_status=3,
            justification="Error: something went wrong",
            metrics=[],
        )
        assert case.is_skipped() is False

    def test_is_skipped_returns_false_for_status3_with_no_justification(self) -> None:
        """CaseScore.is_skipped() returns False for final_status=3 with no justification text."""
        case = CaseScore(
            case_id="test-judge",
            final_status=3,
            metrics=[],
        )
        assert case.is_skipped() is False

    def test_skipped_judge_via_top_level_justification_passes_validation(self, tmp_path: Path) -> None:
        """Report with a skipped judge (top-level justification, empty metrics) passes validation."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        # Build report: all judges normal except the first, which is skipped
        stats = []
        for i, judge_id in enumerate(plan_judges):
            if i == 0:
                stats.append(_make_skipped_casescore(judge_id, via="top_level"))
            else:
                stats.append(create_valid_casescore(judge_id))

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, f"Expected valid report with skipped judge, got: {message}"

    def test_skipped_judge_via_metric_justification_passes_validation(self, tmp_path: Path) -> None:
        """Report with a skipped judge (justification in metric) passes validation."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        stats = []
        for i, judge_id in enumerate(plan_judges):
            if i == 0:
                stats.append(_make_skipped_casescore(judge_id, via="metric"))
            else:
                stats.append(create_valid_casescore(judge_id))

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, f"Expected valid report with skipped judge via metric, got: {message}"

    def test_multiple_skipped_judges_pass_validation(self, tmp_path: Path) -> None:
        """Report with multiple skipped judges (all have case_ids) passes validation."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        stats = []
        for i, judge_id in enumerate(plan_judges):
            if i < 3:
                stats.append(_make_skipped_casescore(judge_id, via="top_level"))
            else:
                stats.append(create_valid_casescore(judge_id))

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, f"Expected valid report with multiple skipped judges, got: {message}"

    def test_skipped_judge_still_requires_case_id_in_report(self, tmp_path: Path) -> None:
        """Missing case_id is still an error even when other judges are skipped."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        # Omit the first judge entirely (missing from report)
        stats = [_make_skipped_casescore(plan_judges[1], via="top_level")]
        for judge_id in plan_judges[2:]:
            stats.append(create_valid_casescore(judge_id))

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False, "Missing case_id should still fail validation"
        assert "Missing expected judges" in message
        assert plan_judges[0] in message

    def test_status3_without_skipped_text_still_requires_metrics(self, tmp_path: Path) -> None:
        """A judge with final_status=3 but no 'Skipped:' text still requires metrics."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        stats = []
        for i, judge_id in enumerate(plan_judges):
            if i == 0:
                # status=3, no "Skipped:" in justification, empty metrics -> should still error
                stats.append({
                    "type": "case_score",
                    "case_id": judge_id,
                    "final_status": 3,
                    "justification": "Error: something failed unexpectedly",
                    "metrics": [],
                })
            else:
                stats.append(create_valid_casescore(judge_id))

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is False, "status=3 without 'Skipped:' and empty metrics should fail"
        assert "has no metrics" in message

    def test_all_judges_skipped_passes_validation(self, tmp_path: Path) -> None:
        """Report where every judge is skipped (128K mode) passes validation."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        stats = [_make_skipped_casescore(judge_id, via="top_level") for judge_id in plan_judges]

        report = {
            "report_id": "run-20250211-plan-judges",
            "timestamp": "2025-02-11T12:00:00Z",
            "stats": stats,
        }

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="plan")
        assert valid is True, f"Expected valid report with all judges skipped (128K mode), got: {message}"
