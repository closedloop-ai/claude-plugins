#!/usr/bin/env python3
"""Tests for code_review_schema.py (PLN-719 Phase 1)."""

from __future__ import annotations

import json

import pytest

from code_review_schema import (
    CATEGORIES,
    FINDING_SCOPES,
    SCHEMA_VERSION,
    SEVERITIES,
    SOURCES,
    SYSTEM_MARKERS_FIXED,
    SYSTEM_MARKER_TEMPLATES,
    finding_json_schema,
    is_valid_finding_id,
    is_valid_system_marker,
    make_finding_id,
    normalize_legacy_finding,
    parse_system_marker,
    result_envelope_json_schema,
    system_marker_scope,
    validate_finding,
    validate_result_envelope,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _minimal_diff_finding(**overrides) -> dict:
    base = {
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


def _minimal_system_finding(**overrides) -> dict:
    base = _minimal_diff_finding(
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


def _minimal_pr_metadata_finding(**overrides) -> dict:
    base = _minimal_diff_finding(
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


def _minimal_envelope(**overrides) -> dict:
    base = {
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
        "telemetry": {},
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_schema_version_is_one():
    assert SCHEMA_VERSION == 1


def test_finding_scopes():
    assert FINDING_SCOPES == frozenset({"diff", "system", "pr_metadata"})


def test_severities():
    assert SEVERITIES == frozenset({"BLOCKING", "HIGH", "MEDIUM"})


def test_categories_include_canonical_and_legacy_alias():
    assert "Hygiene" in CATEGORIES
    assert "Repo Hygiene" in CATEGORIES  # legacy alias retained
    assert "Premise" in CATEGORIES
    assert "Coverage" in CATEGORIES


def test_sources():
    assert "agent" in SOURCES
    assert "hygiene" in SOURCES
    assert "injection-detector" in SOURCES
    assert "companion-validator" in SOURCES
    assert "coverage-verifier" in SOURCES


# ---------------------------------------------------------------------------
# Finding ID
# ---------------------------------------------------------------------------


def test_make_finding_id_basic():
    assert make_finding_id("bha_p0", 0) == "bha_p0_f0"
    assert make_finding_id("premise", 7) == "premise_f7"
    assert make_finding_id("coverage-verifier", 1) == "coverage-verifier_f1"


def test_make_finding_id_rejects_empty_reviewer():
    with pytest.raises(ValueError, match="reviewer_id is required"):
        make_finding_id("", 0)


def test_make_finding_id_rejects_negative_index():
    with pytest.raises(ValueError, match="index must be >= 0"):
        make_finding_id("bha_p0", -1)


def test_make_finding_id_rejects_bad_reviewer():
    with pytest.raises(ValueError, match="reviewer_id must match"):
        make_finding_id("BHA_P0", 0)  # uppercase rejected


def test_is_valid_finding_id():
    assert is_valid_finding_id("bha_p0_f0")
    assert is_valid_finding_id("coverage-verifier_f12")
    assert not is_valid_finding_id("bha_p0_f")
    assert not is_valid_finding_id("BHA_F0")
    assert not is_valid_finding_id("")


# ---------------------------------------------------------------------------
# system_marker
# ---------------------------------------------------------------------------


def test_fixed_system_markers():
    for marker in ("budget-exceeded", "agent-failure", "signal-extraction-failed",
                   "schema-version", "pr_description"):
        assert marker in SYSTEM_MARKERS_FIXED
        assert is_valid_system_marker(marker)


def test_templated_system_markers():
    assert "coverage" in SYSTEM_MARKER_TEMPLATES
    assert "commit" in SYSTEM_MARKER_TEMPLATES
    assert is_valid_system_marker("coverage:database-architect")
    assert is_valid_system_marker("commit:abc1234")
    assert system_marker_scope("coverage:database-architect") == "system"
    assert system_marker_scope("commit:abc1234") == "pr_metadata"


def test_parse_system_marker():
    assert parse_system_marker("coverage:foo") == ("coverage", "foo")
    assert parse_system_marker("commit:abc") == ("commit", "abc")
    assert parse_system_marker("budget-exceeded") == (None, None)


def test_unknown_system_marker_invalid():
    assert not is_valid_system_marker("random-marker")
    assert not is_valid_system_marker("budget_exceeded")  # underscore typo
    assert not is_valid_system_marker("")
    assert system_marker_scope("unknown") is None


def test_templated_marker_requires_suffix():
    assert not is_valid_system_marker("coverage:")
    assert not is_valid_system_marker("commit:")


# ---------------------------------------------------------------------------
# validate_finding — diff scope
# ---------------------------------------------------------------------------


def test_minimal_diff_finding_passes():
    assert validate_finding(_minimal_diff_finding()) == []


def test_diff_finding_must_have_file():
    f = _minimal_diff_finding(file=None)
    errors = validate_finding(f)
    assert any("requires non-empty string file" in e for e in errors)


def test_diff_finding_must_not_have_system_marker():
    f = _minimal_diff_finding(system_marker="budget-exceeded")
    errors = validate_finding(f)
    assert any("must not set system_marker" in e for e in errors)


# ---------------------------------------------------------------------------
# validate_finding — system scope
# ---------------------------------------------------------------------------


def test_minimal_system_finding_passes():
    assert validate_finding(_minimal_system_finding()) == []


def test_system_finding_must_have_system_marker():
    f = _minimal_system_finding(system_marker=None)
    errors = validate_finding(f)
    assert any("requires system_marker" in e for e in errors)


def test_system_finding_rejects_unknown_marker():
    f = _minimal_system_finding(system_marker="random-stuff")
    errors = validate_finding(f)
    assert any("not in canonical enum" in e for e in errors)


def test_system_finding_marker_must_be_in_system_scope():
    # pr_description belongs to pr_metadata, not system
    f = _minimal_system_finding(system_marker="pr_description")
    errors = validate_finding(f)
    assert any("belongs to scope" in e for e in errors)


def test_system_finding_must_have_null_file():
    f = _minimal_system_finding(file="src/x.py")
    errors = validate_finding(f)
    assert any("must have file=null" in e for e in errors)


def test_templated_coverage_marker_in_system_scope():
    f = _minimal_system_finding(system_marker="coverage:database-architect")
    assert validate_finding(f) == []


# ---------------------------------------------------------------------------
# validate_finding — pr_metadata scope
# ---------------------------------------------------------------------------


def test_minimal_pr_metadata_finding_passes():
    assert validate_finding(_minimal_pr_metadata_finding()) == []


def test_pr_metadata_finding_with_commit_marker():
    f = _minimal_pr_metadata_finding(system_marker="commit:abc1234")
    assert validate_finding(f) == []


def test_pr_metadata_finding_with_system_marker_in_wrong_scope():
    f = _minimal_pr_metadata_finding(system_marker="budget-exceeded")
    errors = validate_finding(f)
    assert any("belongs to scope" in e for e in errors)


# ---------------------------------------------------------------------------
# validate_finding — generic fields
# ---------------------------------------------------------------------------


def test_finding_requires_schema_version():
    f = _minimal_diff_finding()
    del f["schema_version"]
    errors = validate_finding(f)
    assert any("missing schema_version" in e for e in errors)


def test_finding_requires_id():
    f = _minimal_diff_finding(id=None)
    errors = validate_finding(f)
    assert any("missing id" in e for e in errors)


def test_finding_id_must_match_format():
    f = _minimal_diff_finding(id="BAD_FORMAT")
    errors = validate_finding(f)
    assert any("does not match" in e for e in errors)


def test_finding_rejects_bad_severity():
    f = _minimal_diff_finding(severity="CRITICAL")
    errors = validate_finding(f)
    assert any("severity" in e and "CRITICAL" in e for e in errors)


def test_finding_rejects_bad_confidence():
    f = _minimal_diff_finding(confidence=1.5)
    errors = validate_finding(f)
    assert any("out of range" in e for e in errors)


def test_finding_rejects_bad_category():
    f = _minimal_diff_finding(category="MadeUp")
    errors = validate_finding(f)
    assert any("category" in e for e in errors)


def test_finding_rejects_unknown_trigger_type():
    f = _minimal_diff_finding(reviewer_trigger={"type": "wishful", "evidence": None})
    errors = validate_finding(f)
    assert any("reviewer_trigger.type" in e for e in errors)


def test_finding_rejects_unknown_source():
    f = _minimal_diff_finding(source="external-tool")
    errors = validate_finding(f)
    assert any("source" in e and "external-tool" in e for e in errors)


# ---------------------------------------------------------------------------
# validate_result_envelope
# ---------------------------------------------------------------------------


def test_minimal_envelope_passes():
    assert validate_result_envelope(_minimal_envelope()) == []


def test_envelope_requires_buckets():
    env = _minimal_envelope()
    del env["verified"]
    errors = validate_result_envelope(env)
    assert any("missing findings bucket 'verified'" in e for e in errors)


def test_envelope_rejects_bad_mode():
    env = _minimal_envelope(mode="unknown")
    errors = validate_result_envelope(env)
    assert any("mode" in e for e in errors)


def test_envelope_rejects_bad_verdict():
    env = _minimal_envelope(verdict="MAYBE")
    errors = validate_result_envelope(env)
    assert any("verdict" in e for e in errors)


def test_envelope_validates_findings_in_buckets():
    bad_finding = _minimal_diff_finding(severity="CRITICAL")
    env = _minimal_envelope(verified=[bad_finding])
    errors = validate_result_envelope(env)
    assert any("verified[0]" in e and "CRITICAL" in e for e in errors)


def test_envelope_coverage_plan_required_keys():
    env = _minimal_envelope()
    del env["coverage_plan"]["required"]
    errors = validate_result_envelope(env)
    assert any("coverage_plan missing 'required'" in e for e in errors)


# ---------------------------------------------------------------------------
# normalize_legacy_finding
# ---------------------------------------------------------------------------


def test_normalize_legacy_finding_fills_defaults():
    legacy = {
        "file": "src/foo.py",
        "line": 10,
        "severity": "HIGH",
        "category": "Correctness",
        "issue": "Bad code",
        "explanation": "It's bad.",
        "recommendation": "Fix it.",
        "priority": 1,
        "confidence": 0.9,
        "code_snippet": "bad()",
    }
    out = normalize_legacy_finding(legacy, reviewer="bha_p0", index=3)
    assert out["id"] == "bha_p0_f3"
    assert out["schema_version"] == SCHEMA_VERSION
    assert out["finding_scope"] == "diff"
    assert out["system_marker"] is None
    assert out["source"] == "agent"
    assert out["reviewer"] == "bha_p0"
    assert out["reviewer_trigger"] == {"type": "core", "evidence": None}
    assert out["evidence"] == []
    assert out["verifier_verdict"] is None


def test_normalize_legacy_preserves_existing_fields():
    legacy = {
        "id": "premise_f5",
        "reviewer": "premise",
        "source": "agent",
        "schema_version": 1,
        "finding_scope": "diff",
        "file": "src/foo.py",
        "line": 1,
        "category": "Premise",
        "severity": "MEDIUM",
        "priority": 2,
        "confidence": 0.8,
        "issue": "x",
        "explanation": "y",
        "recommendation": "z",
        "code_snippet": "",
    }
    out = normalize_legacy_finding(legacy, reviewer="other", index=99)
    assert out["id"] == "premise_f5"  # unchanged
    assert out["reviewer"] == "premise"  # unchanged


# ---------------------------------------------------------------------------
# JSON Schema dicts are well-formed
# ---------------------------------------------------------------------------


def test_finding_json_schema_well_formed():
    schema = finding_json_schema()
    assert schema["title"] == "CodeReviewFinding"
    assert "schema_version" in schema["required"]
    assert "id" in schema["required"]
    # Round-trips as JSON
    assert json.loads(json.dumps(schema)) == schema


def test_result_envelope_json_schema_well_formed():
    schema = result_envelope_json_schema()
    assert schema["title"] == "CodeReviewResultEnvelope"
    assert "verdict" in schema["required"]
    assert json.loads(json.dumps(schema)) == schema


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_finding_round_trip():
    finding = _minimal_diff_finding()
    assert validate_finding(finding) == []
    serialized = json.dumps(finding)
    deserialized = json.loads(serialized)
    assert validate_finding(deserialized) == []
    assert deserialized == finding


def test_envelope_round_trip():
    finding = _minimal_diff_finding()
    env = _minimal_envelope(verified=[finding])
    assert validate_result_envelope(env) == []
    serialized = json.dumps(env)
    deserialized = json.loads(serialized)
    assert validate_result_envelope(deserialized) == []


# ---------------------------------------------------------------------------
# Determinism tiers (PLN-719 Phase 6)
# ---------------------------------------------------------------------------


def test_determinism_tiers_enum():
    from code_review_schema import (
        DETERMINISM_TIERS,
        DETERMINISM_TIER_DETERMINISTIC,
        DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
        DETERMINISM_TIER_LLM_DRIVEN,
    )
    assert DETERMINISM_TIERS == frozenset({
        DETERMINISM_TIER_DETERMINISTIC,
        DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
        DETERMINISM_TIER_LLM_DRIVEN,
    })


def test_deterministic_stages():
    from code_review_schema import is_deterministic_stage, stage_determinism_tier
    # Foundation-owned stages must be deterministic.
    for sub in ("parse-diff", "extract-patches", "hygiene", "validate",
                "arbitrate-budget", "finalize-result", "verdict", "partition"):
        assert is_deterministic_stage(sub), f"{sub} must be deterministic"
        assert stage_determinism_tier(sub) == "deterministic"


def test_llm_or_cacheable_stages():
    from code_review_schema import (
        is_deterministic_stage, stage_determinism_tier,
        DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE, DETERMINISM_TIER_LLM_DRIVEN,
    )
    # Plan 05 extract-signals must not block required reviewers (cacheable).
    assert stage_determinism_tier("extract-signals") == DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE
    assert stage_determinism_tier("coverage-critic") == DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE
    # Plan 03 verifier
    assert stage_determinism_tier("verify-findings") == DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE
    # Plan 01 detect-injection is LLM-driven (raw text input is adversarial).
    assert stage_determinism_tier("detect-injection") == DETERMINISM_TIER_LLM_DRIVEN
    # None of the cacheable / llm-driven stages are deterministic.
    assert not is_deterministic_stage("extract-signals")
    assert not is_deterministic_stage("detect-injection")


def test_signal_extraction_failed_marker_exists():
    """The system_marker for fail-closed signal extraction is in the canonical enum."""
    from code_review_schema import is_valid_system_marker, system_marker_scope
    assert is_valid_system_marker("signal-extraction-failed")
    assert system_marker_scope("signal-extraction-failed") == "system"
