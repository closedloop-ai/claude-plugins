#!/usr/bin/env python3
"""Tests for code_review_schema.py (PLN-719 Phase 1)."""

from __future__ import annotations

import json

import pytest

from code_review_schema import (
    CATEGORIES,
    EXTERNAL_IMPACT_DISCOVERY,
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


def test_schema_version_is_two():
    # v2 retired the Premise finding category when the premise reviewer
    # was removed.
    assert SCHEMA_VERSION == 2


def test_finding_scopes():
    assert FINDING_SCOPES == frozenset({"diff", "system", "pr_metadata"})


def test_severities():
    assert SEVERITIES == frozenset({"BLOCKING", "HIGH", "MEDIUM"})


def test_categories_include_canonical_and_legacy_alias():
    assert "Hygiene" in CATEGORIES
    assert "Repo Hygiene" in CATEGORIES  # legacy alias retained
    assert "Coverage" in CATEGORIES


def test_premise_category_retired():
    # v2: the premise reviewer was removed; no producer emits Premise, so
    # it is no longer a valid category (the validator rejects it).
    assert "Premise" not in CATEGORIES


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


def test_priorities_include_p3():
    """The shared reviewer prompt (tools/prompts/shared_prompt.txt §"SEVERITY
    + PRIORITY") explicitly teaches a P3 tier ("MEDIUM (P3): Suggestions,
    nice-to-haves"). Excluding ``3`` from PRIORITIES would force every
    reviewer following the documented tiers to misclassify nice-to-haves as
    P2 or have their findings rejected by finalize-result's validator. The
    schema must accept every priority the prompt teaches.
    """
    from code_review_schema import PRIORITIES

    assert PRIORITIES == frozenset({0, 1, 2, 3}), (
        f"PRIORITIES must mirror the P0/P1/P2/P3 tiers in shared_prompt.txt; "
        f"got {sorted(PRIORITIES)}"
    )


def test_p3_finding_passes_validation():
    """A reviewer emitting ``priority: 3`` (matching the prompt's P3 tier)
    must validate end-to-end and land in the verified[] bucket of the
    envelope without producing schema errors."""
    f = _minimal_diff_finding(
        category="Code Quality",
        severity="MEDIUM",
        priority=3,
        issue="Consider extracting this into a hook for clarity",
    )
    assert validate_finding(f) == []
    env = _minimal_envelope(verified=[f])
    assert validate_result_envelope(env) == []


def test_shared_prompt_enumerates_every_canonical_category():
    """The shared reviewer prompt must explicitly enumerate every canonical
    CATEGORIES value in its <output_format> section so reviewers pick from
    the documented list instead of inventing categories like "Code Style" or
    "API Validation" that the schema validator rejects. This guards against
    schema ↔ prompt drift in both directions:

    - If a category is added to CATEGORIES without updating the prompt,
      reviewers won't know it exists.
    - If a category is removed from CATEGORIES without updating the prompt,
      reviewers will keep emitting it and trigger validation errors.
    """
    from pathlib import Path

    prompt_path = (
        Path(__file__).parent.parent / "prompts" / "shared_prompt.txt"
    )
    prompt_text = prompt_path.read_text()

    # The category list appears in the <output_format> section as a bulleted
    # list. We only assert each canonical category appears in the file at
    # least once — exact formatting drift (bullet markers, alignment) is
    # tolerated.
    missing = [c for c in CATEGORIES if c not in prompt_text]
    assert not missing, (
        f"shared_prompt.txt does not enumerate these canonical CATEGORIES: "
        f"{missing}. Reviewers see the prompt but not code_review_schema.py, "
        f"so any category missing from the prompt becomes invented output "
        f"that finalize-result rejects. Add the missing entries to the "
        f"<output_format> section's category list."
    )

    # And conversely: every category mentioned in the prompt's category
    # list must be in CATEGORIES (catches typos and reviewer-invented
    # categories from being smuggled into the prompt without schema
    # support).
    import re

    # Match lines like '  - Correctness        — ...' or '  - "Code Quality" ...'
    bullet_pattern = re.compile(
        r"^\s*-\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b", re.MULTILINE,
    )
    in_output_format = prompt_text.split("<output_format>", 1)[1].split(
        "</output_format>", 1,
    )[0]
    bullet_categories = set(bullet_pattern.findall(in_output_format))

    # Filter to candidates that look like enum entries (capitalized words).
    # The bullets in the category list start with a capitalized category
    # name followed by an em-dash description.
    extra = bullet_categories - CATEGORIES
    # Filter out matches that are not actually in the canonical category
    # list block (e.g. "Add" from "Add detailed documentation"). We accept
    # the test if every non-canonical capitalized token is well-known prose.
    PROSE_ALLOWLIST = {
        "Brief", "Add", "Read", "Use", "Write", "Cite",
        "Standard", "Severity", "DRY", "Output", "Match",
    }
    extra = {e for e in extra if e not in PROSE_ALLOWLIST}
    assert not extra, (
        f"shared_prompt.txt mentions these capitalized category-like tokens "
        f"in <output_format> that are NOT in CATEGORIES: {sorted(extra)}. "
        f"Either add them to CATEGORIES or rewrite the prompt so reviewers "
        f"don't read them as valid categories."
    )


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


def test_verifier_verdicts_include_re_asserted():
    """PLN-773: RE_ASSERTED is a canonical verdict — overridden findings live
    in verified[] with this verdict so they're visible in the envelope and
    distinguishable from CONFIRMED."""
    from code_review_schema import VERIFIER_VERDICTS
    assert "RE_ASSERTED" in VERIFIER_VERDICTS


def test_envelope_accepts_re_asserted_verifier_verdict():
    """A finding with verifier_verdict='RE_ASSERTED' in verified[] passes
    schema validation. The override flow promotes from rejected[] back to
    verified[] with this verdict; the envelope validator must allow it."""
    finding = _minimal_diff_finding()
    finding["verifier_verdict"] = "RE_ASSERTED"
    env = _minimal_envelope(verified=[finding])
    assert validate_result_envelope(env) == []


def test_envelope_accepts_verification_stats_sub_block():
    """PLN-773: the envelope `stats` field accepts the verification telemetry
    sub-block additively — the `justified_valid_count` / `justified_invalid_count`
    tallies plus per-reviewer FP rate (`by_reviewer`), as emitted by
    `_stats_from_findings`. (The earlier premise-scoped `justification` and
    `by_subcategory` sub-blocks were removed with the Premise category, so no
    pipeline stage emits them anymore.)"""
    env = _minimal_envelope()
    env["stats"] = {
        "verification": {
            "justified_valid_count": 2,
            "justified_invalid_count": 1,
            "by_reviewer": {
                "bug_hunter_a": {
                    "verified": 12, "rejected": 3,
                    "fp_rate": 0.20, "re_asserted": 0,
                },
            },
        },
    }
    assert validate_result_envelope(env) == []


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
# Cache namespaces + TTLs (PLN-719 Phase 7 / Section 9)
# ---------------------------------------------------------------------------


def test_cache_ttl_days_matches_pln719_section_9():
    """The canonical TTLs from PLN-719 Section 9.

    BHA: 30d, signals: 7d, coverage_critic: 7d, verifications: 30d,
    overrides: 90d. Any drift between this test and the plan is a
    documentation/schema bug.
    """
    from code_review_schema import CACHE_TTL_DAYS
    assert CACHE_TTL_DAYS == {
        "bha": 30,
        "signals": 7,
        "coverage_critic": 7,
        "verifications": 30,
        "overrides": 90,
    }


def test_cache_ttl_days_covers_every_namespace():
    """Every namespace in CACHE_NAMESPACES has a declared TTL."""
    from code_review_schema import CACHE_NAMESPACES, CACHE_TTL_DAYS
    assert set(CACHE_TTL_DAYS) == set(CACHE_NAMESPACES)


def test_cache_ttl_days_helper():
    from code_review_schema import cache_ttl_days
    assert cache_ttl_days("bha") == 30
    assert cache_ttl_days("overrides") == 90
    assert cache_ttl_days("future-namespace") is None


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


def test_merge_telemetry_preserves_whitelisted_dict_on_null_overlay():
    """Overlay supplying null for a whitelisted dict field is ignored.

    Regression for a finalize-result crash: when telemetry.json contains
    ``{"cache_hit_rate": null}`` (a producer signaling "no data"), the
    previous merge logic overwrote the base dict with None. The next
    writer in finalize-result then did
    ``block["cache_hit_rate"][NAMESPACE] = rate`` and crashed with
    ``TypeError: 'NoneType' object does not support item assignment``.
    Now the whitelist contract is preserved: the base dict survives.
    """
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    # Seed the base with a value so we can verify it survives.
    base["cache_hit_rate"] = {"signals": 0.5}
    merged = merge_telemetry(base, {"cache_hit_rate": None})
    assert merged["cache_hit_rate"] == {"signals": 0.5}


def test_merge_telemetry_preserves_whitelisted_dict_on_scalar_overlay():
    """Same invariant for other scalar shapes (int, str, list)."""
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    base["tokens"] = {
        "input_uncached": 100, "input_cached": 0, "output": 0, "by_model": {},
    }
    for malformed in (0, "garbage", [1, 2, 3], False):
        merged = merge_telemetry(base, {"tokens": malformed})
        assert isinstance(merged["tokens"], dict), (
            f"tokens type invariant broken by overlay value {malformed!r}"
        )
        assert merged["tokens"]["input_uncached"] == 100


def test_merge_telemetry_non_whitelisted_key_still_replaces_on_non_dict():
    """The whitelist guard is scoped to whitelisted keys.

    Non-whitelisted keys retain wholesale-replace semantics for any value,
    including non-dict overlays — they don't have a type invariant to
    preserve.
    """
    from code_review_schema import empty_telemetry, merge_telemetry
    base = empty_telemetry()
    base["future_config"] = {"version": 1}
    # Non-whitelisted key + non-dict overlay → replace.
    merged = merge_telemetry(base, {"future_config": None})
    assert merged["future_config"] is None


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


# ---------------------------------------------------------------------------
# external_impact[].discovery provenance (FEA-1401 graph integration)
# ---------------------------------------------------------------------------


def _impact_finding_with_impacts(*impacts: dict) -> dict:
    f = _minimal_diff_finding(
        id="impact_f0",
        reviewer="impact",
        category="ImpactAnalysis",
        severity="HIGH",
    )
    f["external_impact"] = list(impacts)
    f["grep_query_used"] = r"\bgetUser\s*\("
    return f


def _impact_entry(discovery: str | None) -> dict:
    entry = {
        "file": "src/handlers/userHandler.ts",
        "line": 18,
        "impact_type": "signature_mismatch",
        "description": "one-arg call breaks under new required param",
        "callsite_snippet": "getUser(req.params.id)",
        "confidence": 0.95,
    }
    if discovery is not None:
        entry["discovery"] = discovery
    return entry


def test_external_impact_discovery_vocabulary():
    # The closed vocabulary the verifier's substrate-aware audit keys on.
    assert EXTERNAL_IMPACT_DISCOVERY == {"grep", "graph"}


def test_external_impact_discovery_grep_valid():
    f = _impact_finding_with_impacts(_impact_entry("grep"))
    assert validate_finding(f) == []


def test_external_impact_discovery_graph_valid():
    f = _impact_finding_with_impacts(_impact_entry("graph"))
    assert validate_finding(f) == []


def test_external_impact_discovery_omitted_valid():
    # discovery is optional; absence means the default ("grep").
    f = _impact_finding_with_impacts(_impact_entry(None))
    assert validate_finding(f) == []


def test_external_impact_discovery_invalid_rejected():
    f = _impact_finding_with_impacts(_impact_entry("ast"))
    errors = validate_finding(f)
    assert any("discovery" in e and "ast" in e for e in errors), errors


def test_external_impact_discovery_mixed_substrates_valid():
    f = _impact_finding_with_impacts(
        _impact_entry("grep"), _impact_entry("graph"),
    )
    assert validate_finding(f) == []


def _impact_entry_with_file(file: str) -> dict:
    entry = _impact_entry("graph")
    entry["file"] = file
    return entry


def test_external_impact_repo_relative_path_valid():
    f = _impact_finding_with_impacts(
        _impact_entry_with_file("src/handlers/userHandler.ts"),
    )
    assert validate_finding(f) == []


@pytest.mark.parametrize(
    "bad_path",
    [
        "/etc/passwd",                 # absolute POSIX
        "../../.env",                  # parent traversal
        "src/../../secrets.py",        # embedded traversal
        "C:/Users/x/secret.txt",       # Windows drive letter
        r"C:\Users\x\secret.txt",      # Windows drive + backslashes
        "..",                          # bare parent
    ],
)
def test_external_impact_unsafe_path_rejected(bad_path: str):
    # The graph substrate can introduce out-of-checkout paths; the
    # deterministic gate must reject them before the verifier's per-callsite
    # audit Reads them verbatim.
    f = _impact_finding_with_impacts(_impact_entry_with_file(bad_path))
    errors = validate_finding(f)
    assert any("safe repo-relative path" in e for e in errors), (bad_path, errors)


def test_external_impact_unsafe_path_does_not_block_safe_sibling():
    # Each entry is gated independently — one bad path errors without
    # suppressing validation of the good entries.
    f = _impact_finding_with_impacts(
        _impact_entry_with_file("src/a.ts"),
        _impact_entry_with_file("/etc/passwd"),
    )
    errors = validate_finding(f)
    assert any("external_impact[1].file" in e for e in errors), errors
    assert not any("external_impact[0].file" in e for e in errors), errors
