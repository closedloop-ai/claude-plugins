"""Shared pytest fixtures and finding factories for code-review tests.

Pytest auto-discovers this file; tests import the factory functions explicitly.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import pytest

from code_review_schema import SCHEMA_VERSION, empty_telemetry


def pytest_addoption(parser: pytest.Parser) -> None:
    """Register code-review-specific CLI options.

    PLN-719 Phase 8 — ``--update-golden`` regenerates the
    ``expected/`` artifacts for every golden fixture instead of asserting
    on them. The new expected files are written through the same
    normalization pipeline the assertion path uses, so a subsequent
    pytest run without the flag will see byte-identical expected output.
    """
    parser.addoption(
        "--update-golden",
        action="store_true",
        default=False,
        help="Rewrite expected/ artifacts for every golden fixture instead of asserting.",
    )


@pytest.fixture
def update_golden(request: pytest.FixtureRequest) -> bool:
    """Whether the current test session was launched with ``--update-golden``."""
    return bool(request.config.getoption("--update-golden"))


def invoke_prepare_run(
    cr_dir: Path,
    *,
    output: str | Path | None = None,
    mode: str = "local",
    hygiene_only: bool | str = False,
    since_last_review: bool | str = False,
    full_review: bool | str = False,
    base_ref_override: str = "",
    scope_args: str = "",
    pr_number: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Invoke ``cmd_prepare_run`` and return ``(summary, run_plan)``.

    Centralizes the argparse Namespace construction + stdout suppression
    pattern that previously lived inline in both
    ``test_code_review_helpers.py::TestPrepareRun._run`` and
    ``test_golden_fixtures.py::_invoke``. The run_plan is loaded from
    ``output`` when provided, otherwise from the default location
    ``cr_dir/run_plan.json``. Both callers and any future test that
    needs to drive ``prepare-run`` should delegate here so the Namespace
    shape stays in lock-step with the CLI parser (PLN-719 Section 6).
    """
    from code_review_helpers import cmd_prepare_run
    from golden_fixture_harness import run_with_stdout_capture

    ns = argparse.Namespace(
        cr_dir=str(cr_dir),
        mode=mode,
        hygiene_only=hygiene_only,
        since_last_review=since_last_review,
        full_review=full_review,
        base_ref_override=base_ref_override,
        scope_args=scope_args,
        pr_number=pr_number,
        output=str(output) if output is not None else None,
    )
    captured = run_with_stdout_capture(cmd_prepare_run, ns)
    summary = json.loads(captured) if captured else {}

    run_plan_path = Path(output) if output is not None else Path(cr_dir) / "run_plan.json"
    run_plan = json.loads(run_plan_path.read_text())
    return summary, run_plan


def minimal_diff_finding(**overrides: Any) -> dict[str, Any]:
    """Return a canonical diff-scoped finding with sensible defaults.

    Pass keyword overrides to customize fields for a given test case.
    """
    base: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "id": "bha_p0_f0",
        "reviewer": "bha_p0",
        "reviewer_trigger": {"type": "partition", "evidence": "p0"},
        "source": "agent",
        "emitted_at": "2026-01-01T00:00:00Z",
        "finding_scope": "diff",
        "file": "src/foo.py",
        "line": 42,
        "system_marker": None,
        "category": "Correctness",
        "severity": "HIGH",
        "priority": 1,
        "confidence": 0.9,
        "issue": "Null pointer access",
        "explanation": "Variable `x` may be None.",
        "recommendation": "Add a None check before accessing `.bar`.",
        "code_snippet": "x.bar",
    }
    base.update(overrides)
    return base


def minimal_system_finding(**overrides: Any) -> dict[str, Any]:
    """Return a canonical system-scoped finding (e.g. coverage gap)."""
    base = minimal_diff_finding(
        id="coverage-verifier_f0",
        reviewer="coverage-verifier",
        source="coverage-verifier",
        reviewer_trigger={"type": "always", "evidence": None},
        finding_scope="system",
        file=None,
        line=None,
        system_marker="budget-exceeded",
        category="Coverage",
        severity="MEDIUM",
        priority=2,
        confidence=1.0,
        code_snippet="",
    )
    base.update(overrides)
    return base


def minimal_pr_metadata_finding(**overrides: Any) -> dict[str, Any]:
    """Return a canonical pr_metadata-scoped finding (e.g. prompt injection)."""
    base = minimal_diff_finding(
        id="injection-detector_f0",
        reviewer="injection-detector",
        source="injection-detector",
        reviewer_trigger={"type": "always", "evidence": None},
        finding_scope="pr_metadata",
        file=None,
        line=None,
        system_marker="pr_description",
        category="Security",
        code_snippet="<redacted>",
    )
    base.update(overrides)
    return base


def legacy_minimal_finding(**overrides: Any) -> dict[str, Any]:
    """Return a pre-foundation finding shape (no id / schema_version / scope).

    Used to exercise the legacy → canonical normalization path in
    cmd_collect_findings and cmd_validate.
    """
    base: dict[str, Any] = {
        "file": "src/foo.py",
        "line": 42,
        "severity": "HIGH",
        "category": "Correctness",
        "issue": "Bug",
        "explanation": "It's bad.",
        "recommendation": "Fix it.",
        "priority": 1,
        "confidence": 0.9,
        "code_snippet": "bad()",
    }
    base.update(overrides)
    return base


def minimal_envelope(**overrides: Any) -> dict[str, Any]:
    """Return a canonical ResultEnvelope with empty buckets."""
    base: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "review_id": "00000000-0000-4000-8000-000000000000",
        "pr_number": None,
        "head_sha": None,
        "diff_tip": "abc1234",
        "review_branch": "main",
        "base_ref": "main",
        "diff_scope": "main..HEAD",
        "mode": "local",
        "intent": "mixed",
        "verified": [],
        "justified": [],
        "rejected": [],
        "coverage_plan": {
            "required": [],
            "best_effort": [],
            "deferred_for_budget": [],
            "budget": {
                "total_cap": 20,
                "required_count": 0,
                "best_effort_count": 0,
                "bha_partitions": 1,
            },
        },
        "coverage_gaps": [],
        "verdict": "APPROVED",
        "verdict_reason": "no findings",
        "stats": {},
        # PLN-719 Phase 9: telemetry must conform to the canonical zero-valued
        # schema. Use the factory so tests stay valid by construction; tests
        # that exercise the validator can override with malformed values.
        "telemetry": empty_telemetry(),
    }
    base.update(overrides)
    return base
