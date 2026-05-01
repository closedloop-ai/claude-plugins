#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pydantic>=2.0.0",
# ]
# ///
"""
ClosedLoop Judge Report Validation

Validates judge report JSON output from the judge orchestrator against the expected
Pydantic models.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import List, Optional

try:
    from pydantic import BaseModel, ConfigDict, Field, field_validator
except ImportError:
    print("Error: pydantic is not installed. Install it with: uv pip install pydantic", file=sys.stderr)
    sys.exit(1)


class MetricStatistics(BaseModel):
    """A single metric evaluation result."""
    model_config = ConfigDict(strict=True)

    metric_name: str
    threshold: Optional[float] = None
    score: float
    justification: str


class CaseScore(BaseModel):
    """Score for a single judge evaluation."""
    model_config = ConfigDict(strict=True)

    type: Optional[str] = Field(default="case_score")
    case_id: str
    final_status: int  # 1=pass, 2=fail, 3=error
    metrics: List[MetricStatistics]

    @field_validator('final_status')
    @classmethod
    def validate_status(cls, v: int) -> int:
        """Validate final_status is one of the allowed values."""
        if v not in (1, 2, 3):
            raise ValueError(f"final_status must be 1 (pass), 2 (fail), or 3 (error), got {v}")
        return v


class EvaluationReport(BaseModel):
    """Top-level report containing all judge evaluations."""
    model_config = ConfigDict(strict=True)

    report_id: str
    timestamp: str
    stats: List[CaseScore]


JUDGE_REGISTRY: dict[str, set[str]] = {
    "plan": {
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
    },
    "code": {
        "code-organization-judge",
        "custom-best-practices-judge",
        "dry-judge",
        "kiss-judge",
        "readability-judge",
        "solid-isp-dip-judge",
        "solid-liskov-substitution-judge",
        "solid-open-closed-judge",
        "ssot-judge",
        "technical-accuracy-judge",
        "test-judge",
    },
    "prd": {
        "feature-completeness-judge",
        "prd-auditor",
        "prd-dependency-judge",
        "prd-testability-judge",
        "prd-scope-judge",
    },
    "feature": {
        "feature-completeness-judge",
        "prd-testability-judge",
        "prd-dependency-judge",
    },
}

VALID_SUFFIXES: dict[str, list[str]] = {
    "plan": ["-plan-judges", "-judges"],
    "code": ["-code-judges"],
    "prd": ["-prd-judges"],
    "feature": ["-feature-judges"],
}

# Default report filename per category
DEFAULT_FILENAMES: dict[str, str] = {
    "plan": "plan-judges.json",
    "code": "code-judges.json",
    "prd": "prd-judges.json",
    "feature": "feature-judges.json",
}


def validate_report(report_path: Path, category: str = "plan") -> tuple[bool, str]:
    """Validate judge report JSON against Pydantic models.

    Args:
        report_path: Path to the judge report file
        category: Judge category to validate against ('plan', 'code', 'prd', or 'feature')

    Returns:
        Tuple of (valid: bool, message: str)
    """
    if not report_path.exists():
        return False, f"Report file does not exist: {report_path}"

    try:
        with open(report_path, 'r') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        return False, f"Invalid JSON: {e}"
    except IOError as e:
        return False, f"Error reading file: {e}"

    try:
        report = EvaluationReport.model_validate(data, strict=True)
    except Exception as e:
        return False, f"Validation failed: {e}"

    errors = []

    if not report.stats:
        errors.append("Report contains no judge results (stats array is empty)")

    if category not in JUDGE_REGISTRY:
        errors.append(f"Invalid category '{category}'. Must be one of: {', '.join(sorted(JUDGE_REGISTRY.keys()))}")
    else:
        expected_judges = JUDGE_REGISTRY[category]
        found_judges = {case.case_id for case in report.stats}
        missing_judges = expected_judges - found_judges
        if missing_judges:
            errors.append(f"Missing expected judges for category '{category}': {', '.join(sorted(missing_judges))}")

    valid_suffixes = VALID_SUFFIXES.get(category, [])
    if not any(report.report_id.endswith(suffix) for suffix in valid_suffixes):
        errors.append(f"report_id should end with one of {valid_suffixes}, got: {report.report_id}")

    for case in report.stats:
        if not case.metrics:
            errors.append(f"Judge {case.case_id} has no metrics")

    if errors:
        return False, "Validation errors:\n  - " + "\n  - ".join(errors)

    return True, f"Valid report with {len(report.stats)} judge results"


def main() -> int:
    """Main entry point for validation script.

    Returns:
        0 if valid, 1 if invalid
    """
    parser = argparse.ArgumentParser(description='Validate judge report JSON format')
    parser.add_argument('--workdir', required=True, help='Working directory containing judge report files')
    parser.add_argument('--report-path', help='Path to report file (defaults to $WORKDIR/{category}-judges.json)')
    parser.add_argument('--category', choices=list(JUDGE_REGISTRY.keys()), default='plan',
                        help='Judge category to validate against (default: plan)')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()

    if not workdir.exists():
        print(f"Error: workdir does not exist: {workdir}", file=sys.stderr)
        return 1

    if not workdir.is_dir():
        print(f"Error: workdir is not a directory: {workdir}", file=sys.stderr)
        return 1

    if args.report_path:
        report_path = Path(args.report_path).resolve()
    else:
        report_path = workdir / DEFAULT_FILENAMES[args.category]

    try:
        valid, message = validate_report(report_path, category=args.category)
    except Exception as e:
        print(f"Error: unexpected error during validation: {e}", file=sys.stderr)
        return 1

    if valid:
        print(f"✓ {message}")
        return 0

    print(f"✗ {message}", file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
