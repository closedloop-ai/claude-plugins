"""Shared test helpers for judge report contract tests."""

from __future__ import annotations


def create_valid_casescore(case_id: str) -> dict[str, object]:
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
