"""Tests for aggregate_judge_report.py."""

from __future__ import annotations

import json

import pytest
import subprocess
import sys
from pathlib import Path
from typing import Any

from judge_report_contract import (
    aggregate_results,
    get_default_manifest_path,
    load_manifest,
    main,
    validate_report,
)
from conftest import create_valid_casescore

MANIFEST_PATH = get_default_manifest_path()
SCRIPT_PATH = Path(__file__).resolve().parent / "judge_report_contract.py"


def _write_results(path: Path, results: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps({"results": results}, indent=2))


def _load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def test_aggregate_plan_results_validate_successfully(tmp_path: Path) -> None:
    manifest = load_manifest(MANIFEST_PATH)
    plan_judges = manifest.categories["plan"].judges
    results_path = tmp_path / "judge-results-plan.json"

    _write_results(
        results_path,
        [{"judge_id": j, "result": create_valid_casescore(j)} for j in plan_judges],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="plan",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-123",
    )

    assert output_path.name == "judges.json"
    valid, message = validate_report(
        output_path, category="plan", manifest_path=MANIFEST_PATH
    )
    assert valid is True, message

    report = _load_report(output_path)
    assert report["report_id"] == "run-123-judges"


def test_aggregate_synthesizes_error_for_missing_judge(tmp_path: Path) -> None:
    manifest = load_manifest(MANIFEST_PATH)
    plan_judges = manifest.categories["plan"].judges
    results_path = tmp_path / "judge-results-plan.json"

    only_judge = plan_judges[0]
    _write_results(
        results_path,
        [{"judge_id": only_judge, "result": create_valid_casescore(only_judge)}],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="plan",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-124",
    )
    report = _load_report(output_path)
    stats_by_id = {entry["case_id"]: entry for entry in report["stats"]}

    missing_judge = next(j for j in plan_judges if j != only_judge)
    assert stats_by_id[missing_judge]["final_status"] == 3


def test_aggregate_invalid_result_payload_becomes_error_case(tmp_path: Path) -> None:
    results_path = tmp_path / "judge-results-code.json"
    _write_results(
        results_path,
        [
            {
                "judge_id": "code-quality-judge",
                "result": {"not": "a valid casescore"},
            }
        ],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-125",
    )
    report = _load_report(output_path)
    stats_by_id = {entry["case_id"]: entry for entry in report["stats"]}

    assert stats_by_id["code-quality-judge"]["final_status"] == 3
    assert stats_by_id["code-quality-judge"]["metrics"][0]["metric_name"] == (
        "aggregation_error_score"
    )


def test_aggregate_non_string_case_id_recovery_does_not_crash(tmp_path: Path) -> None:
    """Regression: when case_id is int/list, recovery path must cast to str before _error_casescore."""
    results_path = tmp_path / "judge-results-code.json"
    # Bare result with case_id as int (no judge_id wrapper) triggers the recovery path
    # that previously crashed by passing int to _error_casescore.
    _write_results(
        results_path,
        [
            {"judge_id": "design-principles-judge", "result": create_valid_casescore("design-principles-judge")},
            {"case_id": 123, "type": "case_score", "final_status": 1},
        ],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-125b",
    )
    report = _load_report(output_path)
    stats_by_id = {entry["case_id"]: entry for entry in report["stats"]}

    assert stats_by_id["design-principles-judge"]["final_status"] == 1
    # Manifest judges without valid results get error CaseScores
    assert stats_by_id["code-quality-judge"]["final_status"] == 3


@pytest.mark.parametrize(
    ("payload_json", "run_id"),
    [
        ("null", "run-null"),
        ("42", "run-number"),
        ('"string"', "run-string"),
    ],
    ids=["null", "number", "string"],
)
def test_aggregate_non_dict_list_payload_marks_all_error(
    tmp_path: Path, payload_json: str, run_id: str
) -> None:
    """Valid JSON that is not dict/list degrades gracefully to error CaseScores."""
    results_path = tmp_path / "judge-results-code.json"
    results_path.write_text(payload_json)

    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id=run_id,
    )
    report = _load_report(output_path)
    assert all(entry["final_status"] == 3 for entry in report["stats"])


def test_aggregate_missing_results_file_marks_all_missing(tmp_path: Path) -> None:
    missing_results_path = tmp_path / "does-not-exist.json"
    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=missing_results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-126",
    )
    report = _load_report(output_path)
    assert output_path.name == "code-judges.json"
    assert all(entry["final_status"] == 3 for entry in report["stats"])


def test_aggregate_preserves_manifest_judge_order(tmp_path: Path) -> None:
    manifest = load_manifest(MANIFEST_PATH)
    code_judges = manifest.categories["code"].judges
    results_path = tmp_path / "judge-results-code.json"

    # Intentionally reverse input order; output should match manifest order.
    _write_results(
        results_path,
        [{"judge_id": j, "result": create_valid_casescore(j)} for j in reversed(code_judges)],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-127",
    )
    report = _load_report(output_path)
    output_order = [entry["case_id"] for entry in report["stats"]]
    assert output_order == code_judges


def test_aggregate_output_validates_for_code_category(tmp_path: Path) -> None:
    manifest = load_manifest(MANIFEST_PATH)
    code_judges = manifest.categories["code"].judges
    results_path = tmp_path / "judge-results-code.json"

    _write_results(
        results_path,
        [
            {
                "judge_id": judge_id,
                "result": {
                    "type": "case_score",
                    "case_id": judge_id,
                    "final_status": 2,
                    "metrics": [
                        {
                            "metric_name": "test_metric",
                            "threshold": 0.8,
                            "score": 0.5,
                            "justification": "failed intentionally",
                        }
                    ],
                },
            }
            for judge_id in code_judges
        ],
    )

    output_path = aggregate_results(
        workdir=tmp_path,
        category="code",
        results_path=results_path,
        manifest_path=MANIFEST_PATH,
        run_id="run-128",
    )
    valid, message = validate_report(
        output_path, category="code", manifest_path=MANIFEST_PATH
    )
    assert valid is True, message


def test_cli_no_subcommand_fails() -> None:
    """CLI requires a subcommand; invocation without one exits with non-zero."""
    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH)],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "required" in result.stderr.lower() or "aggregate" in result.stderr.lower()


def test_cli_validate_report_subcommand_succeeds(tmp_path: Path) -> None:
    """validate-report subcommand works with --report-path and --category."""
    manifest = load_manifest(MANIFEST_PATH)
    plan_judges = manifest.categories["plan"].judges
    report = {
        "report_id": "run-cli-plan-judges",
        "timestamp": "2025-03-11T12:00:00Z",
        "stats": [create_valid_casescore(j) for j in plan_judges],
    }
    report_path = tmp_path / "judges.json"
    report_path.write_text(json.dumps(report, indent=2))

    exit_code = main(
        argv=[
            "validate-report",
            "--report-path",
            str(report_path),
            "--category",
            "plan",
            "--manifest-path",
            str(MANIFEST_PATH),
        ]
    )
    assert exit_code == 0


def test_cli_validate_case_score_subcommand_succeeds(tmp_path: Path) -> None:
    """validate-case-score subcommand works with --case-score-path."""
    case_path = tmp_path / "case.json"
    case_path.write_text(
        json.dumps(
            {
                "type": "case_score",
                "case_id": "code-quality-judge",
                "final_status": 1,
                "metrics": [
                    {
                        "metric_name": "test",
                        "threshold": 0.8,
                        "score": 1.0,
                        "justification": "ok",
                    }
                ],
            },
            indent=2,
        )
    )

    exit_code = main(argv=["validate-case-score", "--case-score-path", str(case_path)])
    assert exit_code == 0


def test_cli_aggregate_subcommand_succeeds(tmp_path: Path) -> None:
    """aggregate subcommand works with --workdir."""
    manifest = load_manifest(MANIFEST_PATH)
    plan_judges = manifest.categories["plan"].judges
    results_path = tmp_path / "judge-results-plan.json"
    _write_results(
        results_path,
        [{"judge_id": j, "result": create_valid_casescore(j)} for j in plan_judges],
    )

    exit_code = main(
        argv=[
            "aggregate",
            "--workdir",
            str(tmp_path),
            "--category",
            "plan",
            "--manifest-path",
            str(MANIFEST_PATH),
            "--run-id",
            "run-cli",
        ]
    )
    assert exit_code == 0
