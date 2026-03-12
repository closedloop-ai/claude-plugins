#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Single-source contract and tooling for judge report aggregation/validation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any, Optional

MAX_JUDGES_PER_CATEGORY = 4
MANDATORY_CATEGORIES = {"plan", "code"}


def _expect_str(value: Any, field_name: str) -> str:
    """Strict: require str, no coercion."""
    if not isinstance(value, str):
        raise ValueError(
            f"{field_name} must be str, got {type(value).__name__}"
        )
    return value


def _expect_int(value: Any, field_name: str) -> int:
    """Strict: require int, no coercion."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(
            f"{field_name} must be int, got {type(value).__name__}"
        )
    return value


def _expect_float(value: Any, field_name: str) -> float:
    """Strict: require float, no coercion."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(
            f"{field_name} must be float, got {type(value).__name__}"
        )
    return float(value)


def _expect_float_or_none(value: Any, field_name: str) -> float | None:
    """Strict: require float or None."""
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(
            f"{field_name} must be float or None, got {type(value).__name__}"
        )
    return float(value)


def _expect_list(value: Any, field_name: str) -> list:
    """Strict: require list."""
    if not isinstance(value, list):
        raise ValueError(
            f"{field_name} must be list, got {type(value).__name__}"
        )
    return value


def _expect_dict(value: Any, field_name: str) -> dict:
    """Strict: require dict."""
    if not isinstance(value, dict):
        raise ValueError(
            f"{field_name} must be dict, got {type(value).__name__}"
        )
    return value


@dataclass(frozen=True)
class MetricStatistics:
    """A single metric evaluation result."""

    metric_name: str
    threshold: float | None
    score: float
    justification: str

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MetricStatistics:
        """Parse from dict with strict type validation."""
        d = _expect_dict(data, "MetricStatistics input")
        return cls(
            metric_name=_expect_str(d.get("metric_name"), "metric_name"),
            threshold=_expect_float_or_none(d.get("threshold"), "threshold"),
            score=_expect_float(d.get("score"), "score"),
            justification=_expect_str(d.get("justification"), "justification"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "metric_name": self.metric_name,
            "threshold": self.threshold,
            "score": self.score,
            "justification": self.justification,
        }


@dataclass
class CaseScore:
    """Score for a single judge evaluation."""

    case_id: str
    final_status: int  # 1=pass, 2=fail, 3=error
    metrics: list[MetricStatistics]
    type: str = "case_score"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CaseScore:
        """Parse from dict with strict type validation."""
        d = _expect_dict(data, "CaseScore input")
        final_status = _expect_int(d.get("final_status"), "final_status")
        if final_status not in (1, 2, 3):
            raise ValueError(
                f"final_status must be 1 (pass), 2 (fail), or 3 (error), got {final_status}"
            )
        metrics_raw = _expect_list(d.get("metrics"), "metrics")
        metrics = [MetricStatistics.from_dict(m) for m in metrics_raw]
        type_val = d.get("type")
        type_str = type_val if type_val is None else _expect_str(type_val, "type")
        return cls(
            case_id=_expect_str(d.get("case_id"), "case_id"),
            final_status=final_status,
            metrics=metrics,
            type=type_str if type_str else "case_score",
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "case_id": self.case_id,
            "final_status": self.final_status,
            "metrics": [m.to_dict() for m in self.metrics],
        }


@dataclass
class EvaluationReport:
    """Top-level report containing all judge evaluations."""

    report_id: str
    timestamp: str
    stats: list[CaseScore]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EvaluationReport:
        """Parse from dict with strict type validation."""
        d = _expect_dict(data, "EvaluationReport input")
        stats_raw = _expect_list(d.get("stats"), "stats")
        stats = [CaseScore.from_dict(s) for s in stats_raw]
        return cls(
            report_id=_expect_str(d.get("report_id"), "report_id"),
            timestamp=_expect_str(d.get("timestamp"), "timestamp"),
            stats=stats,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "report_id": self.report_id,
            "timestamp": self.timestamp,
            "stats": [s.to_dict() for s in self.stats],
        }


@dataclass
class ManifestCategory:
    """Manifest configuration for a single evaluation category."""

    output_file: str
    report_id_suffix: str
    judges: list[str]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ManifestCategory:
        """Parse from dict with strict type validation."""
        d = _expect_dict(data, "ManifestCategory input")
        judges_raw = _expect_list(d.get("judges"), "judges")
        judges: list[str] = []
        seen: set[str] = set()
        for i, j in enumerate(judges_raw):
            if not isinstance(j, str):
                raise ValueError(
                    f"judges[{i}] must be str, got {type(j).__name__}"
                )
            if not j:
                raise ValueError("Invalid judge id in judges list")
            if j in seen:
                raise ValueError(f"Duplicate judge id in judges list: {j}")
            seen.add(j)
            judges.append(j)
        if not judges:
            raise ValueError("judges must contain at least one judge")
        if len(judges) > MAX_JUDGES_PER_CATEGORY:
            raise ValueError(
                f"judges has {len(judges)} entries; max allowed is {MAX_JUDGES_PER_CATEGORY}"
            )
        return cls(
            output_file=_expect_str(d.get("output_file"), "output_file"),
            report_id_suffix=_expect_str(d.get("report_id_suffix"), "report_id_suffix"),
            judges=judges,
        )


@dataclass
class JudgeManifest:
    """Top-level manifest contract for run-judges configuration."""

    version: int
    categories: dict[str, ManifestCategory]

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> JudgeManifest:
        """Parse from dict with strict type validation."""
        d = _expect_dict(data, "JudgeManifest input")
        categories_raw = _expect_dict(d.get("categories"), "categories")
        categories: dict[str, ManifestCategory] = {}
        for k, v in categories_raw.items():
            if not isinstance(v, dict):
                raise ValueError(
                    f"categories.{k} must be dict, got {type(v).__name__}"
                )
            categories[k] = ManifestCategory.from_dict(v)
        missing = MANDATORY_CATEGORIES - set(categories.keys())
        if missing:
            raise ValueError(
                f"Missing required categories: {', '.join(sorted(missing))}"
            )
        return cls(
            version=_expect_int(d.get("version"), "version"),
            categories=categories,
        )


def get_default_manifest_path() -> Path:
    """Return default manifest path under judges plugin."""
    return Path(__file__).resolve().parents[3] / "agents" / "judge-manifest.json"


def load_manifest(manifest_path: Optional[Path] = None) -> JudgeManifest:
    """Load and strictly validate the judge manifest."""
    resolved_path = (manifest_path or get_default_manifest_path()).resolve()
    if not resolved_path.exists():
        raise FileNotFoundError(f"Manifest file does not exist: {resolved_path}")
    if not resolved_path.is_file():
        raise ValueError(f"Manifest path is not a file: {resolved_path}")

    try:
        manifest_data = json.loads(resolved_path.read_text())
    except json.JSONDecodeError as error:
        raise ValueError(f"Invalid manifest JSON: {error}") from error
    except OSError as error:
        raise ValueError(f"Unable to read manifest: {error}") from error

    try:
        return JudgeManifest.from_dict(manifest_data)
    except Exception as error:  # noqa: BLE001
        raise ValueError(f"Manifest schema validation failed: {error}") from error


def build_judge_registry(manifest: JudgeManifest) -> dict[str, set[str]]:
    """Build expected judge sets per category from manifest judge lists."""
    return {
        category_name: set(category_config.judges)
        for category_name, category_config in manifest.categories.items()
    }


def _error_casescore(judge_id: str, reason: str) -> CaseScore:
    """Build a deterministic error CaseScore for missing/invalid judge output."""
    return CaseScore.from_dict(
        {
            "type": "case_score",
            "case_id": judge_id,
            "final_status": 3,
            "metrics": [
                {
                    "metric_name": "aggregation_error_score",
                    "threshold": 0.8,
                    "score": 0.0,
                    "justification": f"Judge result unavailable during aggregation: {reason}",
                }
            ],
        }
    )


def _extract_case_scores(raw_payload: object) -> dict[str, CaseScore]:
    """Extract CaseScore objects from known payload shapes."""
    extracted: dict[str, CaseScore] = {}

    payload = raw_payload
    if isinstance(payload, dict) and "results" in payload:
        payload = payload["results"]

    if isinstance(payload, dict):
        iterable: list[object] = []
        for judge_id, item_payload in payload.items():
            candidate = item_payload
            if isinstance(candidate, dict) and "case_id" not in candidate:
                candidate = {**candidate, "case_id": judge_id}
            iterable.append(candidate)
    elif isinstance(payload, list):
        iterable = payload
    else:
        raise ValueError("Unsupported results payload; expected dict or list")

    for index, item in enumerate(iterable):
        candidate = item
        if isinstance(item, dict) and "result" in item and isinstance(item["result"], dict):
            candidate = item["result"]
            if "judge_id" in item and "case_id" not in candidate:
                candidate = {**candidate, "case_id": item["judge_id"]}

        if not isinstance(candidate, dict):
            continue

        try:
            score = CaseScore.from_dict(candidate)
        except Exception as error:  # noqa: BLE001
            case_id: str | None = None
            if isinstance(item, dict) and "judge_id" in item:
                case_id = str(item["judge_id"])
            elif isinstance(candidate, dict):
                raw = candidate.get("case_id")
                case_id = str(raw) if raw is not None else None
            if case_id:
                extracted[case_id] = _error_casescore(
                    case_id, f"invalid CaseScore payload at index {index}: {error}"
                )
            continue

        extracted[score.case_id] = score

    return extracted


def _build_report_id(workdir: Path, report_suffix: str, run_id_arg: str | None) -> str:
    """Derive report ID from explicit arg, env var, or workdir directory name."""
    run_id = run_id_arg or os.getenv("CLOSEDLOOP_RUN_ID") or workdir.name
    return f"{run_id}{report_suffix}"


def _atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    """Write JSON atomically to avoid partial report files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        delete=False,
        prefix=f".{path.name}.tmp.",
    ) as tmp_file:
        tmp_name = tmp_file.name
        try:
            json.dump(payload, tmp_file, indent=2)
            tmp_file.write("\n")
        except Exception:
            Path(tmp_name).unlink(missing_ok=True)
            raise
    try:
        Path(tmp_name).replace(path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def aggregate_results(
    *,
    workdir: Path,
    category: str,
    results_path: Path,
    manifest_path: Optional[Path] = None,
    run_id: str | None = None,
) -> Path:
    """Aggregate judge outputs into a manifest-defined report file."""
    manifest = load_manifest(manifest_path)
    if category not in manifest.categories:
        available = ", ".join(sorted(manifest.categories))
        raise ValueError(f"Unknown category '{category}'. Available: {available}")

    category_cfg = manifest.categories[category]

    if not results_path.exists():
        raw_scores: dict[str, CaseScore] = {}
    else:
        try:
            raw_payload = json.loads(results_path.read_text())
        except (json.JSONDecodeError, OSError) as err:
            print(f"Warning: results file unreadable ({err}); all judges will be error CaseScores", file=sys.stderr)
            raw_payload = {}
        try:
            raw_scores = _extract_case_scores(raw_payload)
        except (ValueError, TypeError) as err:
            print(f"Warning: results payload unsupported ({err}); all judges will be error CaseScores", file=sys.stderr)
            raw_scores = {}

    ordered_scores: list[CaseScore] = []
    for judge_id in category_cfg.judges:
        if judge_id in raw_scores:
            ordered_scores.append(raw_scores[judge_id])
        else:
            missing_reason = (
                f"results file not found: {results_path}"
                if not results_path.exists()
                else f"missing judge result for {judge_id}"
            )
            ordered_scores.append(_error_casescore(judge_id, missing_reason))

    report = EvaluationReport.from_dict(
        {
            "report_id": _build_report_id(workdir, category_cfg.report_id_suffix, run_id),
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "stats": [score.to_dict() for score in ordered_scores],
        }
    )

    output_path = workdir / category_cfg.output_file
    _atomic_write_json(output_path, report.to_dict())
    return output_path


def validate_case_score(
    case_score_path: Path, expected_case_id: Optional[str] = None
) -> tuple[bool, str]:
    """Validate a single CaseScore JSON file."""
    if not case_score_path.exists():
        return False, f"CaseScore file does not exist: {case_score_path}"

    try:
        data = json.loads(case_score_path.read_text())
    except json.JSONDecodeError as error:
        return False, f"Invalid JSON: {error}"
    except OSError as error:
        return False, f"Error reading file: {error}"

    if isinstance(data, dict) and "result" in data and isinstance(data["result"], dict):
        data = data["result"]

    try:
        case_score = CaseScore.from_dict(data)
    except Exception as error:  # noqa: BLE001
        return False, f"CaseScore validation failed: {error}"

    if expected_case_id and case_score.case_id != expected_case_id:
        return (
            False,
            f"case_id mismatch: expected '{expected_case_id}', got '{case_score.case_id}'",
        )

    if not case_score.metrics:
        return False, f"Judge {case_score.case_id} has no metrics"

    return True, f"Valid CaseScore for judge '{case_score.case_id}'"


def validate_report(
    report_path: Path, category: str = "plan", manifest_path: Optional[Path] = None
) -> tuple[bool, str]:
    """Validate EvaluationReport payload and category-specific manifest expectations."""
    try:
        manifest = load_manifest(manifest_path)
        judge_registry = build_judge_registry(manifest)
    except Exception as error:  # noqa: BLE001
        return False, f"Manifest validation failed: {error}"

    if not report_path.exists():
        return False, f"Report file does not exist: {report_path}"

    try:
        data = json.loads(report_path.read_text())
    except json.JSONDecodeError as error:
        return False, f"Invalid JSON: {error}"
    except OSError as error:
        return False, f"Error reading file: {error}"

    try:
        report = EvaluationReport.from_dict(data)
    except Exception as error:  # noqa: BLE001
        return False, f"Validation failed: {error}"

    errors: list[str] = []
    if not report.stats:
        errors.append("Report contains no judge results (stats array is empty)")

    if category not in judge_registry:
        errors.append(
            f"Invalid category '{category}'. Must be one of: {', '.join(sorted(judge_registry.keys()))}"
        )
    else:
        expected_judges = judge_registry[category]
        found_judges = {case.case_id for case in report.stats}
        missing_judges = expected_judges - found_judges
        if missing_judges:
            errors.append(
                f"Missing expected judges for category '{category}': {', '.join(sorted(missing_judges))}"
            )

    if category in manifest.categories:
        valid_suffixes = [manifest.categories[category].report_id_suffix]
        if not any(report.report_id.endswith(suffix) for suffix in valid_suffixes):
            errors.append(
                f"report_id should end with one of {valid_suffixes}, got: {report.report_id}"
            )

    for case in report.stats:
        if not case.metrics:
            errors.append(f"Judge {case.case_id} has no metrics")

    if errors:
        return False, "Validation errors:\n  - " + "\n  - ".join(errors)
    return True, f"Valid report with {len(report.stats)} judge results"


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Judge report tooling (contract, aggregation, and validation)."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    aggregate_parser = subparsers.add_parser(
        "aggregate", help="Aggregate judge CaseScores into report output."
    )
    aggregate_parser.add_argument("--workdir", required=True, help="Absolute workdir path")
    aggregate_parser.add_argument(
        "--category",
        default="plan",
        help="Manifest category to aggregate (default: plan).",
    )
    aggregate_parser.add_argument(
        "--results-path",
        help="Path to JSON file with judge results (defaults to $WORKDIR/judge-results-{category}.json).",
    )
    aggregate_parser.add_argument("--manifest-path", help="Optional path to judge-manifest.json")
    aggregate_parser.add_argument(
        "--run-id",
        help="Optional run id for report_id prefix. Defaults to CLOSEDLOOP_RUN_ID or workdir basename.",
    )

    validate_report_parser = subparsers.add_parser(
        "validate-report", help="Validate aggregated EvaluationReport output."
    )
    validate_report_parser.add_argument(
        "--workdir", help="Workdir containing manifest-defined output report."
    )
    validate_report_parser.add_argument(
        "--report-path",
        help="Path to report file (defaults to manifest category output in --workdir).",
    )
    validate_report_parser.add_argument(
        "--category",
        default="plan",
        help="Judge category to validate against (default: plan). Validated against manifest.",
    )
    validate_report_parser.add_argument(
        "--manifest-path", help="Optional path to judge-manifest.json"
    )

    validate_case_parser = subparsers.add_parser(
        "validate-case-score", help="Validate single CaseScore payload."
    )
    validate_case_parser.add_argument(
        "--case-score-path", required=True, help="Path to single CaseScore JSON payload."
    )
    validate_case_parser.add_argument(
        "--expected-case-id", help="Optional expected judge id for case_id guard-rail check."
    )

    return parser.parse_args(argv)


def _resolve_validate_report_path(
    *,
    workdir: Path | None,
    explicit_report_path: Path | None,
    category: str,
    manifest_path: Path | None,
) -> Path:
    if explicit_report_path is not None:
        return explicit_report_path
    if workdir is None:
        raise ValueError("--workdir is required when --report-path is not provided")
    manifest = load_manifest(manifest_path)
    if category not in manifest.categories:
        raise ValueError(
            f"Unknown category '{category}'. Available: {', '.join(sorted(manifest.categories))}"
        )
    return workdir / manifest.categories[category].output_file


def _run_aggregate(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir).resolve()
    if not workdir.exists():
        print(f"Error: workdir does not exist: {workdir}", file=sys.stderr)
        return 1
    if not workdir.is_dir():
        print(f"Error: workdir is not a directory: {workdir}", file=sys.stderr)
        return 1

    if args.results_path:
        results_path = Path(args.results_path).resolve()
    else:
        results_path = workdir / f"judge-results-{args.category}.json"
    manifest_path = Path(args.manifest_path).resolve() if args.manifest_path else None

    output_path = aggregate_results(
        workdir=workdir,
        category=args.category,
        results_path=results_path,
        manifest_path=manifest_path,
        run_id=args.run_id,
    )
    print(f"✓ Aggregated judge report written to {output_path}")
    return 0


def _run_validate_report(args: argparse.Namespace) -> int:
    workdir = Path(args.workdir).resolve() if args.workdir else None
    if workdir is not None:
        if not workdir.exists():
            print(f"Error: workdir does not exist: {workdir}", file=sys.stderr)
            return 1
        if not workdir.is_dir():
            print(f"Error: workdir is not a directory: {workdir}", file=sys.stderr)
            return 1

    report_path = Path(args.report_path).resolve() if args.report_path else None
    manifest_path = Path(args.manifest_path).resolve() if args.manifest_path else None

    try:
        resolved_report_path = _resolve_validate_report_path(
            workdir=workdir,
            explicit_report_path=report_path,
            category=args.category,
            manifest_path=manifest_path,
        )
    except Exception as error:  # noqa: BLE001
        print(f"✗ {error}", file=sys.stderr)
        return 1

    valid, message = validate_report(
        resolved_report_path, category=args.category, manifest_path=manifest_path
    )
    if valid:
        print(f"✓ {message}")
        return 0
    print(f"✗ {message}", file=sys.stderr)
    return 1


def _run_validate_case_score(args: argparse.Namespace) -> int:
    case_score_path = Path(args.case_score_path).resolve()
    valid, message = validate_case_score(
        case_score_path, expected_case_id=args.expected_case_id
    )
    if valid:
        print(f"✓ {message}")
        return 0
    print(f"✗ {message}", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for aggregate and validation commands."""
    parsed = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        if parsed.command == "aggregate":
            return _run_aggregate(parsed)
        if parsed.command == "validate-report":
            return _run_validate_report(parsed)
        if parsed.command == "validate-case-score":
            return _run_validate_case_score(parsed)

        return 1  # Unreachable when required=True on subparsers
    except Exception as error:  # noqa: BLE001
        print(f"Error: operation failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
