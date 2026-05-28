#!/usr/bin/env python3
"""
Code Review Canonical Schema

Defines the canonical Finding + ResultEnvelope schema (PLN-719 Foundation).

This module is the single source of truth for:
  - Schema version constant (SCHEMA_VERSION)
  - Allowed values for finding_scope, severity, category, system_marker
  - Finding ID format and assignment
  - Producer-side validators for findings and the result envelope
  - JSON Schema dicts (for documentation + machine validation)

The dataclasses below are convenience types for Python callers. The wire
format is JSON; producers may emit dicts directly and the validators check
schema conformance.

Plan reference: .closedloop-ai/plan-docs/00-foundation.md sections 1-4.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------

SCHEMA_VERSION = 1
"""Integer schema version for Finding + ResultEnvelope. Bumped on breaking
changes per section 12 of the foundation plan."""


# ---------------------------------------------------------------------------
# Enums (literal sets)
# ---------------------------------------------------------------------------

FINDING_SCOPES: frozenset[str] = frozenset({"diff", "system", "pr_metadata"})

SEVERITIES: frozenset[str] = frozenset({"BLOCKING", "HIGH", "MEDIUM"})

PRIORITIES: frozenset[int] = frozenset({0, 1, 2})

# Categories — section 1 of the plan. Includes legacy "Repo Hygiene" as an
# accepted alias so the hygiene helper can keep its historical category
# string until plan 04 / Phase D rewrites it.
CATEGORIES: frozenset[str] = frozenset({
    "Correctness",
    "Hygiene",
    "Repo Hygiene",
    "Premise",
    "ImpactAnalysis",
    "TestQuality",
    "Coverage",
    "InjectionAttempt",
    "CompanionChange",
    "Security",
})

# Reviewer triggers — section 1 of the plan.
REVIEWER_TRIGGERS: frozenset[str] = frozenset({
    "core",
    "always",
    "extension",
    "path_pattern",
    "content_signal",
    "change_class",
    "signal",
    "partition",
})

SOURCES: frozenset[str] = frozenset({
    "agent",
    "hygiene",
    "injection-detector",
    "companion-validator",
    "coverage-verifier",
})

VERDICTS: frozenset[str] = frozenset({
    "APPROVED",
    "NEEDS_ATTENTION",
    "CHANGES_REQUESTED",
})

VERIFIER_VERDICTS: frozenset[str] = frozenset({
    "CONFIRMED",
    "DOWNGRADE",
    "TENTATIVE",
    "REJECTED",
    "JUSTIFIED-VALID",
    "JUSTIFIED-INVALID",
})

REASONING_CERTIFICATE_KINDS: frozenset[str] = frozenset({
    "necessity",
    "cohesion",
    "workaround",
    "complexity",
    "impact",
    "test_quality",
    "sibling_pattern",
    "bha",
    "bhb",
    "auditor",
})


# ---------------------------------------------------------------------------
# Determinism tiers (PLN-719 Section 8)
# ---------------------------------------------------------------------------
#
# Required-coverage policy follows from these tiers:
#   - deterministic        : same inputs → same outputs, no model involved.
#                            Required reviewers may depend on these.
#   - reproducible_via_cache : same inputs → same outputs *if cache hit*;
#                              otherwise LLM-driven. Required reviewers may
#                              use these only as additive evidence.
#   - llm_driven           : same inputs may produce different outputs.
#                            Required-reviewer selection cannot depend on
#                            llm_driven outputs.
DETERMINISM_TIER_DETERMINISTIC = "deterministic"
DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE = "reproducible_via_cache"
DETERMINISM_TIER_LLM_DRIVEN = "llm_driven"

DETERMINISM_TIERS: frozenset[str] = frozenset({
    DETERMINISM_TIER_DETERMINISTIC,
    DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
    DETERMINISM_TIER_LLM_DRIVEN,
})

# Pipeline stage → determinism tier. Foundation owns this mapping; plan 05's
# signal taxonomy and plan 03's verifier add additional entries when they ship.
STAGE_DETERMINISM_TIERS: dict[str, str] = {
    "setup": DETERMINISM_TIER_DETERMINISTIC,
    "prep-assets": DETERMINISM_TIER_DETERMINISTIC,
    "resolve-scope": DETERMINISM_TIER_DETERMINISTIC,
    "finalize-cache": DETERMINISM_TIER_DETERMINISTIC,
    "parse-diff": DETERMINISM_TIER_DETERMINISTIC,
    "extract-patches": DETERMINISM_TIER_DETERMINISTIC,
    "auto-incremental": DETERMINISM_TIER_DETERMINISTIC,
    "fetch-intent": DETERMINISM_TIER_DETERMINISTIC,
    "classify-intent": DETERMINISM_TIER_DETERMINISTIC,
    "hygiene": DETERMINISM_TIER_DETERMINISTIC,
    "validate-companions": DETERMINISM_TIER_DETERMINISTIC,
    "arbitrate-budget": DETERMINISM_TIER_DETERMINISTIC,
    "partition": DETERMINISM_TIER_DETERMINISTIC,
    "compute-hashes": DETERMINISM_TIER_DETERMINISTIC,
    "cache-check": DETERMINISM_TIER_DETERMINISTIC,
    "collect-findings": DETERMINISM_TIER_DETERMINISTIC,
    "validate": DETERMINISM_TIER_DETERMINISTIC,
    "finalize-result": DETERMINISM_TIER_DETERMINISTIC,
    "cache-update": DETERMINISM_TIER_DETERMINISTIC,
    "review-state-write": DETERMINISM_TIER_DETERMINISTIC,
    "verdict": DETERMINISM_TIER_DETERMINISTIC,
    "footer": DETERMINISM_TIER_DETERMINISTIC,
    # Plan 05's LLM-extracted signals.
    "extract-signals": DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
    "coverage-critic": DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
    # Plan 03 verifier.
    "verify-findings": DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
    "verify-coverage": DETERMINISM_TIER_REPRODUCIBLE_VIA_CACHE,
    # Plan 01 injection detection — LLM-driven on raw text.
    "detect-injection": DETERMINISM_TIER_LLM_DRIVEN,
    # All reviewer agents (bha/bhb/auditor/premise/test_quality/impact) are
    # LLM-driven; tracked by agent_id rather than by subcommand.
}


def stage_determinism_tier(subcommand: str) -> str | None:
    """Return the determinism tier for a known pipeline subcommand, or None."""
    return STAGE_DETERMINISM_TIERS.get(subcommand)


def is_deterministic_stage(subcommand: str) -> bool:
    """True iff the stage is in the deterministic tier."""
    return stage_determinism_tier(subcommand) == DETERMINISM_TIER_DETERMINISTIC


# ---------------------------------------------------------------------------
# Cache namespaces (PLN-719 Section 9)
# ---------------------------------------------------------------------------
# Five canonical namespaces. Each namespace has an independent prompt_hash
# domain and an independent hit-rate metric in telemetry.cache_hit_rate.
CACHE_NAMESPACE_BHA = "bha"
CACHE_NAMESPACE_SIGNALS = "signals"
CACHE_NAMESPACE_COVERAGE_CRITIC = "coverage_critic"
CACHE_NAMESPACE_VERIFICATIONS = "verifications"
CACHE_NAMESPACE_OVERRIDES = "overrides"

CACHE_NAMESPACES: frozenset[str] = frozenset({
    CACHE_NAMESPACE_BHA,
    CACHE_NAMESPACE_SIGNALS,
    CACHE_NAMESPACE_COVERAGE_CRITIC,
    CACHE_NAMESPACE_VERIFICATIONS,
    CACHE_NAMESPACE_OVERRIDES,
})


# ---------------------------------------------------------------------------
# Telemetry (PLN-719 Phase 9 / Section 11)
# ---------------------------------------------------------------------------
# The telemetry block is the single per-run metrics surface, embedded in
# `review_result.json.telemetry`. The schema is forward-compatible: producers
# may add new fields, but the canonical keys below must be present with
# correct types. The orchestrator (or any helper that wraps a stage) is the
# expected producer; finalize-result aggregates everything into the envelope.


def empty_telemetry() -> dict[str, Any]:
    """Return a zero-valued telemetry block conforming to the canonical schema.

    Used as the base by finalize-result; any ``<cr_dir>/telemetry.json``
    produced by upstream stages is deep-merged over these defaults.
    """
    return {
        "duration_ms": 0,
        "duration_by_stage_ms": {},
        "estimated_cost_usd": 0.0,
        "tokens": {
            "input_uncached": 0,
            "input_cached": 0,
            "output": 0,
            "by_model": {},
        },
        "cache_hit_rate": {},
        "agent_failures": 0,
        "schema_versions_seen": {
            "finding": SCHEMA_VERSION,
            "result": SCHEMA_VERSION,
        },
        "findings_counts": {},
        "verification_stats": {},
        "coverage_stats": {},
    }


def _is_nonneg_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0


def _is_nonneg_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _validate_nonneg_number_map(
    field: str, value: Any, *, value_kind: str = "number",
) -> list[str]:
    """Validate ``{str: non-negative number}`` and return prefixed errors."""
    if not isinstance(value, dict):
        return [f"telemetry.{field} must be an object"]
    out: list[str] = []
    checker = _is_nonneg_number if value_kind == "number" else _is_nonneg_int
    for k, v in value.items():
        if not isinstance(k, str):
            out.append(f"telemetry.{field} keys must be strings")
            break
        if not checker(v):
            out.append(f"telemetry.{field}[{k!r}] must be a non-negative {value_kind}")
    return out


def _validate_tokens_by_model(by_model: Any) -> list[str]:
    if not isinstance(by_model, dict):
        return ["telemetry.tokens.by_model must be an object"]
    out: list[str] = []
    for mk, mv in by_model.items():
        if not isinstance(mk, str):
            out.append("telemetry.tokens.by_model keys must be strings")
            break
        if isinstance(mv, dict):
            out.extend(
                f"telemetry.tokens.by_model[{mk!r}][{sk!r}] must be "
                "a non-negative integer keyed by string"
                for sk, sv in mv.items()
                if not isinstance(sk, str) or not _is_nonneg_int(sv)
            )
        elif not _is_nonneg_int(mv):
            out.append(
                f"telemetry.tokens.by_model[{mk!r}] must be a non-negative "
                "integer or per-key object",
            )
    return out


def _validate_tokens(tokens: Any) -> list[str]:
    if not isinstance(tokens, dict):
        return ["telemetry.tokens must be an object"]
    out = [
        f"telemetry.tokens.{key} must be a non-negative integer"
        for key in ("input_uncached", "input_cached", "output")
        if not _is_nonneg_int(tokens.get(key))
    ]
    out.extend(_validate_tokens_by_model(tokens.get("by_model")))
    return out


def _validate_cache_hit_rate(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ["telemetry.cache_hit_rate must be an object"]
    out: list[str] = []
    for ns, rate in value.items():
        if not isinstance(ns, str):
            out.append("telemetry.cache_hit_rate keys must be strings")
            break
        if not isinstance(rate, (int, float)) or isinstance(rate, bool):
            out.append(f"telemetry.cache_hit_rate[{ns!r}] must be a number in [0, 1]")
        elif rate < 0 or rate > 1:
            out.append(f"telemetry.cache_hit_rate[{ns!r}] must be in [0, 1]")
    return out


def _validate_schema_versions_seen(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ["telemetry.schema_versions_seen must be an object"]
    return [
        f"telemetry.schema_versions_seen[{k!r}] must be int keyed by string"
        for k, v in value.items()
        if not isinstance(k, str) or not isinstance(v, int) or isinstance(v, bool)
    ]


def validate_telemetry(telemetry: Any) -> list[str]:
    """Return list of validation errors for a telemetry block.

    The required keys mirror ``empty_telemetry()`` so any envelope produced
    by ``finalize-result`` is valid by construction. Unknown keys are
    permitted (forward-compat); known keys must have the correct type and
    non-negative numeric values where applicable.
    """
    if not isinstance(telemetry, dict):
        return ["telemetry must be an object"]

    errors: list[str] = []

    if not _is_nonneg_number(telemetry.get("duration_ms")):
        errors.append("telemetry.duration_ms must be a non-negative number")
    errors.extend(_validate_nonneg_number_map(
        "duration_by_stage_ms", telemetry.get("duration_by_stage_ms"),
    ))
    if not _is_nonneg_number(telemetry.get("estimated_cost_usd")):
        errors.append("telemetry.estimated_cost_usd must be a non-negative number")
    errors.extend(_validate_tokens(telemetry.get("tokens")))
    errors.extend(_validate_cache_hit_rate(telemetry.get("cache_hit_rate")))
    if not _is_nonneg_int(telemetry.get("agent_failures")):
        errors.append("telemetry.agent_failures must be a non-negative integer")
    errors.extend(_validate_schema_versions_seen(telemetry.get("schema_versions_seen")))

    for opt in ("findings_counts", "verification_stats", "coverage_stats"):
        if opt in telemetry and not isinstance(telemetry[opt], dict):
            errors.append(f"telemetry.{opt} must be an object when present")

    return errors


def merge_telemetry(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge ``overlay`` into ``base`` for telemetry fields.

    Used by finalize-result: ``base`` is ``empty_telemetry()``, ``overlay`` is
    the contents of ``<cr_dir>/telemetry.json`` written by the orchestrator
    (or any upstream stage). For known nested objects we recurse one level
    so callers can populate ``tokens.input_uncached`` without overriding the
    whole ``tokens`` block; everything else is a straight overwrite.
    """
    out = {k: (dict(v) if isinstance(v, dict) else v) for k, v in base.items()}
    for k, v in overlay.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            merged = dict(out[k])
            for sk, sv in v.items():
                merged[sk] = sv
            out[k] = merged
        else:
            out[k] = v
    return out


# ---------------------------------------------------------------------------
# system_marker canonical enum (section 3 of the plan)
# ---------------------------------------------------------------------------

# Exact, non-templated system markers.
SYSTEM_MARKERS_FIXED: frozenset[str] = frozenset({
    # system category
    "budget-exceeded",
    "agent-failure",
    "signal-extraction-failed",
    "schema-version",
    # pr_metadata category
    "pr_description",
})

# Templated markers: prefix + ":" + non-empty suffix.
# Example: "coverage:database-architect", "commit:abc1234".
SYSTEM_MARKER_TEMPLATES: dict[str, str] = {
    "coverage": "system",       # coverage:{reviewer-name}
    "commit": "pr_metadata",    # commit:{sha}
}

# Map of fixed marker -> finding_scope it belongs in.
SYSTEM_MARKER_SCOPES: dict[str, str] = {
    "budget-exceeded": "system",
    "agent-failure": "system",
    "signal-extraction-failed": "system",
    "schema-version": "system",
    "pr_description": "pr_metadata",
}

_TEMPLATE_RE = re.compile(r"^([a-z][a-z0-9_-]*):(.+)$")


def parse_system_marker(marker: str) -> tuple[str | None, str | None]:
    """Return (prefix, suffix) for templated markers, else (None, None).

    Examples:
        parse_system_marker("coverage:database-architect") -> ("coverage", "database-architect")
        parse_system_marker("budget-exceeded") -> (None, None)
    """
    match = _TEMPLATE_RE.match(marker)
    if match:
        return match.group(1), match.group(2)
    return None, None


def system_marker_scope(marker: str) -> str | None:
    """Return the expected finding_scope for a system_marker, or None if unknown."""
    if marker in SYSTEM_MARKERS_FIXED:
        return SYSTEM_MARKER_SCOPES[marker]
    prefix, suffix = parse_system_marker(marker)
    if prefix and suffix and prefix in SYSTEM_MARKER_TEMPLATES:
        return SYSTEM_MARKER_TEMPLATES[prefix]
    return None


def is_valid_system_marker(marker: str) -> bool:
    """Check whether `marker` is one of the canonical system_marker values."""
    return system_marker_scope(marker) is not None


# ---------------------------------------------------------------------------
# Finding ID generation
# ---------------------------------------------------------------------------

_FINDING_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*_f\d+$")


def make_finding_id(reviewer_id: str, index: int) -> str:
    """Construct a deterministic finding id: '<reviewer_id>_f<index>'.

    See section 4 of the foundation plan. The id is stable across re-runs of
    the same reviewer on the same input.
    """
    if not reviewer_id:
        raise ValueError("reviewer_id is required")
    if index < 0:
        raise ValueError("index must be >= 0")
    if not re.match(r"^[a-z][a-z0-9_-]*$", reviewer_id):
        raise ValueError(
            f"reviewer_id must match [a-z][a-z0-9_-]*; got {reviewer_id!r}",
        )
    return f"{reviewer_id}_f{index}"


def is_valid_finding_id(value: str) -> bool:
    """Check whether `value` is a well-formed finding id."""
    return bool(_FINDING_ID_RE.match(value))


# ---------------------------------------------------------------------------
# Dataclasses (typed convenience views; producers may emit dicts directly)
# ---------------------------------------------------------------------------


@dataclass
class ReviewerTrigger:
    type: str
    evidence: str | None = None


@dataclass
class Evidence:
    file: str
    line: int
    claim: str
    snippet_hash: str


@dataclass
class ReasoningCertificate:
    kind: str
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass
class Justification:
    text: str
    source: str
    addresses_specific_concern: bool
    claimed_by_reviewer: str


@dataclass
class ExternalImpact:
    file: str
    line: int
    impact_type: str
    description: str
    callsite_snippet: str
    callsite_snippet_hash: str
    confidence: float


@dataclass
class EvidenceCheck:
    claim: str
    verified: bool
    actual_read: str
    snippet_hash_matched: bool


@dataclass
class OtherLocation:
    file: str
    line: int
    issue: str = ""


@dataclass
class CanonicalFinding:
    """Typed view of a canonical finding (section 1 of the foundation plan).

    Producers may emit this as a dict; see `to_dict` / `from_dict`.
    """
    id: str
    reviewer: str
    reviewer_trigger: ReviewerTrigger
    source: str
    emitted_at: str
    finding_scope: Literal["diff", "system", "pr_metadata"]
    category: str
    severity: str
    priority: int
    confidence: float
    issue: str
    explanation: str
    recommendation: str
    code_snippet: str

    # Anchor (depends on finding_scope)
    file: str | None = None
    line: int | None = None
    system_marker: str | None = None

    # Classification
    subcategory: str | None = None

    # Structured evidence
    evidence: list[Evidence] = field(default_factory=list)

    # Reasoning certificate
    reasoning_certificate: ReasoningCertificate | None = None

    # Justification (plan 02)
    justified: bool = False
    justification: Justification | None = None

    # External impact (plan 06)
    external_impact: list[ExternalImpact] = field(default_factory=list)
    grep_query_used: str | None = None

    # Verifier state (plan 03 populates)
    verifier_verdict: str | None = None
    verifier_severity: str | None = None
    verifier_confidence: float | None = None
    verifier_reasoning: str | None = None
    verifier_model: str | None = None
    verification_duration_ms: int | None = None
    evidence_checks: list[EvidenceCheck] = field(default_factory=list)
    rejection_class: str | None = None
    human_review_recommended: bool = False

    # Cross-file grouping
    other_locations: list[OtherLocation] = field(default_factory=list)

    # Schema version (per-finding, complements envelope version)
    schema_version: int = SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Producer-side validators
# ---------------------------------------------------------------------------


def validate_finding(finding: dict[str, Any]) -> list[str]:
    """Return list of validation errors for a finding dict. Empty = valid.

    Performs producer-side validation against the canonical schema. Used by
    the `validate` and `finalize-result` subcommands.
    """
    errors: list[str] = []

    def _err(msg: str) -> None:
        errors.append(msg)

    # Schema version
    sv = finding.get("schema_version")
    if sv is None:
        _err("missing schema_version")
    elif not isinstance(sv, int):
        _err(f"schema_version must be int, got {type(sv).__name__}")

    # ID
    fid = finding.get("id")
    if not fid:
        _err("missing id")
    elif not isinstance(fid, str):
        _err(f"id must be str, got {type(fid).__name__}")
    elif not is_valid_finding_id(fid):
        _err(f"id {fid!r} does not match '<reviewer_id>_f<index>'")

    # Provenance
    reviewer = finding.get("reviewer")
    if not reviewer or not isinstance(reviewer, str):
        _err("missing or non-string reviewer")
    src = finding.get("source")
    if src not in SOURCES:
        _err(f"source {src!r} not in {sorted(SOURCES)}")
    trig = finding.get("reviewer_trigger")
    if not isinstance(trig, dict):
        _err("reviewer_trigger must be an object")
    else:
        ttype = trig.get("type")
        if ttype not in REVIEWER_TRIGGERS:
            _err(f"reviewer_trigger.type {ttype!r} not in {sorted(REVIEWER_TRIGGERS)}")

    if not finding.get("emitted_at"):
        _err("missing emitted_at")

    # Finding scope + anchor
    scope = finding.get("finding_scope")
    if scope not in FINDING_SCOPES:
        _err(f"finding_scope {scope!r} not in {sorted(FINDING_SCOPES)}")

    file_val = finding.get("file")
    marker = finding.get("system_marker")

    if scope == "diff":
        if not file_val or not isinstance(file_val, str):
            _err("diff-scoped finding requires non-empty string file")
        if marker is not None:
            _err("diff-scoped finding must not set system_marker")
    elif scope in ("system", "pr_metadata"):
        if file_val is not None:
            _err(f"{scope}-scoped finding must have file=null")
        if not marker:
            _err(f"{scope}-scoped finding requires system_marker")
        elif not is_valid_system_marker(marker):
            _err(f"system_marker {marker!r} is not in canonical enum")
        else:
            expected_scope = system_marker_scope(marker)
            if expected_scope != scope:
                _err(
                    f"system_marker {marker!r} belongs to scope "
                    f"{expected_scope!r}, not {scope!r}",
                )

    # Severity + priority + confidence
    sev = finding.get("severity")
    if sev not in SEVERITIES:
        _err(f"severity {sev!r} not in {sorted(SEVERITIES)}")
    pri = finding.get("priority")
    if pri not in PRIORITIES:
        _err(f"priority {pri!r} not in {sorted(PRIORITIES)}")
    conf = finding.get("confidence")
    if not isinstance(conf, (int, float)):
        _err(f"confidence must be number, got {type(conf).__name__}")
    elif not 0.0 <= float(conf) <= 1.0:
        _err(f"confidence {conf} out of range [0.0, 1.0]")

    # Category
    cat = finding.get("category")
    if cat not in CATEGORIES:
        _err(f"category {cat!r} not in {sorted(CATEGORIES)}")

    # Required content fields
    for content_field in ("issue", "explanation", "recommendation"):
        val = finding.get(content_field)
        if val is None or not isinstance(val, str):
            _err(f"missing or non-string {content_field}")

    # code_snippet may be empty (system-scoped findings)
    cs = finding.get("code_snippet")
    if cs is None:
        _err("missing code_snippet (use '' for system-scoped)")

    return errors


def _validate_envelope_scalars(envelope: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if not isinstance(envelope.get("schema_version"), int):
        out.append("envelope schema_version must be int")
    if not envelope.get("review_id"):
        out.append("missing review_id")
    if not envelope.get("diff_tip"):
        out.append("missing diff_tip")
    mode = envelope.get("mode")
    if mode not in ("local", "github"):
        out.append(f"mode {mode!r} must be 'local' or 'github'")
    intent = envelope.get("intent")
    if intent not in ("feature", "fix", "refactor", "mixed"):
        out.append(f"intent {intent!r} must be one of feature|fix|refactor|mixed")
    verdict = envelope.get("verdict")
    if verdict not in VERDICTS:
        out.append(f"verdict {verdict!r} not in {sorted(VERDICTS)}")
    return out


def _validate_envelope_buckets(envelope: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for bucket in ("verified", "justified", "rejected"):
        if bucket not in envelope:
            out.append(f"missing findings bucket {bucket!r}")
        elif not isinstance(envelope[bucket], list):
            out.append(f"{bucket} must be a list")
    pv = envelope.get("pending_verification")
    if "pending_verification" in envelope and not isinstance(pv, list):
        out.append("pending_verification must be a list when present")
    return out


def _validate_coverage_plan(cp: Any) -> list[str]:
    if not isinstance(cp, dict):
        return ["coverage_plan must be an object"]
    out: list[str] = []
    for key in ("required", "best_effort", "deferred_for_budget"):
        if key not in cp:
            out.append(f"coverage_plan missing {key!r}")
        elif not isinstance(cp[key], list):
            out.append(f"coverage_plan.{key} must be a list")
    if "budget" not in cp or not isinstance(cp["budget"], dict):
        out.append("coverage_plan.budget must be an object")
    return out


def _validate_envelope_findings(envelope: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for bucket in ("verified", "justified", "rejected", "pending_verification"):
        for i, finding in enumerate(envelope.get(bucket, []) or []):
            out.extend(f"{bucket}[{i}]: {err}" for err in validate_finding(finding))
    for i, finding in enumerate(envelope.get("coverage_gaps", []) or []):
        out.extend(f"coverage_gaps[{i}]: {err}" for err in validate_finding(finding))
    return out


def validate_result_envelope(envelope: dict[str, Any]) -> list[str]:
    """Return list of validation errors for a review_result envelope dict."""
    errors: list[str] = []
    errors.extend(_validate_envelope_scalars(envelope))
    errors.extend(_validate_envelope_buckets(envelope))
    errors.extend(_validate_coverage_plan(envelope.get("coverage_plan")))
    if "coverage_gaps" not in envelope:
        errors.append("missing coverage_gaps")
    elif not isinstance(envelope["coverage_gaps"], list):
        errors.append("coverage_gaps must be a list")
    errors.extend(_validate_envelope_findings(envelope))

    # Telemetry block (PLN-719 Phase 9). When absent, treat as the zero-valued
    # default — finalize-result always emits one, but legacy envelopes might
    # not. When present, the block must conform to the canonical telemetry
    # schema (required keys + correct types).
    if "telemetry" in envelope:
        errors.extend(validate_telemetry(envelope["telemetry"]))

    return errors


# ---------------------------------------------------------------------------
# Normalization: legacy -> canonical
# ---------------------------------------------------------------------------


def normalize_legacy_finding(
    raw: dict[str, Any],
    *,
    reviewer: str = "unknown",
    source: str = "agent",
    index: int = 0,
    emitted_at: str = "",
) -> dict[str, Any]:
    """Take a legacy finding (pre-foundation) and fill in canonical fields.

    Used by `validate` and `collect-findings` to upgrade in-flight findings
    until every producer emits canonical schema natively.

    Does NOT replace fields that are already canonical; only fills gaps.
    """
    out = dict(raw)  # shallow copy

    out.setdefault("schema_version", SCHEMA_VERSION)
    out.setdefault("finding_scope", "diff")
    out.setdefault("system_marker", None)
    out.setdefault("source", source)
    out.setdefault("reviewer", raw.get("reviewer", reviewer))
    out.setdefault("emitted_at", emitted_at)
    out.setdefault("reviewer_trigger", {"type": "core", "evidence": None})
    out.setdefault("evidence", [])
    out.setdefault("reasoning_certificate", None)
    out.setdefault("justified", False)
    out.setdefault("justification", None)
    out.setdefault("external_impact", [])
    out.setdefault("grep_query_used", None)
    out.setdefault("verifier_verdict", None)
    out.setdefault("verifier_severity", None)
    out.setdefault("verifier_confidence", None)
    out.setdefault("verifier_reasoning", None)
    out.setdefault("verifier_model", None)
    out.setdefault("verification_duration_ms", None)
    out.setdefault("evidence_checks", [])
    out.setdefault("rejection_class", None)
    out.setdefault("human_review_recommended", False)
    out.setdefault("other_locations", [])
    out.setdefault("subcategory", None)
    out.setdefault("code_snippet", out.get("code_snippet", ""))
    out.setdefault("explanation", out.get("explanation", ""))
    out.setdefault("recommendation", out.get("recommendation", ""))

    # Synthesize id if missing
    if not out.get("id"):
        out["id"] = make_finding_id(out["reviewer"], index)

    return out


# ---------------------------------------------------------------------------
# JSON Schema (for documentation + machine validation)
# ---------------------------------------------------------------------------


def finding_json_schema() -> dict[str, Any]:
    """Return the JSON Schema (draft-07) for a Finding."""
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "CodeReviewFinding",
        "type": "object",
        "required": [
            "schema_version", "id", "reviewer", "reviewer_trigger", "source",
            "emitted_at", "finding_scope", "category", "severity", "priority",
            "confidence", "issue", "explanation", "recommendation", "code_snippet",
        ],
        "properties": {
            "schema_version": {"type": "integer"},
            "id": {"type": "string", "pattern": _FINDING_ID_RE.pattern},
            "reviewer": {"type": "string"},
            "reviewer_trigger": {
                "type": "object",
                "required": ["type"],
                "properties": {
                    "type": {"enum": sorted(REVIEWER_TRIGGERS)},
                    "evidence": {"type": ["string", "null"]},
                },
            },
            "source": {"enum": sorted(SOURCES)},
            "emitted_at": {"type": "string"},
            "finding_scope": {"enum": sorted(FINDING_SCOPES)},
            "file": {"type": ["string", "null"]},
            "line": {"type": ["integer", "null"]},
            "system_marker": {"type": ["string", "null"]},
            "category": {"enum": sorted(CATEGORIES)},
            "subcategory": {"type": ["string", "null"]},
            "severity": {"enum": sorted(SEVERITIES)},
            "priority": {"enum": sorted(PRIORITIES)},
            "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "issue": {"type": "string"},
            "explanation": {"type": "string"},
            "recommendation": {"type": "string"},
            "code_snippet": {"type": "string"},
            "evidence": {"type": "array"},
            "reasoning_certificate": {"type": ["object", "null"]},
            "justified": {"type": "boolean"},
            "justification": {"type": ["object", "null"]},
            "external_impact": {"type": "array"},
            "grep_query_used": {"type": ["string", "null"]},
            "verifier_verdict": {
                "anyOf": [
                    {"type": "null"},
                    {"enum": sorted(VERIFIER_VERDICTS)},
                ],
            },
            "verifier_severity": {"type": ["string", "null"]},
            "verifier_confidence": {"type": ["number", "null"]},
            "verifier_reasoning": {"type": ["string", "null"]},
            "verifier_model": {"type": ["string", "null"]},
            "verification_duration_ms": {"type": ["integer", "null"]},
            "evidence_checks": {"type": "array"},
            "rejection_class": {"type": ["string", "null"]},
            "human_review_recommended": {"type": "boolean"},
            "other_locations": {"type": "array"},
        },
    }


def result_envelope_json_schema() -> dict[str, Any]:
    """Return the JSON Schema (draft-07) for a ResultEnvelope."""
    return {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "CodeReviewResultEnvelope",
        "type": "object",
        "required": [
            "schema_version", "review_id", "diff_tip", "mode", "intent",
            "verified", "justified", "rejected",
            "coverage_plan", "coverage_gaps", "verdict",
        ],
        "properties": {
            "schema_version": {"type": "integer"},
            "review_id": {"type": "string"},
            "pr_number": {"type": ["integer", "null"]},
            "head_sha": {"type": ["string", "null"]},
            "diff_tip": {"type": "string"},
            "review_branch": {"type": ["string", "null"]},
            "base_ref": {"type": ["string", "null"]},
            "diff_scope": {"type": ["string", "null"]},
            "mode": {"enum": ["local", "github"]},
            "intent": {"enum": ["feature", "fix", "refactor", "mixed"]},
            "verified": {"type": "array"},
            "justified": {"type": "array"},
            "rejected": {"type": "array"},
            "pending_verification": {"type": "array"},
            "coverage_plan": {"type": "object"},
            "coverage_gaps": {"type": "array"},
            "verdict": {"enum": sorted(VERDICTS)},
            "verdict_reason": {"type": "string"},
            "stats": {"type": "object"},
            "telemetry": {
                "type": "object",
                "required": [
                    "duration_ms", "duration_by_stage_ms",
                    "estimated_cost_usd", "tokens",
                    "cache_hit_rate", "agent_failures",
                    "schema_versions_seen",
                ],
                "properties": {
                    "duration_ms": {"type": "number", "minimum": 0},
                    "duration_by_stage_ms": {
                        "type": "object",
                        "additionalProperties": {"type": "number", "minimum": 0},
                    },
                    "estimated_cost_usd": {"type": "number", "minimum": 0},
                    "tokens": {
                        "type": "object",
                        "required": ["input_uncached", "input_cached", "output", "by_model"],
                        "properties": {
                            "input_uncached": {"type": "integer", "minimum": 0},
                            "input_cached": {"type": "integer", "minimum": 0},
                            "output": {"type": "integer", "minimum": 0},
                            "by_model": {"type": "object"},
                        },
                    },
                    "cache_hit_rate": {
                        "type": "object",
                        "additionalProperties": {
                            "type": "number", "minimum": 0, "maximum": 1,
                        },
                    },
                    "agent_failures": {"type": "integer", "minimum": 0},
                    "schema_versions_seen": {
                        "type": "object",
                        "additionalProperties": {"type": "integer"},
                    },
                    "findings_counts": {"type": "object"},
                    "verification_stats": {"type": "object"},
                    "coverage_stats": {"type": "object"},
                },
            },
        },
    }
