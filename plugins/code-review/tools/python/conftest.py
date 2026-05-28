"""Shared pytest fixtures and finding factories for code-review tests.

Pytest auto-discovers this file; tests import the factory functions explicitly.
"""

from __future__ import annotations

from typing import Any

from code_review_schema import SCHEMA_VERSION, empty_telemetry


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
