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
from conftest import (
    minimal_diff_finding as _minimal_diff_finding,
    minimal_envelope as _minimal_envelope,
    minimal_pr_metadata_finding as _minimal_pr_metadata_finding,
    minimal_system_finding as _minimal_system_finding,
)


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


def test_categories_include_code_quality():
    """Code Quality is the canonical category for DRY/maintainability findings.

    The shared reviewer prompt (tools/prompts/shared_prompt.txt) documents
    ``"category": "Code Quality"`` as the example category for MEDIUM-tier
    DRY violations; if the enum drops it, finalize-result rejects the
    envelope and verdict silently falls back to validate_output.json.
    """
    assert "Code Quality" in CATEGORIES


def test_code_quality_finding_passes_validation():
    """A reviewer-emitted Code Quality finding must validate end-to-end."""
    f = _minimal_diff_finding(
        category="Code Quality",
        severity="MEDIUM",
        priority=2,
        issue="EditableDescription duplicates EditableTitle",
    )
    assert validate_finding(f) == []


def test_code_quality_finding_in_envelope_passes_validation():
    """A Code Quality finding bucketed into verified[] must not reject the envelope."""
    f = _minimal_diff_finding(
        category="Code Quality", severity="MEDIUM", priority=2,
    )
    env = _minimal_envelope(verified=[f])
    assert validate_result_envelope(env) == []


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


# ---------------------------------------------------------------------------
# Telemetry (PLN-719 Phase 9)
# ---------------------------------------------------------------------------


def test_empty_telemetry_passes_validation():
    """The zero-valued factory must be valid by construction."""
    from code_review_schema import empty_telemetry, validate_telemetry
    assert validate_telemetry(empty_telemetry()) == []


def test_empty_telemetry_includes_all_canonical_keys():
    """Every required key listed in SCHEMA.md Section 11 is present."""
    from code_review_schema import empty_telemetry
    t = empty_telemetry()
    for key in (
        "duration_ms", "duration_by_stage_ms", "estimated_cost_usd",
        "tokens", "cache_hit_rate", "agent_failures", "schema_versions_seen",
    ):
        assert key in t, f"empty_telemetry missing canonical key {key!r}"
    assert set(t["tokens"].keys()) == {
        "input_uncached", "input_cached", "output", "by_model",
    }


def test_validate_telemetry_rejects_non_dict():
    from code_review_schema import validate_telemetry
    assert validate_telemetry([]) == ["telemetry must be an object"]
    assert validate_telemetry(None) == ["telemetry must be an object"]


def test_validate_telemetry_flags_negative_duration():
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["duration_ms"] = -1
    errors = validate_telemetry(t)
    assert any("duration_ms" in e for e in errors)


def test_validate_telemetry_flags_non_int_tokens():
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["tokens"]["input_uncached"] = 1.5
    errors = validate_telemetry(t)
    assert any("input_uncached" in e for e in errors)


def test_validate_telemetry_accepts_by_model_dict_or_int():
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["tokens"]["by_model"] = {
        "opus": 1200,
        "sonnet": {"input": 500, "output": 800, "cache_hit": 100},
    }
    assert validate_telemetry(t) == []


def test_by_model_negative_value_message_points_at_value_not_key():
    """A negative sub-value error must name the value, not blame the key.

    Regression for the merged-check error message that read "must be a
    non-negative integer keyed by string" even when the key was already
    a valid string. Now value failures cite the value; key failures cite
    the key.
    """
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["tokens"]["by_model"] = {"claude": {"output": -1}}
    errors = validate_telemetry(t)
    assert len(errors) == 1
    err = errors[0]
    assert "by_model['claude']['output']" in err
    assert "must be a non-negative integer" in err
    # Must NOT misattribute to a key-type problem.
    assert "keyed by string" not in err
    assert "sub-keys must be strings" not in err


def test_by_model_non_string_subkey_message_points_at_key():
    """A non-string sub-key error must cite the bad sub-key value."""
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["tokens"]["by_model"] = {"claude": {42: 100}}
    errors = validate_telemetry(t)
    assert len(errors) == 1
    err = errors[0]
    assert "by_model['claude']" in err
    assert "sub-keys must be strings" in err
    assert "42" in err  # the offending key surfaces in the message


def test_validate_telemetry_flags_cache_hit_rate_out_of_range():
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["cache_hit_rate"] = {"bha": 1.5}
    errors = validate_telemetry(t)
    assert any("cache_hit_rate" in e and "[0, 1]" in e for e in errors)


def test_validate_telemetry_accepts_known_namespaces():
    from code_review_schema import CACHE_NAMESPACES, empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["cache_hit_rate"] = dict.fromkeys(CACHE_NAMESPACES, 0.5)
    assert validate_telemetry(t) == []


def test_validate_telemetry_accepts_unknown_keys():
    """Forward-compat: extra keys are permitted."""
    from code_review_schema import empty_telemetry, validate_telemetry
    t = empty_telemetry()
    t["future_metric"] = {"some": "thing"}
    assert validate_telemetry(t) == []


def test_validate_result_envelope_includes_telemetry_errors():
    """A malformed telemetry block must surface through envelope validation."""
    from code_review_schema import validate_result_envelope
    env = _minimal_envelope()
    env["telemetry"]["duration_ms"] = -42
    errors = validate_result_envelope(env)
    assert any("telemetry.duration_ms" in e for e in errors)


def test_merge_telemetry_deep_merges_known_objects():
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    overlay = {
        "duration_ms": 1234,
        "duration_by_stage_ms": {"stage_05_parse_diff": 18},
        "tokens": {"input_uncached": 4200, "output": 980},
        "cache_hit_rate": {"bha": 0.62},
    }
    merged = merge_telemetry(base, overlay)
    assert merged["duration_ms"] == 1234
    assert merged["duration_by_stage_ms"] == {"stage_05_parse_diff": 18}
    # tokens.input_uncached is set, but tokens.input_cached survives from base.
    assert merged["tokens"]["input_uncached"] == 4200
    assert merged["tokens"]["input_cached"] == 0
    assert merged["tokens"]["output"] == 980
    assert merged["cache_hit_rate"] == {"bha": 0.62}


def test_telemetry_deep_merge_keys_match_empty_telemetry_dict_fields():
    """The whitelist must enumerate every dict-typed field in empty_telemetry().

    Any divergence is a documentation/contract bug: either a new dict
    field shipped without considering merge semantics, or a key was
    added/removed from the whitelist without updating the factory.
    """
    from code_review_schema import TELEMETRY_DEEP_MERGE_KEYS, empty_telemetry
    base = empty_telemetry()
    dict_fields = {k for k, v in base.items() if isinstance(v, dict)}
    assert dict_fields == TELEMETRY_DEEP_MERGE_KEYS, (
        f"empty_telemetry() dict fields {sorted(dict_fields)} != "
        f"TELEMETRY_DEEP_MERGE_KEYS {sorted(TELEMETRY_DEEP_MERGE_KEYS)} — "
        "update one to match the other."
    )


def test_merge_telemetry_replaces_unknown_dict_keys_wholesale():
    """A dict-typed key not in TELEMETRY_DEEP_MERGE_KEYS is overwritten.

    This is the regression for the merge_telemetry behavior gap: previously
    any dict-in-both-base-and-overlay key got one-level merge regardless of
    whether the schema intended it. Now non-whitelisted dict keys take the
    overlay's value verbatim, which is the safe default for forward-compat
    fields (e.g. a versioned config block where partial overrides could
    corrupt the document).
    """
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    base["future_config"] = {"version": 1, "flags": {"a": True, "b": False}}
    overlay = {"future_config": {"version": 2}}
    merged = merge_telemetry(base, overlay)
    # The whole future_config block is replaced; "flags" does NOT survive.
    assert merged["future_config"] == {"version": 2}
    assert "flags" not in merged["future_config"]


def test_merge_telemetry_overlay_dict_replaces_scalar_base():
    """A scalar base + dict overlay still results in straight overwrite."""
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    # duration_ms is a number in the canonical schema; an overlay that
    # supplies a dict here is malformed, but merge must not crash.
    overlay = {"duration_ms": {"unexpected": "shape"}}
    merged = merge_telemetry(base, overlay)
    assert merged["duration_ms"] == {"unexpected": "shape"}


def test_telemetry_json_schema_declares_required_keys():
    """The exported JSON Schema lists telemetry as a typed object with required keys."""
    from code_review_schema import result_envelope_json_schema
    schema = result_envelope_json_schema()
    tele = schema["properties"]["telemetry"]
    assert tele["type"] == "object"
    for key in (
        "duration_ms", "duration_by_stage_ms", "estimated_cost_usd",
        "tokens", "cache_hit_rate", "agent_failures", "schema_versions_seen",
    ):
        assert key in tele["required"], f"telemetry JSON Schema missing required {key!r}"
