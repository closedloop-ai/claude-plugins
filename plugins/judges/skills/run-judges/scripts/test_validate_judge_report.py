"""Tests for validate_judge_report.py."""

import json

# Add scripts directory to path to import validate_judge_report module
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from validate_judge_report import (  # type: ignore[import-not-found]
    JUDGE_REGISTRY,
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

    def test_no_category_flag_validates_16_judges(self, tmp_path: Path) -> None:
        """Verify default behavior (no category parameter) validates 16 plan judges."""
        # Create valid report with all 16 plan judges
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Call validate_report WITHOUT category parameter (uses default='plan')
        valid, message = validate_report(report_path)
        assert valid is True, (
            f"Expected valid report with default category, got: {message}"
        )
        assert "16 judge results" in message

    def test_default_category_plan(self, tmp_path: Path) -> None:
        """Verify omitting --category defaults to plan validation."""
        # This is the same as test_no_category_flag_validates_15_judges but more explicit
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("run-20250211-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        # Call without category - should default to 'plan'
        valid, _ = validate_report(report_path)
        assert valid is True

    def test_existing_judges_json_suffix(self, tmp_path: Path) -> None:
        """Verify legacy '-judges' suffix is still accepted for plan reports."""
        plan_judges = sorted(JUDGE_REGISTRY["plan"])
        report = create_evaluation_report("abc123-judges", plan_judges)

        report_path = tmp_path / "plan-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, _ = validate_report(report_path, category="plan")
        assert valid is True

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
    """Tests for the new prd category with 4 judges."""

    def test_accepts_valid_4_judge_report(self, tmp_path: Path) -> None:
        """Valid 4-judge prd report passes validation."""
        prd_judges = sorted(JUDGE_REGISTRY["prd"])
        assert len(prd_judges) == 4, "PRD judges count should be 4"

        report = create_evaluation_report("run-20250211-prd-judges", prd_judges)

        report_path = tmp_path / "prd-judges.json"
        report_path.write_text(json.dumps(report, indent=2))

        valid, message = validate_report(report_path, category="prd")
        assert valid is True, f"Expected valid prd report, got: {message}"
        assert "4 judge results" in message

    def test_prd_registry_contains_expected_judges(self) -> None:
        """Verify prd JUDGE_REGISTRY contains the 4 expected PRD judges."""
        expected = {
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
        assert len(partial_judges) == 3

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
        """PRD report with extra judges beyond the required 4 still passes."""
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
        from validate_judge_report import (
            DEFAULT_FILENAMES,  # type: ignore[import-not-found]
        )

        assert DEFAULT_FILENAMES["plan"] == "plan-judges.json"

    def test_default_filename_for_prd_category(self) -> None:
        """DEFAULT_FILENAMES produces 'prd-judges.json' for prd category."""
        from validate_judge_report import (
            DEFAULT_FILENAMES,  # type: ignore[import-not-found]
        )

        assert DEFAULT_FILENAMES["prd"] == "prd-judges.json"

    def test_valid_suffixes_for_prd_category(self) -> None:
        """VALID_SUFFIXES for prd contains only '-prd-judges'."""
        from validate_judge_report import (
            VALID_SUFFIXES,  # type: ignore[import-not-found]
        )

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
