#!/usr/bin/env python3
"""
Code Review Deterministic Helpers

Offloads deterministic work from the /code-review orchestrator:
  parse-diff  — run git diff commands and produce structured JSON
  hygiene     — pattern-match for CI artifacts, path leakage, sensitive files
  partition   — bin-pack files into agent-sized partitions
  route       — compute risk scores and model routing
  validate    — normalize, filter, and deduplicate findings
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import functools
import hashlib
import json
import os
import random
import re
import shutil
import stat
import subprocess
import sys
import uuid
from collections.abc import Generator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from code_review_schema import (
    CACHE_NAMESPACE_BHA,
    CACHE_NAMESPACE_COVERAGE_CRITIC,
    CACHE_NAMESPACE_OVERRIDES,
    CACHE_NAMESPACE_SIGNALS,
    CACHE_NAMESPACE_VERIFICATIONS,
    COVERAGE_CHANGE_CLASSES,
    COVERAGE_CORE_REQUIRED,
    COVERAGE_DETERMINISTIC_TRIGGERS,
    COVERAGE_SCOPES,
    COVERAGE_TRIGGER_TYPES,
    SCHEMA_VERSION,
    SEVERITIES,
    VERIFIER_VERDICTS,
    cache_ttl_days,
    empty_telemetry,
    is_valid_system_marker,
    make_finding_id,
    merge_telemetry,
    normalize_legacy_finding,
    system_marker_scope,
    validate_result_envelope,
)


# ---------------------------------------------------------------------------
# Shared constants
# ---------------------------------------------------------------------------

HUNK_RE = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")

# Cache constants
CACHE_SCHEMA_VERSION = 1
CACHE_SCHEMA_VERSION_V2 = 2
CACHE_MANIFEST_FILENAME = "manifest.json"
CACHE_LOCK_FILENAME = "manifest.json.lock"
CACHE_GC_TTL_DAYS_DEFAULT = 14
CACHE_GC_MAX_PER_FILE_DEFAULT = 3

# Timestamp threshold: values above this are milliseconds, not seconds
TIMESTAMP_MS_THRESHOLD = 1e12

# Review state constants
REVIEW_STATE_FILENAME = "review_state.json"

# Hygiene: directories/extensions to skip entirely
HYGIENE_SKIP_DIRS = {"test", "tests", "__tests__", "fixtures", "examples", "docs"}
HYGIENE_SKIP_EXTS = {".md", ".txt"}

# Hygiene: extensions that auto-upgrade to HIGH
HIGH_EXTS = {
    ".json", ".ts", ".tsx", ".js", ".jsx", ".py",
    ".env", ".pem", ".key",
}

# Test file detection patterns
TEST_PATTERNS = re.compile(
    r"(\.test\.|\.spec\.|(?:^|/)__tests__/|(?:^|/)test/|(?:^|/)tests/)", re.IGNORECASE
)

# Severity canonical order
SEVERITY_PRIORITY: dict[str, int] = {
    "BLOCKING": 0,
    "HIGH": 1,
    "MEDIUM": 2,
}

# Size category thresholds
SIZE_SMALL = 500
SIZE_MEDIUM = 2000

# Batch size for -U0 when >200 files
U0_BATCH_SIZE = 100
U0_FILE_THRESHOLD = 200

# Parsing thresholds
NAME_STATUS_MIN_FIELDS = 2
NUMSTAT_MIN_FIELDS = 3
DIFF_HEADER_PARTS = 2

# Risk scoring
HIGH_LOC_THRESHOLD = 50

# Partition post-processing
TRIVIAL_PARTITION_THRESHOLD = 20
DEFAULT_MAX_BHA_AGENTS = 5
REBALANCE_LOC_BUDGET = 1200
MIXED_PARTITION_SPLIT_THRESHOLD = 50

# PLN-774: Conditional BHA partitioning threshold. PRs with total changed
# LOC at or below this value get a single "unified" partition so cross-
# region invariants stay visible to one reviewer's context; PRs above the
# threshold fall back to the standard bin-pack (REBALANCE_LOC_BUDGET).
# Operator-overridable via ``.closedloop-ai/settings/code-review.json``
# with key ``bha_unified_threshold_loc``. Setting the value to 0 forces
# the always-partition behavior (kill switch / regression escape hatch).
BHA_UNIFIED_THRESHOLD_LOC = 5000

# Fast-path routing thresholds
FAST_PATH_MAX_LOC = 200

# Validation thresholds
CONFIDENCE_DISCARD_THRESHOLD = 0.5
LINE_TOLERANCE = 3
JACCARD_DEDUP_THRESHOLD = 0.6

# Out-of-hunk confidence floor. P1 BLOCKING/HIGH always passes (no floor);
# P2+ out-of-hunk findings survive when ``confidence > floor`` (strict ``>``).
# Operator-overridable via ``.closedloop-ai/settings/code-review.json`` key
# ``out_of_hunk_confidence_floor`` (range [0.0, 1.0]). Floor 1.0 is a kill
# switch (reviewer confidence is bounded at 1.0; nothing can clear); floor 0.0
# lets every non-zero-confidence out-of-hunk P2+ through (leans entirely on the
# PLN-722 verifier for noise filtering). The default is tighter than the
# in-hunk floor (CONFIDENCE_DISCARD_THRESHOLD = 0.5) because out-of-hunk
# findings must demonstrate causation, not just colocation.
OUT_OF_HUNK_CONFIDENCE_FLOOR = 0.80

# Number formatting thresholds
FORMAT_MILLION = 1_000_000
FORMAT_THOUSAND = 1_000

# Intent classification
INTENT_FEATURE_WORDS = frozenset({"feat", "feature", "add", "implement", "new", "introduce", "create"})
INTENT_FIX_WORDS = frozenset({"fix", "bug", "patch", "hotfix", "repair", "correct", "revert"})
INTENT_REFACTOR_WORDS = frozenset({"refactor", "cleanup", "clean", "reorganize", "rename", "move", "restructure"})
FEATURE_FILE_STATUS_THRESHOLD = 0.70


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DiffData:
    files_to_review: list[str]
    file_statuses: dict[str, str]
    file_loc: dict[str, dict[str, int]]
    total_loc: int
    changed_ranges: dict[str, dict[str, list[list[int]]]]
    patch_lines: dict[str, dict[str, dict[str, str]]]


@dataclass
class Finding:
    file: str
    line: int
    severity: str
    category: str
    issue: str
    explanation: str = ""
    recommendation: str = ""
    code_snippet: str = ""
    priority: int = 2
    confidence: float = 1.0


@dataclass
class DiscardedFinding:
    finding: dict[str, Any]
    reason: str


@dataclass
class Partition:
    id: int
    files: list[dict[str, Any]]
    total_loc: int
    is_test_only: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_git(args: list[str], workdir: str | None = None) -> str:
    """Run a git command and return stdout."""
    cmd = ["git"]
    if workdir:
        cmd += ["-C", workdir]
    cmd += args
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return result.stdout


def _detect_open_pr() -> int | None:
    """Detect an open PR for the current branch via ``gh pr view``.

    Returns the PR number or ``None`` when detection fails for any reason
    (no open PR, ``gh`` not installed, network error, malformed output).
    """
    try:
        result = subprocess.run(
            ["gh", "pr", "view", "--json", "number", "-q", ".number"],
            capture_output=True, text=True, check=True,
        )
        return int(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError, OSError, ValueError):
        return None


def _resolve_pr_scope(
    pr_number: int,
    current_branch: str,
    *,
    allow_guess_fallback: bool,
) -> dict[str, str | int]:
    """Resolve diff scope fields for a given PR number.

    When *allow_guess_fallback* is ``True`` (explicit ``--pr-number``), a
    ``CalledProcessError`` from ``gh pr view`` falls back to
    ``base_ref="main"`` / ``head_ref=current_branch``.  When ``False``
    (auto-detect path), errors propagate so the caller can revert to branch
    scope.
    """
    try:
        result = subprocess.run(
            ["gh", "pr", "view", str(pr_number), "--json", "baseRefName,headRefName",
             "-q", ".baseRefName,.headRefName"],
            capture_output=True, text=True, check=True,
        )
        lines = result.stdout.strip().splitlines()
        base_ref = lines[0].strip() if len(lines) > 0 else "main"
        head_ref = lines[1].strip() if len(lines) > 1 else current_branch
    except subprocess.CalledProcessError:
        if not allow_guess_fallback:
            raise
        base_ref = "main"
        head_ref = current_branch

    return {
        "diff_scope": f"origin/{base_ref}...origin/{head_ref}",
        "base_ref": base_ref,
        "head_ref": head_ref,
        "review_branch": head_ref,
        "diff_tip": f"origin/{head_ref}",
        "path_filter": "",
        "scope_kind": "pr",
        "pr_number": pr_number,
    }


def _parse_scope(scope: str) -> list[str]:
    """Split scope string into git diff arguments."""
    return scope.split()


def _is_in_skip_dir(path: str) -> bool:
    """Check if file path is under a skipped directory."""
    parts = Path(path).parts
    return bool(HYGIENE_SKIP_DIRS & set(parts))


def _is_skip_ext(path: str) -> bool:
    """Check if file has a skipped extension."""
    return Path(path).suffix.lower() in HYGIENE_SKIP_EXTS


def _severity_for_hygiene_file(path: str) -> str | None:
    """Return severity for a hygiene finding, or None to skip."""
    if _is_in_skip_dir(path) or _is_skip_ext(path):
        return None
    ext = Path(path).suffix.lower()
    # .env files may have suffixes like .env.local
    basename = Path(path).name.lower()
    if ext in HIGH_EXTS or basename.startswith(".env") or "/" not in path:
        return "HIGH"
    return "MEDIUM"


def _first_added_line(
    all_changed_ranges: dict[str, dict[str, list[list[int]]]], filepath: str
) -> int:
    """Return the first added line for a file, or 1 as fallback."""
    file_ranges = all_changed_ranges.get(filepath, {})
    added = file_ranges.get("added", [])
    if added:
        return added[0][0]
    return 1


def _line_in_range(line: int, ranges: list[list[int]], tolerance: int = 3) -> bool:
    """Check if line falls within tolerance of any range."""
    for r in ranges:
        start = r[0]
        end = r[1] if len(r) > 1 else start
        if start - tolerance <= line <= end + tolerance:
            return True
    return False


def _jaccard_similarity(a: str, b: str) -> float:
    """Word-level Jaccard similarity between two strings."""
    words_a = set(re.findall(r"\w+", a.lower()))
    words_b = set(re.findall(r"\w+", b.lower()))
    if not words_a or not words_b:
        return 0.0
    return len(words_a & words_b) / len(words_a | words_b)


def _is_test_file(path: str) -> bool:
    """Check if a file is a test file."""
    return bool(TEST_PATTERNS.search(path))


# ---------------------------------------------------------------------------
# Subcommand: parse-diff
# ---------------------------------------------------------------------------

def _parse_name_status(raw: str) -> dict[str, str]:
    """Parse git diff --name-status output into {path: status}."""
    statuses: dict[str, str] = {}
    for line in raw.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < NAME_STATUS_MIN_FIELDS:
            continue
        code = parts[0].strip()
        # Renamed: R100\told\tnew
        if code.startswith("R"):
            filepath = parts[-1]
            statuses[filepath] = "modified"
        elif code == "A":
            statuses[parts[1]] = "added"
        elif code == "D":
            statuses[parts[1]] = "removed"
        elif code == "M":
            statuses[parts[1]] = "modified"
        else:
            statuses[parts[-1]] = "modified"
    return statuses


def _parse_numstat(raw: str) -> dict[str, dict[str, int]]:
    """Parse git diff --numstat output into {path: {added, removed}}."""
    loc: dict[str, dict[str, int]] = {}
    for line in raw.strip().splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < NUMSTAT_MIN_FIELDS:
            continue
        added_str, removed_str, filepath = parts[0], parts[1], parts[2]
        # Binary files show as "- -"
        added = int(added_str) if added_str != "-" else 0
        removed = int(removed_str) if removed_str != "-" else 0
        # Handle renames: "old => new" or "{old => new}"
        if " => " in filepath:
            # Extract the new path
            filepath = re.sub(r"\{[^}]*=> ", "", filepath)
            filepath = filepath.replace("}", "")
            filepath = filepath.strip()
        loc[filepath] = {"added": added, "removed": removed}
    return loc


def _parse_u0_output(
    raw: str, include_patch_lines: bool = True
) -> tuple[dict[str, dict[str, list[list[int]]]], dict[str, dict[str, dict[str, str]]]]:
    """Parse git diff -U0 output into changed_ranges and patch_lines.

    Returns:
        (changed_ranges, patch_lines)
        changed_ranges: {filepath: {"added": [[s,e],...], "removed": [[s,e],...]}}
        patch_lines: {filepath: {"added_lines": {"line": "content"}, "removed_lines": {"line": "content"}}}
    """
    changed_ranges: dict[str, dict[str, list[list[int]]]] = {}
    patch_lines: dict[str, dict[str, dict[str, str]]] = {}

    current_file: str | None = None
    current_removed_start = 0
    current_added_start = 0
    current_removed_count = 0
    current_added_count = 0
    removed_line_counter = 0
    added_line_counter = 0

    for line in raw.splitlines():
        # Detect file header
        if line.startswith("diff --git"):
            # Extract b/filepath
            parts = line.split(" b/", 1)
            if len(parts) == DIFF_HEADER_PARTS:
                current_file = parts[1]
                if current_file not in changed_ranges:
                    changed_ranges[current_file] = {"added": [], "removed": []}
                if include_patch_lines and current_file not in patch_lines:
                    patch_lines[current_file] = {"added_lines": {}, "removed_lines": {}}
            continue

        # Detect hunk header
        m = HUNK_RE.match(line)
        if m and current_file:
            current_removed_start = int(m.group(1))
            current_removed_count = int(m.group(2)) if m.group(2) is not None else 1
            current_added_start = int(m.group(3))
            current_added_count = int(m.group(4)) if m.group(4) is not None else 1

            if current_removed_count > 0:
                end = current_removed_start + current_removed_count - 1
                changed_ranges[current_file]["removed"].append(
                    [current_removed_start, end]
                )
            if current_added_count > 0:
                end = current_added_start + current_added_count - 1
                changed_ranges[current_file]["added"].append(
                    [current_added_start, end]
                )

            removed_line_counter = 0
            added_line_counter = 0
            continue

        if not current_file:
            continue

        # Collect patch lines
        if include_patch_lines:
            if line.startswith("-") and not line.startswith("---"):
                line_num = current_removed_start + removed_line_counter
                patch_lines[current_file]["removed_lines"][str(line_num)] = line[1:]
                removed_line_counter += 1
            elif line.startswith("+") and not line.startswith("+++"):
                line_num = current_added_start + added_line_counter
                patch_lines[current_file]["added_lines"][str(line_num)] = line[1:]
                added_line_counter += 1

    return changed_ranges, patch_lines


def cmd_parse_diff(args: argparse.Namespace) -> int:
    """Execute parse-diff subcommand."""
    scope_args = _parse_scope(args.scope)
    workdir = args.workdir

    # 1. --name-only
    name_only_raw = _run_git(["diff", "--name-only"] + scope_args, workdir)
    files_to_review = [f for f in name_only_raw.strip().splitlines() if f.strip()]

    # 2. --name-status
    name_status_raw = _run_git(["diff", "--name-status"] + scope_args, workdir)
    file_statuses = _parse_name_status(name_status_raw)

    # 3. --numstat
    numstat_raw = _run_git(["diff", "--numstat"] + scope_args, workdir)
    file_loc = _parse_numstat(numstat_raw)

    total_loc = sum(v["added"] + v["removed"] for v in file_loc.values())

    # 4. -U0 (batched if >200 files)
    if len(files_to_review) > U0_FILE_THRESHOLD:
        all_ranges: dict[str, dict[str, list[list[int]]]] = {}
        all_patch_lines: dict[str, dict[str, dict[str, str]]] = {}
        for i in range(0, len(files_to_review), U0_BATCH_SIZE):
            batch = files_to_review[i : i + U0_BATCH_SIZE]
            u0_raw = _run_git(
                ["diff", "-U0"] + scope_args + ["--"] + batch, workdir
            )
            ranges, plines = _parse_u0_output(u0_raw, True)
            all_ranges.update(ranges)
            all_patch_lines.update(plines)
        changed_ranges = all_ranges
        patch_lines = all_patch_lines
    else:
        u0_raw = _run_git(["diff", "-U0"] + scope_args, workdir)
        changed_ranges, patch_lines = _parse_u0_output(u0_raw, True)

    result = {
        "files_to_review": files_to_review,
        "file_statuses": file_statuses,
        "file_loc": file_loc,
        "total_loc": total_loc,
        "changed_ranges": changed_ranges,
        "patch_lines": patch_lines,
    }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: hygiene
# ---------------------------------------------------------------------------

CI_PATTERNS = [
    re.compile(r"/home/runner/"),
    re.compile(r"/github/workspace/"),
]

PATH_PATTERNS = [
    re.compile(r"/Users/\w+"),
    re.compile(r"/home/\w+"),
    re.compile(r"[A-Z]:\\"),
]

SENSITIVE_NAME_PATTERNS = [
    re.compile(r"\.env", re.IGNORECASE),
    re.compile(r"credentials", re.IGNORECASE),
    re.compile(r"\.pem$", re.IGNORECASE),
    re.compile(r"\.key$", re.IGNORECASE),
    re.compile(r"secret", re.IGNORECASE),
]

GITIGNORE_RISKY_PATTERNS = [
    re.compile(r"\.local$"),
    re.compile(r"\.generated$"),
    re.compile(r"^\.dev-"),
    re.compile(r"\.env"),
    re.compile(r"\.pem$"),
    re.compile(r"\.key$"),
]


def _check_ci_artifacts(
    filepath: str,
    added_lines: dict[str, str],
) -> list[dict[str, Any]]:
    """Check for CI runner paths in added lines."""
    findings: list[dict[str, Any]] = []
    for line_num_str, content in added_lines.items():
        for pattern in CI_PATTERNS:
            if pattern.search(content):
                severity = _severity_for_hygiene_file(filepath)
                if severity is None:
                    continue
                findings.append({
                    "file": filepath,
                    "line": int(line_num_str),
                    "severity": severity,
                    "category": "Repo Hygiene",
                    "subcategory": "ci_artifacts",
                    "issue": f"[P1] CI artifact — file contains {pattern.pattern} paths",
                    "explanation": f"Line {line_num_str} contains a CI-generated path that should not be committed.",
                    "recommendation": "Remove the hardcoded CI path or add this file to .gitignore.",
                    "priority": 1,
                    "confidence": 1.0,
                })
                break  # one finding per line
    return findings


def _check_path_leakage(
    filepath: str,
    added_lines: dict[str, str],
) -> list[dict[str, Any]]:
    """Check for absolute machine-specific paths."""
    findings: list[dict[str, Any]] = []
    for line_num_str, content in added_lines.items():
        # Exclude node_modules references
        if "node_modules" in content:
            continue
        for pattern in PATH_PATTERNS:
            if pattern.search(content):
                severity = _severity_for_hygiene_file(filepath)
                if severity is None:
                    continue
                findings.append({
                    "file": filepath,
                    "line": int(line_num_str),
                    "severity": severity,
                    "category": "Repo Hygiene",
                    "subcategory": "path_leakage",
                    "issue": "[P1] Path leakage — absolute machine-specific path",
                    "explanation": f"Line {line_num_str} contains a machine-specific path.",
                    "recommendation": "Use relative paths or environment variables instead.",
                    "priority": 1,
                    "confidence": 1.0,
                })
                break
    return findings


def _check_gitignore_drift(
    filepath: str,
    file_status: str,
    workdir: str | None,
) -> list[dict[str, Any]]:
    """Check if added files should be gitignored."""
    if file_status != "added":
        return []

    basename = Path(filepath).name
    if not any(p.search(basename) for p in GITIGNORE_RISKY_PATTERNS):
        return []

    severity = _severity_for_hygiene_file(filepath)
    if severity is None:
        return []

    # Check git check-ignore
    try:
        cmd = ["git"]
        if workdir:
            cmd += ["-C", workdir]
        cmd += ["check-ignore", "--no-index", filepath]
        result = subprocess.run(cmd, capture_output=True, text=True)
        # If exit code 0, the file IS ignored — that's fine
        if result.returncode == 0:
            return []
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    return [{
        "file": filepath,
        "line": 1,
        "severity": severity,
        "category": "Repo Hygiene",
        "subcategory": "gitignore_drift",
        "issue": f"[P1] Gitignore drift — {basename} should likely be ignored",
        "explanation": f"Added file '{filepath}' matches a risky pattern and is not gitignored.",
        "recommendation": "Add this file to .gitignore if it contains local/generated content.",
        "priority": 1,
        "confidence": 0.9,
    }]


def _check_sensitive_files(
    filepath: str,
    file_status: str,
    all_changed_ranges: dict[str, dict[str, list[list[int]]]],
) -> list[dict[str, Any]]:
    """Check for sensitive file patterns."""
    if file_status not in ("added", "modified"):
        return []

    basename = Path(filepath).name
    if not any(p.search(basename) for p in SENSITIVE_NAME_PATTERNS):
        return []

    severity = _severity_for_hygiene_file(filepath)
    if severity is None:
        return []

    line = 1 if file_status == "added" else _first_added_line(all_changed_ranges, filepath)

    return [{
        "file": filepath,
        "line": line,
        "severity": severity,
        "category": "Repo Hygiene",
        "subcategory": "sensitive_files",
        "issue": f"[P1] Sensitive file — {basename} may contain secrets",
        "explanation": f"File '{filepath}' matches a sensitive file pattern.",
        "recommendation": "Verify this file does not contain credentials or secrets. Consider using a secrets manager.",
        "priority": 1,
        "confidence": 0.9,
    }]


_TIER_MISMATCH_NUDGE_LOC_THRESHOLD = 3000

# Path segments that signal schema / migration territory. Matched
# against any ``/``-separated segment of the file path so root-level
# paths (``migrations/0001.sql``, ``schemas/user.py``,
# ``models/user.rb``) fire the heuristic alongside nested ones.
_TIER_MISMATCH_NUDGE_SCHEMA_DIR_SEGMENTS = frozenset({
    "migrations",
    "schemas",
    "models",
})

# Special filenames that often indicate schema state regardless of
# directory placement (Prisma, raw SQL, etc.).
_TIER_MISMATCH_NUDGE_SCHEMA_FILENAMES = frozenset({
    "schema.prisma",
    "schema.sql",
})

_TIER_MISMATCH_NUDGE_PUBLIC_API_FILES = frozenset({
    "plugin.json",
    "package.json",
    "index.ts",
    "index.tsx",
    "index.js",
    "__init__.py",
})


def _matches_schema_or_migration_path(filepath: str) -> bool:
    """Path-aware schema/migration matcher.

    Splits on ``/`` and looks for any directory segment in the
    schema-dir set. Catches both root-level (``migrations/0001.sql``)
    and nested (``apps/web/db/migrations/2024_x.sql``) layouts. Also
    matches the basename against the schema-filename set so
    ``schema.prisma`` fires regardless of placement.
    """
    p = filepath.replace("\\", "/")
    parts = [seg for seg in p.split("/") if seg]
    if Path(p).name in _TIER_MISMATCH_NUDGE_SCHEMA_FILENAMES:
        return True
    return any(
        seg in _TIER_MISMATCH_NUDGE_SCHEMA_DIR_SEGMENTS for seg in parts[:-1]
    )


def _check_tier_mismatch_nudge(
    diff_data: dict[str, Any], depth: str | None,
) -> list[dict[str, Any]]:
    """Emit a single MEDIUM system-scoped finding when shallow runs on
    a PR that would benefit from a higher-tier review (PLN-807 Phase 5).

    Three heuristics fire independently; any one is enough:

      - Diff > 3000 LOC — premise reviewer's value scales with diff
        size; large refactors warrant the deeper architectural look.
      - Schema/migration paths in the diff — premise + repo-specific
        critics typically catch ORM-vs-schema drift and irreversible
        migrations that shallow's pure bug-finding fleet misses.
      - Public API surface (plugin.json, index.ts/__init__.py with new
        exports, package.json) — Impact-analyzer territory in deep; at
        minimum, premise should run.

    Runs only when depth=='shallow'. All other tiers no-op. The
    finding's marker (``tier_mismatch_nudge``) makes it easy to
    auto-dismiss or filter out at the operator's discretion. Severity
    is MEDIUM — the lowest tier that survives validate's
    SEVERITY_NORMALIZE map (which DISCARDs "low"). Category "Coverage"
    rather than "Premise" keeps it out of the cumulative Premise
    MEDIUM gate (Rule 4 of _compute_canonical_verdict) so it cannot
    escalate the verdict on its own.
    """
    if depth != "shallow":
        return []

    files: list[str] = list(diff_data.get("files_to_review", []) or [])
    total_loc = int(diff_data.get("total_loc") or 0)

    reasons: list[str] = []

    if total_loc > _TIER_MISMATCH_NUDGE_LOC_THRESHOLD:
        reasons.append(
            f"diff size ({total_loc} LOC) exceeds {_TIER_MISMATCH_NUDGE_LOC_THRESHOLD} LOC"
        )

    schema_hits = [f for f in files if _matches_schema_or_migration_path(f)]
    if schema_hits:
        sample = ", ".join(schema_hits[:3])
        more = f" (+{len(schema_hits) - 3} more)" if len(schema_hits) > 3 else ""
        reasons.append(f"schema/migration path{'s' if len(schema_hits) > 1 else ''} touched: {sample}{more}")

    api_hits = [
        f for f in files
        if Path(f).name in _TIER_MISMATCH_NUDGE_PUBLIC_API_FILES
    ]
    if api_hits:
        sample = ", ".join(api_hits[:3])
        more = f" (+{len(api_hits) - 3} more)" if len(api_hits) > 3 else ""
        reasons.append(f"public API surface{'s' if len(api_hits) > 1 else ''} touched: {sample}{more}")

    if not reasons:
        return []

    # MEDIUM severity (not LOW) so the finding survives validate's
    # SEVERITY_NORMALIZE map (which DISCARDs "low"). MEDIUM is the
    # lowest severity that reaches the operator. Category "Coverage"
    # rather than "Premise" so it does not contribute to the cumulative
    # Premise MEDIUM gate (Rule 4 of _compute_canonical_verdict) and
    # cannot accidentally escalate the verdict on its own.
    return [{
        "reviewer": "hygiene",
        "source": "hygiene",
        "finding_scope": "system",
        "system_marker": "tier_mismatch_nudge",
        "category": "Coverage",
        "severity": "MEDIUM",
        "file": None,
        "line": None,
        "issue": "Shallow review skipped premise_reviewer and repo-specific critics; PR characteristics suggest a standard or deep review.",
        "explanation": (
            "PLN-807 shallow tier intentionally drops premise_reviewer + "
            "critic-gates entries to lower cost. The following heuristics "
            "fired on this PR: " + "; ".join(reasons) + ". The skipped "
            "reviewers commonly catch issues those patterns introduce."
        ),
        "recommendation": (
            "Re-run with `/code-review start --depth standard` (or `deep` "
            "if Impact Analysis is wanted) to engage the full reviewer "
            "fleet."
        ),
        "confidence": 1.0,
        "rationale_summary": "; ".join(reasons)[:1000],
    }]


def cmd_hygiene(args: argparse.Namespace) -> int:
    """Execute hygiene subcommand."""
    diff_data_path: str | None = getattr(args, "diff_data", None)
    diff_data = json.load(open(diff_data_path)) if diff_data_path else json.load(sys.stdin)
    file_statuses: dict[str, str] = diff_data.get("file_statuses", {})
    changed_ranges: dict[str, dict[str, list[list[int]]]] = diff_data.get("changed_ranges", {})
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {})
    workdir: str | None = args.workdir
    depth: str | None = getattr(args, "depth", None)
    ok, err = _validate_invocation_depth(depth)
    if not ok:
        print(err, file=sys.stderr)
        return 1

    findings: list[dict[str, Any]] = []

    for filepath, status in file_statuses.items():
        if status not in ("added", "modified"):
            continue

        file_patch = patch_lines.get(filepath, {})
        added_lines: dict[str, str] = file_patch.get("added_lines", {})

        # Check 1: CI artifacts
        findings.extend(_check_ci_artifacts(filepath, added_lines))
        # Check 2: Path leakage
        findings.extend(_check_path_leakage(filepath, added_lines))
        # Check 3: Gitignore drift
        findings.extend(_check_gitignore_drift(filepath, status, workdir))
        # Check 4: Sensitive files
        findings.extend(_check_sensitive_files(filepath, status, changed_ranges))

    # PLN-807 Phase 5: tier-mismatch nudge. Runs once per invocation
    # (not per file) because the heuristics are diff-level. Adds a
    # single MEDIUM finding when shallow was chosen but heuristics
    # suggest a higher tier would have caught more.
    findings.extend(_check_tier_mismatch_nudge(diff_data, depth))

    # Promote to canonical schema (PLN-719 Foundation Section 1).
    now_iso = datetime.now(timezone.utc).isoformat()
    canonical: list[dict[str, Any]] = []
    for idx, raw in enumerate(findings):
        promoted = normalize_legacy_finding(
            raw,
            reviewer="hygiene",
            source="hygiene",
            index=idx,
            emitted_at=now_iso,
        )
        promoted["reviewer_trigger"] = {"type": "always", "evidence": "deterministic-hygiene"}
        # code_snippet defaults to the added line content if available.
        if not promoted.get("code_snippet"):
            file_patch = patch_lines.get(promoted.get("file", ""), {})
            line_str = str(promoted.get("line", ""))
            promoted["code_snippet"] = file_patch.get("added_lines", {}).get(line_str, "")
        canonical.append(promoted)

    json.dump({"findings": canonical}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: partition
# ---------------------------------------------------------------------------


def _write_per_partition_patches(
    partitions: list[dict[str, Any]],
    diff_scope: str,
    cr_dir: Path,
    workdir: str | None = None,
) -> list[str]:
    """Write ``patches_p<N>.txt`` for each partition and return their filenames.

    The ``partition`` helper is the canonical producer of per-partition patch
    files. Strips any embedded pathspec (``-- file1 file2``) from ``diff_scope``
    since we always supply our own explicit file list.
    """
    run_kwargs: dict[str, Any] = {"capture_output": False, "text": True, "check": False}
    if workdir:
        run_kwargs["cwd"] = workdir

    range_scope = diff_scope.split(" -- ")[0] if " -- " in diff_scope else diff_scope
    range_parts = range_scope.split()

    written: list[str] = []
    for part in partitions:
        part_id = part["id"]
        files_in_part = [entry["file"] for entry in part.get("files", [])]
        patch_name = f"patches_p{part_id}.txt"
        patch_path = cr_dir / patch_name

        # Guard against empty files lists: `git diff <range> --` with no
        # pathspec is an unrestricted diff of every changed file, which would
        # silently fold the entire diff into this partition's patch. When a
        # partition somehow has no files, write an empty patch and skip the
        # git call.
        if not files_in_part:
            patch_path.write_text("")
            written.append(patch_name)
            continue

        cmd = ["git", "diff"] + range_parts + ["--"] + files_in_part
        with open(patch_path, "w") as out:
            subprocess.run(cmd, stdout=out, stderr=subprocess.DEVNULL, **run_kwargs)
        written.append(patch_name)
    return written


def cmd_partition(args: argparse.Namespace) -> int:
    """Execute partition subcommand."""
    diff_data_path: str | None = getattr(args, "diff_data", None)
    diff_data = json.load(open(diff_data_path)) if diff_data_path else json.load(sys.stdin)
    file_loc: dict[str, dict[str, int]] = diff_data.get("file_loc", {})
    changed_ranges: dict[str, dict[str, list[list[int]]]] = diff_data.get("changed_ranges", {})
    files_to_review: list[str] = diff_data.get("files_to_review", [])

    loc_budget = args.loc_budget
    max_files = args.max_files

    # Build file entries with LOC, sorted descending
    file_entries: list[dict[str, Any]] = []
    for f in files_to_review:
        loc_info = file_loc.get(f, {"added": 0, "removed": 0})
        total = loc_info["added"] + loc_info["removed"]
        file_entries.append({"file": f, "loc": total, "is_test": _is_test_file(f)})

    file_entries.sort(key=lambda x: (-x["loc"], x["file"]))  # type: ignore[arg-type]

    test_file_paths: list[str] = [
        str(e["file"]) for e in file_entries if e["is_test"]
    ]

    # PLN-774 — Conditional partitioning. If total LOC is at or below the
    # configured threshold AND there is at least one file to review, emit
    # a single "unified" partition containing all files. Skips bin-pack
    # and the mixed-impl/test split — the whole point of unified mode is
    # to keep cross-region invariants visible to a single reviewer's
    # context.
    #
    # Threshold resolution order (highest precedence first):
    #   1. ``args.bha_unified_threshold_loc`` — explicit Namespace
    #      override (tests, future CLI flag).
    #   2. ``.closedloop-ai/settings/code-review.json`` →
    #      ``bha_unified_threshold_loc`` — operator-tunable settings file.
    #   3. :data:`BHA_UNIFIED_THRESHOLD_LOC` (5000) — built-in default.
    #
    # Setting the threshold to 0 disables unified mode entirely (always
    # partition; restores pre-PLN-774 behavior).
    namespace_override = getattr(args, "bha_unified_threshold_loc", None)
    if namespace_override is not None:
        unified_threshold: int = int(namespace_override)
    else:
        settings_path = Path(
            getattr(args, "settings", None) or _CODE_REVIEW_SETTINGS_DEFAULT_PATH,
        )
        code_review_settings = _load_code_review_settings(settings_path)
        unified_threshold = int(
            code_review_settings.get(
                "bha_unified_threshold_loc", BHA_UNIFIED_THRESHOLD_LOC,
            ),
        )
    total_changed_loc: int = sum(int(e["loc"]) for e in file_entries)
    use_unified = (
        unified_threshold > 0
        and file_entries
        and total_changed_loc <= unified_threshold
    )

    partitions: list[dict[str, Any]] = []

    if use_unified:
        # Single partition holding every file at hand. ``is_test_only``
        # mirrors the standard-flow definition (all entries are test
        # files); preserved so downstream gating (e.g. mandatory-human-
        # review-paths) still has the signal it expects. Skip the entire
        # bin-pack / mixed-split / force-merge / trivial-merge pipeline
        # by jumping straight to the partition-patches materialization
        # step. ``force_merged_count`` stays 0 (no merges happened);
        # the cap-enforcement passes don't fire because there's only
        # one partition.
        is_test_only = all(e.get("is_test", False) for e in file_entries)
        partitions.append({
            "id": 0,
            "files": file_entries,
            "total_loc": total_changed_loc,
            "is_test_only": is_test_only,
        })
        return _emit_partitions(
            args, partitions, test_file_paths,
            force_merged_count=0,
            partition_mode="unified",
            unified_threshold=unified_threshold,
            total_changed_loc=total_changed_loc,
        )

    current_files: list[dict[str, Any]] = []
    current_loc = 0
    partition_id = 0

    def _flush_partition() -> None:
        nonlocal current_files, current_loc, partition_id
        if not current_files:
            return
        is_test_only = all(e.get("is_test", False) for e in current_files)
        partitions.append({
            "id": partition_id,
            "files": current_files,
            "total_loc": current_loc,
            "is_test_only": is_test_only,
        })
        partition_id += 1
        current_files = []
        current_loc = 0

    for entry in file_entries:
        loc_val: int = entry["loc"]  # type: ignore[assignment]
        filepath: str = entry["file"]  # type: ignore[assignment]

        # Oversized single file — split by hunks
        if loc_val > loc_budget:
            _flush_partition()
            file_ranges = changed_ranges.get(filepath, {})
            added_ranges: list[list[int]] = file_ranges.get("added", []) if isinstance(file_ranges, dict) else []
            removed_ranges: list[list[int]] = file_ranges.get("removed", []) if isinstance(file_ranges, dict) else []
            all_hunks = [(r[0], r[1] if len(r) > 1 else r[0], r[1] - r[0] + 1 if len(r) > 1 else 1) for r in added_ranges + removed_ranges]
            all_hunks.sort(key=lambda x: x[0])

            chunk_hunks: list[tuple[int, int, int]] = []
            chunk_loc = 0
            for hunk_start, hunk_end, hunk_loc in all_hunks:
                if chunk_loc + hunk_loc > loc_budget and chunk_hunks:
                    # Flush chunk
                    line_start = chunk_hunks[0][0]
                    line_end = chunk_hunks[-1][1]
                    partitions.append({
                        "id": partition_id,
                        "files": [{
                            "file": filepath,
                            "loc": chunk_loc,
                            "is_test": _is_test_file(filepath),
                            "line_range": [line_start, line_end],
                        }],
                        "total_loc": chunk_loc,
                        "is_test_only": _is_test_file(filepath),
                    })
                    partition_id += 1
                    chunk_hunks = []
                    chunk_loc = 0
                chunk_hunks.append((hunk_start, hunk_end, hunk_loc))
                chunk_loc += hunk_loc

            if chunk_hunks:
                line_start = chunk_hunks[0][0]
                line_end = chunk_hunks[-1][1]
                partitions.append({
                    "id": partition_id,
                    "files": [{
                        "file": filepath,
                        "loc": chunk_loc,
                        "is_test": _is_test_file(filepath),
                        "line_range": [line_start, line_end],
                    }],
                    "total_loc": chunk_loc,
                    "is_test_only": _is_test_file(filepath),
                })
                partition_id += 1
            continue

        # Would adding this file exceed the budget or max files?
        if (current_loc + loc_val > loc_budget and current_files) or len(current_files) >= max_files:
            _flush_partition()

        current_files.append(entry)
        current_loc += loc_val

    _flush_partition()

    max_bha_agents: int = getattr(args, "max_bha_agents", DEFAULT_MAX_BHA_AGENTS) or DEFAULT_MAX_BHA_AGENTS

    # Pass 1 -- Mixed-partition split
    # For each partition with both test and non-test files where impl LOC >= threshold, split.
    new_partitions: list[dict[str, Any]] = []
    for part in partitions:
        files = part["files"]
        impl_files = [f for f in files if not f.get("is_test", False)]
        test_files = [f for f in files if f.get("is_test", False)]
        impl_loc = sum(f["loc"] for f in impl_files)
        if impl_files and test_files and impl_loc >= MIXED_PARTITION_SPLIT_THRESHOLD:
            # Split into impl-only and test-only sub-partitions
            new_partitions.append({
                "id": 0,  # renumbered later
                "files": impl_files,
                "total_loc": impl_loc,
                "is_test_only": False,
            })
            test_loc = sum(f["loc"] for f in test_files)
            new_partitions.append({
                "id": 0,
                "files": test_files,
                "total_loc": test_loc,
                "is_test_only": True,
            })
        else:
            new_partitions.append(part)
    partitions = new_partitions

    # Pass 2a -- Budget-respecting merges (all same-type pairs)
    # Enumerate ALL same-type partition pairs, merge the lowest-total-LOC pair
    # that satisfies both REBALANCE_LOC_BUDGET and max_files.
    while len(partitions) > max_bha_agents:
        best_pair: tuple[int, int, int, bool] | None = None  # (idx_a, idx_b, merged_loc, is_test)
        for is_test in (True, False):
            same_type = [
                (i, p) for i, p in enumerate(partitions) if p["is_test_only"] == is_test
            ]
            if len(same_type) < 2:
                continue
            for ai in range(len(same_type)):
                for bi in range(ai + 1, len(same_type)):
                    idx_a, part_a = same_type[ai]
                    idx_b, part_b = same_type[bi]
                    merged_loc = part_a["total_loc"] + part_b["total_loc"]
                    merged_file_count = len(part_a["files"]) + len(part_b["files"])
                    if merged_loc <= REBALANCE_LOC_BUDGET and merged_file_count <= max_files:
                        if best_pair is None or merged_loc < best_pair[2]:
                            best_pair = (idx_a, idx_b, merged_loc, is_test)
        if best_pair is None:
            break  # No valid same-type merge possible, proceed to Phase 2b
        idx_a, idx_b, merged_loc, is_test = best_pair
        part_a = partitions[idx_a]
        part_b = partitions[idx_b]
        merged_files = part_a["files"] + part_b["files"]
        new_part: dict[str, Any] = {
            "id": 0,
            "files": merged_files,
            "total_loc": merged_loc,
            "is_test_only": is_test,
        }
        for ri in sorted([idx_a, idx_b], reverse=True):
            partitions.pop(ri)
        partitions.append(new_part)

    # Pass 2b -- Unconditional cap enforcement (force-merge fallback)
    # When Phase 2a cannot reduce further, ignore budget and max_files constraints.
    # Sort by total_loc ascending, merge the two smallest partitions (any type).
    force_merged_count = 0
    while len(partitions) > max_bha_agents:
        partitions.sort(key=lambda p: p["total_loc"])
        part_a = partitions.pop(0)
        part_b = partitions.pop(0)
        merged_files = part_a["files"] + part_b["files"]
        is_test_only = all(f.get("is_test", False) for f in merged_files)
        new_part = {
            "id": 0,
            "files": merged_files,
            "total_loc": part_a["total_loc"] + part_b["total_loc"],
            "is_test_only": is_test_only,
        }
        partitions.append(new_part)
        force_merged_count += 1

    # Pass 3 -- Trivial merge
    # Merge partitions below TRIVIAL_PARTITION_THRESHOLD into same-type normal partitions.
    trivial = [p for p in partitions if p["total_loc"] < TRIVIAL_PARTITION_THRESHOLD]
    normal = [p for p in partitions if p["total_loc"] >= TRIVIAL_PARTITION_THRESHOLD]

    for triv in trivial:
        triv_is_test = triv["is_test_only"]
        triv_files = triv["files"]
        triv_loc = triv["total_loc"]

        # Find best merge target: prefer same-type, fallback to any
        same_type_targets = [
            p for p in normal if p["is_test_only"] == triv_is_test and len(p["files"]) + len(triv_files) <= max_files
        ]
        any_type_targets = [
            p for p in normal if len(p["files"]) + len(triv_files) <= max_files
        ]

        target = None
        if same_type_targets:
            # Merge into smallest same-type
            target = min(same_type_targets, key=lambda p: p["total_loc"])
        elif any_type_targets:
            # Fallback: merge into smallest any-type
            target = min(any_type_targets, key=lambda p: p["total_loc"])

        if target is not None:
            target["files"] = target["files"] + triv_files
            target["total_loc"] += triv_loc
            # Recompute is_test_only
            target["is_test_only"] = all(f.get("is_test", False) for f in target["files"])
        else:
            # No valid merge target — keep trivial partition as-is
            normal.append(triv)

    partitions = normal

    # Renumber IDs sequentially
    for idx, part in enumerate(partitions):
        part["id"] = idx

    return _emit_partitions(
        args, partitions, test_file_paths,
        force_merged_count=force_merged_count,
        partition_mode="partitioned",
        unified_threshold=unified_threshold,
        total_changed_loc=total_changed_loc,
    )


def _emit_partitions(
    args: argparse.Namespace,
    partitions: list[dict[str, Any]],
    test_file_paths: list[str],
    *,
    force_merged_count: int,
    partition_mode: str,
    unified_threshold: int,
    total_changed_loc: int,
) -> int:
    """Materialize per-partition patches (when requested), build the
    ``partitions.json`` output payload, and emit it to stdout.

    PLN-774 — extracted from ``cmd_partition`` so the unified-mode
    early-return path and the standard bin-pack path share one emission
    step. ``partition_mode`` is "unified" when the early-return path
    hit, "partitioned" otherwise. ``unified_threshold`` and
    ``total_changed_loc`` are surfaced in the output so downstream
    consumers (verify-prepare manifest propagation, presenters, replay
    harness) can explain why the mode was chosen without re-reading
    settings.
    """
    # PLN-719 Phase 5: partition is the canonical producer of
    # patches_p<N>.txt. Materialize per-partition patches when both
    # --diff-scope and --cr-dir are provided.
    diff_scope: str | None = getattr(args, "diff_scope", None)
    cr_dir_arg: str | None = getattr(args, "cr_dir", None)
    workdir: str | None = getattr(args, "workdir", None)
    partition_patches: list[str] = []
    if diff_scope and cr_dir_arg:
        partition_patches = _write_per_partition_patches(
            partitions, diff_scope, Path(cr_dir_arg), workdir,
        )

    output: dict[str, Any] = {
        "partitions": partitions,
        "test_file_paths": test_file_paths,
        "force_merged_count": force_merged_count,
        # PLN-774 — partition-mode telemetry. Downstream consumers
        # (cmd_verify_prepare, presenters, replay harness) read these
        # to surface unified-vs-partitioned behavior per PR and to
        # split BHA findings by partition when ``partitioned``.
        "partition_mode": partition_mode,
        "partition_count": len(partitions),
        "total_changed_loc": total_changed_loc,
        "unified_threshold_loc": unified_threshold,
    }
    if partition_patches:
        output["partition_patches"] = partition_patches

    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: route
# ---------------------------------------------------------------------------

_EMPTY_CRITIC_GATES: dict[str, Any] = {
    "defaults": {"reviewBudget": 2},
    "moduleCritics": [],
}


def _load_critic_gates(path: str | None) -> dict[str, Any]:
    """Load critic-gates.json, returning empty structure on failure."""
    if not path:
        return dict(_EMPTY_CRITIC_GATES)
    p = Path(path)
    if not p.exists():
        return dict(_EMPTY_CRITIC_GATES)
    try:
        with open(p) as f:
            data: dict[str, Any] = json.load(f)
            return data
    except (json.JSONDecodeError, OSError):
        return dict(_EMPTY_CRITIC_GATES)


def cmd_route(args: argparse.Namespace) -> int:
    """Execute route subcommand.

    Writes the routing payload into ``<cr_dir>/spawn.json`` (``route`` section)
    via ``--cr-dir``; downstream consumers (cmd_derive_spawn_spec,
    cmd_render_fleet_summary) read it from ``state["route"]``. The routing
    block is also emitted to stdout unconditionally so callers using the
    ``helpers route ... > route.json`` shell idiom continue to work.
    """
    diff_data_path: str | None = getattr(args, "diff_data", None)
    diff_data = json.load(open(diff_data_path)) if diff_data_path else json.load(sys.stdin)
    files_to_review: list[str] = diff_data.get("files_to_review", [])
    file_loc: dict[str, dict[str, int]] = diff_data.get("file_loc", {})
    total_loc: int = diff_data.get("total_loc", 0)

    critic_gates = _load_critic_gates(args.critic_gates)
    raw_mc = critic_gates.get("moduleCritics", [])
    module_critics: list[dict[str, Any]] = list(raw_mc) if isinstance(raw_mc, list) else []
    defaults = critic_gates.get("defaults", {})
    review_budget: int = int(defaults.get("reviewBudget", 2)) if isinstance(defaults, dict) else 2

    # Size category
    if total_loc <= SIZE_SMALL:
        size_category = "Small"
    elif total_loc <= SIZE_MEDIUM:
        size_category = "Medium"
    else:
        size_category = "Large"

    # Model routing — BHA impl uses Opus, test-only uses Sonnet; other agents always Sonnet
    intent: str = getattr(args, "intent", "mixed") or "mixed"
    premise_model = "opus" if intent in ("fix", "refactor", "mixed") else "sonnet"
    models: dict[str, Any] = {
        "bug_hunter_a": {"default": "opus", "test_only": "sonnet"},
        "bug_hunter_b": "sonnet",
        "unified_auditor": "sonnet",
        "premise_reviewer": premise_model,
        "fast_path_reviewer": "sonnet",
    }

    # Risk scoring for high-risk files (large diffs)
    file_scores: dict[str, int] = {}
    for filepath in files_to_review:
        score = 0
        fp_lower = filepath.lower()
        for module in module_critics:
            patterns: list[str] = module.get("patterns", [])
            for pattern in patterns:
                if pattern.lower() in fp_lower:
                    score += 2
                    break  # one match per module
        loc_info = file_loc.get(filepath, {"added": 0, "removed": 0})
        if loc_info["added"] + loc_info["removed"] > HIGH_LOC_THRESHOLD:
            score += 1
        if score > 0:
            file_scores[filepath] = score

    # Sort by score desc, then path asc
    high_risk_files = sorted(
        file_scores.keys(), key=lambda f: (-file_scores[f], f)
    )[:5]

    # Domain critics
    file_context = " ".join(files_to_review).lower()
    max_domain_critics = min(review_budget, 1)
    selected_domain_critics: list[str] = []

    for module in module_critics:
        patterns = module.get("patterns", [])
        for pattern in patterns:
            if pattern.lower() in file_context:
                critics_list: list[str] = module.get("critics", [])
                selected_domain_critics.extend(critics_list)
                break

    selected_domain_critics = sorted(set(selected_domain_critics))[:max_domain_critics]

    max_bha_agents = 9 - 3 - len(selected_domain_critics)  # 3 = BHB + Auditor + Premise

    fast_path = total_loc <= FAST_PATH_MAX_LOC

    route_payload: dict[str, Any] = {
        "size_category": size_category,
        "total_loc": total_loc,
        "fast_path": fast_path,
        "models": models,
        "high_risk_files": high_risk_files,
        "domain_critics": selected_domain_critics,
        "max_bha_agents": max_bha_agents,
    }

    # When --cr-dir is supplied, write the routing block into
    # ``spawn.json.route`` via atomic section update so a later stage's
    # write to a different section can't clobber it.
    cr_dir_arg: str | None = getattr(args, "cr_dir", None)
    if cr_dir_arg:
        _write_spawn_section(Path(cr_dir_arg), "route", route_payload)
    return _emit_summary(route_payload)


# ---------------------------------------------------------------------------
# Subcommand: validate
# ---------------------------------------------------------------------------

SEVERITY_NORMALIZE: dict[str, str] = {
    "critical": "BLOCKING",
    "high": "HIGH",
    "medium": "MEDIUM",
    "low": "DISCARD",
    "blocking": "BLOCKING",
}


def _normalize_severity(raw: str) -> tuple[str, bool]:
    """Normalize severity string. Returns (normalized, was_non_standard)."""
    lower = raw.lower().strip()
    mapped = SEVERITY_NORMALIZE.get(lower)
    if mapped:
        return mapped, False
    # Unknown → MEDIUM with warning
    return "MEDIUM", True


def _severity_to_priority(severity: str) -> int:
    """Map severity to default priority."""
    return SEVERITY_PRIORITY.get(severity, 2)


def _normalize_findings(
    raw_findings: list[dict[str, Any]],
    discarded: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, list[str]]:
    """Phase 1: Normalize severity + fill defaults. Returns (normalized, warn_count, non_standard)."""
    normalized: list[dict[str, Any]] = []
    warnings = 0
    non_standard: list[str] = []

    for finding in raw_findings:
        sev_raw = str(finding.get("severity", "MEDIUM"))
        sev, was_nonstandard = _normalize_severity(sev_raw)
        if was_nonstandard:
            warnings += 1
            if sev_raw not in non_standard:
                non_standard.append(sev_raw)

        if sev == "DISCARD":
            discarded.append({"finding": finding, "reason": "DISCARD_LOW_SEVERITY"})
            continue

        finding["severity"] = sev
        if "priority" not in finding or finding["priority"] is None:
            finding["priority"] = _severity_to_priority(sev)
        if "confidence" not in finding or finding["confidence"] is None:
            finding["confidence"] = 1.0

        normalized.append(finding)

    return normalized, warnings, non_standard


def _filter_scope_and_range(
    findings: list[dict[str, Any]],
    files_to_review: set[str],
    changed_ranges: dict[str, dict[str, list[list[int]]]],
    discarded: list[dict[str, Any]],
    *,
    out_of_hunk_confidence_floor: float = OUT_OF_HUNK_CONFIDENCE_FLOOR,
) -> list[dict[str, Any]]:
    """Filter by file scope, line range, and confidence.

    Honors ``finding_scope``:
      - ``diff`` (default): file-in-diff check applies; line-in-changed-range
        check is confidence-gated for P2+ (see below).
      - ``system`` / ``pr_metadata``: file/line checks bypassed; finding must
        carry a canonical ``system_marker``.

    Out-of-hunk P2+ semantics (in-hunk and P1 paths unchanged):
      - confidence > ``out_of_hunk_confidence_floor`` (default 0.80) →
        the finding survives and is tagged ``out_of_hunk_kept: True`` so
        presenters can distinguish in-hunk from companion-change findings
        without re-deriving the hunk membership. The validator OWNS this
        field — it's set to ``False`` on every in-hunk exit path so a
        reviewer that pre-populated the field can't trick the telemetry
        counter or downstream presenter labels.
      - confidence ≤ floor → discarded with reason
        ``DISCARD_OUT_OF_HUNK_LOW_CONFIDENCE`` (distinct from the in-hunk
        ``DISCARD_LOW_CONFIDENCE`` so the validate-summary stats keep
        them separable).

    Strict ``>`` comparison makes floor 1.0 a kill switch (reviewer
    confidence is bounded at 1.0; nothing can clear); floor 0.80 means
    confidence > 0.80 survives, ``confidence == 0.80`` discards. The
    default (0.80) is tighter than the in-hunk floor
    (CONFIDENCE_DISCARD_THRESHOLD = 0.5) because out-of-hunk findings
    must demonstrate causation, not just colocation. Operator-tunable
    via ``.closedloop-ai/settings/code-review.json``.

    Low-confidence in-hunk findings (P2+ with confidence < the in-hunk
    threshold) are still discarded with reason ``DISCARD_LOW_CONFIDENCE``.
    """
    result: list[dict[str, Any]] = []

    for finding in findings:
        # Default to diff scope when missing.
        scope = finding.get("finding_scope") or "diff"
        priority = int(finding.get("priority", 2))
        confidence = float(finding.get("confidence", 1.0))

        if scope in ("system", "pr_metadata"):
            marker = finding.get("system_marker")
            if not marker or not is_valid_system_marker(marker):
                discarded.append({"finding": finding, "reason": "DISCARD_INVALID_SYSTEM_MARKER"})
                continue
            expected_scope = system_marker_scope(marker)
            if expected_scope != scope:
                discarded.append({"finding": finding, "reason": "DISCARD_MARKER_SCOPE_MISMATCH"})
                continue
            if priority > 1 and confidence < CONFIDENCE_DISCARD_THRESHOLD:
                discarded.append({"finding": finding, "reason": "DISCARD_LOW_CONFIDENCE"})
                continue
            # system/pr_metadata findings can never be "companion-change" —
            # the field is meaningless for them. Pop any reviewer-supplied
            # value so the schema convention (present iff companion-change)
            # holds universally.
            finding.pop("out_of_hunk_kept", None)
            result.append(finding)
            continue

        # diff scope (default): apply file + line filters.
        filepath = str(finding.get("file", ""))
        if filepath not in files_to_review:
            discarded.append({"finding": finding, "reason": "DISCARD_FILE_NOT_CHANGED"})
            continue

        line = int(finding.get("line", 0))

        file_ranges = changed_ranges.get(filepath, {})
        added = file_ranges.get("added", [])
        removed = file_ranges.get("removed", [])

        in_range = _line_in_range(line, added) or _line_in_range(line, removed)
        if not in_range and priority > 1:
            # Confidence must STRICTLY EXCEED the floor (``>``, not ``>=``)
            # so ``floor=1.0`` is a real kill switch — reviewer confidence
            # is bounded at 1.0, so ``confidence > 1.0`` is impossible and
            # every out-of-hunk finding fails. Survivors get tagged so
            # presenters can label them as companion-change without
            # re-deriving hunk membership against changed_ranges.
            if confidence > out_of_hunk_confidence_floor:
                finding["out_of_hunk_kept"] = True
                result.append(finding)
            else:
                discarded.append({
                    "finding": finding,
                    "reason": "DISCARD_OUT_OF_HUNK_LOW_CONFIDENCE",
                })
            continue

        # In-hunk diff-scope path: pop any reviewer-supplied
        # ``out_of_hunk_kept`` value so the validator OWNS the field.
        # Schema convention: tag is present (and True) IFF the finding
        # is a companion-change survivor of the out-of-hunk filter; absence
        # means in-hunk. Without this pop, a reviewer that pre-populated
        # ``out_of_hunk_kept: true`` would slip through untouched and
        # inflate the kept_out_of_hunk counter + downstream presenter labels.
        if priority > 1 and confidence < CONFIDENCE_DISCARD_THRESHOLD:
            discarded.append({"finding": finding, "reason": "DISCARD_LOW_CONFIDENCE"})
            continue
        finding.pop("out_of_hunk_kept", None)
        result.append(finding)

    return result


def _merge_duplicates(
    findings: list[dict[str, Any]],
    discarded: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Phases 5-6: Duplicate merge + root-cause dedup.

    Diff-scoped findings dedup by (file, line, category|recommendation).
    System/pr_metadata findings dedup by (system_marker, category).
    """
    merged: list[dict[str, Any]] = []

    for finding in findings:
        scope = finding.get("finding_scope") or "diff"
        category = str(finding.get("category", ""))
        sev = str(finding.get("severity", "MEDIUM"))

        if scope in ("system", "pr_metadata"):
            marker = str(finding.get("system_marker", ""))
            is_dup = False
            for existing in merged:
                if (existing.get("finding_scope") or "diff") != scope:
                    continue
                if str(existing.get("system_marker", "")) != marker:
                    continue
                if str(existing.get("category", "")) != category:
                    continue
                _upgrade_severity(existing, sev, finding.get("priority", 2))
                is_dup = True
                discarded.append({"finding": finding, "reason": "DISCARD_DUPLICATE"})
                break
            if not is_dup:
                merged.append(finding)
            continue

        # diff scope (default)
        filepath = str(finding.get("file", ""))
        line = int(finding.get("line", 0))
        recommendation = str(finding.get("recommendation", ""))

        is_dup = False
        for existing in merged:
            if (existing.get("finding_scope") or "diff") != "diff":
                continue
            ex_file = str(existing.get("file", ""))
            if ex_file != filepath:
                continue
            ex_line = int(existing.get("line", 0))
            if abs(ex_line - line) > LINE_TOLERANCE:
                continue
            ex_cat = str(existing.get("category", ""))
            ex_rec = str(existing.get("recommendation", ""))

            if ex_cat == category or (recommendation and ex_rec == recommendation):
                _upgrade_severity(existing, sev, finding.get("priority", 2))
                is_dup = True
                discarded.append({"finding": finding, "reason": "DISCARD_DUPLICATE"})
                break

        if not is_dup:
            merged.append(finding)

    # Root-cause dedup via Jaccard similarity (diff-scoped findings only).
    final: list[dict[str, Any]] = []
    for finding in merged:
        if (finding.get("finding_scope") or "diff") != "diff":
            final.append(finding)
            continue

        issue = str(finding.get("issue", ""))
        filepath = str(finding.get("file", ""))
        line = int(finding.get("line", 0))
        sev = str(finding.get("severity", "MEDIUM"))

        is_root_dup = False
        for existing in final:
            if (existing.get("finding_scope") or "diff") != "diff":
                continue
            ex_file = str(existing.get("file", ""))
            ex_line = int(existing.get("line", 0))
            if ex_file == filepath and abs(ex_line - line) <= LINE_TOLERANCE:
                ex_issue = str(existing.get("issue", ""))
                if _jaccard_similarity(issue, ex_issue) > JACCARD_DEDUP_THRESHOLD:
                    _upgrade_severity(existing, sev, finding.get("priority", 2))
                    is_root_dup = True
                    discarded.append({"finding": finding, "reason": "DISCARD_DUPLICATE"})
                    break

        if not is_root_dup:
            final.append(finding)

    return final


def _group_cross_file(
    findings: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Cross-file root-cause grouping.

    Groups diff-scoped findings across different files that share the same
    category and similar issue text (Jaccard > threshold). Keeps the
    highest-severity finding as primary and attaches others as
    ``other_locations``. Non-diff findings pass through untouched.
    """
    absorbed: set[int] = set()
    result: list[dict[str, Any]] = []

    for i, finding in enumerate(findings):
        if i in absorbed:
            continue

        # Skip cross-file grouping for system/pr_metadata findings.
        if (finding.get("finding_scope") or "diff") != "diff":
            result.append(finding)
            continue

        category = str(finding.get("category", ""))
        issue = str(finding.get("issue", ""))

        # Collect cross-file siblings (diff-scoped only)
        siblings: list[tuple[int, dict[str, Any]]] = []
        for j in range(i + 1, len(findings)):
            if j in absorbed:
                continue
            other = findings[j]
            if (other.get("finding_scope") or "diff") != "diff":
                continue
            if str(other.get("category", "")) != category:
                continue
            if _jaccard_similarity(issue, str(other.get("issue", ""))) > JACCARD_DEDUP_THRESHOLD:
                siblings.append((j, other))

        if not siblings:
            result.append(finding)
            continue

        # Pick the highest-severity finding as primary
        all_in_group: list[tuple[int, dict[str, Any]]] = [(i, finding)] + siblings
        all_in_group.sort(
            key=lambda x: SEVERITY_PRIORITY.get(str(x[1].get("severity", "MEDIUM")), 2)
        )

        _, primary = all_in_group[0]
        locations: list[dict[str, Any]] = []
        for _idx, member in all_in_group[1:]:
            locations.append({
                "file": str(member.get("file", "")),
                "line": int(member.get("line", 0)),
                "severity": str(member.get("severity", "MEDIUM")),
            })

        # Absorb ALL group indices (prevents re-processing the primary
        # when it came from a sibling rather than the current index i)
        for idx, _ in all_in_group:
            absorbed.add(idx)

        primary["other_locations"] = locations
        result.append(primary)

    return result


def _upgrade_severity(existing: dict[str, Any], new_sev: str, new_priority: Any) -> None:
    """Upgrade existing finding's severity if new one is higher."""
    ex_sev = str(existing.get("severity", "MEDIUM"))
    if SEVERITY_PRIORITY.get(new_sev, 2) < SEVERITY_PRIORITY.get(ex_sev, 2):
        existing["severity"] = new_sev
        existing["priority"] = new_priority


def cmd_validate(args: argparse.Namespace) -> int:
    """Execute validate subcommand."""
    with open(args.findings) as f:
        findings_data = json.load(f)
    with open(args.diff_data) as f:
        diff_data = json.load(f)

    raw_findings: list[dict[str, Any]] = (
        findings_data if isinstance(findings_data, list)
        else findings_data.get("findings", [])
    )
    files_to_review: set[str] = set(diff_data.get("files_to_review", []))
    changed_ranges: dict[str, dict[str, list[list[int]]]] = diff_data.get("changed_ranges", {})

    # Read the operator-tunable out-of-hunk confidence floor from
    # code-review.json (same file that hosts bha_unified_threshold_loc).
    # Settings path is overridable via --settings for test isolation;
    # falls back to the canonical repo-root location otherwise.
    settings_path = Path(
        getattr(args, "settings", None) or _CODE_REVIEW_SETTINGS_DEFAULT_PATH,
    )
    code_review_settings = _load_code_review_settings(settings_path)
    out_of_hunk_floor = float(
        code_review_settings.get(
            "out_of_hunk_confidence_floor", OUT_OF_HUNK_CONFIDENCE_FLOOR,
        ),
    )

    discarded: list[dict[str, Any]] = []
    total_input = len(raw_findings)

    normalized, normalization_warnings, non_standard_values = _normalize_findings(
        raw_findings, discarded
    )
    filtered = _filter_scope_and_range(
        normalized, files_to_review, changed_ranges, discarded,
        out_of_hunk_confidence_floor=out_of_hunk_floor,
    )
    # Count out-of-hunk findings that survived the confidence floor.
    # Counted on ``filtered`` (post-filter, pre-grouping) because
    # ``_group_cross_file`` absorbs sibling findings into the primary's
    # ``other_locations`` where the ``out_of_hunk_kept`` tag is lost;
    # post-grouping would silently undercount companion-change findings
    # that happened to be grouped with another.
    kept_out_of_hunk = sum(
        1 for f in filtered if f.get("out_of_hunk_kept") is True
    )

    deduped = _merge_duplicates(filtered, discarded)
    validated = _group_cross_file(deduped)

    cross_file_grouped = sum(
        len(f.get("other_locations", [])) for f in validated
    )

    stats = {
        "total_input": total_input,
        "validated": len(validated),
        "cross_file_grouped": cross_file_grouped,
        "kept_out_of_hunk": kept_out_of_hunk,
        "discarded_file_not_changed": sum(1 for d in discarded if d["reason"] == "DISCARD_FILE_NOT_CHANGED"),
        "discarded_out_of_hunk_low_confidence": sum(
            1 for d in discarded
            if d["reason"] == "DISCARD_OUT_OF_HUNK_LOW_CONFIDENCE"
        ),
        "discarded_low_confidence": sum(1 for d in discarded if d["reason"] == "DISCARD_LOW_CONFIDENCE"),
        "discarded_low_severity": sum(1 for d in discarded if d["reason"] == "DISCARD_LOW_SEVERITY"),
        "discarded_duplicate": sum(1 for d in discarded if d["reason"] == "DISCARD_DUPLICATE"),
        "out_of_hunk_confidence_floor": out_of_hunk_floor,
    }

    json.dump(
        {
            "validated": validated,
            "discarded": discarded,
            "normalization_warnings": normalization_warnings,
            "non_standard_values": non_standard_values,
            "stats": stats,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommands: verify-prepare / verify-consolidate (PLN-722)
# ---------------------------------------------------------------------------
#
# Pipeline placement (foundation stage_23_verify_findings is an agent_fleet
# stage; the two helpers below wrap it):
#
#   stage_22  cmd_validate              → findings_validated.json
#   stage_22b cmd_verify_prepare        → verify_manifest.json + per-finding inputs
#   stage_23  Verifier Fleet (agents)   → agent_verifier_<finding_id>.json
#   stage_24a cmd_verify_consolidate    → findings_verified.json (bucket-split)
#   stage_25  cmd_finalize_result       → review_result.json envelope
#
# "What gets verified" tier table (PLN-722 §Architecture):
#
#   | Tier                          | Verified? |
#   | BLOCKING / HIGH               | Always    |
#   | MEDIUM, confidence < 0.85     | Yes       |
#   | MEDIUM, confidence ≥ 0.85     | No        |
#   | LOW (P3)                      | No        |
#   | category=Hygiene              | No (deterministic producer) |
#   | source=injection-detector     | No (deterministic producer) |
#   | category=Premise              | Always (strict adversarial framing) |
#
# MAX_VERIFICATIONS = 50 (PLN-722: 50 × Sonnet ≈ $2/PR at current pricing).
# Overflow ranks by (severity_weight × confidence) and tags the bottom of
# the list as "deferred for verification budget" — they're surfaced in
# pending_verification[] so operators can re-run via /start --verify-deferred
# in plan 03 follow-up work.

VERIFY_MAX_VERIFICATIONS = 50

# Severity → weight for ranking when MAX_VERIFICATIONS is exceeded. Higher
# = more likely to retain a verification slot.
_VERIFY_SEVERITY_WEIGHT: dict[str, float] = {
    "BLOCKING": 1.0,
    "HIGH": 0.7,
    "MEDIUM": 0.4,
    "LOW": 0.1,
}

# Verifier model selection (PLN-722 §Model selection). v1 routes everything
# to Sonnet — cost-bounded for the common case (BHB/Auditor/critics) and
# cross-model-independent for Opus-produced BHA findings. Future revisions
# may split this back out per original-reviewer model; the routing lives
# in _select_verifier_model so callers don't need to know the policy.
_VERIFY_MODEL_DEFAULT = "sonnet"


def _verification_cache_key(
    finding: dict[str, Any], model: str, prompt_hash: str,
) -> str:
    """Cache key for the verifications namespace.

    Per PLN-722 §Cache integration: keyed by ``(finding_id,
    file_content_hash, verifier_model, verifier_prompt_hash)``. We use the
    finding's ``code_snippet`` field as the file-content proxy — when the
    code at the cited location changes, the reviewer re-emits a different
    snippet, so the key flips and the cached verdict is invalidated.
    Coarse but correct: false-misses (re-pay verifier cost) are tolerable;
    false-hits (re-use a stale verdict) would be a correctness bug.
    """
    fid = str(finding.get("id", ""))
    snippet = str(finding.get("code_snippet", ""))
    payload = (
        fid + "\0"
        + hashlib.sha256(snippet.encode("utf-8", "replace")).hexdigest() + "\0"
        + model + "\0"
        + (prompt_hash or "")
    )
    return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()


def _verifications_cache_path(cache_dir: Path, key: str) -> Path:
    """Per PLN-719 namespace layout: ``<cache_dir>/verifications/<key>.json``."""
    return cache_dir / CACHE_NAMESPACE_VERIFICATIONS / f"{key}.json"


# ---------------------------------------------------------------------------
# PLN-773 Phase 6 — pending-learnings jsonl writer (with fcntl.flock)
# ---------------------------------------------------------------------------

_PENDING_LEARNINGS_DIR = Path(".closedloop-ai/pending-learnings")
_PENDING_LEARNINGS_PREMISE = "premise-justifications.jsonl"
_PENDING_LEARNINGS_OVERRIDES = "verifier-overrides.jsonl"


def _pending_learnings_append(
    path: Path, payload: dict[str, Any],
) -> bool:
    """Append one ``json.dumps(payload)`` line to a jsonl file under exclusive
    ``fcntl.flock``. Concurrent writers each get exactly one line.

    Fail-open: any I/O error returns False without raising so the caller
    can continue. The pending-learnings stream is observational, not a
    source of truth — a missed event is acceptable; a crashed pipeline
    is not.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    lock_path = path.with_suffix(path.suffix + ".lock")
    try:
        import fcntl
    except ImportError:
        # No flock (Windows, etc.) — best-effort append without locking.
        try:
            with open(path, "a") as fh:
                fh.write(json.dumps(payload) + "\n")
            return True
        except OSError:
            return False

    try:
        with open(lock_path, "w") as lock_fd:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                with open(path, "a") as fh:
                    fh.write(json.dumps(payload) + "\n")
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# PLN-773 Phase 3 — operator override cache namespace
# ---------------------------------------------------------------------------

# Number of context lines on either side of the cited line that participate
# in the file-content hash. Mirrors the verifier prompt's EXISTENCE-check
# window (±20) so an override is invalidated by the same kind of change
# that would otherwise force the verifier to re-evaluate.
_OVERRIDE_CONTEXT_LINES = 20

# Sentinel value stored in ``file_content_hash`` for system-scoped findings
# (no file/line). There is no file content to drift against, so the override
# is always honored as long as the TTL has not expired. Without the
# sentinel ``_file_content_hash`` would return "" and the override would
# be silently dropped at promotion time (PR #114 review HIGH).
_OVERRIDE_SYSTEM_SCOPE_SENTINEL = "SYSTEM_SCOPE"


def _override_cache_path(cache_dir: Path, finding_id: str) -> Path:
    """``<cache_dir>/overrides/<finding_id>.json``."""
    return cache_dir / CACHE_NAMESPACE_OVERRIDES / f"{finding_id}.json"


def _file_content_hash(cr_dir: Path, file: str | None, line: int | None) -> str:
    """SHA-256 of the cited file's content within ±20 lines of ``line``.

    Returns "" for system-scoped findings (no file/line). Returns "" when
    the file is unreadable or the line is out of range — callers treat
    "" as "cannot match"; the override is auto-invalidated rather than
    silently accepted.

    The hash window matches the verifier's EXISTENCE-check window
    (verifier_prompt.txt §1) so an override is invalidated by exactly the
    kind of change that would force the verifier to re-evaluate.
    """
    if not file or not line:
        return ""
    # Resolve against cr_dir's parent (the repo root); cr_dir lives at
    # ``.closedloop-ai/code-review/cr-<N>`` so the repo root is three
    # levels up. Callers in tests pass an absolute path to a tmp_path
    # so this resolution does not need to be perfect — the helper just
    # needs to find the file given a relative path from repo root.
    candidate = Path(file)
    if not candidate.is_absolute():
        # cr_dir → repo root is three parents above (.closedloop-ai/code-review/cr-*).
        # Fall back to cwd if the structure doesn't match.
        repo_root = cr_dir
        for _ in range(3):
            if repo_root.parent != repo_root:
                repo_root = repo_root.parent
        candidate = repo_root / file
        if not candidate.exists():
            candidate = Path.cwd() / file
    try:
        with open(candidate) as fh:
            lines = fh.readlines()
    except OSError:
        return ""
    if line < 1 or line > len(lines):
        return ""
    start = max(0, line - 1 - _OVERRIDE_CONTEXT_LINES)
    end = min(len(lines), line + _OVERRIDE_CONTEXT_LINES)
    window = "".join(lines[start:end])
    return hashlib.sha256(window.encode("utf-8", "replace")).hexdigest()


def _load_override(
    cache_dir: Path | None, finding_id: str,
) -> dict[str, Any] | None:
    """Read ``<cache_dir>/overrides/<finding_id>.json`` or None.

    Returns None on missing/malformed. The override flow (PLN-773 Phase 4)
    writes these files; `cmd_verify_prepare` checks them BEFORE the
    verifications/ cache so an override short-circuits verification.
    """
    if cache_dir is None:
        return None
    path = _override_cache_path(cache_dir, finding_id)
    data = _read_optional_json(path, None)
    if not isinstance(data, dict):
        return None
    if not data.get("finding_id"):
        return None
    return data


def _override_is_expired(override: dict[str, Any]) -> bool:
    """True when the override is older than ``CACHE_TTL_DAYS["overrides"]``.

    Added in the PR #114 review pass — the 90-day TTL was declared in
    ``CACHE_TTL_DAYS`` but never enforced; both ``_load_override`` and
    ``_override_is_valid`` only checked the content hash. Sweep-on-read
    here keeps the override namespace consistent with verifications/ and
    signals/ where TTL is the only freshness signal.

    Returns False (allow honor) when ``asserted_at`` is missing or
    unparseable — defensive: a missing timestamp predates this enforcement
    and should not silently drop a still-valid operator override. Callers
    that need a stricter contract should reject overrides that fail to
    write ``asserted_at`` at write time, not at read time.
    """
    asserted_at = override.get("asserted_at")
    if not isinstance(asserted_at, str) or not asserted_at:
        return False
    ttl_days = cache_ttl_days(CACHE_NAMESPACE_OVERRIDES)
    if not ttl_days or ttl_days <= 0:
        return False
    try:
        # ``cmd_re_assert`` writes ISO-8601 UTC timestamps via
        # ``datetime.now(timezone.utc).isoformat()``. ``fromisoformat``
        # in Python 3.11+ accepts the "+00:00" / "Z" suffixes.
        normalized = asserted_at.replace("Z", "+00:00")
        ts = datetime.fromisoformat(normalized)
    except ValueError:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - ts
    return age.days > ttl_days


def _override_is_valid(
    override: dict[str, Any], finding: dict[str, Any], cr_dir: Path,
) -> bool:
    """Override survives only while the cited file content matches.

    Recomputes ``_file_content_hash`` against the file at HEAD and compares
    against the hash stored at override-write time. Any drift → override
    auto-invalidated (caller logs the event and falls through to the
    standard verifier flow).

    System-scoped findings (no file/line at re-assert time) bypass the
    content-hash gate via the ``SYSTEM_SCOPE`` sentinel; there is no file
    to drift against, so only the TTL gates the override.

    TTL gate (PR #114 review) — overrides older than
    ``CACHE_TTL_DAYS["overrides"]`` (90 days) are dropped. Both the
    content-hash and system-scope paths run through it so stale operator
    opinions cannot resurrect indefinitely after the underlying finding's
    context has presumably moved on.
    """
    stored = str(override.get("file_content_hash", ""))
    if not stored:
        # Override has no hash anchor — refuse to honor it (defensive;
        # writers in Phase 4 always store the hash).
        return False
    if _override_is_expired(override):
        return False
    if stored == _OVERRIDE_SYSTEM_SCOPE_SENTINEL:
        # System-scoped override — honor regardless of file/line because
        # there's nothing to drift. Defensive: still require the finding
        # itself to lack file/line so a malformed override cannot promote
        # a file-scoped finding it was never written against.
        return not finding.get("file") and not finding.get("line")
    current = _file_content_hash(
        cr_dir, finding.get("file"), finding.get("line"),
    )
    return current != "" and current == stored


def _write_override(
    cache_dir: Path | None, payload: dict[str, Any],
) -> Path | None:
    """Atomically write ``<cache_dir>/overrides/<finding_id>.json``.

    Returns the path on success, None when ``cache_dir`` is None or the
    write fails. Atomic via tmp + ``os.replace`` so a crash mid-write
    cannot leave a half-written override on disk.
    """
    if cache_dir is None:
        return None
    finding_id = str(payload.get("finding_id", ""))
    if not finding_id:
        return None
    path = _override_cache_path(cache_dir, finding_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    try:
        with open(tmp, "w") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, path)
    except OSError:
        return None
    return path


def _synthesize_re_asserted_verifier_output(
    finding: dict[str, Any], override: dict[str, Any], output_path: Path,
) -> bool:
    """Write a ``RE_ASSERTED`` verifier-output stub so verify-consolidate
    treats the override as a fresh CONFIRMED-equivalent verdict.

    The synthetic output mirrors the shape ``cmd_verify_consolidate``
    expects from a real verifier agent so no branch in the consolidator
    needs to special-case the override path. Returns True on success.
    """
    payload = {
        "finding_id": finding.get("id"),
        "verifier_verdict": "RE_ASSERTED",
        "verifier_severity": None,
        "verifier_confidence": 1.0,
        "verifier_reasoning": (
            f"Operator override ({override.get('override', 'RE_ASSERT')}). "
            f"Asserted at {override.get('asserted_at', 'unknown')}. "
            f"Reason: {override.get('reason') or 'not provided'}."
        ),
        "evidence_checks": [
            {
                "claim": "operator override on file:line",
                "expected": "file content hash matches stored override",
                "actual_read": override.get("file_content_hash", ""),
                "verified": True,
                "source": (
                    f"{finding.get('file', '?')}:{finding.get('line', '?')}"
                ),
            },
        ],
        "rejection_class": None,
    }
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as fh:
            json.dump(payload, fh, indent=2)
    except OSError:
        return False
    return True


def _read_cached_verification(
    cache_dir: Path | None, finding: dict[str, Any],
    model: str, prompt_hash: str,
) -> dict[str, Any] | None:
    """Return the cached verifier output for ``finding`` or None.

    Lazy TTL: entries older than ``cache_ttl_days('verifications')`` (30)
    are treated as a cache miss and silently swept. The cache is purely
    a cost optimization — missing or malformed entries never block the
    pipeline.
    """
    if cache_dir is None:
        return None
    key = _verification_cache_key(finding, model, prompt_hash)
    path = _verifications_cache_path(cache_dir, key)
    if not path.exists():
        return None
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    # TTL check: cached_at must be present and within the window;
    # malformed/missing → miss + unlink.
    cached_at = data.get("cached_at")
    ttl = cache_ttl_days(CACHE_NAMESPACE_VERIFICATIONS) or 30
    try:
        ts = datetime.fromisoformat(str(cached_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        try:
            path.unlink()
        except OSError:
            pass
        return None
    if datetime.now(timezone.utc) - ts > timedelta(days=ttl):
        try:
            path.unlink()
        except OSError:
            pass
        return None
    verdict_data = data.get("verdict")
    if not isinstance(verdict_data, dict):
        return None
    return verdict_data


def _write_cached_verification(
    cache_dir: Path | None, finding: dict[str, Any],
    model: str, prompt_hash: str, verdict_data: dict[str, Any],
) -> None:
    """Persist a fresh verifier output under the verifications namespace.

    Best-effort: any OSError silently drops the write (the cache is an
    optimization, not a source of truth). Atomic via tmp + rename to
    avoid partial files leaking across runs.
    """
    if cache_dir is None:
        return
    if not isinstance(verdict_data, dict):
        return
    verdict_only = verdict_data.get("verifier_verdict")
    if verdict_only not in VERIFIER_VERDICTS:
        return
    key = _verification_cache_key(finding, model, prompt_hash)
    path = _verifications_cache_path(cache_dir, key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w") as fh:
            json.dump(
                {
                    "cached_at": datetime.now(timezone.utc).isoformat(),
                    "key": key,
                    "finding_id": finding.get("id"),
                    "verifier_model": model,
                    "verifier_prompt_hash": prompt_hash,
                    "verdict": verdict_data,
                },
                fh,
                indent=2,
            )
        os.replace(str(tmp), str(path))
    except OSError:
        pass


def _verification_priority(finding: dict[str, Any]) -> float:
    """Risk score for verification-budget ranking: severity_weight × confidence."""
    sw = _VERIFY_SEVERITY_WEIGHT.get(str(finding.get("severity", "")), 0.0)
    try:
        conf = float(finding.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    return sw * conf


def _needs_verification(finding: dict[str, Any]) -> bool:
    """Apply the PLN-722 'What gets verified' tier table to one finding.

    Out-of-hunk findings (``out_of_hunk_kept: True``) ALWAYS verify
    regardless of confidence. Their causal claim — that the diff broke
    nearby unchanged code — is exactly the cross-region reasoning LLM
    reviewers are weakest on, so the high-confidence MEDIUM skip rule
    (confidence ≥ 0.85 → no verification) is the wrong default for them.
    """
    category = str(finding.get("category", ""))
    source = str(finding.get("source", ""))
    severity = str(finding.get("severity", ""))
    try:
        confidence = float(finding.get("confidence", 0.0) or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0

    # Deterministic producers — never verified (the verifier would be
    # second-guessing a regex catalogue or a static check).
    if category == "Hygiene":
        return False
    if source == "injection-detector":
        return False

    # Out-of-hunk-kept backstop: every such finding gets verified.
    # Placed after the deterministic-producer guards (Hygiene findings
    # never carry the tag in practice, but the ordering keeps the
    # never-verify producers absolute) and before the severity tiers
    # so confidence-based skips don't apply.
    if finding.get("out_of_hunk_kept") is True:
        return True

    # Premise: always verified with the strict adversarial framing in
    # verifier_prompt.txt — the verdict precedence already gives Premise
    # a high blast radius (cumulative MEDIUM gate in PLN-721), so every
    # Premise finding needs an independent second opinion.
    if category == "Premise":
        return True

    if severity in ("BLOCKING", "HIGH"):
        return True

    if severity == "MEDIUM":
        return confidence < 0.85

    # LOW (P3) and anything unrecognized: skip verification.
    return False


def _select_verifier_model(finding: dict[str, Any]) -> str:
    """Pick the verifier model for a finding (currently uniform)."""
    # finding is intentionally unused — the function is the single
    # routing seam for when v2 splits Opus-cross-verification back out.
    del finding
    return _VERIFY_MODEL_DEFAULT


def cmd_verify_prepare(args: argparse.Namespace) -> int:
    """Tier-select findings for verification and emit per-finding inputs.

    PLN-722 stage_22b. Reads ``findings_validated.json`` (or any input
    shaped as ``{"validated": [...]}`` / ``{"findings": [...]}`` / bare
    list), applies the "What gets verified" tier rules, ranks the eligible
    set by ``severity_weight × confidence``, caps at
    ``VERIFY_MAX_VERIFICATIONS``, and writes:

      - ``<cr_dir>/verify_manifest.json`` (also printed to stdout):
        ``{
            "to_verify": [{"finding_id", "model", "input_path", ...}, ...],
            "skipped_no_verification": [...],
            "deferred_budget": [...],
            "max_verifications": int,
            "total_eligible": int,
            "verifier_prompt_path": str
          }``

      - ``<cr_dir>/verifier_inputs/<finding_id>.json`` per eligible finding,
        containing the canonical finding + the path the verifier should
        write its verdict to (``<cr_dir>/agent_verifier_<finding_id>.json``).

    Always exits 0; an empty validated set produces an empty manifest. The
    walker's Verifier Fleet section spawns one ``code:code-review-worker``
    Task per ``to_verify`` entry; each agent reads its input file and
    writes its verdict to the canonical output path.
    """
    cr_dir = Path(args.cr_dir)
    findings_path = Path(args.findings)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    prompt_hash = str(getattr(args, "prompt_hash", "") or "")
    # Read partitions.json (written by ``cmd_partition`` at stage_17)
    # so the verify manifest can surface partition mode + count for
    # downstream consumers (presenters, stats split). Defensive: absent
    # file → unknown mode, partition_count=0 (legitimate state for
    # hygiene-only runs or older caches).
    partitions_meta = _read_optional_json(cr_dir / "partitions.json", None)
    partition_mode = "unknown"
    partition_count = 0
    if isinstance(partitions_meta, dict):
        raw_mode = partitions_meta.get("partition_mode")
        if isinstance(raw_mode, str) and raw_mode in {"unified", "partitioned"}:
            partition_mode = raw_mode
        raw_count = partitions_meta.get("partition_count")
        if isinstance(raw_count, int) and raw_count >= 0:
            partition_count = raw_count

    data = _read_optional_json(findings_path, {})
    if isinstance(data, dict):
        raw = data.get("validated") or data.get("findings") or []
    elif isinstance(data, list):
        raw = data
    else:
        raw = []

    findings: list[dict[str, Any]] = [
        f for f in raw if isinstance(f, dict) and f.get("id")
    ]
    finding_by_id: dict[str, dict[str, Any]] = {
        str(f["id"]): f for f in findings
    }

    eligible: list[dict[str, Any]] = []
    skipped: list[str] = []
    for f in findings:
        fid = str(f["id"])
        if _needs_verification(f):
            eligible.append({
                "finding_id": fid,
                "model": _select_verifier_model(f),
                "severity": f.get("severity"),
                "confidence": f.get("confidence"),
                "category": f.get("category"),
                "_priority_score": _verification_priority(f),
            })
        else:
            skipped.append(fid)

    # Rank by priority; stable secondary sort by finding_id so a tie
    # doesn't make the cutoff non-deterministic across runs (cache
    # invalidation cares about ordering).
    eligible.sort(key=lambda e: (-e["_priority_score"], e["finding_id"]))

    deferred: list[str] = []
    if len(eligible) > VERIFY_MAX_VERIFICATIONS:
        deferred = [e["finding_id"] for e in eligible[VERIFY_MAX_VERIFICATIONS:]]
        eligible = eligible[:VERIFY_MAX_VERIFICATIONS]

    inputs_dir = cr_dir / "verifier_inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    verifier_prompt_path = cr_dir / "verifier_prompt.txt"

    to_verify: list[dict[str, Any]] = []
    cache_hits: list[str] = []
    override_hits: list[str] = []
    override_invalidated: list[str] = []
    for entry in eligible:
        fid = entry["finding_id"]
        finding = finding_by_id[fid]
        output_path = cr_dir / f"agent_verifier_{fid}.json"

        # PLN-773 Phase 3 — operator override has precedence over the
        # verifications/ cache. Check overrides FIRST; if one exists and
        # the file-content hash still matches, synthesize a RE_ASSERTED
        # verifier output and skip both the cache check and the agent
        # spawn entirely. Hash drift invalidates the override silently
        # (logged on the manifest); the verifier then runs normally.
        override = _load_override(cache_dir, fid)
        if override is not None:
            if _override_is_valid(override, finding, cr_dir):
                if _synthesize_re_asserted_verifier_output(
                    finding, override, output_path,
                ):
                    override_hits.append(fid)
                    continue
            else:
                override_invalidated.append(fid)
                # Fall through to standard verification.

        # Cache check — if we have a fresh verdict for this exact
        # (finding_id, snippet_hash, model, prompt_hash) tuple, materialize
        # the cached verdict at the canonical output path and skip
        # spawning the agent. cmd_verify_consolidate reads the same file
        # regardless of source.
        cached = _read_cached_verification(
            cache_dir, finding, entry["model"], prompt_hash,
        )
        if cached is not None:
            try:
                with open(output_path, "w") as fh:
                    json.dump(cached, fh, indent=2)
                cache_hits.append(fid)
                continue
            except OSError:
                # Fall through to spawn if materializing the cache hit
                # fails; the verifier will re-derive and the write-back
                # in verify-consolidate will refresh the entry.
                pass

        input_path = inputs_dir / f"{fid}.json"
        with open(input_path, "w") as fh:
            json.dump(
                {
                    "finding": finding,
                    "verifier_prompt_path": str(verifier_prompt_path),
                    "output_path": str(output_path),
                },
                fh,
                indent=2,
            )
        to_verify.append({
            "finding_id": fid,
            "model": entry["model"],
            "severity": entry["severity"],
            "confidence": entry["confidence"],
            "category": entry["category"],
            "input_path": str(input_path),
            "output_path": str(output_path),
        })

    manifest = {
        "to_verify": to_verify,
        "skipped_no_verification": skipped,
        "deferred_budget": deferred,
        "cache_hits": cache_hits,
        # PLN-773 Phase 3 — operator override telemetry. ``override_hits``
        # are findings whose verification was short-circuited by a stored
        # override; ``override_invalidated`` are findings whose override
        # was rejected on file-content drift and ran normal verification.
        "override_hits": override_hits,
        "override_invalidated": override_invalidated,
        # Partition-mode telemetry propagated from partitions.json
        # (stage_17). Surfaces in the presenter footers and drives the
        # per-reviewer FP-rate split (BHA findings get bucketed by
        # partition id only when ``partition_mode == "partitioned"``).
        "partition_mode": partition_mode,
        "partition_count": partition_count,
        "max_verifications": VERIFY_MAX_VERIFICATIONS,
        "total_eligible": (
            len(to_verify) + len(deferred) + len(cache_hits) + len(override_hits)
        ),
        "verifier_prompt_path": str(verifier_prompt_path),
    }

    # Always also persist the manifest at a deterministic path so the
    # walker can read it without parsing stdout. cmd_validate emits via
    # stdout-redirect; we mirror the pattern.
    manifest_path = cr_dir / "verify_manifest.json"
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# PLN-774: Operator-tunable code-review behavior settings (currently the
# BHA unified-partition threshold; future knobs land here too). Absent or
# malformed file → built-in defaults.
_CODE_REVIEW_SETTINGS_DEFAULT_PATH = Path(".closedloop-ai/settings/code-review.json")

# Sensitive-path config (PLN-722 §Sensitive-path escalation). Absent file
# = no escalation; bootstrap does NOT auto-generate per `00-discovery.md`.
_VERIFICATION_GATES_DEFAULT_PATH = Path(".closedloop-ai/settings/verification-gates.json")

# PLN-721 Phase 4: Premise cumulative-MEDIUM verdict gate. Operator-overridable
# via ``.closedloop-ai/settings/verdict-thresholds.json``; absent/malformed →
# the default fires at 3 (matches the plan's design intent: "a single MEDIUM
# does not block; three MEDIUM Premise findings on the same PR signal the
# patch is structurally wrong even when no individual line is dangerous").
_VERDICT_THRESHOLDS_DEFAULT_PATH = Path(".closedloop-ai/settings/verdict-thresholds.json")
_VERDICT_PREMISE_MEDIUM_THRESHOLD_DEFAULT = 3
# PLN-773 Premise justification rate alert. Fires when the share of
# Premise findings carrying author justification crosses the threshold
# (PLN-721 §Telemetry: "if > ~30%, authors likely gaming the hatch").
# Operator-tunable via the same verdict-thresholds.json config.
_VERDICT_JUSTIFICATION_RATE_ALERT_DEFAULT = 0.30
_VERDICT_THRESHOLD_KEYS: tuple[str, ...] = (
    "premise_cumulative_medium",
    "justification_rate_alert",
)


def _load_optional_settings_dict(
    path: Path | None, defaults: dict[str, Any],
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Open an optional operator-authored settings JSON file.

    Shared frame for ``_load_verdict_thresholds`` and
    ``_load_verification_gates``. Returns:

      - ``(None, fresh_defaults)`` when ``path`` is None, missing, or
        the file does not contain a top-level JSON object — caller
        returns ``fresh_defaults`` directly.
      - ``(data, fresh_defaults)`` otherwise — caller layers per-key
        validation on top by reading from ``data`` and overwriting
        ``fresh_defaults`` entries when the value is accepted.

    ``fresh_defaults`` is a per-call shallow copy with list values
    deep-copied so callers may mutate it without affecting future
    invocations.
    """
    fresh: dict[str, Any] = {
        k: (list(v) if isinstance(v, list) else v)
        for k, v in defaults.items()
    }
    if path is None:
        return None, fresh
    data = _read_optional_json(path, None)
    if not isinstance(data, dict):
        return None, fresh
    return data, fresh


def _load_verdict_thresholds(path: Path | None) -> dict[str, Any]:
    """Read verdict-thresholds.json. Absent or malformed → built-in defaults.

    Returns a dict with the canonical keys present:

      - ``premise_cumulative_medium`` (int, ≥ 1): MEDIUM Premise count
        gate. Default 3.
      - ``justification_rate_alert`` (float, [0.0, 1.0]): threshold above
        which the justification-rate footer flips to ALERT. Default 0.30.

    Unknown keys are ignored. Invalid entries (wrong type, out of range)
    fall back to the default — the file is operator-authored and should
    not crash the pipeline on a typo or a "0" that would disable a gate
    entirely (use a very large number / 1.0 for that respectively).
    """
    defaults: dict[str, Any] = {
        "premise_cumulative_medium": _VERDICT_PREMISE_MEDIUM_THRESHOLD_DEFAULT,
        "justification_rate_alert": _VERDICT_JUSTIFICATION_RATE_ALERT_DEFAULT,
    }
    data, out = _load_optional_settings_dict(path, defaults)
    if data is None:
        return out
    # Per-key validation (each threshold has its own range constraints).
    raw_pm = data.get("premise_cumulative_medium")
    if isinstance(raw_pm, int) and not isinstance(raw_pm, bool) and raw_pm >= 1:
        out["premise_cumulative_medium"] = raw_pm
    raw_jr = data.get("justification_rate_alert")
    if (
        isinstance(raw_jr, (int, float))
        and not isinstance(raw_jr, bool)
        and 0.0 <= float(raw_jr) <= 1.0
    ):
        out["justification_rate_alert"] = float(raw_jr)
    return out

_VERIFICATION_GATE_KEYS: tuple[str, ...] = (
    # REJECTED on this path + BLOCKING/HIGH severity → TENTATIVE
    # (severity capped at HIGH; rejection_class cleared).
    "sensitive_paths",
    # Any verdict on this path → TENTATIVE (rejection_class cleared if
    # the lift came from REJECTED so the finding stops claiming both
    # "disproved" and "legitimate" simultaneously).
    "tentative_on_paths",
    # Any verdict on this path → TENTATIVE + force_human_review=True,
    # which propagates to NEEDS_ATTENTION via _compute_canonical_verdict
    # rule 2.5.
    "mandatory_human_review_paths",
)


def _glob_to_regex(pattern: str) -> re.Pattern[str]:
    """Translate a glob with ``**`` support to a compiled regex.

    Supports the three patterns used by ``verification-gates.json`` per
    PLN-722's documented examples (``lib/auth/**``, ``**/migrations/**``,
    ``**/credentials.*``):

      * ``**/`` at the start  → optional path prefix (any depth)
      * ``/**`` at the end    → optional path suffix (any depth)
      * ``**`` in the middle  → any characters across segments
      * ``*``                 → any chars except ``/``
      * ``?``                 → single char except ``/``
      * literal ``.``         → escaped

    The matching is forward-slash-only (we never feed Windows-style paths
    into this — the producers all use POSIX paths inside the repo).
    """
    parts: list[str] = []
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        # Handle `**/` as optional prefix at start of segment.
        if pattern[i:i + 3] == "**/":
            parts.append("(?:.*/)?")
            i += 3
        # Handle trailing `/**` as optional suffix.
        elif pattern[i:i + 3] == "/**" and i + 3 == n:
            parts.append("(?:/.*)?")
            i += 3
        elif pattern[i:i + 2] == "**":
            parts.append(".*")
            i += 2
        elif ch == "*":
            parts.append("[^/]*")
            i += 1
        elif ch == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(ch))
            i += 1
    return re.compile("^" + "".join(parts) + "$")


def _matches_any_glob(path: str | None, patterns: list[str]) -> bool:
    if not path:
        return False
    for pat in patterns:
        if not isinstance(pat, str) or not pat:
            continue
        if _glob_to_regex(pat).match(path):
            return True
    return False


def _load_code_review_settings(path: Path | None) -> dict[str, Any]:
    """Read ``code-review.json`` operator-tunable settings. Absent or
    malformed → built-in defaults.

    Returns a dict with the canonical keys present:

      - ``bha_unified_threshold_loc`` (int, ≥ 0): PR total changed LOC at
        or below this value gets a single "unified" BHA partition so
        cross-region invariants stay visible to one reviewer. Default
        :data:`BHA_UNIFIED_THRESHOLD_LOC` (5000). Setting the value to 0
        forces always-partition behavior (kill switch).
      - ``out_of_hunk_confidence_floor`` (float, [0.0, 1.0]): P2+ findings
        whose line is outside the changed-range of the file but whose
        confidence exceeds this floor survive validation (admits
        legitimate companion-change findings). Default
        :data:`OUT_OF_HUNK_CONFIDENCE_FLOOR` (0.80). Setting to 1.0 is a
        kill switch (strict "in-hunk only" behavior).

    Unknown keys are ignored. Invalid entries (wrong type, out of range)
    fall back to the default — the file is operator-authored and should
    not crash the pipeline on a typo.
    """
    defaults: dict[str, Any] = {
        "bha_unified_threshold_loc": BHA_UNIFIED_THRESHOLD_LOC,
        "out_of_hunk_confidence_floor": OUT_OF_HUNK_CONFIDENCE_FLOOR,
    }
    data, out = _load_optional_settings_dict(path, defaults)
    if data is None:
        return out
    raw_threshold = data.get("bha_unified_threshold_loc")
    if (
        isinstance(raw_threshold, int)
        and not isinstance(raw_threshold, bool)
        and raw_threshold >= 0
    ):
        out["bha_unified_threshold_loc"] = raw_threshold
    raw_floor = data.get("out_of_hunk_confidence_floor")
    # Accept int or float; reject bool (which is an int subclass) so
    # a stray `true` in JSON doesn't quietly become 1.0. Range [0, 1].
    if (
        isinstance(raw_floor, (int, float))
        and not isinstance(raw_floor, bool)
        and 0.0 <= float(raw_floor) <= 1.0
    ):
        out["out_of_hunk_confidence_floor"] = float(raw_floor)
    return out


def _load_verification_gates(path: Path | None) -> dict[str, list[str]]:
    """Read verification-gates.json. Absent or malformed → empty gates.

    Returns a dict with the three canonical keys present, each mapped to
    a list of glob patterns (possibly empty). Unknown keys are ignored.
    Non-string list entries are dropped silently — the file is operator-
    authored and should not crash the pipeline on a typo.
    """
    defaults: dict[str, Any] = {k: [] for k in _VERIFICATION_GATE_KEYS}
    data, out_any = _load_optional_settings_dict(path, defaults)
    # The shared helper returns dict[str, Any]; this loader's contract
    # is dict[str, list[str]] and per-key validation below preserves
    # that invariant.
    out: dict[str, list[str]] = out_any  # type: ignore[assignment]
    if data is None:
        return out
    for key in _VERIFICATION_GATE_KEYS:
        raw = data.get(key, [])
        if isinstance(raw, list):
            out[key] = [p for p in raw if isinstance(p, str) and p]
    return out


def _agent_verifier_output_path(cr_dir: Path, finding_id: str) -> Path:
    return cr_dir / f"agent_verifier_{finding_id}.json"


def _read_verifier_output(path: Path) -> dict[str, Any] | None:
    """Read one agent_verifier_<id>.json. Returns None on missing/malformed.

    Tolerates the agent emitting the verdict at the top level or wrapped
    in a ``{"finding": {...}}`` envelope (mirroring how some reviewer
    agents emit ``{"findings": [...]}``).
    """
    data = _read_optional_json(path, None)
    if not isinstance(data, dict):
        return None
    if "verifier_verdict" in data:
        return data
    inner = data.get("finding")
    if isinstance(inner, dict) and "verifier_verdict" in inner:
        return inner
    return None


def cmd_verify_consolidate(args: argparse.Namespace) -> int:
    """Merge verifier outputs with the validated set + bucket-split.

    PLN-722 stage_24a. Reads:

      - ``findings_validated.json`` (the originals)
      - ``verify_manifest.json`` (which IDs went to verification, which
        were skipped, which deferred)
      - ``agent_verifier_<id>.json`` for each ``to_verify`` entry
      - ``verification-gates.json`` (sensitive-path config; optional)

    Produces ``findings_verified.json`` with bucket-split shape:

      {
        "verified": [...],                # CONFIRMED + DOWNGRADE + TENTATIVE
                                          #   + JUSTIFIED-INVALID (reserved;
                                          #   not currently emitted)
                                          #   + tier-skipped findings (no
                                          #   verification needed)
        "rejected": [...],                # REJECTED (with verifier fields)
        "pending_verification": [...],    # deferred + missing verifier outputs
        "justified": [...],               # PLN-721 — JUSTIFIED-VALID findings
                                          #   (author defense audited + passed)
        "force_human_review": bool,       # any finding on a mandatory_human_
                                          #   review_paths match
        "stats": {
            "verified_count": int,
            "rejected_count": int,
            "pending_count": int,
            "justified_count": int,       # PLN-721 — len(justified)
            "escalated_sensitive_path": int,
            "escalated_mandatory_review": int,
        }
      }

    Sensitive-path escalations (applied BEFORE bucketing):
      * REJECTED + BLOCKING/HIGH severity + sensitive_paths match
          → TENTATIVE (capped at HIGH per plan).
      * Any finding on tentative_on_paths
          → TENTATIVE (verdict stays as recorded if already non-rejected,
          but the finding lands in verified[] with a TENTATIVE flag so the
          presenter renders it under "[verifier uncertain]").
      * Any finding on mandatory_human_review_paths
          → TENTATIVE + force_human_review True (drives verdict precedence
          to NEEDS_ATTENTION downstream).

    Always exits 0; missing inputs degrade to "everything pending_verification"
    so the pipeline never aborts on a verifier crash.
    """
    cr_dir = Path(args.cr_dir)
    validated_path = Path(args.validated)
    manifest_path = Path(args.manifest) if getattr(args, "manifest", None) else (
        cr_dir / "verify_manifest.json"
    )
    gates_path = Path(args.gates) if getattr(args, "gates", None) else (
        _VERIFICATION_GATES_DEFAULT_PATH
    )
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    prompt_hash = str(getattr(args, "prompt_hash", "") or "")

    validated_data = _read_optional_json(validated_path, {})
    if isinstance(validated_data, dict):
        validated = validated_data.get("validated") or validated_data.get("findings") or []
    elif isinstance(validated_data, list):
        validated = validated_data
    else:
        validated = []

    manifest = _read_optional_json(manifest_path, {})
    to_verify_ids: set[str] = set()
    skipped_ids: set[str] = set()
    deferred_ids: set[str] = set()
    cache_hit_ids: set[str] = set()
    override_hit_ids: set[str] = set()
    to_verify_models: dict[str, str] = {}
    if isinstance(manifest, dict):
        for e in manifest.get("to_verify", []):
            if not isinstance(e, dict) or not e.get("finding_id"):
                continue
            fid = str(e["finding_id"])
            to_verify_ids.add(fid)
            if isinstance(e.get("model"), str):
                to_verify_models[fid] = e["model"]
        skipped_ids = {
            str(fid) for fid in manifest.get("skipped_no_verification", [])
            if isinstance(fid, str)
        }
        deferred_ids = {
            str(fid) for fid in manifest.get("deferred_budget", [])
            if isinstance(fid, str)
        }
        cache_hit_ids = {
            str(fid) for fid in manifest.get("cache_hits", [])
            if isinstance(fid, str)
        }
        # PLN-773 PR #114 review fix — override hits must be routed through
        # the same read-back path as cache hits so the synthesized
        # RE_ASSERTED verifier output reaches verified[] with the verdict
        # intact. Without this, override fids fell through as tier-skips
        # (verifier_verdict=None) and the per-reviewer re_asserted telemetry
        # was always 0 even when the footer reported N honored overrides.
        override_hit_ids = {
            str(fid) for fid in manifest.get("override_hits", [])
            if isinstance(fid, str)
        }

    gates = _load_verification_gates(gates_path)

    verified: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    # PLN-721: JUSTIFIED-VALID verdicts land here. The bucket exists at the
    # consolidate boundary so finalize-result can route them to the canonical
    # envelope's justified[] surface without re-deriving from verifier_verdict.
    justified: list[dict[str, Any]] = []
    escalated_sensitive = 0
    escalated_mandatory = 0
    force_human_review = False

    for raw in validated:
        if not isinstance(raw, dict):
            continue
        finding = dict(raw)  # shallow copy
        fid = str(finding.get("id", ""))
        if not fid:
            # Unkeyed finding — straight to verified[] without a verifier
            # round-trip. Anchors validate's discard policy: anything that
            # makes it past validate is real even if upstream forgot an id.
            verified.append(finding)
            continue

        file_path = finding.get("file") if isinstance(finding.get("file"), str) else None

        if fid in to_verify_ids or fid in cache_hit_ids or fid in override_hit_ids:
            output_path = _agent_verifier_output_path(cr_dir, fid)
            verdict_data = _read_verifier_output(output_path)
            if verdict_data is None:
                # Agent didn't emit. Tag as pending so operators know to
                # re-run; do NOT silently drop and do NOT auto-confirm.
                finding["verifier_verdict"] = None
                finding["verifier_reasoning"] = (
                    "Verifier agent did not produce an output file; finding "
                    "deferred for re-verification."
                )
                pending.append(finding)
                continue
            _merge_verifier_fields(finding, verdict_data)
            # Cache write-back for fresh verdicts. Skip cache hits (came
            # from cache) AND override hits (synthesized stub — never
            # belongs in the verifications/ cache because it would
            # corrupt the verifier-output cache namespace with operator
            # opinion).
            if (
                fid in to_verify_ids
                and fid not in cache_hit_ids
                and fid not in override_hit_ids
            ):
                model = to_verify_models.get(fid, _VERIFY_MODEL_DEFAULT)
                _write_cached_verification(
                    cache_dir, finding, model, prompt_hash, verdict_data,
                )
        elif fid in deferred_ids:
            finding["verifier_verdict"] = None
            finding["verifier_reasoning"] = (
                "Deferred for verification budget (MAX_VERIFICATIONS exceeded)."
            )
            pending.append(finding)
            continue
        elif fid in skipped_ids:
            # Tier-skipped: verifier_verdict stays None. Land in verified[].
            pass
        # else: not in any manifest list → treat as skipped (no manifest)

        # Sensitive-path escalation
        if _matches_any_glob(file_path, gates["mandatory_human_review_paths"]):
            finding["verifier_verdict"] = "TENTATIVE"
            finding["human_review_recommended"] = True
            escalated_mandatory += 1
            force_human_review = True
            verified.append(finding)
            continue
        if (
            finding.get("verifier_verdict") == "REJECTED"
            and str(finding.get("severity", "")) in ("BLOCKING", "HIGH")
            and _matches_any_glob(file_path, gates["sensitive_paths"])
        ):
            finding["verifier_verdict"] = "TENTATIVE"
            # Cap severity at HIGH per plan. Both fields must change:
            # _compute_canonical_verdict reads `severity` (not
            # `verifier_severity`) for the BLOCKING short-circuit, so
            # leaving `severity = "BLOCKING"` would route this finding
            # to CHANGES_REQUESTED via Rule 2 — stronger than any
            # REJECTED-then-escalated finding should ever produce, and
            # also dead-code-ing the HIGH cap. We mirror the change on
            # `verifier_severity` so any future reader that does prefer
            # the verifier field sees the same value.
            if str(finding.get("severity", "")) == "BLOCKING":
                finding["severity"] = "HIGH"
                finding["verifier_severity"] = "HIGH"
            finding["rejection_class"] = None
            escalated_sensitive += 1
            verified.append(finding)
            continue
        if _matches_any_glob(file_path, gates["tentative_on_paths"]):
            # `tentative_on_paths` applies to ALL verdicts, including
            # REJECTED — a REJECTED finding on a path the operator has
            # flagged for "always-tentative" treatment must be lifted out
            # of the rejected bucket; otherwise it lands in verified[]
            # with verifier_verdict="REJECTED" + rejection_class intact
            # ("simultaneously disproved and in the legitimate bucket"),
            # never surfacing in the Dismissed Findings presenter section
            # despite being marked REJECTED. Mirror the sensitive_paths
            # escalation: clear rejection_class on the lift.
            # PLN-721: JUSTIFIED-VALID / JUSTIFIED-INVALID participate on
            # the same contract — the operator's "always-tentative" tag
            # outranks the author's justification. JUSTIFIED-VALID lifts
            # out of justified[] back into verified[] (with TENTATIVE
            # verdict) so Rule 3.5 escalates to NEEDS_ATTENTION; the
            # human will re-judge the justification.
            if finding.get("verifier_verdict") in (
                None, "CONFIRMED", "DOWNGRADE", "REJECTED",
                "JUSTIFIED-VALID", "JUSTIFIED-INVALID",
            ):
                if finding.get("verifier_verdict") == "REJECTED":
                    finding["rejection_class"] = None
                finding["verifier_verdict"] = "TENTATIVE"
            verified.append(finding)
            continue

        # No escalation — bucket by verdict.
        # PLN-721: JUSTIFIED-VALID lands in justified[] (the author's
        # defense is valid; the finding is dismissed by the justification);
        # JUSTIFIED-INVALID lands in verified[] (the justification was
        # audited and refuted, so the original finding stands).
        verdict = finding.get("verifier_verdict")
        if verdict == "REJECTED":
            rejected.append(finding)
        elif verdict == "JUSTIFIED-VALID":
            justified.append(finding)
        else:
            verified.append(finding)
        # PLN-773 Phase 6: append a pending-learnings entry for every
        # JUSTIFIED-INVALID outcome so self-learning:process-learnings
        # can tune the verifier's J2 (responsiveness) threshold over
        # time. Best-effort; failure does not affect the verdict path.
        if verdict == "JUSTIFIED-INVALID":
            justification = finding.get("justification") or {}
            _pending_learnings_append(
                _PENDING_LEARNINGS_DIR / _PENDING_LEARNINGS_PREMISE,
                {
                    "finding_id": finding.get("id"),
                    "category": finding.get("category"),
                    "subcategory": finding.get("subcategory"),
                    "justification_text": (
                        justification.get("text")
                        if isinstance(justification, dict) else None
                    ),
                    "justification_source": (
                        justification.get("source")
                        if isinstance(justification, dict) else None
                    ),
                    "audit_reason": finding.get("verifier_reasoning"),
                    "emitted_at": datetime.now(timezone.utc).isoformat(),
                },
            )

    output = {
        "verified": verified,
        "rejected": rejected,
        "pending_verification": pending,
        # PLN-721: justified[] bucket exposed at the consolidate boundary
        # so cmd_finalize_result can route directly into the envelope's
        # justified[] surface without re-deriving from verifier_verdict.
        "justified": justified,
        "force_human_review": force_human_review,
        "stats": {
            "verified_count": len(verified),
            "rejected_count": len(rejected),
            "pending_count": len(pending),
            "justified_count": len(justified),
            "escalated_sensitive_path": escalated_sensitive,
            "escalated_mandatory_review": escalated_mandatory,
        },
    }

    consolidated_path = cr_dir / "findings_verified.json"
    with open(consolidated_path, "w") as fh:
        json.dump(output, fh, indent=2)
        fh.write("\n")

    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _merge_verifier_fields(
    finding: dict[str, Any], verdict_data: dict[str, Any],
) -> None:
    """Merge verifier output fields into the original finding in place.

    Only canonical verifier_* fields are merged; the verifier never
    overwrites the original finding's issue / explanation / recommendation
    (those stay author-of-record for downstream presentation).

    Severity reconciliation on DOWNGRADE: per ``verifier_prompt.txt``
    ("the finding still counts toward verdict — at the corrected
    severity"), a DOWNGRADE verdict with a valid ``verifier_severity``
    also rewrites the canonical ``severity`` field, so downstream
    ``_compute_canonical_verdict`` (which reads ``severity`` in Rules 2
    and 3) sees the corrected tier. Without this rewrite a verifier
    that knocks BLOCKING down to MEDIUM is inert at the verdict layer —
    Rule 2 still short-circuits on the unrewritten BLOCKING. PR #111
    review HIGH #1 surfaced the same bug for the sensitive-path cap;
    DOWNGRADE has the identical shape.
    """
    if "verifier_verdict" in verdict_data:
        verdict = verdict_data["verifier_verdict"]
        if verdict in VERIFIER_VERDICTS:
            finding["verifier_verdict"] = verdict
            if verdict == "DOWNGRADE":
                vs = verdict_data.get("verifier_severity")
                if isinstance(vs, str) and vs in SEVERITIES:
                    finding["severity"] = vs
    for key in (
        "verifier_severity",
        "verifier_confidence",
        "verifier_reasoning",
        "verifier_model",
        "verification_duration_ms",
        "rejection_class",
    ):
        if key in verdict_data:
            finding[key] = verdict_data[key]
    checks = verdict_data.get("evidence_checks")
    if isinstance(checks, list):
        finding["evidence_checks"] = checks


# ---------------------------------------------------------------------------
# Subcommand: cache-check / cache-update
# ---------------------------------------------------------------------------


def _compute_patch_hash(file_path: str, patch_data: dict[str, dict[str, str]]) -> str:
    """SHA256 of file_path + NUL + deterministic JSON of patch_data."""
    payload = file_path + "\0" + json.dumps(patch_data, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def _load_manifest(cache_dir: Path) -> dict[str, Any]:
    """Load manifest.json from cache_dir, return {} on missing/corrupt/non-dict."""
    manifest_path = cache_dir / CACHE_MANIFEST_FILENAME
    if not manifest_path.exists():
        return {}
    try:
        with open(manifest_path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def _write_manifest(cache_dir: Path, manifest: dict[str, Any]) -> None:
    """Atomic write manifest.json via .tmp + rename."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_dir / (CACHE_MANIFEST_FILENAME + ".tmp")
    manifest_path = cache_dir / CACHE_MANIFEST_FILENAME
    with open(tmp_path, "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    os.replace(str(tmp_path), str(manifest_path))


def _entry_matches(
    entry: dict[str, Any],
    schema_version: int,
    model_id: str,
    prompt_hash: str,
    patch_hash: str,
) -> bool:
    """All four components must match for a cache hit."""
    return (
        entry.get("schema_version") == schema_version
        and entry.get("model_id") == model_id
        and entry.get("prompt_hash") == prompt_hash
        and entry.get("patch_hash") == patch_hash
    )


def _is_entry_fresh(
    entry: dict[str, Any],
    namespace: str,
    *,
    now: datetime | None = None,
) -> bool:
    """Return True iff ``entry["cached_at"]`` is within the namespace TTL.

    PLN-719 Phase 7 — sweep-on-read TTL enforcement. The canonical TTLs
    live in ``code_review_schema.CACHE_TTL_DAYS``; unknown namespaces or
    missing/malformed ``cached_at`` timestamps count as fresh (callers
    handle their own corruption fallback).
    """
    ttl = cache_ttl_days(namespace)
    if ttl is None:
        return True
    cached_at_raw = entry.get("cached_at")
    if not isinstance(cached_at_raw, str):
        return True
    try:
        # fromisoformat tolerates the trailing "Z" used by datetime.isoformat()
        # only on Python 3.11+; normalize manually for safety.
        normalized = cached_at_raw.replace("Z", "+00:00")
        cached_at = datetime.fromisoformat(normalized)
    except ValueError:
        return True
    if cached_at.tzinfo is None:
        cached_at = cached_at.replace(tzinfo=timezone.utc)
    current = now if now is not None else datetime.now(timezone.utc)
    return (current - cached_at) <= timedelta(days=ttl)


# ---------------------------------------------------------------------------
# V2 Cache helpers (content-addressed, cross-PR)
# ---------------------------------------------------------------------------


def _compute_composite_key(
    model_id: str, prompt_hash: str, patch_hash: str, context_key: str,
) -> str:
    """Full 64-char SHA256 composite key for V2 cache lookup."""
    payload = f"{model_id}\0{prompt_hash}\0{patch_hash}\0{context_key}"
    return hashlib.sha256(payload.encode()).hexdigest()


def _entry_matches_v2(
    entry: dict[str, Any],
    model_id: str,
    prompt_hash: str,
    patch_hash: str,
    context_key: str,
) -> bool:
    """Check if a V2 cache entry matches all four components."""
    return (
        entry.get("schema_version") == CACHE_SCHEMA_VERSION_V2
        and entry.get("model_id") == model_id
        and entry.get("prompt_hash") == prompt_hash
        and entry.get("patch_hash") == patch_hash
        and entry.get("context_key") == context_key
    )


def _migrate_v1_entry_to_v2(filepath: str, v1_entry: dict[str, Any]) -> dict[str, Any]:
    """Convert a V1 flat entry to a V2 single-slot nested entry."""
    patch_hash = v1_entry.get("patch_hash", "")
    model_id = v1_entry.get("model_id", "")
    prompt_hash = v1_entry.get("prompt_hash", "")
    context_key = ""  # V1 has no context_key
    composite = _compute_composite_key(model_id, prompt_hash, patch_hash, context_key)
    cached_at = v1_entry.get("cached_at", datetime.now(timezone.utc).isoformat())
    return {
        composite: {
            "schema_version": CACHE_SCHEMA_VERSION_V2,
            "model_id": model_id,
            "prompt_hash": prompt_hash,
            "patch_hash": patch_hash,
            "context_key": context_key,
            "findings": v1_entry.get("findings", []),
            "cached_at": cached_at,
            "last_hit_at": cached_at,
            "hit_count": 0,
        }
    }


def _load_manifest_v2(cache_dir: Path) -> tuple[dict[str, Any], bool]:
    """Load manifest.json, auto-migrating V1 entries to V2.

    Returns (manifest, was_migrated). V1 entries are converted in-memory;
    the file on disk is only overwritten when cache-update writes.
    """
    raw = _load_manifest(cache_dir)
    if not raw:
        return {}, False

    result: dict[str, Any] = {}
    was_migrated = False

    for filepath, value in raw.items():
        if not isinstance(value, dict):
            continue  # skip corrupt

        # V1 detection: has "patch_hash" at top level or schema_version == 1
        if "patch_hash" in value and (
            value.get("schema_version") == CACHE_SCHEMA_VERSION
            or "context_key" not in value
        ):
            # V1 entry — migrate
            result[filepath] = _migrate_v1_entry_to_v2(filepath, value)
            was_migrated = True
        else:
            # V2 nested dict structure (or unknown — pass through)
            # Validate that sub-values are dicts with schema_version
            nested: dict[str, Any] = {}
            for key, sub in value.items():
                if isinstance(sub, dict) and sub.get("schema_version") == CACHE_SCHEMA_VERSION_V2:
                    nested[key] = sub
                # else: skip corrupt/unknown sub-entries (fail-open)
            if nested:
                result[filepath] = nested
            # else: skip entirely (all sub-entries were invalid)

    return result, was_migrated


def _run_gc(
    manifest: dict[str, Any],
    ttl_days: int,
    max_per_file: int,
    now: datetime | None = None,
) -> tuple[int, int]:
    """Run garbage collection on a V2 manifest in-place.

    Returns (ttl_evictions, max_evictions).
    """
    if now is None:
        now = datetime.now(timezone.utc)

    ttl_evictions = 0
    max_evictions = 0
    empty_filepaths: list[str] = []

    for filepath, slots in list(manifest.items()):
        if not isinstance(slots, dict):
            continue

        # TTL eviction
        keys_to_remove: list[str] = []
        for key, entry in slots.items():
            if not isinstance(entry, dict):
                continue
            last_hit = entry.get("last_hit_at", entry.get("cached_at", ""))
            if not last_hit:
                continue
            try:
                hit_dt = datetime.fromisoformat(last_hit)
                if hit_dt.tzinfo is None:
                    hit_dt = hit_dt.replace(tzinfo=timezone.utc)
                age_days = (now - hit_dt).total_seconds() / 86400
                if age_days > ttl_days:
                    keys_to_remove.append(key)
            except (ValueError, TypeError):
                continue

        for key in keys_to_remove:
            del slots[key]
            ttl_evictions += 1

        # Max-per-file eviction
        if len(slots) > max_per_file:
            # Sort by last_hit_at ascending (oldest first)
            sorted_entries = sorted(
                slots.items(),
                key=lambda kv: kv[1].get("last_hit_at", kv[1].get("cached_at", ""))
                if isinstance(kv[1], dict) else "",
            )
            excess = len(sorted_entries) - max_per_file
            for key, _ in sorted_entries[:excess]:
                del slots[key]
                max_evictions += 1

        if not slots:
            empty_filepaths.append(filepath)

    for fp in empty_filepaths:
        del manifest[fp]

    return ttl_evictions, max_evictions


@contextlib.contextmanager
def _manifest_lock(lock_path: Path, exclusive: bool) -> Generator[None, None, None]:
    """File-based lock using fcntl.flock. Fail-open if unavailable."""
    try:
        import fcntl
    except ImportError:
        yield
        return

    fd = None
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = open(lock_path, "w")
        mode = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        fcntl.flock(fd, mode)
        yield
    except OSError:
        # Fail-open: if lock creation/acquisition fails, proceed without
        yield
    finally:
        if fd is not None:
            try:
                import fcntl as _fcntl
                _fcntl.flock(fd, _fcntl.LOCK_UN)
            except (OSError, ImportError):
                pass
            fd.close()


def _is_global_cache_enabled(is_github_mode: bool) -> bool:
    """Check if global V2 cache is enabled via CR_GLOBAL_CACHE env var."""
    env_val = os.environ.get("CR_GLOBAL_CACHE")
    if env_val is not None:
        return env_val == "1"
    # Default: on for local, off for GitHub
    return not is_github_mode


def _write_cache_output_files(  # noqa: PLR0913
    output_dir: Path,
    cached_files: list[str],
    uncached_files: list[str],
    cached_findings: list[dict[str, Any]],
    diff_data: dict[str, Any],
    hit_rate: float,
) -> None:
    """Write the three cache output files consumed by downstream pipeline."""
    total = len(cached_files) + len(uncached_files)
    cache_result = {
        "cached_files": cached_files,
        "uncached_files": uncached_files,
        "stats": {
            "total_files": total,
            "cached": len(cached_files),
            "uncached": len(uncached_files),
            "hit_rate_pct": round(hit_rate, 1),
        },
    }
    with open(output_dir / "cache_result.json", "w") as f:
        json.dump(cache_result, f, indent=2)
        f.write("\n")

    with open(output_dir / "agent_cached_bha.json", "w") as f:
        json.dump({"findings": cached_findings}, f, indent=2)
        f.write("\n")

    uncached_set = set(uncached_files)
    uncached_file_loc: dict[str, dict[str, int]] = {
        fp: diff_data.get("file_loc", {}).get(fp, {"added": 0, "removed": 0})
        for fp in uncached_files
    }
    uncached_total_loc = sum(
        v["added"] + v["removed"] for v in uncached_file_loc.values()
    )
    uncached_diff_data: dict[str, Any] = {
        "files_to_review": uncached_files,
        "file_statuses": {
            fp: s for fp, s in diff_data.get("file_statuses", {}).items()
            if fp in uncached_set
        },
        "file_loc": uncached_file_loc,
        "total_loc": uncached_total_loc,
        "changed_ranges": {
            fp: r for fp, r in diff_data.get("changed_ranges", {}).items()
            if fp in uncached_set
        },
    }
    if "patch_lines" in diff_data:
        uncached_diff_data["patch_lines"] = {
            fp: p for fp, p in diff_data["patch_lines"].items()
            if fp in uncached_set
        }
    with open(output_dir / "uncached_diff_data.json", "w") as f:
        json.dump(uncached_diff_data, f, indent=2)
        f.write("\n")


def cmd_cache_check(args: argparse.Namespace) -> int:
    """Execute cache-check subcommand."""
    cache_dir = Path(args.cache_dir)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        with open(args.diff_data) as f:
            diff_data: dict[str, Any] = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Warning: failed to read diff data: {exc}", file=sys.stderr)
        diff_data = {"files_to_review": [], "patch_lines": {}}

    files_to_review: list[str] = diff_data.get("files_to_review", [])
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {})

    use_global = getattr(args, "global_cache", 0) == 1
    context_key: str = getattr(args, "context_key", "") or ""

    if use_global:
        return _cmd_cache_check_v2(
            cache_dir, output_dir, diff_data, files_to_review, patch_lines,
            args.model_id, args.prompt_hash, context_key,
        )
    return _cmd_cache_check_v1(
        cache_dir, output_dir, diff_data, files_to_review, patch_lines,
        args.schema_version, args.model_id, args.prompt_hash,
    )


def _compute_cache_status(
    stats: dict[str, Any],
    manifest: dict[str, Any],
    fallback_error: bool,
    manifest_file_existed: bool = False,
) -> tuple[str, str]:
    """Compute status_kind and status_message for cache_result.json."""
    if fallback_error:
        status_kind = "fallback_error"
        msg = "BHA Cache: unavailable (fallback to full review)"
    elif stats["cached"] > 0:
        status_kind = "hits"
        msg = (
            f"BHA Cache: {stats['cached']}/{stats['total_files']} files cached "
            f"({stats['hit_rate_pct']}% hit rate) -- "
            f"{stats['cached']} files skip BHA review"
        )
    elif not manifest and not manifest_file_existed:
        # File genuinely absent (first run), not corrupt
        status_kind = "first_run"
        msg = "BHA Cache: first run -- building cache for next review"
    elif not manifest and manifest_file_existed:
        # File existed but was empty/corrupt -- treat as error, not first run
        status_kind = "fallback_error"
        msg = "BHA Cache: unavailable (corrupt manifest, fallback to full review)"
    else:
        status_kind = "all_changed"
        msg = (
            f"BHA Cache: 0/{stats['total_files']} files cached "
            f"(all files changed since last review)"
        )
    return status_kind, msg


def _append_cache_status(
    output_dir: Path,
    manifest: dict[str, Any],
    fallback_error: bool,
    manifest_file_existed: bool = False,
) -> None:
    """Add status_kind and status_message to the written cache_result.json."""
    result_path = output_dir / "cache_result.json"
    try:
        with open(result_path) as f:
            cache_result = json.load(f)
        stats = cache_result.get("stats", {})
        status_kind, msg = _compute_cache_status(stats, manifest, fallback_error, manifest_file_existed)
        cache_result["status_kind"] = status_kind
        cache_result["status_message"] = msg
        with open(result_path, "w") as f:
            json.dump(cache_result, f, indent=2)
            f.write("\n")
    except (OSError, json.JSONDecodeError):
        pass


def _cmd_cache_check_v1(  # noqa: PLR0913
    cache_dir: Path,
    output_dir: Path,
    diff_data: dict[str, Any],
    files_to_review: list[str],
    patch_lines: dict[str, dict[str, dict[str, str]]],
    schema_version: int,
    model_id: str,
    prompt_hash: str,
) -> int:
    """Per-cr-dir cache-check path (non-global-cache fallback)."""
    manifest_file_existed = (cache_dir / CACHE_MANIFEST_FILENAME).exists()
    manifest = _load_manifest(cache_dir)

    cached_files: list[str] = []
    uncached_files: list[str] = []
    cached_findings: list[dict[str, Any]] = []

    for filepath in files_to_review:
        file_patch = patch_lines.get(filepath, {})
        patch_hash = _compute_patch_hash(filepath, file_patch)
        entry = manifest.get(filepath)

        if (
            entry
            and isinstance(entry, dict)
            and _entry_matches(entry, schema_version, model_id, prompt_hash, patch_hash)
            and _is_entry_fresh(entry, CACHE_NAMESPACE_BHA)
        ):
            cached_files.append(filepath)
            cached_findings.extend(entry.get("findings", []))
        else:
            uncached_files.append(filepath)

    total = len(files_to_review)
    hit_rate = (len(cached_files) / total * 100) if total > 0 else 0.0
    _write_cache_output_files(
        output_dir, cached_files, uncached_files, cached_findings, diff_data, hit_rate,
    )
    _append_cache_status(output_dir, manifest, fallback_error=False, manifest_file_existed=manifest_file_existed)

    summary = (
        f"Cache: {len(cached_files)}/{total} files hit ({hit_rate:.0f}%), "
        f"{len(uncached_files)} uncached, {len(cached_findings)} cached findings"
    )
    print(summary)
    return 0


def _cmd_cache_check_v2(  # noqa: PLR0913
    cache_dir: Path,
    output_dir: Path,
    diff_data: dict[str, Any],
    files_to_review: list[str],
    patch_lines: dict[str, dict[str, dict[str, str]]],
    model_id: str,
    prompt_hash: str,
    context_key: str,
) -> int:
    """V2 content-addressed cache-check with locking and observability."""
    lock_path = cache_dir / CACHE_LOCK_FILENAME
    migration = False
    fallback: str | None = None
    manifest: dict[str, Any] = {}
    manifest_file_existed = (cache_dir / CACHE_MANIFEST_FILENAME).exists()

    try:
        with _manifest_lock(lock_path, exclusive=False):
            manifest, migration = _load_manifest_v2(cache_dir)

            cached_files: list[str] = []
            uncached_files: list[str] = []
            cached_findings: list[dict[str, Any]] = []
            now_iso = datetime.now(timezone.utc).isoformat()

            for filepath in files_to_review:
                file_patch = patch_lines.get(filepath, {})
                patch_hash = _compute_patch_hash(filepath, file_patch)
                composite = _compute_composite_key(
                    model_id, prompt_hash, patch_hash, context_key,
                )
                slots = manifest.get(filepath, {})
                entry = slots.get(composite) if isinstance(slots, dict) else None

                if (
                    entry
                    and isinstance(entry, dict)
                    and _entry_matches_v2(entry, model_id, prompt_hash, patch_hash, context_key)
                    and _is_entry_fresh(entry, CACHE_NAMESPACE_BHA)
                ):
                    cached_files.append(filepath)
                    cached_findings.extend(entry.get("findings", []))
                    entry["last_hit_at"] = now_iso
                    entry["hit_count"] = entry.get("hit_count", 0) + 1
                else:
                    uncached_files.append(filepath)

    except Exception as exc:
        # Fail-open: write all 3 output files with safe defaults
        fallback = f"{type(exc).__name__}: {exc}"
        print(f"Warning: cache-check failed, proceeding uncached: {fallback}", file=sys.stderr)
        cached_files = []
        uncached_files = list(files_to_review)
        cached_findings = []

    total = len(files_to_review)
    hit_rate = (len(cached_files) / total * 100) if total > 0 else 0.0
    _write_cache_output_files(
        output_dir, cached_files, uncached_files, cached_findings, diff_data, hit_rate,
    )
    _append_cache_status(output_dir, manifest, fallback_error=fallback is not None, manifest_file_existed=manifest_file_existed)

    # Observability: JSON line to stdout
    obs = {
        "cache_mode": "global",
        "schema": CACHE_SCHEMA_VERSION_V2,
        "hits": len(cached_files),
        "misses": len(uncached_files),
        "hit_rate_pct": round(hit_rate, 1),
        "migration": migration,
        "fallback": fallback,
    }
    print(json.dumps(obs))
    return 0


def _collect_bha_findings(bha_dir: Path) -> dict[str, list[dict[str, Any]]]:
    """Glob BHA findings from agent_bha_*.json files, grouped by filepath."""
    import glob as glob_mod
    findings_by_file: dict[str, list[dict[str, Any]]] = {}
    for bha_path_str in sorted(glob_mod.glob(str(bha_dir / "agent_bha_*.json"))):
        bha_path = Path(bha_path_str)
        try:
            with open(bha_path) as f:
                bha_data = json.load(f)
            bha_findings: list[dict[str, Any]] = (
                bha_data.get("findings", []) if isinstance(bha_data, dict) else []
            )
            for finding in bha_findings:
                fpath = finding.get("file", "")
                if fpath:
                    findings_by_file.setdefault(fpath, []).append(finding)
        except (json.JSONDecodeError, OSError):
            continue
    return findings_by_file


def cmd_cache_update(args: argparse.Namespace) -> int:
    """Execute cache-update subcommand."""
    cache_dir = Path(args.cache_dir)

    with open(args.diff_data) as f:
        diff_data: dict[str, Any] = json.load(f)

    files_to_review: list[str] = diff_data.get("files_to_review", [])
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {})

    # Compute current patch hashes for all files in the diff
    current_hashes: dict[str, str] = {}
    for filepath in files_to_review:
        file_patch = patch_lines.get(filepath, {})
        current_hashes[filepath] = _compute_patch_hash(filepath, file_patch)

    bha_dir = Path(args.bha_dir)
    findings_by_file = _collect_bha_findings(bha_dir)

    reviewed_files: list[str] = args.reviewed_files or []
    partitions_file: str | None = getattr(args, "partitions_file", None)
    if not reviewed_files and partitions_file:
        try:
            with open(partitions_file) as pf:
                pdata = json.load(pf)
            reviewed_files = [
                entry["file"]
                for part in pdata.get("partitions", [])
                for entry in part.get("files", [])
            ]
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            print(f"Warning: failed to read partitions file: {exc}", file=sys.stderr)

    exclude_test = getattr(args, "exclude_test_partitions", False)
    if exclude_test and partitions_file:
        try:
            with open(partitions_file) as pf:
                pdata = json.load(pf)
            test_files = {
                entry["file"]
                for part in pdata.get("partitions", [])
                if part.get("is_test_only", False)
                for entry in part.get("files", [])
            }
            reviewed_files = [f for f in reviewed_files if f not in test_files]
        except (OSError, json.JSONDecodeError, KeyError):
            pass  # Fall through to existing behavior

    if not reviewed_files:
        reviewed_files = list(findings_by_file.keys())

    use_global = getattr(args, "global_cache", 0) == 1
    context_key: str = getattr(args, "context_key", "") or ""

    if use_global:
        return _cmd_cache_update_v2(
            cache_dir, current_hashes,
            findings_by_file, reviewed_files, args.model_id, args.prompt_hash,
            context_key, getattr(args, "gc_ttl_days", CACHE_GC_TTL_DAYS_DEFAULT),
            getattr(args, "gc_max_per_file", CACHE_GC_MAX_PER_FILE_DEFAULT),
        )
    return _cmd_cache_update_v1(
        cache_dir, files_to_review, current_hashes,
        findings_by_file, reviewed_files, args.schema_version,
        args.model_id, args.prompt_hash,
    )


def _cmd_cache_update_v1(  # noqa: PLR0913
    cache_dir: Path,
    files_to_review: list[str],
    current_hashes: dict[str, str],
    findings_by_file: dict[str, list[dict[str, Any]]],
    reviewed_files: list[str],
    schema_version: int,
    model_id: str,
    prompt_hash: str,
) -> int:
    """Per-cr-dir cache-update path (non-global-cache fallback)."""
    manifest = _load_manifest(cache_dir)
    diff_file_set = set(files_to_review)
    updated_manifest: dict[str, Any] = {
        fp: entry for fp, entry in manifest.items()
        if fp not in diff_file_set
    }

    now_iso = datetime.now(timezone.utc).isoformat()
    cached_count = 0
    for filepath in reviewed_files:
        if filepath not in current_hashes:
            continue
        updated_manifest[filepath] = {
            "schema_version": schema_version,
            "model_id": model_id,
            "prompt_hash": prompt_hash,
            "patch_hash": current_hashes[filepath],
            "findings": findings_by_file.get(filepath, []),
            "cached_at": now_iso,
        }
        cached_count += 1

    _write_manifest(cache_dir, updated_manifest)
    print(f"Cache updated: {cached_count} files cached, {len(updated_manifest)} total entries")
    return 0


def _cmd_cache_update_v2(  # noqa: PLR0913
    cache_dir: Path,
    current_hashes: dict[str, str],
    findings_by_file: dict[str, list[dict[str, Any]]],
    reviewed_files: list[str],
    model_id: str,
    prompt_hash: str,
    context_key: str,
    gc_ttl_days: int,
    gc_max_per_file: int,
) -> int:
    """V2 content-addressed cache-update with locking, GC, and observability."""
    lock_path = cache_dir / CACHE_LOCK_FILENAME
    fallback: str | None = None

    try:
        with _manifest_lock(lock_path, exclusive=True):
            manifest, _ = _load_manifest_v2(cache_dir)

            now_iso = datetime.now(timezone.utc).isoformat()
            cached_count = 0

            for filepath in reviewed_files:
                if filepath not in current_hashes:
                    continue
                patch_hash = current_hashes[filepath]
                composite = _compute_composite_key(
                    model_id, prompt_hash, patch_hash, context_key,
                )
                slots = manifest.setdefault(filepath, {})
                slots[composite] = {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": model_id,
                    "prompt_hash": prompt_hash,
                    "patch_hash": patch_hash,
                    "context_key": context_key,
                    "findings": findings_by_file.get(filepath, []),
                    "cached_at": now_iso,
                    "last_hit_at": now_iso,
                    "hit_count": 0,
                }
                cached_count += 1

            # GC pass
            ttl_evictions, max_evictions = _run_gc(manifest, gc_ttl_days, gc_max_per_file)

            # Count total entries
            total_entries = sum(
                len(slots) for slots in manifest.values() if isinstance(slots, dict)
            )

            _write_manifest(cache_dir, manifest)

    except Exception as exc:
        fallback = f"{type(exc).__name__}: {exc}"
        print(f"Warning: cache-update failed, skipping write: {fallback}", file=sys.stderr)
        cached_count = 0
        ttl_evictions = 0
        max_evictions = 0
        total_entries = 0

    # Observability
    obs: dict[str, Any] = {
        "cache_mode": "global",
        "schema": CACHE_SCHEMA_VERSION_V2,
        "cached_count": cached_count,
        "fallback": fallback,
    }
    print(json.dumps(obs))
    if ttl_evictions or max_evictions:
        gc_obs = {
            "gc_ttl_evictions": ttl_evictions,
            "gc_max_evictions": max_evictions,
            "manifest_entries": total_entries,
        }
        print(json.dumps(gc_obs))
    return 0


# ---------------------------------------------------------------------------
# Subcommand: post-comments
# ---------------------------------------------------------------------------


def _format_comment_body(finding: dict[str, Any]) -> str:
    """Render a finding dict into the inline comment markdown body."""
    severity = finding.get("severity", "MEDIUM")
    category = finding.get("category", "General")
    issue = finding.get("issue", "")
    recommendation = finding.get("recommendation", "")
    code_snippet = finding.get("code_snippet", "")
    other_locations: list[dict[str, Any]] = finding.get("other_locations", [])

    parts: list[str] = [f"**[{severity}]** {category}", "", issue]

    if recommendation:
        parts.append("")
        parts.append(f"**Recommendation:** {recommendation}")

    if code_snippet:
        # Detect language from the file extension
        filepath = finding.get("file", "")
        ext = Path(filepath).suffix.lstrip(".")
        lang = ext if ext else ""
        parts.append("")
        parts.append(f"```{lang}")
        parts.append(code_snippet)
        parts.append("```")

    if other_locations:
        parts.append("")
        parts.append(f"**Other Locations** ({len(other_locations)} more):")
        for loc in other_locations:
            loc_file = loc.get("file", "")
            loc_line = loc.get("line", 0)
            loc_desc = loc.get("description", "")
            desc_part = f" — {loc_desc}" if loc_desc else ""
            parts.append(f"- `{loc_file}:{loc_line}`{desc_part}")

    return "\n".join(parts)


def _gh_api(
    args: list[str],
    *,
    dry_run: bool = False,
    label: str = "",
) -> subprocess.CompletedProcess[str]:
    """Call ``gh api`` via subprocess. Returns CompletedProcess.

    In dry-run mode, prints what would be called and returns a fake success.
    """
    cmd = ["gh", "api"] + args
    if dry_run:
        print(f"[dry-run] {label}: {' '.join(cmd)}")
        return subprocess.CompletedProcess(cmd, returncode=0, stdout="{}", stderr="")
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def cmd_post_comments(args: argparse.Namespace) -> int:
    """Post inline review comments to a GitHub PR."""
    try:
        with open(args.findings) as f:
            data: dict[str, Any] = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading findings file: {exc}", file=sys.stderr)
        return 1

    pr_number = data.get("pr_number")
    head_sha = data.get("head_sha", "")
    findings: list[dict[str, Any]] = data.get("findings", [])

    repo = args.repo or os.environ.get("GITHUB_REPOSITORY", "")
    if not repo:
        print("Error: --repo or GITHUB_REPOSITORY env required", file=sys.stderr)
        return 1
    if not pr_number:
        print("Error: pr_number missing from findings file", file=sys.stderr)
        return 1

    owner, repo_name = repo.split("/", 1)
    dry_run: bool = args.dry_run

    if not findings:
        print("No findings to post.")
        return 0

    # Fetch existing comments for dedup
    existing_comments: set[tuple[str, int]] = set()
    result = _gh_api(
        [f"/repos/{owner}/{repo_name}/pulls/{pr_number}/comments", "--paginate"],
        dry_run=False,
        label="fetch existing comments",
    )
    if result.returncode == 0 and result.stdout.strip():
        try:
            comments_data = json.loads(result.stdout)
            if isinstance(comments_data, list):
                for c in comments_data:
                    c_path = c.get("path", "")
                    c_line = c.get("line") or c.get("original_line") or 0
                    if c_path and c_line:
                        existing_comments.add((c_path, int(c_line)))
        except json.JSONDecodeError:
            pass  # proceed without dedup data

    posted = 0
    skipped_dedup = 0
    skipped_no_inline = 0
    failed = 0

    for finding in findings:
        # Skip findings explicitly marked as non-inline
        if finding.get("inline") is False:
            skipped_no_inline += 1
            continue

        path = finding.get("file") or ""
        # Schema permits ``line: int | None`` for system + pr_metadata scopes;
        # some reviewers emit ``"42"`` as a string. The split below: reject
        # ``bool`` first (``bool`` is a subclass of ``int`` in Python —
        # ``isinstance(True, int)`` is True — so unguarded ``int(True)`` posts
        # to line 1), then try ``int(line_raw)`` which handles ints, numeric
        # strings, and falls through to ``0`` on
        # ``None``/non-numeric values via the typed exception catch.
        line_raw = finding.get("line")
        if isinstance(line_raw, bool):
            line = 0
        else:
            try:
                line = int(line_raw) if line_raw is not None else 0
            except (TypeError, ValueError):
                line = 0

        if not path or not line:
            failed += 1
            continue

        # Dedup check
        if (path, line) in existing_comments:
            skipped_dedup += 1
            continue

        body = _format_comment_body(finding)

        api_result = _gh_api(
            [
                f"/repos/{owner}/{repo_name}/pulls/{pr_number}/comments",
                "-f", f"body={body}",
                "-f", f"path={path}",
                "-F", f"line={line}",
                "-f", f"commit_id={head_sha}",
                "-f", "side=RIGHT",
            ],
            dry_run=dry_run,
            label=f"POST comment {path}:{line}",
        )

        if dry_run:
            posted += 1
            continue

        if api_result.returncode != 0:
            # Check for known recoverable errors (422 = line not in diff, 401/403 = auth)
            stderr_lower = (api_result.stderr or "").lower()
            stdout_lower = (api_result.stdout or "").lower()
            err_text = stderr_lower + stdout_lower
            if "422" in err_text or "validation failed" in err_text:
                print(f"  Skipped {path}:{line} — line not in diff (422)")
            elif "401" in err_text or "403" in err_text:
                print(f"  Skipped {path}:{line} — auth error")
            else:
                print(f"  Failed {path}:{line} — {api_result.stderr.strip()}")
            failed += 1
            continue

        posted += 1

    total_skipped = skipped_dedup + skipped_no_inline
    print(f"Posted {posted}, skipped {total_skipped} (dedup={skipped_dedup}, non-inline={skipped_no_inline}), failed {failed}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: resolve-threads
# ---------------------------------------------------------------------------


def cmd_resolve_threads(args: argparse.Namespace) -> int:
    """Resolve outdated review threads on a GitHub PR."""
    try:
        with open(args.threads) as f:
            data: dict[str, Any] = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading threads file: {exc}", file=sys.stderr)
        return 1

    thread_ids: list[str] = data.get("outdated_thread_ids", [])
    dry_run: bool = args.dry_run

    if not thread_ids:
        print("No outdated threads to resolve.")
        return 0

    resolved = 0
    failed = 0

    for thread_id in thread_ids:
        mutation = """
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { isResolved }
  }
}"""
        api_result = _gh_api(
            ["graphql", "-f", f"query={mutation}", "-f", f"threadId={thread_id}"],
            dry_run=dry_run,
            label=f"resolve thread {thread_id}",
        )

        if dry_run:
            resolved += 1
            continue

        if api_result.returncode != 0:
            print(f"  Failed to resolve {thread_id}: {api_result.stderr.strip()}")
            failed += 1
            continue

        # Check for GraphQL-level errors in the response
        try:
            resp = json.loads(api_result.stdout)
            if "errors" in resp:
                error_msg = resp["errors"][0].get("message", "unknown error")
                print(f"  Failed to resolve {thread_id}: {error_msg}")
                failed += 1
                continue
        except (json.JSONDecodeError, IndexError, KeyError):
            pass  # If we can't parse, assume success

        resolved += 1

    print(f"Resolved {resolved}, failed {failed}")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: review-state-read / review-state-write
# ---------------------------------------------------------------------------


def _load_review_state(cache_dir: Path) -> dict[str, Any]:
    """Load review_state.json from cache_dir, return {} on missing/corrupt."""
    state_path = cache_dir / REVIEW_STATE_FILENAME
    if not state_path.exists():
        return {}
    try:
        with open(state_path) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return data
    except (json.JSONDecodeError, OSError):
        return {}


def _write_review_state(cache_dir: Path, state: dict[str, Any]) -> None:
    """Atomic write review_state.json via .tmp + rename."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = cache_dir / (REVIEW_STATE_FILENAME + ".tmp")
    state_path = cache_dir / REVIEW_STATE_FILENAME
    with open(tmp_path, "w") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    os.replace(str(tmp_path), str(state_path))


def _entry_satisfies_depth(
    entry_tier: str | None, invocation_tier: str | None,
) -> bool:
    """Return True when a cached review_state entry is at least as strong as the new invocation.

    Cached tier must rank ≥ invocation tier:
      - shallow invocation can reuse any cached tier (shallow, standard, deep)
      - standard invocation requires cached tier in {standard, deep}
      - deep invocation requires cached tier == deep

    Stale entries written before PLN-807 carry no ``tier`` field; they
    are treated as standard-equivalent (the pre-PLN-807 default), which
    preserves prior cache behavior for shallow/standard but conservatively
    rejects deep reuse.
    """
    if invocation_tier is None:
        return True  # tier-unaware caller — preserve legacy behavior
    cached_rank = _DEPTH_RANK.get(entry_tier or _DEFAULT_MIN_DEPTH, 2)
    return cached_rank >= _DEPTH_RANK[invocation_tier]


def cmd_review_state_read(args: argparse.Namespace) -> int:
    """Read review state for a branch:base key. Outputs JSON or empty.

    The optional ``--depth`` arg gates the result on tier sufficiency:
    a cached entry whose stored ``tier`` is weaker than the new
    invocation depth returns ``{}`` (treated as a cache miss), forcing
    the upgrade to actually run. See ``_entry_satisfies_depth`` for the
    ranking rules.
    """
    cache_dir = Path(args.cache_dir)
    key = args.key
    invocation_depth: str | None = getattr(args, "depth", None)
    ok, err = _validate_invocation_depth(invocation_depth)
    if not ok:
        print(err, file=sys.stderr)
        return 1
    lock_path = cache_dir / CACHE_LOCK_FILENAME

    try:
        with _manifest_lock(lock_path, exclusive=False):
            state = _load_review_state(cache_dir)
            reviews = state.get("reviews", {})
            entry = reviews.get(key)

            if (
                entry and isinstance(entry, dict)
                and _entry_satisfies_depth(entry.get("tier"), invocation_depth)
            ):
                json.dump(entry, sys.stdout)
                sys.stdout.write("\n")
            else:
                print("{}")
    except Exception as exc:
        print(f"Warning: review-state-read failed: {exc}", file=sys.stderr)
        print("{}")

    return 0


def cmd_review_state_write(args: argparse.Namespace) -> int:
    """Write review state entry. Atomic write via tmp+rename.

    The optional ``--depth`` arg persists the invocation tier alongside
    the SHA so a later run can detect tier transitions: a cached
    ``shallow`` result MUST NOT be reused to skip a follow-up
    ``standard`` or ``deep`` review — those would have spawned premise
    and the critic gates that shallow skipped, so the cached SHA
    represents a strictly weaker review. Stale entries (pre-PLN-807,
    no ``tier`` field) are treated as standard-equivalent on read.
    """
    cache_dir = Path(args.cache_dir)
    key = args.key
    sha: str | None = getattr(args, "sha", None)
    ref: str | None = getattr(args, "ref", None)
    depth: str | None = getattr(args, "depth", None)

    if not sha and not ref:
        print("Error: one of --sha or --ref is required", file=sys.stderr)
        return 1

    if ref and not sha:
        try:
            sha = _run_git(["rev-parse", ref]).strip()
        except subprocess.CalledProcessError as exc:
            print(f"Error: git rev-parse {ref} failed: {exc}", file=sys.stderr)
            return 1

    ok, err = _validate_invocation_depth(depth)
    if not ok:
        print(err, file=sys.stderr)
        return 1

    lock_path = cache_dir / CACHE_LOCK_FILENAME

    try:
        with _manifest_lock(lock_path, exclusive=True):
            state = _load_review_state(cache_dir)
            reviews = state.setdefault("reviews", {})
            entry: dict[str, Any] = {
                "sha": sha,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "success": True,
            }
            if depth is not None:
                entry["tier"] = depth
            reviews[key] = entry
            _write_review_state(cache_dir, state)
            print(f"Review state written: {key} -> {sha}")
    except Exception as exc:
        print(f"Warning: review-state-write failed: {exc}", file=sys.stderr)

    return 0


# ---------------------------------------------------------------------------
# Subcommand: session-tokens
# ---------------------------------------------------------------------------


def cmd_session_tokens(args: argparse.Namespace) -> int:
    """Sum token usage from a Claude Code session transcript.

    Reads the JSONL transcript file, filters assistant messages by start_time,
    and outputs aggregated token usage as JSON.
    """
    from pathlib import Path

    project_dir: str = args.project_dir or os.getcwd()
    start_time: float = args.start_time

    # Build the project key: Claude Code replaces all non-alphanumeric chars with hyphens
    abs_project = str(Path(project_dir).resolve())
    project_key = re.sub(r"[^a-zA-Z0-9]", "-", abs_project)

    sessions_dir = Path.home() / ".claude" / "projects" / project_key
    if not sessions_dir.is_dir():
        print(json.dumps({"error": f"sessions dir not found: {sessions_dir}"}))
        return 0  # fail-open

    # Find the most recently modified JSONL file
    jsonl_files = sorted(sessions_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not jsonl_files:
        print(json.dumps({"error": "no session transcripts found"}))
        return 0

    transcript = jsonl_files[-1]  # most recent

    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    turns = 0
    models: set[str] = set()

    with open(transcript) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            # Filter by timestamp (seconds since epoch)
            ts = obj.get("timestamp")
            if ts and isinstance(ts, (int, float)):
                # Transcript timestamps may be in ms
                ts_sec = ts / 1000 if ts > TIMESTAMP_MS_THRESHOLD else ts
                if ts_sec < start_time:
                    continue
            msg = obj.get("message", {})
            usage = msg.get("usage", {})
            if not usage:
                continue
            for key in totals:
                totals[key] += usage.get(key, 0)
            turns += 1
            model = msg.get("model", "")
            if model:
                models.add(model)

    total_all = sum(totals.values())
    result = {
        **totals,
        "total_tokens": total_all,
        "turns": turns,
        "models": sorted(models),
    }
    print(json.dumps(result))
    return 0


# ---------------------------------------------------------------------------
# Subcommand: resolve-scope
# ---------------------------------------------------------------------------


def cmd_resolve_scope(args: argparse.Namespace) -> int:
    """Resolve diff scope from mode, pr-number, and scope-args."""
    mode: str = args.mode
    pr_number: int | None = args.pr_number
    scope_args: str = args.scope_args or ""
    base_ref_override: str | None = args.base_ref_override
    setup_json_path: str = args.setup_json

    # Read current_branch from setup.json
    try:
        with open(setup_json_path) as f:
            setup_data = json.load(f)
        current_branch: str = setup_data.get("current_branch", "HEAD")
    except (OSError, json.JSONDecodeError):
        current_branch = "HEAD"

    diff_scope = ""
    base_ref = "main"
    head_ref = current_branch
    review_branch = current_branch
    diff_tip = "HEAD"
    path_filter = ""
    scope_kind = "branch"

    pr_auto_detected = False

    if pr_number is not None:
        # Explicit --pr-number: use _resolve_pr_scope with guess fallback.
        # FileNotFoundError / OSError propagate as hard failures.
        pr_scope = _resolve_pr_scope(pr_number, current_branch, allow_guess_fallback=True)
        base_ref = str(pr_scope["base_ref"])
        head_ref = str(pr_scope["head_ref"])
        diff_scope = str(pr_scope["diff_scope"])
        diff_tip = str(pr_scope["diff_tip"])
        review_branch = str(pr_scope["review_branch"])
        path_filter = str(pr_scope["path_filter"])
        scope_kind = str(pr_scope["scope_kind"])

        # Fetch origin head (allow failure for explicit PR)
        subprocess.run(
            ["git", "fetch", "origin", head_ref],
            capture_output=True, text=True,
        )

    elif mode == "local":
        if not scope_args or scope_args.strip() in ("", "branch"):
            # Try auto-detecting an open PR for the current branch
            detected_pr = _detect_open_pr()
            if detected_pr is not None:
                try:
                    pr_scope = _resolve_pr_scope(
                        detected_pr, current_branch, allow_guess_fallback=False,
                    )
                    # Three-step success: fetch must also succeed
                    subprocess.run(
                        ["git", "fetch", "origin", str(pr_scope["head_ref"])],
                        capture_output=True, text=True, check=True,
                    )
                    # All three steps succeeded
                    base_ref = str(pr_scope["base_ref"])
                    head_ref = str(pr_scope["head_ref"])
                    diff_scope = str(pr_scope["diff_scope"])
                    diff_tip = str(pr_scope["diff_tip"])
                    review_branch = str(pr_scope["review_branch"])
                    path_filter = str(pr_scope["path_filter"])
                    scope_kind = str(pr_scope["scope_kind"])
                    pr_number = detected_pr
                    pr_auto_detected = True
                except (subprocess.CalledProcessError, FileNotFoundError,
                        OSError, ValueError):
                    # Any failure: fall back to branch scope
                    pr_number = None
                    pr_auto_detected = False
                    diff_scope = "main...HEAD"
                    scope_kind = "branch"
            else:
                diff_scope = "main...HEAD"
                scope_kind = "branch"
        elif scope_args.strip() == "staged":
            diff_scope = "--cached"
            scope_kind = "staged"
        else:
            # Treat scope_args as file paths
            files = scope_args.strip()
            diff_scope = f"main...HEAD -- {files}"
            path_filter = f"-- {files}"
            scope_kind = "file_paths"

    elif mode == "github":
        # GitHub mode, no PR number: leave unset
        diff_scope = ""
        scope_kind = "github_pending"

    # Apply base-ref override if provided
    if base_ref_override:
        if scope_kind == "pr":
            diff_scope = f"origin/{base_ref_override}...origin/{head_ref}"
        elif path_filter:
            diff_scope = f"origin/{base_ref_override}...HEAD {path_filter}"
        else:
            diff_scope = f"origin/{base_ref_override}...HEAD"
        base_ref = base_ref_override

    result_out = {
        "diff_scope": diff_scope,
        "base_ref": base_ref,
        "head_ref": head_ref,
        "review_branch": review_branch,
        "diff_tip": diff_tip,
        "pr_number": pr_number,
        "path_filter": path_filter,
        "scope_kind": scope_kind,
        "pr_auto_detected": pr_auto_detected,
    }
    json.dump(result_out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: fetch-intent
# ---------------------------------------------------------------------------


def cmd_fetch_intent(args: argparse.Namespace) -> int:
    """Fetch intent context (PR description or commit messages) for premise review."""
    pr_number: int | None = args.pr_number
    base_ref: str = args.base_ref
    diff_tip: str = args.diff_tip
    scope_kind: str = args.scope_kind
    cr_dir = Path(args.cr_dir)

    intent_data: dict[str, str] = {"title": "", "body": "", "commits": ""}
    source = "empty"

    if pr_number is not None:
        try:
            result = subprocess.run(
                ["gh", "pr", "view", str(pr_number), "--json", "title,body"],
                capture_output=True, text=True, check=True,
            )
            pr_json = json.loads(result.stdout)
            intent_data = {
                "title": pr_json.get("title", ""),
                "body": pr_json.get("body", ""),
                "commits": "",
            }
            source = "pr"
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            # Graceful fallback to empty context
            intent_data = {"title": "", "body": "", "commits": ""}
            source = "empty"

    elif scope_kind == "branch":
        try:
            result = subprocess.run(
                ["git", "log", f"{base_ref}..{diff_tip}",
                 "--oneline", "--no-merges", "--format=%s"],
                capture_output=True, text=True, check=True,
            )
            commits_text = result.stdout.strip()
            intent_data = {"title": "", "body": "", "commits": commits_text}
            source = "commits"
        except subprocess.CalledProcessError:
            intent_data = {"title": "", "body": "", "commits": ""}
            source = "empty"

    # Otherwise (staged, file_paths, github_pending, etc.): empty context

    intent_path = cr_dir / "intent_context.json"
    with open(intent_path, "w") as f:
        json.dump(intent_data, f, indent=2)
        f.write("\n")

    result_out = {"path": str(intent_path), "source": source}
    json.dump(result_out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: setup
# ---------------------------------------------------------------------------


def cmd_setup(args: argparse.Namespace) -> int:
    """Session setup: emit start_time, repo_name, current_branch, global_cache."""
    import time

    mode: str = args.mode

    start_time = int(time.time())

    try:
        toplevel = _run_git(["rev-parse", "--show-toplevel"]).strip()
        repo_name = os.path.basename(toplevel)
    except subprocess.CalledProcessError:
        repo_name = "unknown"

    try:
        current_branch = _run_git(["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    except subprocess.CalledProcessError:
        current_branch = "HEAD"

    env_val = os.environ.get("CR_GLOBAL_CACHE")
    if env_val is not None:
        global_cache = env_val
    elif mode == "github":
        global_cache = "0"
    else:
        global_cache = "1"

    output: dict[str, Any] = {
        "start_time": start_time,
        "repo_name": repo_name,
        "current_branch": current_branch,
        "global_cache": global_cache,
    }

    cr_dir_prefix: str | None = getattr(args, "cr_dir_prefix", None)
    if cr_dir_prefix is not None:
        suffix = random.randint(10000, 99999)
        cr_dir = f"{cr_dir_prefix}{suffix}"
        os.makedirs(cr_dir, exist_ok=True)
        output["cr_dir"] = cr_dir

    json.dump(output, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: compute-hashes
# ---------------------------------------------------------------------------


def compute_canonical_prompt_hash(
    parts: list[bytes],
    schema_version: int = SCHEMA_VERSION,
) -> str:
    """Return the canonical prompt_hash (PLN-719 Section 9).

    ``parts`` is a list of byte-string components joined with a NUL separator
    in stable order; schema_version is appended so a MAJOR schema bump
    invalidates every cache namespace at once.
    """
    sep = b"\0"
    payload = sep.join(parts) + sep + str(int(schema_version)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def cmd_compute_hashes(args: argparse.Namespace) -> int:
    """Compute prompt hash and context key for cache operations.

    The prompt hash folds the canonical schema_version per PLN-719
    Section 9 (any MAJOR schema bump invalidates all caches) plus the
    verifier and premise prompt bytes, so editing ``verifier_prompt.txt``
    or ``premise_prompt.txt`` busts every cache namespace that keys on
    ``<PROMPT_HASH>`` (BHA cache and the ``verifications/`` namespace).
    Coarse but correct: prompt revs are rare, and the over-invalidation
    cost (re-pay the BHA reviewer pass) is bounded by how often the
    prompts actually change.
    """
    shared_prompt: str = args.shared_prompt
    bha_suffix: str = args.bha_suffix
    verifier_prompt: str | None = getattr(args, "verifier_prompt", None)
    premise_prompt: str | None = getattr(args, "premise_prompt", None)
    diff_tip: str = args.diff_tip
    base_ref: str = args.base_ref

    # Read all prompt files.
    try:
        with open(shared_prompt, "rb") as f:
            shared_bytes = f.read()
    except OSError as exc:
        print(f"Error: cannot read shared prompt: {exc}", file=sys.stderr)
        return 1
    try:
        with open(bha_suffix, "rb") as f:
            bha_bytes = f.read()
    except OSError as exc:
        print(f"Error: cannot read BHA suffix: {exc}", file=sys.stderr)
        return 1
    # verifier_prompt.txt is optional for backward compatibility;
    # canonical callers (stage_18 wiring) always pass it.
    verifier_bytes: bytes | None = None
    if verifier_prompt:
        try:
            with open(verifier_prompt, "rb") as f:
                verifier_bytes = f.read()
        except OSError as exc:
            print(f"Error: cannot read verifier prompt: {exc}", file=sys.stderr)
            return 1
    # premise_prompt.txt is optional with the same back-compat contract
    # as verifier_prompt.
    premise_bytes: bytes | None = None
    if premise_prompt:
        try:
            with open(premise_prompt, "rb") as f:
                premise_bytes = f.read()
        except OSError as exc:
            print(f"Error: cannot read premise prompt: {exc}", file=sys.stderr)
            return 1

    hash_parts = [shared_bytes, bha_bytes]
    if verifier_bytes is not None:
        hash_parts.append(verifier_bytes)
    if premise_bytes is not None:
        hash_parts.append(premise_bytes)
    prompt_hash = compute_canonical_prompt_hash(hash_parts)

    # Compute context key via git merge-base
    context_key = ""
    try:
        context_key = _run_git(["merge-base", diff_tip, f"origin/{base_ref}"]).strip()
    except subprocess.CalledProcessError:
        pass

    json.dump(
        {
            "prompt_hash": prompt_hash,
            "context_key": context_key,
            "schema_version": SCHEMA_VERSION,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: auto-incremental
# ---------------------------------------------------------------------------


def cmd_auto_incremental(args: argparse.Namespace) -> int:  # noqa: PLR0911
    """Evaluate auto-incremental eligibility. Outputs JSON with diff_scope and review_mode_line.

    PLN-807 tier-gated cache: when ``--depth`` is provided, a cached
    review whose stored ``tier`` is weaker than the invocation tier is
    treated as a cache miss for incremental purposes. Without this
    gate, a cached shallow review's SHA could seed a follow-up standard
    or deep run's incremental diff, skipping every file changed between
    the two — none of which received premise/critic coverage on the
    shallow run.
    """
    cache_dir: str = args.cache_dir
    key: str = args.key
    diff_tip: str = args.diff_tip
    original_scope: str = args.original_scope
    full_review: bool = args.full_review.lower() == "true" if args.full_review else False
    since_last_review: bool = args.since_last_review.lower() == "true" if args.since_last_review else False
    mode: str = args.mode
    invocation_depth: str | None = getattr(args, "depth", None) or None
    ok, err = _validate_invocation_depth(invocation_depth)
    if not ok:
        print(err, file=sys.stderr)
        return 1

    # --full-review forces full diff
    if full_review:
        json.dump(
            {"diff_scope": None, "review_mode_line": "Review mode: Full review (--full-review flag)"},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0

    # --since-last-review: force incremental, error if no prior state
    if since_last_review:
        if not cache_dir:
            print("ERROR: --since-last-review requires cache state", file=sys.stderr)
            return 1
        state = _load_review_state(Path(cache_dir))
        reviews = state.get("reviews", {})
        entry = reviews.get(key, {})
        last_sha: str = entry.get("sha", "")
        if not last_sha:
            print(f"ERROR: --since-last-review: no previous review found for {key}", file=sys.stderr)
            return 1
        if not _entry_satisfies_depth(entry.get("tier"), invocation_depth):
            print(
                f"ERROR: --since-last-review: cached review for {key} ran at tier "
                f"{entry.get('tier') or 'unknown'!r}, weaker than current invocation "
                f"{invocation_depth!r}; run without --since-last-review to do a full diff",
                file=sys.stderr,
            )
            return 1
        try:
            _run_git(["merge-base", "--is-ancestor", last_sha, diff_tip])
        except subprocess.CalledProcessError:
            print(
                f"ERROR: --since-last-review: previous SHA {last_sha} is not an ancestor of {diff_tip} (rebase detected)",
                file=sys.stderr,
            )
            return 1
        new_scope = f"{last_sha}...{diff_tip}"
        json.dump(
            {
                "diff_scope": new_scope,
                "review_mode_line": f"Review mode: Forced incremental (--since-last-review, {new_scope})",
            },
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0

    # Staged scope — always full
    if original_scope == "--cached":
        json.dump(
            {"diff_scope": None, "review_mode_line": "Review mode: Full review (staged scope)"},
            sys.stdout,
        )
        sys.stdout.write("\n")
        return 0

    # Auto-incremental for local mode
    auto_enabled = os.environ.get("CR_AUTO_INCREMENTAL", "1") == "1"
    if mode == "local" and auto_enabled and cache_dir:
        state = _load_review_state(Path(cache_dir))
        reviews = state.get("reviews", {})
        entry = reviews.get(key, {})
        last_sha = entry.get("sha", "")
        if last_sha and not _entry_satisfies_depth(
            entry.get("tier"), invocation_depth,
        ):
            json.dump(
                {
                    "diff_scope": None,
                    "review_mode_line": (
                        f"Review mode: Auto incremental skipped: reason=tier upgrade "
                        f"(cached={entry.get('tier') or 'legacy'!r}, "
                        f"now={invocation_depth!r}), using full diff"
                    ),
                },
                sys.stdout,
            )
            sys.stdout.write("\n")
            return 0

        if last_sha:
            # Check ancestry
            try:
                _run_git(["merge-base", "--is-ancestor", last_sha, diff_tip])
            except subprocess.CalledProcessError:
                json.dump(
                    {
                        "diff_scope": None,
                        "review_mode_line": "Review mode: Auto incremental skipped: reason=rebase detected, using full diff",
                    },
                    sys.stdout,
                )
                sys.stdout.write("\n")
                return 0

            # Same HEAD check
            try:
                current_tip = _run_git(["rev-parse", diff_tip]).strip()
            except subprocess.CalledProcessError:
                current_tip = ""

            if last_sha == current_tip:
                json.dump(
                    {
                        "diff_scope": None,
                        "review_mode_line": "Review mode: Previous review found at same HEAD — using full diff",
                    },
                    sys.stdout,
                )
                sys.stdout.write("\n")
                return 0

            # Guardrail checks
            try:
                name_only = _run_git(["diff", "--name-only", f"{last_sha}...{diff_tip}"])
                incr_files = len([ln for ln in name_only.strip().splitlines() if ln.strip()])
            except subprocess.CalledProcessError:
                incr_files = 0

            try:
                shortstat = _run_git(["diff", "--shortstat", f"{last_sha}...{diff_tip}"])
                nums = re.findall(r"(\d+) insertion|(\d+) deletion", shortstat)
                incr_loc = sum(int(n) for pair in nums for n in pair if n)
            except subprocess.CalledProcessError:
                incr_loc = 0

            max_files = int(os.environ.get("CR_INCREMENTAL_MAX_FILES", "30"))
            max_loc = int(os.environ.get("CR_INCREMENTAL_MAX_LOC", "1500"))

            if incr_files <= max_files and incr_loc <= max_loc:
                new_scope = f"{last_sha}...{diff_tip}"
                json.dump(
                    {
                        "diff_scope": new_scope,
                        "review_mode_line": f"Review mode: Auto incremental ({new_scope}, {incr_files} files, ~{incr_loc} LOC)",
                    },
                    sys.stdout,
                )
                sys.stdout.write("\n")
                return 0
            elif incr_files > max_files:
                json.dump(
                    {
                        "diff_scope": None,
                        "review_mode_line": f"Review mode: Auto incremental skipped: reason=exceeds max files ({incr_files} > {max_files}), using full diff",
                    },
                    sys.stdout,
                )
                sys.stdout.write("\n")
                return 0
            else:
                json.dump(
                    {
                        "diff_scope": None,
                        "review_mode_line": f"Review mode: Auto incremental skipped: reason=exceeds max LOC ({incr_loc} > {max_loc}), using full diff",
                    },
                    sys.stdout,
                )
                sys.stdout.write("\n")
                return 0
        else:
            json.dump(
                {
                    "diff_scope": None,
                    "review_mode_line": "Review mode: Auto incremental skipped: reason=no previous review, using full diff",
                },
                sys.stdout,
            )
            sys.stdout.write("\n")
            return 0

    # Default: full review
    json.dump(
        {"diff_scope": None, "review_mode_line": "Review mode: Full review"},
        sys.stdout,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: footer
# ---------------------------------------------------------------------------


def _aggregate_tokens(
    project_dir: str, start_time: float,
) -> dict[str, Any]:
    """Aggregate token usage from session transcript. Extracted from cmd_session_tokens."""
    abs_project = str(Path(project_dir).resolve())
    project_key = re.sub(r"[^a-zA-Z0-9]", "-", abs_project)
    sessions_dir = Path.home() / ".claude" / "projects" / project_key

    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    turns = 0
    models: set[str] = set()

    if not sessions_dir.is_dir():
        return {**totals, "total_tokens": 0, "turns": 0, "models": []}

    jsonl_files = sorted(sessions_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if not jsonl_files:
        return {**totals, "total_tokens": 0, "turns": 0, "models": []}

    transcript = jsonl_files[-1]
    with open(transcript) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "assistant":
                continue
            ts = obj.get("timestamp")
            if ts and isinstance(ts, (int, float)):
                ts_sec = ts / 1000 if ts > TIMESTAMP_MS_THRESHOLD else ts
                if ts_sec < start_time:
                    continue
            msg = obj.get("message", {})
            usage = msg.get("usage", {})
            if not usage:
                continue
            for key in totals:
                totals[key] += usage.get(key, 0)
            turns += 1
            model = msg.get("model", "")
            if model:
                models.add(model)

    total_all = sum(totals.values())
    return {
        **totals,
        "total_tokens": total_all,
        "turns": turns,
        "models": sorted(models),
    }


def _format_number(n: int | float) -> str:
    """Format a number with K/M suffixes."""
    if n >= FORMAT_MILLION:
        return f"{n / FORMAT_MILLION:.1f}M"
    if n >= FORMAT_THOUSAND:
        return f"{n / FORMAT_THOUSAND:.1f}K"
    return str(int(n))


def _format_elapsed(seconds: int) -> str:
    """Format elapsed seconds as Xh Ym Zs, omitting zero components."""
    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    secs = seconds % 60
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)


def cmd_footer(args: argparse.Namespace) -> int:
    """Compute review footer with timing, cache stats, and token usage."""
    import time

    start_time: float = args.start_time
    cache_result_path: str | None = getattr(args, "cache_result", None)
    review_mode_line: str | None = getattr(args, "review_mode_line", None)
    cr_dir: str | None = getattr(args, "cr_dir", None)
    project_dir: str = getattr(args, "project_dir", None) or os.getcwd()

    # Fallback: read review_mode_line from auto_incremental.json in CR_DIR
    if not review_mode_line and cr_dir:
        ai_path = os.path.join(cr_dir, "auto_incremental.json")
        try:
            with open(ai_path) as f:
                ai_data = json.load(f)
            review_mode_line = ai_data.get("review_mode_line", "Full review")
        except (OSError, json.JSONDecodeError):
            review_mode_line = "Full review"
    elif not review_mode_line:
        review_mode_line = "Full review"

    end_time = int(time.time())
    elapsed = int(end_time - start_time)
    elapsed_str = _format_elapsed(elapsed)

    # Cache stats
    cache_str = "Cache: disabled"
    if cache_result_path:
        try:
            with open(cache_result_path) as f:
                cr = json.load(f)
            stats = cr.get("stats", {})
            cached = stats.get("cached", 0)
            total = stats.get("total_files", 0)
            pct = stats.get("hit_rate_pct", 0)
            cache_str = f"Cache: {cached}/{total} files ({pct:.0f}%)"
        except (OSError, json.JSONDecodeError):
            pass

    # Extract review mode from the mode line (always str after fallback logic above)
    assert review_mode_line is not None
    mode_str = review_mode_line.replace("Review mode: ", "") if review_mode_line.startswith("Review mode: ") else review_mode_line

    # Token stats
    tokens = _aggregate_tokens(project_dir, start_time)
    inp = tokens.get("input_tokens", 0)
    out = tokens.get("output_tokens", 0)
    cache_write = tokens.get("cache_creation_input_tokens", 0)
    cache_read = tokens.get("cache_read_input_tokens", 0)
    effective = inp + out + cache_write + int(cache_read * 0.1)
    token_str = (
        f"Tokens: ~{_format_number(effective)} effective "
        f"({_format_number(inp)} in, {_format_number(out)} out, "
        f"{_format_number(cache_write)} cache-write, {_format_number(cache_read)} cache-read)"
    )

    footer_line = f"**Review complete** — {elapsed_str} | {cache_str} | {mode_str} | {token_str}"

    json.dump({"footer_line": footer_line}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_finalize_cache(args: argparse.Namespace) -> int:
    """Resolve the final CACHE_DIR path from setup.json and scope context."""
    setup_path: str = args.setup_json
    mode: str = args.mode
    pr_number: str | None = getattr(args, "pr_number", None)

    try:
        with open(setup_path) as f:
            setup = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading setup.json: {exc}", file=sys.stderr)
        return 1

    global_cache = str(setup.get("global_cache", "0"))
    repo_name = setup.get("repo_name", "unknown")

    cache_dir = ""
    if global_cache == "1":
        if mode == "github":
            cache_dir = os.environ.get("RUNNER_TEMP", "/tmp") + "/cr-cache"
        else:
            cache_dir = os.path.expanduser(f"~/.claude/cr-cache-global-repo-{repo_name}")
    elif mode == "github":
        cache_dir = os.environ.get("RUNNER_TEMP", "/tmp") + "/cr-cache"
    elif pr_number:
        cache_dir = os.path.expanduser(f"~/.claude/cr-cache-repo-{repo_name}-pr-{pr_number}")
    else:
        # Local branch review without PR — use repo-scoped cache
        cache_dir = os.path.expanduser(f"~/.claude/cr-cache-repo-{repo_name}")

    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)

    json.dump({"cache_dir": cache_dir}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: classify-intent
# ---------------------------------------------------------------------------


def _classify_intent(
    title: str,
    body: str,
    commits: str,
    file_statuses: dict[str, str],
) -> str:
    """Classify the intent of a diff as feature, fix, refactor, or mixed.

    Uses stem-prefix matching on tokenized text so inflected forms like
    "fixes" (starts with "fix") and "adds" (starts with "add") are matched
    without enumerating every variant.
    """
    # Use first line of body only -- full body is noisy
    body_first_line = body.split("\n")[0] if body else ""
    combined = " ".join(filter(None, [title, body_first_line, commits]))
    tokens = re.split(r"[^a-z]+", combined.lower())

    has_feature = any(
        tok.startswith(w) for tok in tokens for w in INTENT_FEATURE_WORDS if tok
    )
    has_fix = any(
        tok.startswith(w) for tok in tokens for w in INTENT_FIX_WORDS if tok
    )
    has_refactor = any(
        tok.startswith(w) for tok in tokens for w in INTENT_REFACTOR_WORDS if tok
    )

    # Boost toward "feature" if majority of files are newly added
    if file_statuses:
        added_count = sum(1 for s in file_statuses.values() if s == "added")
        if added_count / len(file_statuses) >= FEATURE_FILE_STATUS_THRESHOLD:
            has_feature = True

    matches = [c for c, flag in [("feature", has_feature), ("fix", has_fix), ("refactor", has_refactor)] if flag]
    if len(matches) == 1:
        return matches[0]
    return "mixed"


# ---------------------------------------------------------------------------
# Subcommand: detect-injection (PLN-720)
# ---------------------------------------------------------------------------

# Pattern catalogue: deterministic regex for the 9 prompt-injection classes
# documented in PLN-720 §Detection pattern catalogue. Each pattern carries a
# weight; matches in a single section accumulate; the section total maps
# through _injection_severity() into the severity tier.

# Zero-width and BOM characters used by exfiltration / steganography attacks.
# Built from chr() so the source is grep-friendly (literal zero-width chars
# would be invisible in editor + diff views).
_ZW_CHARS = "".join(chr(c) for c in (
    0x200B,  # ZERO WIDTH SPACE
    0x200C,  # ZERO WIDTH NON-JOINER
    0x200D,  # ZERO WIDTH JOINER
    0x200E,  # LEFT-TO-RIGHT MARK
    0x200F,  # RIGHT-TO-LEFT MARK
    0xFEFF,  # ZERO WIDTH NO-BREAK SPACE (BOM)
))
_ENCODED_PAYLOAD_PATTERN = (
    r"[A-Za-z0-9+/]{60,}={0,2}"        # long base64-ish run
    r"|(?:[0-9a-fA-F]{2}\s*){40,}"     # long hex run
    "|[" + _ZW_CHARS + "]{3,}"          # 3+ zero-width / BOM chars
)

_INJECTION_PATTERN_DEFS: list[tuple[str, int, str, int]] = [
    (
        "instruction_override", 50,
        r"\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:prior|previous|above|earlier)\s+"
        r"(?:instructions|directives|prompts|messages|context|rules)\b",
        re.IGNORECASE,
    ),
    (
        # `act as <anything>` would match benign PR wording like "act as
        # a thin wrapper" or "act as the source of truth" and contribute
        # 40 toward quarantine. The other branches are specific enough
        # already; narrow only `act as` to require a model/agent/role
        # noun (the actual injection vector). The persona list mirrors
        # the canonical adversarial-persona vocabulary — extend on real
        # false-negative evidence from the audit log.
        "role_reversal", 40,
        r"\b(?:you\s+are\s+now|pretend\s+to\s+be|roleplay\s+as|"
        r"from\s+now\s+on\s+you\s+are)\s+\S"
        r"|\bact\s+as\s+(?:an?\s+|the\s+)?"
        r"(?:AI|LLM|model|assistant|chatbot|agent|expert|"
        r"admin|root|sysop|sudoer|developer|maintainer|reviewer|"
        r"approver|owner|operator|moderator|user|hacker|attacker)\b",
        re.IGNORECASE,
    ),
    (
        "system_prompt_forgery", 50,
        r"(?:<system>|<\|im_start\|>|<\|im_end\|>|\[INST\]|\[/INST\])",
        0,
    ),
    (
        "directive_injection", 30,
        r"\bthe\s+(?:user|developer|maintainer|reviewer|admin)\s+"
        r"(?:wants|needs|requires|asks|requests)\s+you\s+to\b",
        re.IGNORECASE,
    ),
    (
        "output_coercion", 35,
        r"\b(?:emit|return|output|produce|provide|generate)\s+"
        r"(?:no|empty|zero|0)\s+findings\b"
        r"|\breturn\s+an?\s+empty\s+(?:array|list)\b"
        r"|\bapprove\s+(?:all|every)\s+(?:findings|changes|PRs|pull\s+requests)\b",
        re.IGNORECASE,
    ),
    (
        "tool_coercion", 30,
        r"\bdo\s+not\s+use\s+(?:Read|Grep|Write|Bash|Edit|Glob)\b"
        r"|\bskip\s+(?:verification|validation|review|the\s+\w+\s+pass)\b",
        re.IGNORECASE,
    ),
    (
        "encoded_payload", 25,
        _ENCODED_PAYLOAD_PATTERN,
        0,
    ),
    (
        "unicode_tag_chars", 40,
        r"[\U000E0000-\U000E007F]",        # Unicode tag character range
        0,
    ),
    (
        "html_comment_exfil", 25,
        r"<!--[^>]{50,}-->",               # long HTML comment
        0,
    ),
]

# Compile once at module load.
_INJECTION_PATTERNS: list[tuple[str, int, re.Pattern[str]]] = [
    (name, weight, re.compile(pat, flags))
    for name, weight, pat, flags in _INJECTION_PATTERN_DEFS
]

# Literal forgery delimiters stripped from raw content before scoring. An
# adversary embedding a real `<system>` tag in PR body would have its
# system_prompt_forgery match counted AND the literal removed before the
# wrapper sees it.
_INJECTION_STRIP_TOKENS: tuple[str, ...] = (
    "<untrusted_input>", "</untrusted_input>",
    "<system>", "</system>",
    "<|im_start|>", "<|im_end|>",
    "[INST]", "[/INST]",
)

# Severity thresholds (PLN-720 §Detection pattern catalogue).
_INJECTION_SCORE_LOW = 1
_INJECTION_SCORE_MEDIUM = 30
_INJECTION_SCORE_HIGH = 70

# Per-class cap on how many matches contribute to the score. Classes
# where *presence* is signal but count is not proportionally more
# dangerous get capped to 1: e.g. GitHub's default PR template ships
# three instructional `<!-- ... -->` blocks past 50 chars; without a
# cap, leaving them in would push 3 × 25 = 75 past _INJECTION_SCORE_HIGH
# and quarantine + BLOCK a benign PR. Classes absent from this map
# accumulate unbounded (the default), which is correct for patterns
# where repetition genuinely amplifies the threat (e.g. multiple
# `<system>` forgery tokens, multiple "ignore previous instructions").
_INJECTION_CLASS_MAX_MATCHES: dict[str, int] = {
    "html_comment_exfil": 1,
}

# Confidence weighting: a match within the first N chars or following ":"
# counts as imperative-to-model context (full weight). Quote-prefixed lines
# (">") get halved — those are citations, not commands.
_INJECTION_IMPERATIVE_HEAD_CHARS = 500
_INJECTION_BURIED_DOWNWEIGHT = 0.75
_INJECTION_QUOTE_DOWNWEIGHT = 0.5
_INJECTION_COLON_LOOKBACK = 80

# Audit log: JSONL with 90-day TTL, swept on every write. Implementation
# is read-modify-write — not atomic append — so concurrent runs in the
# same workdir can clobber entries. The log is observational (not a
# source of truth, never read by the pipeline) and concurrent reviews
# in one workdir are rare in practice, so the clobber risk is accepted.
_INJECTION_AUDIT_LOG = Path(".closedloop-ai/injection-log.jsonl")
_INJECTION_AUDIT_TTL_DAYS = 90


def _strip_injection_tokens(text: str) -> tuple[str, list[str]]:
    """Strip literal forgery tokens. Returns (cleaned_text, removed_tokens)."""
    removed: list[str] = []
    out = text
    for token in _INJECTION_STRIP_TOKENS:
        if token in out:
            removed.append(token)
            out = out.replace(token, "")
    return out, removed


def _injection_severity(score: int) -> str:
    """Map a numeric score to one of: none, low, medium, high."""
    if score >= _INJECTION_SCORE_HIGH:
        return "high"
    if score >= _INJECTION_SCORE_MEDIUM:
        return "medium"
    if score >= _INJECTION_SCORE_LOW:
        return "low"
    return "none"


def _quote_line_ranges(text: str) -> list[tuple[int, int]]:
    """Return [(start, end), ...] character ranges for lines beginning with `>`."""
    ranges: list[tuple[int, int]] = []
    offset = 0
    for line in text.split("\n"):
        if line.startswith(">"):
            ranges.append((offset, offset + len(line)))
        offset += len(line) + 1
    return ranges


def _score_text_for_injection(
    text: str, source_label: str,
) -> tuple[float, list[dict[str, Any]]]:
    """Score one untrusted-content string against the pattern catalogue.

    Returns (score, matches). Each match dict carries pattern name, source
    label, character offset, raw weight, and applied weight (after position
    downweighting). Designed so the report payload is self-explanatory for
    operators triaging false positives.
    """
    if not text:
        return 0.0, []

    quote_ranges = _quote_line_ranges(text)

    def _in_quote(pos: int) -> bool:
        return any(start <= pos < end for start, end in quote_ranges)

    score = 0.0
    matches: list[dict[str, Any]] = []
    for name, weight, pat in _INJECTION_PATTERNS:
        cap = _INJECTION_CLASS_MAX_MATCHES.get(name)
        counted = 0
        for m in pat.finditer(text):
            if cap is not None and counted >= cap:
                break
            counted += 1
            start = m.start()
            in_head = start < _INJECTION_IMPERATIVE_HEAD_CHARS
            after_colon = (
                start > 0
                and ":" in text[max(0, start - _INJECTION_COLON_LOOKBACK):start]
            )
            imperative = in_head or after_colon
            effective = float(weight)
            if _in_quote(start):
                effective *= _INJECTION_QUOTE_DOWNWEIGHT
            elif not imperative:
                effective *= _INJECTION_BURIED_DOWNWEIGHT
            score += effective
            matches.append({
                "pattern": name,
                "source": source_label,
                "offset": start,
                "weight": weight,
                "applied_weight": round(effective, 2),
            })
    return score, matches


def _make_injection_finding(
    score: int, matches: list[dict[str, Any]],
    system_marker: str, emitted_at: str,
) -> dict[str, Any]:
    """Build a canonical InjectionAttempt Finding (severity ≥ High only).

    The finding flows through cmd_collect_findings via the standard
    agent_*.json glob, so it lands in review_result.envelope.verified[]
    without any special-case routing.
    """
    pattern_names = sorted({m["pattern"] for m in matches})
    return {
        "id": make_finding_id("injection-detector", 0),
        "reviewer": "injection-detector",
        "source": "injection-detector",
        "finding_scope": "pr_metadata",
        "category": "InjectionAttempt",
        "severity": "BLOCKING",
        "priority": 0,
        "file": None,
        "line": None,
        "system_marker": system_marker,
        "issue": (
            f"[P0] Prompt-injection signals detected in {system_marker} "
            f"(score: {score})"
        ),
        "explanation": (
            f"Detected {len(matches)} match(es) across pattern classes: "
            f"{', '.join(pattern_names)}. Score: {score} "
            f"(≥{_INJECTION_SCORE_HIGH} = High)."
        ),
        "recommendation": (
            "Maintainer review required. Inspect the flagged content for "
            "prompt-injection payloads before re-running review."
        ),
        "emitted_at": emitted_at,
        "confidence": 1.0,
        "schema_version": SCHEMA_VERSION,
    }


def _append_injection_audit_log(
    log_path: Path, entry: dict[str, Any],
) -> None:
    """Add one JSONL entry to the audit log, sweeping entries > 90 days old.

    Implementation is **read-modify-write, not atomic append**: the function
    loads existing lines, filters out entries older than 90 days, appends the
    new entry to the in-memory list, and rewrites the whole file. Two
    concurrent calls in the same workdir can therefore clobber each other's
    new entries. This is accepted because the log is observational (never
    read by the review pipeline — only by operators triaging) and concurrent
    reviews against the same workdir are rare.

    The sweep runs on every write (not on read — there is no reader); this
    keeps the file from growing unbounded without requiring a separate
    maintenance command. Malformed pre-existing lines (missing timestamp,
    bad JSON, non-dict JSON values) are dropped silently.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    cutoff = datetime.now(timezone.utc) - timedelta(days=_INJECTION_AUDIT_TTL_DAYS)

    kept: list[str] = []
    if log_path.exists():
        try:
            for line in log_path.read_text().splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                    # Valid JSON values include lists, strings, numbers, and
                    # null in addition to objects — calling .get on any of
                    # those would raise AttributeError (caught by the outer
                    # OSError except otherwise; we'd then drop the whole
                    # sweep + lose the legitimate fresh entries below).
                    # Treat non-dict lines the same way as malformed JSON.
                    if not isinstance(obj, dict):
                        continue
                    ts_str = str(obj.get("timestamp", ""))
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                    if ts >= cutoff:
                        kept.append(stripped)
                except (ValueError, KeyError, TypeError):
                    continue
        except OSError:
            pass

    kept.append(json.dumps(entry, separators=(",", ":")))
    log_path.write_text("\n".join(kept) + "\n")


def cmd_detect_injection(args: argparse.Namespace) -> int:
    """Detect prompt-injection patterns in PR-author-controlled content.

    PLN-720. Reads ``intent_context.json`` (title / body / commits) and scores
    each section against the canonical 9-class regex catalogue. Emits an
    ``injection_report.json`` payload to stdout (the walker redirects to
    ``<CR_DIR>/injection_report.json`` per the run-plan stub at
    ``stage_09_detect_injection``).

    Side effects on severity ≥ Medium: rewrites ``intent_context.json`` in
    place with ``quarantine: true`` + redacted content. Side effects on
    severity ≥ High: writes a canonical InjectionAttempt finding to
    ``<CR_DIR>/agent_injection-detector.json`` so cmd_collect_findings picks
    it up via the standard ``agent_*.json`` glob (no schema-specific routing
    needed).

    Always appends one JSONL entry to ``.closedloop-ai/injection-log.jsonl``
    for audit. ``on_failure: "continue"`` is pinned by the run-plan stub —
    a detector crash must NEVER abort the review pipeline.
    """
    cr_dir = Path(args.cr_dir)
    intent_context_path = Path(args.intent_context)

    # Read intent_context.json; degrade to empty on missing/malformed input
    # rather than aborting (on_failure: continue contract).
    try:
        with open(intent_context_path) as f:
            ctx = json.load(f)
    except (OSError, json.JSONDecodeError):
        empty_report = {
            "score": 0,
            "severity": "none",
            "matches": [],
            "redacted_excerpts": [],
            "quarantine": False,
            "intent_context_path": str(intent_context_path),
        }
        json.dump(empty_report, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    title = str(ctx.get("title", ""))
    body = str(ctx.get("body", ""))
    commits = str(ctx.get("commits", ""))

    # Score the RAW content so the forgery pattern class sees the literal
    # `<system>` / `<|im_start|>` / `[INST]` tokens before they're stripped.
    # The stripped copy (below) is only used to report what was removed and
    # would be handed to the downstream wrapper in a follow-up phase.
    title_score, title_matches = _score_text_for_injection(title, "pr_title")
    body_score, body_matches = _score_text_for_injection(body, "pr_description")
    commits_score, commits_matches = _score_text_for_injection(commits, "commits")

    _, title_stripped = _strip_injection_tokens(title)
    _, body_stripped = _strip_injection_tokens(body)
    _, commits_stripped = _strip_injection_tokens(commits)

    total_score = int(round(title_score + body_score + commits_score))
    severity = _injection_severity(total_score)
    all_matches = title_matches + body_matches + commits_matches

    redacted_excerpts: list[dict[str, Any]] = []
    stripped_tokens = title_stripped + body_stripped + commits_stripped
    if stripped_tokens:
        redacted_excerpts.append(
            {"reason": "literal-forgery-tokens", "tokens": stripped_tokens},
        )

    # The PR description is the canonical anchor for the metadata finding.
    # cmd_fetch_intent doesn't carry commit shas into the blob, so even when
    # the trigger is a commit message we fall back to pr_description (which
    # is a fixed canonical marker, not a templated one needing a suffix).
    system_marker = "pr_description"

    now_iso = datetime.now(timezone.utc).isoformat()

    # Quarantine: rewrite intent_context.json on severity ≥ Medium so
    # downstream readers (cmd_classify_intent, Premise prompt assembly) see
    # the quarantine flag and redacted content. Selective redaction:
    # title and commits are preserved when their per-section score is 0
    # (clean → keep verbatim). body is *always* redacted on quarantine —
    # it's the highest-risk surface (longest free-form attacker-controlled
    # text) and even a clean-scoring body could carry sub-threshold signals
    # the catalogue missed.
    quarantined = total_score >= _INJECTION_SCORE_MEDIUM
    if quarantined:
        quarantined_ctx = {
            "title": (
                f"[REDACTED — injection detected (score: {total_score}, "
                f"severity: {severity})]"
                if title_score > 0 else title
            ),
            "body": (
                f"[REDACTED — injection detected (score: {total_score}, "
                f"severity: {severity})]"
            ),
            "commits": (
                "[REDACTED — quarantined alongside body]"
                if commits_score > 0 else commits
            ),
            "quarantine": True,
            "injection_score": total_score,
            "injection_severity": severity,
        }
        try:
            with open(intent_context_path, "w") as f:
                json.dump(quarantined_ctx, f, indent=2)
                f.write("\n")
        except OSError as exc:
            print(
                f"Warning: could not rewrite intent_context.json: {exc}",
                file=sys.stderr,
            )

    # BLOCKING finding on severity ≥ High. Naming it `agent_<reviewer>.json`
    # makes cmd_collect_findings pick it up via the standard glob — no new
    # merge path required.
    if total_score >= _INJECTION_SCORE_HIGH:
        finding = _make_injection_finding(
            total_score, all_matches, system_marker, now_iso,
        )
        agent_file = cr_dir / "agent_injection-detector.json"
        try:
            with open(agent_file, "w") as f:
                json.dump({"findings": [finding]}, f, indent=2)
        except OSError as exc:
            print(
                f"Warning: could not write injection finding: {exc}",
                file=sys.stderr,
            )

    # Audit log. Log only pattern class names (not payload content) to avoid
    # log-injection re-amplification.
    audit_entry = {
        "timestamp": now_iso,
        "score": total_score,
        "severity": severity,
        "matches": sorted({m["pattern"] for m in all_matches}),
        "quarantined": quarantined,
        "stripped_token_count": len(stripped_tokens),
        "intent_context_path": str(intent_context_path),
    }
    try:
        _append_injection_audit_log(
            Path.cwd() / _INJECTION_AUDIT_LOG, audit_entry,
        )
    except OSError as exc:
        print(f"Warning: could not append audit log: {exc}", file=sys.stderr)

    # Stdout: the report payload (walker redirects to injection_report.json).
    report = {
        "score": total_score,
        "severity": severity,
        "matches": all_matches,
        "redacted_excerpts": redacted_excerpts,
        "quarantine": quarantined,
        "intent_context_path": str(intent_context_path),
    }
    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# PLN-725 Phase 1 — Signal extraction (Stage 1 of deterministic coverage)
# ---------------------------------------------------------------------------
# Two-step LLM stage modelled on PLN-722's verifier:
#   1. ``extract-signals-prepare`` — read diff_data.json + intent + taxonomy,
#      compute the cache key, check the cache. On hit: write the final
#      ``extract_signals.json`` immediately. On miss: write the agent input
#      bundle (diff summary + taxonomy reference) and the manifest the
#      orchestrator uses to spawn a single Haiku agent.
#   2. ``extract-signals-consolidate`` — read the agent's output, validate it
#      against the taxonomy / evidence / confidence-floor contract, write the
#      final ``extract_signals.json``, and update the cache.
#
# Signal-extraction output is observational and does not affect routing.

SIGNAL_CONFIDENCE_FLOOR = 0.7
SIGNAL_CONFIDENCE_MAX = 1.0
SIGNAL_FAIL_CLOSED_CONFIDENCE = 0.5
SIGNAL_EXTRACTION_MODEL_DEFAULT = "haiku"
SIGNAL_EXTRACTION_MARKER = "signal-extraction-failed"
SIGNAL_TAXONOMY_FILENAME = "signal_taxonomy.json"
SIGNAL_EXTRACTION_PROMPT_FILENAME = "signal_extraction_prompt.txt"

# Cap on per-file excerpt size injected into the agent input. The taxonomy
# is the agent's reference — the diff context is the evidence. We need
# enough to ground signals without blowing the Haiku context budget.
SIGNAL_EXCERPT_MAX_FILES = 25
SIGNAL_EXCERPT_LINES_PER_FILE = 20

# Deterministic file→language hint. Used only as a hint in the agent input;
# language signals must still be confirmed by the LLM (e.g. a ``.ts`` file
# that only renames a constant is not a meaningful TypeScript signal).
_EXTENSION_LANGUAGE_HINTS: dict[str, str] = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin", ".kts": "kotlin",
    ".scala": "scala", ".sc": "scala",
    ".sql": "sql",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
}


def _default_signal_taxonomy_path() -> Path:
    """Canonical location of the v1 taxonomy alongside this module."""
    return Path(__file__).resolve().parent / SIGNAL_TAXONOMY_FILENAME


def _default_signal_extraction_prompt_path() -> Path:
    """Canonical location of the signal-extraction prompt asset."""
    return Path(__file__).resolve().parent.parent / "prompts" / SIGNAL_EXTRACTION_PROMPT_FILENAME


def load_signal_taxonomy(path: Path | None = None) -> tuple[dict[str, Any], bytes]:
    """Load and structurally validate the signal taxonomy.

    Returns ``(taxonomy_dict, raw_bytes)``. ``raw_bytes`` is what the cache
    key hashes — a content-addressed taxonomy fingerprint so any edit (new
    signal, changed description, changed recommended floor) invalidates
    every cached extraction.

    Raises ``ValueError`` on a structurally invalid taxonomy. The taxonomy
    is a checked-in asset; structural failure is a deploy-time bug, not a
    runtime fault to swallow.
    """
    target = path or _default_signal_taxonomy_path()
    raw = target.read_bytes()
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"taxonomy at {target} is not a JSON object")
    signals = data.get("signals")
    if not isinstance(signals, dict) or not signals:
        raise ValueError(f"taxonomy at {target} has no 'signals' object")
    for name, entry in signals.items():
        if not isinstance(name, str) or not name:
            raise ValueError(f"taxonomy {target}: empty signal name")
        if not isinstance(entry, dict):
            raise ValueError(f"taxonomy {target}: signal {name!r} entry not an object")
        for key in ("category", "description", "recommended_min_confidence"):
            if key not in entry:
                raise ValueError(f"taxonomy {target}: signal {name!r} missing {key!r}")
        rmc = entry["recommended_min_confidence"]
        if not isinstance(rmc, (int, float)) or not (0.0 <= float(rmc) <= 1.0):
            raise ValueError(
                f"taxonomy {target}: signal {name!r} has invalid recommended_min_confidence",
            )
    return data, raw


def _taxonomy_hash(raw_bytes: bytes) -> str:
    return hashlib.sha256(raw_bytes).hexdigest()


def _signal_extraction_prompt_hash(path: Path) -> str:
    """Content-addressed hash of the signal-extraction prompt asset.

    Self-contained inside the signals/ namespace rather than folded into
    the canonical ``compute-hashes`` output. The other namespace prompt
    hashes (shared, BHA suffix, verifier, premise) are concerns of those
    pipelines; mixing them into the signal-extraction key would over-
    invalidate (e.g. a premise-prompt edit would bust signal caches).
    Mirrors the taxonomy hash pattern in this same module.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def signal_extraction_cache_key(
    diff_tip: str, taxonomy_hash: str, prompt_hash: str,
) -> str:
    """Cache key for the ``signals`` namespace (PLN-725).

    Tuple ``(diff_tip, taxonomy_hash, prompt_hash)`` is the complete set
    of inputs the extraction is a pure function of. Both
    ``taxonomy_hash`` and ``prompt_hash`` are content-addressed hashes of
    the on-disk asset bytes (``_taxonomy_hash`` and
    ``_signal_extraction_prompt_hash``), computed inside
    ``cmd_extract_signals_prepare`` rather than taken on faith from
    caller-supplied flags. Editing either asset flips the key for real.
    """
    payload = (
        (diff_tip or "") + "\0"
        + (taxonomy_hash or "") + "\0"
        + (prompt_hash or "")
    )
    return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()


def _signal_cache_path(cache_dir: Path, key: str) -> Path:
    """PLN-719 namespace layout: ``<cache_dir>/signals/<key>.json``."""
    return cache_dir / CACHE_NAMESPACE_SIGNALS / f"{key}.json"


def _read_cached_signals(cache_dir: Path | None, key: str) -> dict[str, Any] | None:
    """Return cached extraction output if fresh, else None.

    Thin wrapper over ``_read_simple_cache_entry`` — the signals namespace
    follows the standard ``written_at``-stamped scheme.
    """
    if cache_dir is None:
        return None
    return _read_simple_cache_entry(
        cache_dir, _signal_cache_path(cache_dir, key),
        CACHE_NAMESPACE_SIGNALS, 7,
    )


def _write_cached_signals(
    cache_dir: Path | None, key: str, payload: dict[str, Any],
) -> None:
    """Persist a successful extraction to the ``signals`` cache namespace.

    Fail-open: delegates to ``_write_simple_cache_entry``; an OSError on the
    cache write is logged to stderr but never raised — the canonical
    ``<cr_dir>/extract_signals.json`` is already on disk, so cache-write
    failure is a re-run cost issue, not a pipeline halt.
    """
    if cache_dir is None:
        return
    _write_simple_cache_entry(
        cache_dir, _signal_cache_path(cache_dir, key), payload, "signal",
    )


def _file_language_hint(path: str) -> str | None:
    ext = Path(path).suffix.lower()
    return _EXTENSION_LANGUAGE_HINTS.get(ext)


def _build_signal_input(
    diff_data: dict[str, Any],
    intent_summary: dict[str, Any] | None,
) -> dict[str, Any]:
    """Render the bounded agent-input bundle from ``diff_data.json``.

    The agent gets enough context to ground every taxonomy signal without
    receiving the full diff. We send file metadata for every file (cheap)
    plus per-file excerpts (added + removed lines) for the largest
    ``SIGNAL_EXCERPT_MAX_FILES`` files; for each we cap excerpt size at
    ``SIGNAL_EXCERPT_LINES_PER_FILE`` of each direction. Anything beyond
    the cap is summarized as ``…(+N more added lines, +M more removed)``.
    """
    # parse-diff emits file_loc as ``{path: {"added": int, "removed": int}}``;
    # signal extraction only needs counts, which lines_added/lines_removed
    # already carry. The previous ``loc`` field was both misannotated and
    # redundant.
    file_statuses: dict[str, str] = diff_data.get("file_statuses", {}) or {}
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {}) or {}

    files: list[dict[str, Any]] = []
    for path, status in sorted(file_statuses.items()):
        pl = patch_lines.get(path, {}) or {}
        added = pl.get("added_lines", {}) or {}
        removed = pl.get("removed_lines", {}) or {}
        files.append({
            "path": path,
            "status": status,
            "lines_added": len(added),
            "lines_removed": len(removed),
            "language_hint": _file_language_hint(path),
        })

    # Pick the top-N files by total churn for inline excerpts.
    ranked = sorted(
        files, key=lambda f: f["lines_added"] + f["lines_removed"], reverse=True,
    )[:SIGNAL_EXCERPT_MAX_FILES]

    excerpts: list[dict[str, Any]] = []
    for entry in ranked:
        path = entry["path"]
        pl = patch_lines.get(path, {}) or {}
        added = pl.get("added_lines", {}) or {}
        removed = pl.get("removed_lines", {}) or {}

        def _cap(d: dict[str, str]) -> tuple[list[dict[str, str]], int]:
            items = sorted(d.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 0)
            head = items[:SIGNAL_EXCERPT_LINES_PER_FILE]
            overflow = max(0, len(items) - len(head))
            return ([{"line": k, "content": v} for k, v in head], overflow)

        added_sample, added_overflow = _cap(added)
        removed_sample, removed_overflow = _cap(removed)
        excerpts.append({
            "path": path,
            "added_sample": added_sample,
            "added_overflow": added_overflow,
            "removed_sample": removed_sample,
            "removed_overflow": removed_overflow,
        })

    return {
        "files": files,
        "sample_diff_excerpts": excerpts,
        "intent": intent_summary or {},
    }


def validate_signal_extraction_output(
    raw: Any, taxonomy: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate LLM signal-extraction output against the taxonomy contract.

    Returns ``(accepted_signals, errors)``. ``errors`` lists every reason a
    signal was rejected; an empty ``accepted`` with non-empty ``errors``
    means the whole extraction is unusable and the caller should fail
    closed. The validator is strict by design — the failure modes here
    (invented names, missing evidence, confidence below floor, duplicate
    names) are exactly the contract violations the prompt enumerates.
    """
    errors: list[str] = []
    if not isinstance(raw, dict):
        return [], ["output is not a JSON object"]
    signals = raw.get("signals")
    if not isinstance(signals, list):
        return [], ["'signals' is missing or not a list"]
    valid_names = set(taxonomy.get("signals", {}).keys())
    accepted: list[dict[str, Any]] = []
    seen: set[str] = set()
    for idx, entry in enumerate(signals):
        if not isinstance(entry, dict):
            errors.append(f"signals[{idx}] is not an object")
            continue
        name = entry.get("name")
        evidence = entry.get("evidence")
        confidence = entry.get("confidence")
        if not isinstance(name, str) or name not in valid_names:
            errors.append(f"signals[{idx}] has invalid name: {name!r}")
            continue
        if name in seen:
            errors.append(f"signals[{idx}] duplicates name: {name!r}")
            continue
        if not isinstance(evidence, str) or not evidence.strip():
            errors.append(f"signals[{idx}] ({name}) has empty evidence")
            continue
        if not isinstance(confidence, (int, float)):
            errors.append(f"signals[{idx}] ({name}) has non-numeric confidence")
            continue
        conf = float(confidence)
        if conf < SIGNAL_CONFIDENCE_FLOOR or conf > SIGNAL_CONFIDENCE_MAX:
            errors.append(
                f"signals[{idx}] ({name}) confidence {conf} outside "
                f"[{SIGNAL_CONFIDENCE_FLOOR}, {SIGNAL_CONFIDENCE_MAX}]",
            )
            continue
        seen.add(name)
        accepted.append({"name": name, "evidence": evidence.strip(), "confidence": conf})
    accepted.sort(key=lambda s: s["confidence"], reverse=True)
    return accepted, errors


def fail_closed_signal_set(taxonomy: dict[str, Any]) -> list[dict[str, Any]]:
    """Return the fail-closed signal set: every taxonomy signal at 0.5.

    Per PLN-725 §2: extraction failure → all LLM signals treated as
    present at ``SIGNAL_FAIL_CLOSED_CONFIDENCE`` so coverage over-triggers
    best-effort. The deterministic floor (required reviewers) is unaffected
    because required rules cannot key solely on LLM signals.
    """
    return [
        {
            "name": name,
            "evidence": "fail-closed default (extraction did not produce a valid result)",
            "confidence": SIGNAL_FAIL_CLOSED_CONFIDENCE,
        }
        for name in sorted(taxonomy.get("signals", {}).keys())
    ]


def cmd_extract_signals_prepare(args: argparse.Namespace) -> int:
    """PLN-725 Stage 1a: prep the signal-extraction agent input + check cache.

    Reads ``diff_data.json`` and (optionally) an intent summary, computes
    the ``(diff_tip, taxonomy_hash, prompt_hash)`` cache key, and either:

      - **Cache hit** — writes the cached extraction directly to
        ``<cr_dir>/extract_signals.json`` and emits a manifest with
        ``status: "cache_hit"``. No agent spawn needed.
      - **Cache miss** — writes the agent's input bundle to
        ``<cr_dir>/extract_signals_input.json`` (and a snapshot of the
        taxonomy alongside) and emits a manifest with
        ``status: "needs_agent"``, ``input_path``, ``output_path``,
        ``taxonomy_path``, ``prompt_path`` so the orchestrator can spawn
        a single Haiku agent.

    Always exits 0; structural failures (no diff_data, malformed
    taxonomy) print to stderr and return 1.
    """
    cr_dir = Path(args.cr_dir)
    diff_data_path = Path(args.diff_data)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    diff_tip = str(args.diff_tip)
    taxonomy_path = (
        Path(args.taxonomy) if getattr(args, "taxonomy", None) else _default_signal_taxonomy_path()
    )
    prompt_path = (
        Path(args.prompt) if getattr(args, "prompt", None) else _default_signal_extraction_prompt_path()
    )
    intent_path = Path(args.intent) if getattr(args, "intent", None) else None
    model = str(getattr(args, "model", None) or SIGNAL_EXTRACTION_MODEL_DEFAULT)

    try:
        cr_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Error: cannot create cr_dir: {exc}", file=sys.stderr)
        return 1

    try:
        with open(diff_data_path) as f:
            diff_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading diff_data: {exc}", file=sys.stderr)
        return 1
    if not isinstance(diff_data, dict):
        print("Error: diff_data is not a JSON object", file=sys.stderr)
        return 1

    try:
        taxonomy, taxonomy_bytes = load_signal_taxonomy(taxonomy_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error loading taxonomy: {exc}", file=sys.stderr)
        return 1

    # Hash the prompt asset from its actual bytes so any prompt edit busts
    # every cached extraction — matches the taxonomy hash pattern. The
    # vestigial --prompt-hash flag is honoured only as an explicit
    # orchestrator override for cases where the prompt is computed
    # off-disk; the default behaviour is content-addressed.
    prompt_hash_override = str(getattr(args, "prompt_hash", "") or "")
    try:
        prompt_hash = prompt_hash_override or _signal_extraction_prompt_hash(prompt_path)
    except OSError as exc:
        print(f"Error reading prompt asset: {exc}", file=sys.stderr)
        return 1

    taxonomy_hash = _taxonomy_hash(taxonomy_bytes)
    key = signal_extraction_cache_key(diff_tip, taxonomy_hash, prompt_hash)

    output_path = cr_dir / "extract_signals.json"

    manifest_path = cr_dir / "extract_signals_manifest.json"
    cached = _read_cached_signals(cache_dir, key)
    if cached is not None:
        # Strip cache-only metadata before writing the canonical output.
        canonical = {k: v for k, v in cached.items() if k != "written_at"}
        try:
            with open(output_path, "w") as f:
                json.dump(canonical, f, indent=2)
        except OSError as exc:
            print(f"Error writing cached extraction: {exc}", file=sys.stderr)
            return 1
        return _write_and_emit_manifest(manifest_path, {
            "status": "cache_hit",
            "cache_key": key,
            "taxonomy_hash": taxonomy_hash,
            "prompt_hash": prompt_hash,
            "output_path": str(output_path),
            "model": model,
        })

    intent_summary: dict[str, Any] | None = None
    if intent_path is not None:
        try:
            with open(intent_path) as f:
                intent_summary = json.load(f)
        except (OSError, json.JSONDecodeError):
            intent_summary = None
        if not isinstance(intent_summary, dict):
            intent_summary = None

    agent_input = _build_signal_input(diff_data, intent_summary)
    input_path = cr_dir / "extract_signals_input.json"
    with open(input_path, "w") as f:
        json.dump(agent_input, f, indent=2)

    # Snapshot the taxonomy into cr_dir so the agent reads a stable file
    # for this run even if the canonical asset is edited mid-flight.
    taxonomy_snapshot_path = cr_dir / "extract_signals_taxonomy.json"
    taxonomy_snapshot_path.write_bytes(taxonomy_bytes)

    return _write_and_emit_manifest(manifest_path, {
        "status": "needs_agent",
        "cache_key": key,
        "taxonomy_hash": taxonomy_hash,
        "prompt_hash": prompt_hash,
        "input_path": str(input_path),
        "taxonomy_path": str(taxonomy_snapshot_path),
        "prompt_path": str(prompt_path),
        "output_path": str(output_path),
        "model": model,
    })


def cmd_extract_signals_consolidate(args: argparse.Namespace) -> int:
    """PLN-725 Stage 1b: validate the agent's signal output, write the canonical
    ``extract_signals.json``, and update the cache.

    Reads ``<agent_output>`` (typically ``<cr_dir>/pln725_extract_signals.json``
    written by the Haiku agent), validates against the taxonomy contract,
    and:

      - **All valid:** writes ``<cr_dir>/extract_signals.json`` with the
        accepted signal list and ``status: "ok"``. Updates the cache.
      - **All rejected (or read failure):** fails closed. Writes
        ``extract_signals.json`` with the fail-closed signal set and a
        ``status: "fail_closed"`` block listing every rejection reason.
        Emits a ``system-marker`` MEDIUM finding to
        ``<cr_dir>/agent_signal-extraction-failed.json`` so the verdict
        layer can surface the operator-visible warning. Does **not**
        cache fail-closed output.

    Always exits 0 — a failed extraction is a routing degradation, not a
    pipeline halt. Exits 1 only on structural problems (no cr_dir, no
    taxonomy).
    """
    cr_dir = Path(args.cr_dir)
    agent_output_path = Path(args.agent_output)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    taxonomy_path = (
        Path(args.taxonomy) if getattr(args, "taxonomy", None) else _default_signal_taxonomy_path()
    )
    manifest_path = (
        Path(args.manifest)
        if getattr(args, "manifest", None)
        else cr_dir / "extract_signals_manifest.json"
    )

    if not cr_dir.exists():
        print(f"Error: cr_dir does not exist: {cr_dir}", file=sys.stderr)
        return 1

    try:
        taxonomy, _taxonomy_bytes = load_signal_taxonomy(taxonomy_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"Error loading taxonomy: {exc}", file=sys.stderr)
        return 1

    manifest = _read_manifest_dict(manifest_path)
    cache_key = str(manifest.get("cache_key") or "")
    taxonomy_hash = str(manifest.get("taxonomy_hash") or "")
    prompt_hash = str(manifest.get("prompt_hash") or "")
    model = str(manifest.get("model") or SIGNAL_EXTRACTION_MODEL_DEFAULT)
    manifest_status = str(manifest.get("status") or "")

    output_path = cr_dir / "extract_signals.json"
    now_iso = datetime.now(timezone.utc).isoformat()

    # PLN-725 Phase 4: orchestrator wiring runs consolidate unconditionally as
    # the stage after the agent-dispatch step. On a cache_hit manifest, prepare
    # already wrote extract_signals.json directly — no agent was spawned, no
    # pln725_extract_signals.json exists, and re-reading from cache would just
    # duplicate the work prepare already did. No-op so the walker stays
    # mechanically-driven without conditional dispatch.
    if manifest_status == "cache_hit" and output_path.exists():
        return _emit_summary({
            "status": "cache_hit",
            "output_path": str(output_path),
            "cache_key": cache_key,
        })

    def _build_fail_closed_canonical(errors: list[str]) -> dict[str, Any]:
        return {
            "status": "fail_closed",
            "signals": fail_closed_signal_set(taxonomy),
            "errors": errors,
            "model": model,
            "cache_key": cache_key,
            "taxonomy_hash": taxonomy_hash,
            "prompt_hash": prompt_hash,
            "generated_at": now_iso,
        }

    def _fail_closed(errors: list[str]) -> int:
        canonical = _build_fail_closed_canonical(errors)
        _emit_signal_extraction_failed_finding(cr_dir, errors, now_iso)
        with open(output_path, "w") as f:
            json.dump(canonical, f, indent=2)
        return _emit_summary({
            "status": "fail_closed",
            "errors": errors,
            "output_path": str(output_path),
        })

    raw_output, read_error = _read_agent_output_or_error(agent_output_path)
    if read_error is not None:
        return _fail_closed([read_error])

    accepted, errors = validate_signal_extraction_output(raw_output, taxonomy)
    if not accepted and errors:
        return _fail_closed(errors)

    canonical = {
        "status": "ok",
        "signals": accepted,
        "errors": errors,  # Partial-rejection signal for observability.
        "model": model,
        "cache_key": cache_key,
        "taxonomy_hash": taxonomy_hash,
        "prompt_hash": prompt_hash,
        "generated_at": now_iso,
    }
    with open(output_path, "w") as f:
        json.dump(canonical, f, indent=2)
    if cache_key:
        _write_cached_signals(cache_dir, cache_key, canonical)
    return _emit_summary({
        "status": "ok",
        "signal_count": len(accepted),
        "rejected": len(errors),
        "output_path": str(output_path),
    })


def _emit_signal_extraction_failed_finding(
    cr_dir: Path, errors: list[str], now_iso: str,
) -> None:
    """Write a MEDIUM system-marker finding for surfacing in the run summary.

    Per PLN-725 §2: extraction failure must surface as an operator-visible
    finding (so the failure is auditable, not silent) but must not halt
    the pipeline (fail-closed coverage already protects required
    reviewers). Fail-open on write error — telemetry is observational.
    """
    # Cap embedded error list so a chatty validator can't bloat the
    # finding payload past sensible review-comment size.
    error_summary = errors[:10]
    if len(errors) > 10:
        error_summary.append(f"… {len(errors) - 10} more")
    finding = {
        "reviewer": "signal-extractor",
        "source": "signal-extractor",
        "finding_scope": "system",
        "system_marker": SIGNAL_EXTRACTION_MARKER,
        "category": "Coverage",
        "severity": "MEDIUM",
        "file": None,
        "line": None,
        "issue": "Signal extraction failed; coverage is using fail-closed defaults.",
        "explanation": (
            "The signal-extraction stage produced no usable signals. Coverage "
            "routing is using the fail-closed default (every taxonomy signal "
            "present at 0.5 confidence) so best-effort reviewers over-trigger. "
            "Required reviewers are unaffected because required rules cannot "
            "key solely on LLM signals."
        ),
        "recommendation": (
            "Re-run the review once the underlying issue is resolved. "
            "Common causes: agent timeout, malformed agent output, taxonomy "
            "mismatch after a recent edit."
        ),
        "confidence": 1.0,
        "rationale_summary": "; ".join(error_summary)[:1000],
        "emitted_at": now_iso,
    }
    try:
        with open(cr_dir / "agent_signal-extraction-failed.json", "w") as f:
            json.dump({"findings": [finding]}, f, indent=2)
    except OSError as exc:
        print(f"Warning: could not write signal-extraction-failed finding: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# PLN-725 — Coverage resolution (deterministic coverage stage)
# ---------------------------------------------------------------------------
# Components:
#   1. The ``coverage[]`` rule schema in ``critic-gates.json`` (constants
#      live in ``code_review_schema.py``).
#   2. ``resolve-coverage`` subcommand: deterministic resolver that reads
#      diff_data + critic-gates + (optional) extract_signals.json,
#      evaluates trigger rules, and writes the initial plan into the
#      ``initial`` section of ``coverage.json``. Best-effort migration
#      of legacy ``moduleCritics[]`` entries is handled inline by
#      ``migrate_legacy_module_critics``.

# Canonical change_class → path glob patterns. Adding a class requires
# an entry here AND in ``COVERAGE_CHANGE_CLASSES`` (schema module).
CHANGE_CLASS_PATH_PATTERNS: dict[str, tuple[str, ...]] = {
    "schema_change": (
        "**/migrations/**",
        "**/schema/**",
        "**/*.sql",
    ),
    "infrastructure_change": (
        "**/terraform/**",
        "**/cloudformation/**",
        "**/k8s/**",
        "**/kubernetes/**",
        "**/helm/**",
        "**/*.tf",
        "**/*.tfvars",
    ),
    "build_config_change": (
        "**/webpack.config.*",
        "**/vite.config.*",
        "**/tsconfig*.json",
        "**/babel.config.*",
        "**/esbuild.config.*",
        "**/Makefile",
        "**/Dockerfile*",
        "**/.github/workflows/**",
    ),
    "dependency_change": (
        "**/package.json",
        "**/package-lock.json",
        "**/yarn.lock",
        "**/pnpm-lock.yaml",
        "**/requirements*.txt",
        "**/Pipfile*",
        "**/poetry.lock",
        "**/pyproject.toml",
        "**/Cargo.toml",
        "**/Cargo.lock",
        "**/go.mod",
        "**/go.sum",
        "**/Gemfile*",
    ),
}


def classify_file_changes(files: list[str]) -> set[str]:
    """Return the set of change_classes detected in the changed file list.

    Pure function. Each ``COVERAGE_CHANGE_CLASSES`` entry is treated as
    "any file matches any pattern" — first match wins per class. The
    result is the set of classes that fire, suitable for the
    ``change_class`` trigger evaluator.
    """
    detected: set[str] = set()
    for change_class, patterns in CHANGE_CLASS_PATH_PATTERNS.items():
        for pattern in patterns:
            rx = _glob_to_regex(pattern)
            if any(rx.search(f) for f in files):
                detected.add(change_class)
                break
    return detected


def signals_to_confidence_map(
    extract_signals: dict[str, Any] | None,
) -> dict[str, float]:
    """Flatten ``extract_signals.json`` into ``{signal_name: confidence}``.

    Used by ``_trigger_fires`` for the ``signal`` trigger type. Accepts
    both the canonical output shape and a None for callers that ran
    without signal extraction (no extract_signals.json on disk).
    """
    if not isinstance(extract_signals, dict):
        return {}
    raw = extract_signals.get("signals")
    if not isinstance(raw, list):
        return {}
    out: dict[str, float] = {}
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        conf = entry.get("confidence")
        if isinstance(name, str) and isinstance(conf, (int, float)):
            # If the same name appears twice (shouldn't happen post-
            # validation), keep the higher confidence.
            prev = out.get(name, -1.0)
            if float(conf) > prev:
                out[name] = float(conf)
    return out


def _trigger_fires(
    trigger: dict[str, Any],
    files: list[str],
    patch_lines: dict[str, dict[str, dict[str, str]]],
    change_classes: set[str],
    signals: dict[str, float],
) -> bool:
    """Evaluate a single trigger against the diff state. Pure function.

    Returns True iff the trigger fires for this diff. Unknown trigger
    types return False — the schema validates type membership at load
    time, so this is defensive only.
    """
    ttype = trigger.get("type")
    if ttype == "always":
        return True
    if ttype == "extension":
        exts_raw = trigger.get("extensions", [])
        if not isinstance(exts_raw, list):
            return False
        exts = {str(e).lower() for e in exts_raw}
        min_files = int(trigger.get("min_files", 1) or 1)
        count = sum(1 for f in files if Path(f).suffix.lower() in exts)
        return count >= min_files
    if ttype == "path_pattern":
        patterns = trigger.get("patterns", [])
        if not isinstance(patterns, list):
            return False
        # ``ignore_case`` is opt-in (default False so canonical rules keep
        # their explicit case-sensitive semantics). ``moduleCritics[]``
        # migration sets it to True to preserve the original
        # ``substring.lower() in path.lower()`` behaviour.
        ignore_case = bool(trigger.get("ignore_case", False))
        for pat in patterns:
            if not isinstance(pat, str) or not pat:
                continue
            rx = _glob_to_regex(pat)
            if ignore_case:
                # Re-compile with IGNORECASE preserving the same source pattern.
                rx = re.compile(rx.pattern, re.IGNORECASE)
            if any(rx.search(f) for f in files):
                return True
        return False
    if ttype == "content_signal":
        pattern = trigger.get("pattern", "")
        if not isinstance(pattern, str) or not pattern:
            return False
        try:
            rx = re.compile(pattern)
        except re.error:
            return False
        max_scan = trigger.get("max_scan_lines")
        cap = int(max_scan) if isinstance(max_scan, int) and max_scan > 0 else None
        scanned = 0
        for pl in patch_lines.values():
            added = pl.get("added_lines", {}) if isinstance(pl, dict) else {}
            for line in added.values():
                if cap is not None and scanned >= cap:
                    return False
                scanned += 1
                if rx.search(str(line)):
                    return True
        return False
    if ttype == "change_class":
        cls = trigger.get("class")
        return isinstance(cls, str) and cls in change_classes
    if ttype == "signal":
        name = trigger.get("name")
        if not isinstance(name, str) or name not in signals:
            return False
        min_conf = float(trigger.get("min_confidence", 0.0) or 0.0)
        return signals[name] >= min_conf
    return False


def migrate_legacy_module_critics(
    module_critics: list[Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Migrate ``moduleCritics[]`` substring rules into canonical
    ``coverage[]`` path_pattern rules.

    Pure function. Each entry becomes one ``coverage[]`` entry per critic,
    scoped to ``both`` and ``required=False`` — best-effort, substring-match,
    case-insensitive inside the new schema. Substrings are wrapped as
    ``**<sub>**`` globs so the canonical resolver matches anywhere in the
    path (filename, directory, extension); ``**foo**`` translates to the
    regex ``^.*foo.*$`` per ``_glob_to_regex``'s middle-``**`` rule. The
    migrated trigger carries ``ignore_case: True`` so the resolver compiles
    the pattern with ``re.IGNORECASE``, matching the original
    ``substring.lower() in path.lower()`` semantics.

    Returns ``(migrated, warnings)``. The warning list reports the number
    of entries migrated and the number skipped as malformed.
    """
    migrated: list[dict[str, Any]] = []
    skipped = 0
    for entry in module_critics:
        if not isinstance(entry, dict):
            skipped += 1
            continue
        patterns_raw = entry.get("patterns", [])
        critics_raw = entry.get("critics", [])
        if not isinstance(patterns_raw, list) or not isinstance(critics_raw, list):
            skipped += 1
            continue
        patterns = [
            f"**{p}**" for p in patterns_raw if isinstance(p, str) and p
        ]
        if not patterns:
            skipped += 1
            continue
        for critic in critics_raw:
            if not isinstance(critic, str) or not critic:
                continue
            migrated.append({
                "reviewer": critic,
                "triggers": [{
                    "type": "path_pattern",
                    "patterns": list(patterns),
                    # Legacy ``route`` matched ``substring.lower() in
                    # path.lower()``. Preserve that by setting
                    # ignore_case=True on the migrated trigger; canonical
                    # rules default to case-sensitive.
                    "ignore_case": True,
                }],
                "required": False,
                "scope": "both",
                "_migrated_from": "moduleCritics",
            })
    warnings: list[str] = []
    if migrated:
        warnings.append(
            f"{len(migrated)} entries migrated from moduleCritics[] to "
            f"coverage[] as best-effort path_pattern rules; edit "
            f"critic-gates.json to use the canonical coverage[] schema "
            f"for finer-grained control."
        )
    if skipped:
        warnings.append(
            f"Skipped {skipped} malformed moduleCritics entries during migration.",
        )
    return migrated, warnings


def _validate_coverage_rule(
    rule: dict[str, Any], index: int,
) -> tuple[bool, list[str]]:
    """Structural validation of a coverage[] rule. Returns (ok, errors).

    Catches the contract violations that would otherwise produce
    silent-misroute behaviour:

      - missing or invalid ``reviewer``
      - missing or empty ``triggers``
      - non-object trigger entry
      - unknown trigger ``type``
      - unknown ``change_class.class`` value (would silently never fire)
      - unknown ``scope``

    The required-with-only-LLM-signals invariant is enforced at
    *resolution* time in ``resolve_coverage``, not here, because it
    depends on knowing whether the rule actually fires (so a never-
    matching rule does not generate misleading downgrade noise). See
    PR #124 review (bha_p0_f1, bhb_f1) — this validator catches
    edit-time structural problems only; runtime invariants live in the
    resolver.
    """
    errors: list[str] = []
    reviewer = rule.get("reviewer")
    if not isinstance(reviewer, str) or not reviewer:
        errors.append(f"coverage[{index}] missing or invalid 'reviewer'")
        return False, errors
    triggers = rule.get("triggers")
    if not isinstance(triggers, list) or not triggers:
        errors.append(f"coverage[{index}] ({reviewer}) missing or empty 'triggers'")
        return False, errors
    for ti, t in enumerate(triggers):
        if not isinstance(t, dict):
            errors.append(
                f"coverage[{index}].triggers[{ti}] ({reviewer}) is not an object",
            )
            continue
        ttype = t.get("type")
        if ttype not in COVERAGE_TRIGGER_TYPES:
            errors.append(
                f"coverage[{index}].triggers[{ti}] ({reviewer}) "
                f"unknown trigger type: {ttype!r}",
            )
            continue
        # PR #124 review (auditor_f1): catch unknown change_class
        # values at edit time. Without this an operator can typo
        # "scheme_change" and the trigger silently never fires.
        if ttype == "change_class":
            cls = t.get("class")
            if not isinstance(cls, str) or cls not in COVERAGE_CHANGE_CLASSES:
                errors.append(
                    f"coverage[{index}].triggers[{ti}] ({reviewer}) "
                    f"unknown change_class.class: {cls!r}. "
                    f"Valid values: {sorted(COVERAGE_CHANGE_CLASSES)}",
                )
    scope = rule.get("scope", "code-review")
    if scope not in COVERAGE_SCOPES:
        errors.append(
            f"coverage[{index}] ({reviewer}) unknown scope: {scope!r}",
        )
    return not errors, errors


def resolve_coverage(
    critic_gates: dict[str, Any],
    diff_data: dict[str, Any],
    extract_signals: dict[str, Any] | None = None,
    scope_filter: str = "code-review",
) -> dict[str, Any]:
    """Pure resolver from rules + diff state → Coverage Plan.

    Inputs:
      - ``critic_gates``: parsed critic-gates.json. Reads both
        ``coverage[]`` (canonical) and ``moduleCritics[]`` (soft-compat).
        ``moduleCritics[]`` entries are migrated on the fly via
        ``migrate_legacy_module_critics`` so a file with only those
        entries keeps working.
      - ``diff_data``: parse-diff output. Uses ``files_to_review`` for
        path/extension/change_class triggers and ``patch_lines`` for
        content_signal triggers.
      - ``extract_signals``: optional Phase 1 output. When omitted,
        ``signal`` triggers cannot fire (the determinism enforcement
        already prevents required rules from depending on them).
      - ``scope_filter``: ``code-review`` (default) or ``plan-review``;
        rules with ``scope: "both"`` always pass.

    Returns a dict with ``required``, ``best_effort``, ``warnings``,
    ``stats``. Always-add core reviewers (``COVERAGE_CORE_REQUIRED``)
    appear in ``required`` regardless of rule matches.

    Determinism enforcement: a rule with ``required: true`` whose
    triggers are entirely LLM-driven (only ``signal`` triggers) is
    downgraded to best-effort with a warning. This is the architectural
    invariant from PLN-725 §1 — LLM signals can ADD but not solely
    DRIVE required selection.
    """
    files = list(diff_data.get("files_to_review", []) or [])
    patch_lines_raw = diff_data.get("patch_lines", {}) or {}
    patch_lines: dict[str, dict[str, dict[str, str]]] = (
        patch_lines_raw if isinstance(patch_lines_raw, dict) else {}
    )
    change_classes = classify_file_changes(files)
    signals = signals_to_confidence_map(extract_signals)

    # Compose rule list: canonical coverage[] + migrated moduleCritics[].
    canonical = critic_gates.get("coverage", [])
    canonical = canonical if isinstance(canonical, list) else []
    module_critics = critic_gates.get("moduleCritics", [])
    module_critics = module_critics if isinstance(module_critics, list) else []
    migrated, migration_warnings = migrate_legacy_module_critics(module_critics)
    rules = list(canonical) + migrated

    warnings: list[str] = list(migration_warnings)
    required: list[dict[str, Any]] = []
    best_effort: list[dict[str, Any]] = []
    seen_required: set[str] = set()
    seen_best_effort: set[str] = set()

    # Always-add core required reviewers.
    for core_name in COVERAGE_CORE_REQUIRED:
        required.append({
            "reviewer": core_name,
            "trigger": {"type": "always"},
            "source": "core",
        })
        seen_required.add(core_name)

    rules_evaluated = 0
    rules_matched = 0

    for idx, rule in enumerate(rules):
        if not isinstance(rule, dict):
            continue
        ok, rule_errors = _validate_coverage_rule(rule, idx)
        if not ok:
            warnings.extend(rule_errors)
            continue

        rule_scope = rule.get("scope", "code-review")
        if rule_scope != "both" and rule_scope != scope_filter:
            continue

        reviewer = rule["reviewer"]
        triggers = rule["triggers"]
        required_flag = bool(rule.get("required", False))
        rules_evaluated += 1

        # Compute determinism status once (used both for the downgrade
        # decision and the warning). The warning fires ONLY when the
        # rule actually matches (PR #124 review bha_p0_f1) — a
        # never-matching signal-only rule does not generate misleading
        # "downgraded" noise. Required-flag adjustment happens before
        # the match check so the downgrade is in effect when the rule
        # is selected.
        is_required_with_only_llm = required_flag and not any(
            isinstance(t, dict) and t.get("type") in COVERAGE_DETERMINISTIC_TRIGGERS
            for t in triggers
        )
        if is_required_with_only_llm:
            required_flag = False

        # OR semantics: first trigger that fires selects the reviewer.
        matched_trigger: dict[str, Any] | None = None
        for trigger in triggers:
            if not isinstance(trigger, dict):
                continue
            if _trigger_fires(
                trigger, files, patch_lines, change_classes, signals,
            ):
                matched_trigger = trigger
                break
        if matched_trigger is None:
            continue
        rules_matched += 1

        # Now that the rule has actually matched, surface the downgrade.
        if is_required_with_only_llm:
            warnings.append(
                f"Rule for reviewer '{reviewer}' was required=true but has only "
                f"LLM-signal triggers; downgraded to best-effort. Required rules "
                f"must include at least one deterministic trigger.",
            )

        entry: dict[str, Any] = {
            "reviewer": reviewer,
            "trigger": matched_trigger,
            "source": "rule",
        }
        for opt in ("model_override", "priority"):
            if opt in rule:
                entry[opt] = rule[opt]

        # Dedup by reviewer name. Required wins over best-effort: if a
        # reviewer is already in required[], skip it here. A reviewer
        # that lands in best-effort via one rule can be promoted to
        # required by a later rule (we honour the strictest).
        if required_flag:
            if reviewer in seen_required:
                continue
            if reviewer in seen_best_effort:
                # Promote: remove the best-effort entry, add to required.
                best_effort = [
                    e for e in best_effort if e["reviewer"] != reviewer
                ]
                seen_best_effort.discard(reviewer)
            seen_required.add(reviewer)
            required.append(entry)
        else:
            if reviewer in seen_required or reviewer in seen_best_effort:
                continue
            seen_best_effort.add(reviewer)
            best_effort.append(entry)

    return {
        "required": required,
        "best_effort": best_effort,
        "warnings": warnings,
        "stats": {
            "required_count": len(required),
            "best_effort_count": len(best_effort),
            "rules_evaluated": rules_evaluated,
            "rules_matched": rules_matched,
            "detected_change_classes": sorted(change_classes),
            "signal_count": len(signals),
        },
    }


def cmd_resolve_coverage(args: argparse.Namespace) -> int:
    """Deterministic coverage resolver (PLN-725).

    Reads diff_data + critic-gates + (optional) extract_signals.json,
    runs ``resolve_coverage``, writes the rule-resolved plan into
    ``<cr_dir>/coverage.json`` under the ``initial`` section, and emits
    a summary on stdout. Always exits 0 on a structurally valid run;
    returns 1 on file-read failure (which is the only condition the
    orchestrator needs to halt on — empty results are valid).
    """
    cr_dir = Path(args.cr_dir)
    diff_data_path = Path(args.diff_data)
    critic_gates_path = (
        Path(args.critic_gates) if getattr(args, "critic_gates", None) else None
    )
    extract_signals_path = (
        Path(args.extract_signals) if getattr(args, "extract_signals", None) else None
    )
    scope_filter = str(getattr(args, "scope", None) or "code-review")
    if scope_filter not in COVERAGE_SCOPES:
        print(f"Error: invalid scope {scope_filter!r}", file=sys.stderr)
        return 1

    try:
        cr_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Error: cannot create cr_dir: {exc}", file=sys.stderr)
        return 1

    try:
        with open(diff_data_path) as f:
            diff_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading diff_data: {exc}", file=sys.stderr)
        return 1
    if not isinstance(diff_data, dict):
        print("Error: diff_data is not a JSON object", file=sys.stderr)
        return 1

    critic_gates: dict[str, Any] = dict(_EMPTY_CRITIC_GATES)
    if critic_gates_path is not None and critic_gates_path.exists():
        try:
            with open(critic_gates_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                critic_gates = loaded
        except (OSError, json.JSONDecodeError) as exc:
            print(
                f"Warning: could not read critic-gates ({exc}); proceeding with empty",
                file=sys.stderr,
            )

    extract_signals: dict[str, Any] | None = None
    if extract_signals_path is not None and extract_signals_path.exists():
        try:
            with open(extract_signals_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                extract_signals = loaded
        except (OSError, json.JSONDecodeError):
            extract_signals = None

    plan = resolve_coverage(
        critic_gates=critic_gates,
        diff_data=diff_data,
        extract_signals=extract_signals,
        scope_filter=scope_filter,
    )

    output: dict[str, Any] = dict(plan)
    output["generated_at"] = datetime.now(timezone.utc).isoformat()
    output["scope"] = scope_filter
    # Write into coverage.json.initial via atomic section update.
    # The docstring guarantees exit 0 on structurally valid runs; an
    # OSError on the write surfaces as a structured failure so the
    # contract holds.
    try:
        _write_coverage_section(cr_dir, "initial", output)
    except OSError as exc:
        print(f"Error writing coverage plan: {exc}", file=sys.stderr)
        return 1

    summary = {
        "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
        "required_count": plan["stats"]["required_count"],
        "best_effort_count": plan["stats"]["best_effort_count"],
        "rules_evaluated": plan["stats"]["rules_evaluated"],
        "rules_matched": plan["stats"]["rules_matched"],
        "warning_count": len(plan["warnings"]),
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# PLN-725 Phase 5 — Agent-Definition Loading
#
# Produces the AVAILABLE roster the coverage-critic enforces against.
# Scans a directory (default ``.claude/agents/``) of markdown agent
# definitions, parses YAML frontmatter for each file's ``name`` field,
# and writes ``<cr_dir>/available_reviewers.json`` as a flat string
# list. Phase 4's no-roster fallback (``cmd_coverage_critic_prepare``
# short-circuiting on missing file) stays in place as the safety net
# for projects with no ``.claude/agents/`` directory.
#
# Why parse YAML frontmatter rather than just listing filenames? The
# filename is a stable convention but the in-file ``name`` is the
# authoritative identifier (it's what reviewer prompts reference and
# what ``critic-gates.json`` mentions). A filename/name mismatch
# would surface here as a roster entry that doesn't match anything
# the validator enforces against.
# ---------------------------------------------------------------------------

DEFAULT_AGENTS_DIR = Path(".claude/agents")

_FRONTMATTER_BOUNDARY = re.compile(r"^---\s*$", re.MULTILINE)
# The value group accepts:
#   bare scalar      — name: security-reviewer
#   double-quoted    — name: "security-reviewer"
#   single-quoted    — name: 'security-reviewer'
# Trailing inline comments (`# primary`) are matched and discarded in
# the post-process step below. The bare-scalar regex stays
# conservative (must start with [A-Za-z0-9], YAML-safe chars only)
# so a typo on a different key doesn't accidentally swallow content
# from a later line. Quoted forms are matched more permissively but
# the post-process step validates the unquoted value against
# ``_REVIEWER_ID_RE`` so ``name: "../x"``, ``name: "bad reviewer"``,
# and similarly malformed identifiers are rejected.
_FRONTMATTER_NAME = re.compile(
    r"""^name\s*:\s*
        (?:
            "(?P<dq>[^"\n]*)"
          | '(?P<sq>[^'\n]*)'
          | (?P<bare>[A-Za-z0-9][A-Za-z0-9_.-]*)
        )
        \s*(?:\#.*)?$
    """,
    re.MULTILINE | re.VERBOSE,
)

# Canonical agent-name grammar — used to validate ``name`` values
# extracted from quoted YAML scalars before they enter the roster. The
# bare scalar form is already constrained by the regex above, but
# quoted forms could otherwise smuggle path traversal (``"../x"``),
# whitespace (``"bad reviewer"``), or absurdly long strings into
# ``available_reviewers.json`` — names the critic could then propose
# and the closed-vocabulary check would accept because they came from
# the roster. Length cap is set conservatively at 63 chars; every
# actual project agent uses lowercase-with-hyphens well under this.
#
# The grammar mirrors ``_REVIEWER_ID_RE`` defined later for the
# collect-findings stage (which validates against ``make_finding_id``'s
# ``^[a-z][a-z0-9_-]*$`` requirement). Keeping the agent-name grammar
# at the same level of strictness guarantees that any name added to
# the roster will survive the downstream ``make_finding_id`` check —
# without this alignment a name that passed here could still poison
# the collect-findings stage. Named distinctly to avoid the module-
# level collision the earlier draft hit.
_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,62}$")

# Bounded read for an agent file: enough to cover even pathologically
# long frontmatter, far less than what a `.md` symlinked to /dev/zero
# would let the runner consume. The parser only ever reads the
# frontmatter (between the first two ``---`` lines), so the prose body
# can be truncated without affecting `name` extraction.
_AGENT_FILE_READ_LIMIT_BYTES = 64 * 1024

# Aggregate caps for the agent-definition scan. Per-file read is
# already bounded by _AGENT_FILE_READ_LIMIT_BYTES, but a hostile PR
# could otherwise add hundreds of small valid agent files (or names
# right up to the 63-char cap) to grow scan time, JSON-roster size,
# and downstream critic prompt size — none of which are limited by
# the per-file read alone. The caps deliberately apply at scan time
# (not just post-load) so the work is bounded before any bytes are
# read.
_AGENTS_DIR_MAX_FILES = 200
_ROSTER_MAX_ENTRIES = 200


def _parse_agent_name(text: str) -> str | None:
    """Return the ``name`` field from a markdown agent's YAML frontmatter.

    Tolerant by design — does NOT pull in PyYAML for one regex-able
    field. Accepts the conventional ``---\\n…\\n---`` frontmatter
    fence at the start of the file; returns the value of the first
    ``name:`` line inside the fence. Returns ``None`` for missing
    frontmatter, missing/empty ``name``, or any unparseable shape.

    Accepts the three YAML scalar forms operators actually write:
    bare (``name: foo``), double-quoted (``name: "foo"``), and
    single-quoted (``name: 'foo'``). Trailing inline comments
    (``name: foo  # primary``) are stripped from any form. The caller
    drops ``None`` from the roster — a malformed agent file is
    observable in stderr telemetry but not a fatal pipeline halt.
    """
    if not text.startswith("---"):
        return None
    # Find the closing boundary after the opening one (skip the first
    # ``---`` at index 0).
    boundaries = [m.start() for m in _FRONTMATTER_BOUNDARY.finditer(text)]
    if len(boundaries) < 2:
        return None
    frontmatter = text[boundaries[0] + 3 : boundaries[1]]
    match = _FRONTMATTER_NAME.search(frontmatter)
    if not match:
        return None
    value = (match.group("dq") or match.group("sq") or match.group("bare") or "").strip()
    if not value:
        return None
    # Validate the unquoted value against the canonical agent-name
    # grammar — the regex above accepts arbitrary quoted strings so
    # the YAML parser is permissive, but the roster has stricter
    # requirements (it feeds the closed-vocabulary contract AND must
    # satisfy the downstream ``make_finding_id`` schema). A rejection
    # here surfaces as a per-file warning in the caller and the agent
    # is dropped from the roster.
    if not _AGENT_NAME_RE.match(value):
        return None
    return value


def _scan_agent_definitions(agents_dir: Path) -> tuple[list[str], list[str]]:
    """Walk ``agents_dir`` and return ``(reviewers, warnings)``.

    Reviewers is a dedup'd list of names, sorted by NAME (not filename)
    so the output is stable independent of the file-naming scheme and
    matches the cache-key sort applied by ``_available_reviewers_hash``.
    The walk itself is filename-sorted for deterministic duplicate
    handling — when two files declare the same name, the
    lexicographically-first filename wins. Warnings is a list of
    per-file diagnostics — unreadable files, missing frontmatter,
    duplicate names — surfaced to stderr by the caller for operator
    visibility without aborting the load.
    """
    reviewers: list[str] = []
    seen: set[str] = set()
    warnings: list[str] = []
    if not agents_dir.is_dir():
        return [], [f"agents dir not found: {agents_dir}"]
    # Cap scanned files BEFORE reading any bytes. A hostile PR could add
    # hundreds of small valid agent files; per-file read bounds prevent
    # OOM on any single file but say nothing about aggregate scan time,
    # roster-JSON size, or critic-input prompt size. Sort first so the
    # cap is deterministic in filename order (lexicographically-first
    # wins on collision).
    all_paths = sorted(agents_dir.glob("*.md"))
    if len(all_paths) > _AGENTS_DIR_MAX_FILES:
        warnings.append(
            f"agents dir exceeds {_AGENTS_DIR_MAX_FILES}-file cap "
            f"({len(all_paths)} matches); scanning first "
            f"{_AGENTS_DIR_MAX_FILES} files only",
        )
        all_paths = all_paths[:_AGENTS_DIR_MAX_FILES]
    for path in all_paths:
        # Roster-entry cap — independent from the file-count cap because
        # even within the scanned files, duplicates and warnings reduce
        # the roster size. Stop adding entries once the cap is reached;
        # remaining files still get scanned for warning purposes so
        # operators see why their roster is short.
        if len(reviewers) >= _ROSTER_MAX_ENTRIES:
            warnings.append(
                f"roster size cap reached at {_ROSTER_MAX_ENTRIES} "
                f"entries; skipping remaining {path.name} and beyond",
            )
            break
        # Skip symlinks and non-regular files. The review pipeline runs
        # against an untrusted repo checkout — a PR can add
        # `.claude/agents/x.md` as a symlink to /dev/zero, a FIFO, or a
        # multi-GB file and hang/OOM the runner before the no-roster
        # fallback can degrade safely. Detect via lstat to avoid
        # following the symlink itself.
        try:
            lst = path.lstat()
        except OSError as exc:
            warnings.append(f"{path.name}: lstat error {exc}")
            continue
        if stat.S_ISLNK(lst.st_mode) or not stat.S_ISREG(lst.st_mode):
            warnings.append(f"{path.name}: skipping symlink/non-regular file")
            continue
        # Bound the read at _AGENT_FILE_READ_LIMIT_BYTES so a hostile
        # `name`-less multi-GB file can't exhaust memory. Frontmatter
        # is always near the top of the file; truncation cannot
        # silently produce a wrong `name` because the parser requires
        # the closing ``---`` boundary to be present.
        try:
            with open(path, "rb") as fh:
                raw = fh.read(_AGENT_FILE_READ_LIMIT_BYTES + 1)
        except OSError as exc:
            warnings.append(f"{path.name}: read error {exc}")
            continue
        if len(raw) > _AGENT_FILE_READ_LIMIT_BYTES:
            warnings.append(
                f"{path.name}: oversized (> {_AGENT_FILE_READ_LIMIT_BYTES} bytes); "
                "reading frontmatter prefix only",
            )
            raw = raw[:_AGENT_FILE_READ_LIMIT_BYTES]
        # Decode with replacement so a non-UTF8 byte in the prose
        # body (or invalid bytes in a hostile file) doesn't raise
        # UnicodeDecodeError out of the loop. UnicodeDecodeError is a
        # subclass of ValueError, NOT OSError, so the previous
        # `read_text()` call would have aborted the entire scan on
        # one bad file even though the docstring above promised
        # per-file degradation.
        try:
            text = raw.decode("utf-8", errors="replace")
        except ValueError as exc:
            # Defensive — errors="replace" should never raise, but the
            # surrounding contract is "no single file aborts the scan".
            warnings.append(f"{path.name}: decode error {exc}")
            continue
        name = _parse_agent_name(text)
        if name is None:
            warnings.append(f"{path.name}: no parseable `name` in frontmatter")
            continue
        if name in seen:
            warnings.append(f"{path.name}: duplicate name {name!r}; skipped")
            continue
        seen.add(name)
        reviewers.append(name)
    # Final sort is by NAME — independent of filename scheme. Walking
    # in filename order above kept the duplicate-name "first wins"
    # behaviour deterministic; sorting the output here makes the
    # documented "sorted by name" contract true for any naming scheme.
    reviewers.sort()
    return reviewers, warnings


def cmd_load_available_reviewers(args: argparse.Namespace) -> int:
    """PLN-725 Stage 5: load the AVAILABLE roster the critic enforces against.

    Scans ``--agents-dir`` (default ``.claude/agents``) for markdown
    agent definitions, parses each file's YAML frontmatter for the
    ``name`` field, and writes a flat JSON list to
    ``<cr_dir>/available_reviewers.json``. Skipped files are reported
    on stderr as warnings — empty or unreadable directories produce
    an empty list rather than a non-zero exit, so the downstream
    coverage-critic falls through to its existing no-roster skipped
    semantics rather than aborting the pipeline.

    Always exits 0 on a structurally valid CR_DIR; returns 1 only if
    ``<cr_dir>`` itself cannot be created.
    """
    cr_dir = Path(args.cr_dir)
    agents_dir = (
        Path(args.agents_dir)
        if getattr(args, "agents_dir", None)
        else DEFAULT_AGENTS_DIR
    )

    try:
        cr_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Error: cannot create cr_dir {cr_dir}: {exc}", file=sys.stderr)
        return 1

    reviewers, warnings = _scan_agent_definitions(agents_dir)
    for warning in warnings:
        print(f"Warning: {warning}", file=sys.stderr)

    output_path = cr_dir / "available_reviewers.json"
    try:
        with open(output_path, "w") as f:
            json.dump(reviewers, f, indent=2)
    except OSError as exc:
        print(
            f"Error writing available_reviewers.json: {exc}", file=sys.stderr,
        )
        return 1

    summary = {
        "status": "ok",
        "reviewer_count": len(reviewers),
        "agents_dir": str(agents_dir),
        "output_path": str(output_path),
        "warnings": warnings,
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# PLN-725 — Coverage critic
# ---------------------------------------------------------------------------
# Adversarial LLM stage that fronts the final coverage plan. Reads the
# rule-resolved plan from ``coverage.json.initial`` plus the
# extract_signals.json output and an AVAILABLE-list of reviewer names,
# and may propose additive best-effort additions. The critic CANNOT
# remove, rename, re-scope, promote-to-required, exceed the cap, or
# invent reviewer names; the validator enforces every constraint.
#
# Two-step pattern mirroring extract-signals:
#   1. coverage-critic-prepare — reads inputs, computes cache key,
#      serves cache hit OR writes agent input bundle + manifest into
#      ``coverage.json.critic``.
#   2. coverage-critic-consolidate — validates LLM output, merges into
#      ``coverage.json.final``, writes the cache on success.
#      Fail-closed emits a MEDIUM Coverage finding so the operator
#      footer surfaces the skipped stage.

COVERAGE_CRITIC_MAX_ADDITIONS = 5
COVERAGE_CRITIC_MARKER = "coverage-critic-failed"
COVERAGE_CRITIC_PROMPT_FILENAME = "coverage_critic_prompt.txt"
COVERAGE_CRITIC_MODEL_DEFAULT = "sonnet"


def _default_coverage_critic_prompt_path() -> Path:
    return Path(__file__).resolve().parent.parent / "prompts" / COVERAGE_CRITIC_PROMPT_FILENAME


def _coverage_critic_prompt_hash(path: Path) -> str:
    """Content-addressed hash of the coverage-critic prompt asset.

    Mirrors ``_signal_extraction_prompt_hash``: lives inside the
    coverage_critic/ namespace, not the canonical compute-hashes
    output. A premise/verifier/BHA prompt edit should not invalidate
    coverage-critic caches.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _stable_json_hash(payload: Any) -> str:
    """SHA-256 over a deterministic JSON serialization.

    Used to derive ``coverage_plan_initial_hash`` and ``signals_hash``
    from in-memory dicts. ``sort_keys=True`` plus
    ``separators=(",",":")`` makes the encoding stable across runs.
    """
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8", "replace")).hexdigest()


def coverage_critic_cache_key(
    coverage_plan_initial_hash: str,
    signals_hash: str,
    diff_tip: str,
    prompt_hash: str,
    available_reviewers_hash: str,
) -> str:
    """Cache key for the ``coverage_critic`` namespace (PLN-725).

    Tuple ``(coverage_plan_initial_hash, signals_hash, diff_tip,
    prompt_hash, available_reviewers_hash)`` is the complete set of
    inputs the critic is a pure function of. All five are
    content-addressed.

    ``available_reviewers_hash`` is the deterministic hash of the
    AVAILABLE roster the agent will actually see (sorted, dedup'd, and
    pre-filtered against the initial plan). It must be in the key because
    the validator enforces every proposed addition against this list:
    if the roster shrinks between runs, a cache hit on the old key would
    serve a plan that proposes a reviewer no longer in the roster and
    consolidate never re-runs to catch it.
    """
    payload = (
        (coverage_plan_initial_hash or "") + "\0"
        + (signals_hash or "") + "\0"
        + (diff_tip or "") + "\0"
        + (prompt_hash or "") + "\0"
        + (available_reviewers_hash or "")
    )
    return hashlib.sha256(payload.encode("utf-8", "replace")).hexdigest()


def _available_reviewers_hash(reviewers: list[str]) -> str:
    """Deterministic hash of an AVAILABLE roster.

    Sorts and dedups before hashing so list ordering cannot flip the
    cache key — order is operator-controllable noise that does not
    change what the agent sees as the closed-vocabulary contract.
    """
    sorted_dedup = sorted({r for r in reviewers if isinstance(r, str) and r})
    return _stable_json_hash({"available": sorted_dedup})


def _coverage_critic_cache_path(cache_dir: Path, key: str) -> Path:
    """PLN-719 namespace layout: ``<cache_dir>/coverage_critic/<key>.json``."""
    return cache_dir / CACHE_NAMESPACE_COVERAGE_CRITIC / f"{key}.json"


def _read_cached_coverage_critic(
    cache_dir: Path | None, key: str,
) -> dict[str, Any] | None:
    """Return cached critic output if fresh, else None."""
    if cache_dir is None:
        return None
    return _read_simple_cache_entry(
        cache_dir, _coverage_critic_cache_path(cache_dir, key),
        CACHE_NAMESPACE_COVERAGE_CRITIC, 7,
    )


def _write_cached_coverage_critic(
    cache_dir: Path | None, key: str, payload: dict[str, Any],
) -> None:
    """Persist a successful critic run to the ``coverage_critic`` cache.

    Fail-open: delegates to ``_write_simple_cache_entry``; an OSError on the
    cache write is logged to stderr but never raised — ``coverage.json.final``
    is already on disk, so cache-write failure is a re-run cost issue,
    not a pipeline halt.
    """
    if cache_dir is None:
        return
    _write_simple_cache_entry(
        cache_dir, _coverage_critic_cache_path(cache_dir, key),
        payload, "coverage-critic",
    )


def _coverage_plan_existing_reviewers(plan: dict[str, Any]) -> set[str]:
    """Return the union of reviewers already present in the initial plan."""
    out: set[str] = set()
    for key in ("required", "best_effort"):
        entries = plan.get(key) or []
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict):
                name = entry.get("reviewer")
                if isinstance(name, str) and name:
                    out.add(name)
    return out


def _load_available_reviewers(
    path: Path,
) -> tuple[list[str] | None, str | None]:
    """Parse ``available_reviewers.json`` into a list of reviewer names.

    Accepts either a flat JSON list or ``{"available": [...]}``. Returns
    ``(roster, None)`` on success and ``(None, diagnostic)`` on failure
    so callers can fail consistently AND surface a path-specific
    diagnostic.

    "Success" includes a TRULY-empty roster (``[]`` or ``{"available":
    []}``) — the project legitimately has no configured agents, and
    the verifier's no-roster skip semantics kick in downstream. But a
    present-but-wrong-shape file is NOT a successful empty parse:

      - ``{"reviewers": [...]}`` (wrong key)  → ``(None, "...")``
      - ``{"available": "not-a-list"}``       → ``(None, "...")``
      - ``[1, 2, 3]`` (list of non-strings)   → ``(None, "...")``

    Those are realistic operator hand-edits; without explicit detection
    they would masquerade as "no roster" — ``cmd_verify_coverage`` would
    skip closed-vocabulary and emit PASS on a plan that should have
    been gated. The verifier's roster-BLOCK path keys on ``loaded is
    None``, so detection here gives it the signal it needs.

    IO/parse errors stay bound to the exception so an operator with a
    missing or malformed file sees the real cause (e.g. ``[Errno 2]
    No such file or directory``) instead of a misleading shape-error
    message.
    """
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"Error reading available_reviewers: {exc}"
    if isinstance(raw, list):
        # Truly empty is fine (no configured agents). A non-empty list
        # whose entries are all non-strings (or all empty strings) is
        # malformed — the operator wrote something with intent and we
        # extracted nothing usable.
        if not raw:
            return [], None
        filtered = [a for a in raw if isinstance(a, str) and a]
        if not filtered:
            return None, (
                "Error: available_reviewers list contains no usable "
                "string entries (got non-string or empty values)"
            )
        return filtered, None
    if isinstance(raw, dict):
        # Distinguish "key absent" from "key present with empty list".
        # Absent key → operator wrote a different shape (e.g. the
        # common hand-edit `{"reviewers": [...]}` instead of
        # `{"available": [...]}`); never silently treat as empty.
        if "available" not in raw:
            return None, (
                "Error: available_reviewers dict missing required "
                "'available' key (got keys: "
                f"{sorted(raw.keys())[:10]})"
            )
        inner = raw["available"]
        if not isinstance(inner, list):
            return None, (
                "Error: available_reviewers['available'] must be a "
                f"list (got {type(inner).__name__})"
            )
        if not inner:
            return [], None
        filtered = [a for a in inner if isinstance(a, str) and a]
        if not filtered:
            return None, (
                "Error: available_reviewers['available'] contains no "
                "usable string entries"
            )
        return filtered, None
    return None, "Error: available_reviewers must be a list or {available: [...]}"


def _build_coverage_critic_input(
    coverage_plan_initial: dict[str, Any],
    extract_signals: dict[str, Any] | None,
    diff_data: dict[str, Any],
    available_reviewers: list[str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Render the bounded agent-input bundle + a compact diff summary.

    Returns ``(main_input, diff_summary)``. The main_input groups
    everything the critic needs except the diff excerpts (which can be
    large); the diff_summary is the same shape as the signal-extraction
    excerpt bundle, capped to a small budget.
    """
    # Bounded diff summary identical to extract-signals (file metadata
    # + top-N excerpts). Reuse the helper so the two stages see the
    # same shape — the critic doesn't need a private excerpting story.
    diff_summary = _build_signal_input(diff_data, intent_summary=None)

    return (
        {
            "coverage_plan_initial": coverage_plan_initial,
            "extract_signals": extract_signals or {"signals": []},
            "available_reviewers": list(available_reviewers),
        },
        diff_summary,
    )


def validate_coverage_critic_output(
    raw: Any,
    available_reviewers: list[str],
    existing_in_plan: set[str],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Validate LLM critic output against the constraint contract.

    Returns ``(accepted_additions, errors)``. Per-addition rejection
    keeps surviving additions; an empty ``accepted`` with non-empty
    ``errors`` means the entire critic output is unusable and the
    caller should fail closed.

    Enforces:
      - top-level shape: object with an ``additions`` array
      - per-addition: ``reviewer`` in ``available_reviewers``
      - per-addition: ``evidence`` non-empty after strip
      - per-addition: no duplicate ``reviewer`` within ``additions``
      - per-addition: ``reviewer`` not already in ``existing_in_plan``
      - hard cap of ``COVERAGE_CRITIC_MAX_ADDITIONS`` (excess
        truncated with a warning; truncation is not a rejection)
    """
    errors: list[str] = []
    if not isinstance(raw, dict):
        return [], ["output is not a JSON object"]
    additions = raw.get("additions")
    if not isinstance(additions, list):
        return [], ["'additions' is missing or not a list"]
    available_set = set(available_reviewers)
    accepted: list[dict[str, Any]] = []
    seen_in_additions: set[str] = set()
    for idx, entry in enumerate(additions):
        if not isinstance(entry, dict):
            errors.append(f"additions[{idx}] is not an object")
            continue
        reviewer = entry.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer:
            errors.append(f"additions[{idx}] missing or invalid 'reviewer'")
            continue
        if reviewer not in available_set:
            errors.append(
                f"additions[{idx}] reviewer {reviewer!r} not in available_reviewers",
            )
            continue
        if reviewer in existing_in_plan:
            errors.append(
                f"additions[{idx}] reviewer {reviewer!r} is already in the plan",
            )
            continue
        if reviewer in seen_in_additions:
            errors.append(
                f"additions[{idx}] duplicates reviewer {reviewer!r}",
            )
            continue
        evidence = entry.get("evidence")
        if not isinstance(evidence, str) or not evidence.strip():
            errors.append(
                f"additions[{idx}] ({reviewer}) has empty evidence",
            )
            continue
        seen_in_additions.add(reviewer)
        accepted_entry: dict[str, Any] = {
            "reviewer": reviewer,
            "trigger": {"type": "critic_addition"},
            "source": "critic",
            "evidence": evidence.strip(),
        }
        model_override = entry.get("model_override")
        if isinstance(model_override, str) and model_override:
            accepted_entry["model_override"] = model_override
        accepted.append(accepted_entry)

    if len(accepted) > COVERAGE_CRITIC_MAX_ADDITIONS:
        errors.append(
            f"truncated {len(accepted) - COVERAGE_CRITIC_MAX_ADDITIONS} "
            f"additions over the {COVERAGE_CRITIC_MAX_ADDITIONS}-cap",
        )
        accepted = accepted[:COVERAGE_CRITIC_MAX_ADDITIONS]

    return accepted, errors


def merge_critic_additions(
    coverage_plan_initial: dict[str, Any],
    accepted_additions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Produce the final coverage plan by appending critic additions to
    the initial plan's ``best_effort[]``. Pure function — the caller
    persists the result into ``coverage.json.final``.

    Critic additions are always best-effort (the validator already
    enforces this — there is no "required" code path here). Dedup
    against the initial plan is also already enforced by the validator.
    """
    final: dict[str, Any] = {
        "required": list(coverage_plan_initial.get("required", []) or []),
        "best_effort": list(coverage_plan_initial.get("best_effort", []) or []),
        "warnings": list(coverage_plan_initial.get("warnings", []) or []),
        "stats": dict(coverage_plan_initial.get("stats", {}) or {}),
    }
    final["best_effort"].extend(accepted_additions)
    final["stats"]["critic_additions"] = len(accepted_additions)
    return final


def _emit_skipped_coverage_plan(
    plan_initial: dict[str, Any],
    cr_dir: Path,
    model: str,
    reason: str,
) -> int:
    """Short-circuit ``coverage-critic-prepare`` with a "skipped" outcome.

    Writes the initial plan into ``coverage.json``'s ``.final`` section
    (with ``critic_status="skipped"`` so consumers can distinguish
    skipped from healthy-but-empty and fail_closed via the same field),
    plus a manifest into the ``.critic`` section with ``status:
    "skipped"`` and the caller-supplied ``reason``. Dumps the manifest
    to stdout so the walker's redirected-stdout sees the same shape
    regardless of which skip branch ran. Returns 0 on success; 1 if
    the section writes fail.

    Shared between the ``--no-critic`` operator-flag path (reason
    ``"no-critic"``) and the missing-roster configuration path (reason
    ``"no-roster"``). Single edit site for any future shape changes.
    """
    final = merge_critic_additions(plan_initial, [])
    final["generated_at"] = datetime.now(timezone.utc).isoformat()
    final["critic_status"] = "skipped"
    final["critic_errors"] = []
    manifest = {
        "status": "skipped",
        "reason": reason,
        "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
        "model": model,
    }
    # Atomic multi-section write: ``.final`` + ``.critic`` land as a
    # unit. Sequencing two single-section writes would leave the
    # aggregate inconsistent (``.final`` updated, ``.critic`` stale) if
    # the second write failed mid-OSError.
    try:
        _write_coverage_sections(cr_dir, {"final": final, "critic": manifest})
    except OSError as exc:
        print(f"Error writing coverage.json: {exc}", file=sys.stderr)
        return 1
    return _emit_summary(manifest)


def cmd_coverage_critic_prepare(args: argparse.Namespace) -> int:
    """Prep the coverage-critic agent input + check cache (PLN-725).

    Reads the rule-resolved plan from ``coverage.json``'s ``.initial``
    section, plus ``extract_signals.json``, ``diff_data.json``, and
    ``available_reviewers.json``. Computes the
    ``(coverage_plan_initial_hash, signals_hash, diff_tip, prompt_hash,
    available_reviewers_hash)`` cache key and either:

      - **Cache hit** — writes the merged plan into ``coverage.json``'s
        ``.final`` section directly and exits with a ``cache_hit``
        manifest written into ``.critic``.
      - **Cache miss** — writes a bounded agent-input bundle to
        ``<cr_dir>/coverage_critic_input.json`` plus a diff summary copy
        and a manifest into ``coverage.json``'s ``.critic`` section
        describing the spawn contract.

    With ``--no-critic``, short-circuits: copies the initial plan into
    ``.final`` and emits a ``status: "skipped"`` manifest. Useful for
    cost-sensitive runs (PLN-725 Open Question 3).

    Always exits 0; structural failures print to stderr and return 1.
    """
    cr_dir = Path(args.cr_dir)
    signals_path = (
        Path(args.extract_signals) if getattr(args, "extract_signals", None) else None
    )
    diff_data_path = Path(args.diff_data)
    available_path = Path(args.available_reviewers)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    diff_tip = str(args.diff_tip)
    no_critic = bool(getattr(args, "no_critic", False))
    prompt_path = (
        Path(args.prompt) if getattr(args, "prompt", None) else _default_coverage_critic_prompt_path()
    )
    model = str(getattr(args, "model", None) or COVERAGE_CRITIC_MODEL_DEFAULT)

    try:
        cr_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"Error: cannot create cr_dir: {exc}", file=sys.stderr)
        return 1

    # Initial plan lives in coverage.json.initial.
    plan_initial = _read_coverage_state(cr_dir).get("initial")
    if plan_initial is None:
        print(
            "Error: coverage.json.initial missing — has stage_14 run?",
            file=sys.stderr,
        )
        return 1
    if not isinstance(plan_initial, dict):
        print("Error: coverage.json.initial is not a JSON object", file=sys.stderr)
        return 1

    # Short-circuit per Open Question 3 — write the initial plan
    # straight through as the final, no agent spawn needed. See
    # _emit_skipped_coverage_plan for the shared shape.
    if no_critic:
        return _emit_skipped_coverage_plan(
            plan_initial, cr_dir, model, reason="no-critic",
        )

    # Safety net for the case where stage_14a_load_available_reviewers
    # failed to write available_reviewers.json at all (write error on
    # the roster file). Under normal operation stage_14a always produces
    # the file; the empty-roster and fully-subscribed-roster
    # short-circuits below handle the "file present but the AVAILABLE
    # set is empty" cases. This branch only fires when stage_14a's
    # write was skipped or lost — a present-but-malformed file still
    # returns 1 below as an operator config error.
    if not available_path.exists():
        return _emit_skipped_coverage_plan(
            plan_initial, cr_dir, model, reason="no-roster",
        )

    extract_signals: dict[str, Any] | None = None
    if signals_path is not None and signals_path.exists():
        try:
            with open(signals_path) as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                extract_signals = loaded
        except (OSError, json.JSONDecodeError):
            extract_signals = None

    try:
        with open(diff_data_path) as f:
            diff_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading diff_data: {exc}", file=sys.stderr)
        return 1
    if not isinstance(diff_data, dict):
        print("Error: diff_data is not a JSON object", file=sys.stderr)
        return 1

    available_reviewers, load_err = _load_available_reviewers(available_path)
    if available_reviewers is None:
        print(load_err or "Error reading available_reviewers", file=sys.stderr)
        return 1

    # PLN-725 Phase 5 fix: stage_14a_load_available_reviewers now
    # ALWAYS writes available_reviewers.json (even an empty list when
    # .claude/agents/ is missing or empty), so the earlier
    # `not available_path.exists()` no-roster fallback never fires for
    # empty-roster projects. Short-circuit on the empty roster here so
    # the documented "no-roster skipped" semantics still apply and we
    # don't waste a Sonnet dispatch on a roster the validator could
    # never accept additions from.
    if not available_reviewers:
        return _emit_skipped_coverage_plan(
            plan_initial, cr_dir, model, reason="no-roster",
        )

    # Subtract anything already in the initial plan so the critic
    # sees the actual unused pool. The validator also checks this, but
    # surfacing it in the input bundle prevents the LLM from even
    # proposing names that would be rejected.
    existing_in_plan = _coverage_plan_existing_reviewers(plan_initial)
    available_reviewers = [
        r for r in available_reviewers if r not in existing_in_plan
    ]

    # Same skip semantics if every roster member is already in the
    # initial plan — the critic has nothing it could propose without
    # the validator rejecting it as duplicate. Different reason for
    # operator telemetry (this is "fully subscribed", not "no agents
    # configured").
    if not available_reviewers:
        return _emit_skipped_coverage_plan(
            plan_initial, cr_dir, model,
            reason="no-candidates",
        )

    try:
        prompt_hash = _coverage_critic_prompt_hash(prompt_path)
    except OSError as exc:
        print(f"Error reading prompt asset: {exc}", file=sys.stderr)
        return 1

    plan_initial_hash = _stable_json_hash(plan_initial)
    signals_hash = _stable_json_hash(extract_signals or {"signals": []})
    # Hash the post-filter AVAILABLE roster — that's the closed
    # vocabulary the agent actually sees and the validator enforces
    # against. If it changes between runs the prior cache entry is
    # stale (could propose a now-removed reviewer), so it must key
    # the cache.
    available_reviewers_hash = _available_reviewers_hash(available_reviewers)
    key = coverage_critic_cache_key(
        plan_initial_hash, signals_hash, diff_tip, prompt_hash,
        available_reviewers_hash,
    )

    cached = _read_cached_coverage_critic(cache_dir, key)
    if cached is not None:
        canonical = {k: v for k, v in cached.items() if k != "written_at"}
        manifest = {
            "status": "cache_hit",
            "cache_key": key,
            "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
            "model": model,
        }
        # Same atomic multi-section invariant as the skipped path —
        # ``.final`` + ``.critic`` land as a unit.
        try:
            _write_coverage_sections(
                cr_dir, {"final": canonical, "critic": manifest},
            )
        except OSError as exc:
            print(f"Error writing coverage.json (cache hit): {exc}", file=sys.stderr)
            return 1
        return _emit_summary(manifest)

    main_input, diff_summary = _build_coverage_critic_input(
        plan_initial, extract_signals, diff_data, available_reviewers,
    )
    input_path = cr_dir / "coverage_critic_input.json"
    diff_summary_path = cr_dir / "coverage_critic_diff_summary.json"
    with open(input_path, "w") as f:
        json.dump(main_input, f, indent=2)
    with open(diff_summary_path, "w") as f:
        json.dump(diff_summary, f, indent=2)

    manifest = {
        "status": "needs_agent",
        "cache_key": key,
        "coverage_plan_initial_hash": plan_initial_hash,
        "signals_hash": signals_hash,
        "prompt_hash": prompt_hash,
        "available_reviewers_hash": available_reviewers_hash,
        "input_path": str(input_path),
        "diff_summary_path": str(diff_summary_path),
        "prompt_path": str(prompt_path),
        "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
        "model": model,
    }
    try:
        _write_coverage_section(cr_dir, "critic", manifest)
    except OSError as exc:
        print(f"Error writing coverage.json.critic: {exc}", file=sys.stderr)
        return 1
    return _emit_summary(manifest)


def cmd_coverage_critic_consolidate(args: argparse.Namespace) -> int:
    """PLN-725 Stage 3b: validate the agent's critic output, merge into
    ``coverage.json``'s ``.final`` section, and update the cache.

    Reads ``<agent_output>`` (typically
    ``<cr_dir>/pln725_coverage_critic.json``), validates against the
    constraint contract, and:

      - **At least one valid addition** — merges into the initial plan,
        writes ``coverage.json``'s ``.final`` section, updates the
        cache, exits.
      - **All rejected (or read failure)** — fails closed. Writes
        the initial plan (no critic additions) into ``.final``. Emits
        a MEDIUM ``Coverage`` finding with
        ``system_marker="coverage-critic-failed"`` so the operator
        footer surfaces the skipped stage. Does **not** cache.

    Reads the initial plan from ``coverage.json.initial`` and the
    manifest from ``coverage.json.critic``.

    Always exits 0 (degradation is not a halt); returns 1 only on
    missing cr_dir or unreadable initial plan.
    """
    cr_dir = Path(args.cr_dir)
    agent_output_path = Path(args.agent_output)
    available_path = Path(args.available_reviewers)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None

    if not cr_dir.exists():
        print(f"Error: cr_dir does not exist: {cr_dir}", file=sys.stderr)
        return 1

    plan_initial = _read_coverage_state(cr_dir).get("initial")
    if plan_initial is None:
        print(
            "Error: coverage.json.initial missing — has stage_14 run?",
            file=sys.stderr,
        )
        return 1
    if not isinstance(plan_initial, dict):
        print("Error: coverage.json.initial is not a JSON object", file=sys.stderr)
        return 1

    critic_section = _read_coverage_state(cr_dir).get("critic")
    manifest = critic_section if isinstance(critic_section, dict) else {}
    cache_key = str(manifest.get("cache_key") or "")
    model = str(manifest.get("model") or COVERAGE_CRITIC_MODEL_DEFAULT)
    manifest_status = str(manifest.get("status") or "")

    # PLN-725 Phase 4: orchestrator wiring runs consolidate unconditionally as
    # the stage after the agent-dispatch step. On ``cache_hit`` or ``skipped``,
    # prepare already wrote coverage.json.final (cache hit serves the cached
    # plan; ``--no-critic`` stamps the initial plan + critic_status="skipped").
    # Either way no agent was spawned and the work is done — no-op so the
    # walker stays mechanically-driven without conditional dispatch.
    final_already_written = isinstance(
        _read_coverage_state(cr_dir).get("final"), dict,
    )
    if manifest_status in ("cache_hit", "skipped") and final_already_written:
        return _emit_summary({
            "status": manifest_status,
            "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
            "cache_key": cache_key,
        })

    available_reviewers, load_err = _load_available_reviewers(available_path)
    if available_reviewers is None:
        print(load_err or "Error reading available_reviewers", file=sys.stderr)
        return 1

    existing_in_plan = _coverage_plan_existing_reviewers(plan_initial)

    raw_output, read_error = _read_agent_output_or_error(agent_output_path)
    now_iso = datetime.now(timezone.utc).isoformat()

    def _fail_closed(errors: list[str]) -> int:
        final = merge_critic_additions(plan_initial, [])
        final["generated_at"] = now_iso
        final["critic_status"] = "fail_closed"
        final["critic_errors"] = errors
        try:
            _write_coverage_section(cr_dir, "final", final)
        except OSError as exc:
            print(f"Error writing coverage.json.final: {exc}", file=sys.stderr)
            return 1
        _emit_coverage_critic_failed_finding(cr_dir, errors, now_iso)
        return _emit_summary({
            "status": "fail_closed",
            "errors": errors[:10],
            "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
        })

    if read_error is not None:
        return _fail_closed([read_error])

    accepted, errors = validate_coverage_critic_output(
        raw_output, available_reviewers, existing_in_plan,
    )

    if not accepted and errors:
        return _fail_closed(errors)

    final = merge_critic_additions(plan_initial, accepted)
    final["generated_at"] = now_iso
    final["critic_status"] = "ok"
    final["critic_errors"] = errors
    final["model"] = model
    try:
        _write_coverage_section(cr_dir, "final", final)
    except OSError as exc:
        print(f"Error writing coverage.json.final: {exc}", file=sys.stderr)
        return 1
    if cache_key:
        _write_cached_coverage_critic(cache_dir, cache_key, final)
    return _emit_summary({
        "status": "ok",
        "addition_count": len(accepted),
        "rejected": len(errors),
        "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
    })


def _emit_coverage_critic_failed_finding(
    cr_dir: Path, errors: list[str], now_iso: str,
) -> None:
    """Write a MEDIUM system-marker finding for surfacing in the run summary.

    Per PLN-725 §"Coverage Critic": a failed critic is a routing
    degradation (the initial plan still runs), not a pipeline halt.
    The finding surfaces the skipped stage to the operator so the
    cause can be diagnosed. Fail-open on write error — telemetry is
    observational.
    """
    error_summary = errors[:10]
    if len(errors) > 10:
        error_summary.append(f"… {len(errors) - 10} more")
    finding = {
        "reviewer": "coverage-critic",
        "source": "coverage-critic",
        "finding_scope": "system",
        "system_marker": COVERAGE_CRITIC_MARKER,
        "category": "Coverage",
        "severity": "MEDIUM",
        "file": None,
        "line": None,
        "issue": "Coverage critic produced no usable additions; the initial rule plan is being used as-is.",
        "explanation": (
            "The coverage-critic stage validates LLM additions against the "
            "AVAILABLE list, evidence requirement, and dedup-vs-existing "
            "constraints. When every addition is rejected (or the agent "
            "output is unreadable), the initial rule plan runs unmodified."
        ),
        "recommendation": (
            "Re-run the review once the underlying issue is resolved. "
            "Common causes: agent output malformed, AVAILABLE-list "
            "mismatch, taxonomy/prompt drift."
        ),
        "confidence": 1.0,
        "rationale_summary": "; ".join(error_summary)[:1000],
        "emitted_at": now_iso,
    }
    try:
        with open(cr_dir / "agent_coverage-critic-failed.json", "w") as f:
            json.dump({"findings": [finding]}, f, indent=2)
    except OSError as exc:
        print(
            f"Warning: could not write coverage-critic-failed finding: {exc}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# PLN-725 — Coverage Verifier (deterministic post-LLM gate)
# ---------------------------------------------------------------------------
#
# Stage_15c_verify_coverage runs immediately after stage_15b_coverage_critic_
# consolidate writes ``coverage.json.final``. Its job is the deterministic
# check the LLM critic stage cannot self-enforce: that the final plan honors
# the closed-vocabulary, additive-only, best-effort-only-critic, evidence-
# required, and 5-cap constraints documented in PLN-725 §"Coverage Critic
# Contract".
#
# Verdict shape (written into ``coverage.json``'s ``.verify`` section):
#   {"verdict": "PASS", "violations": [], "checked_at": ...}
#   {"verdict": "BLOCKING", "violations": [{"check": "...", "message": "..."}], ...}
#
# BLOCKING is encoded in the artifact and surfaces as a HIGH system-marker
# finding, but exit code stays 0 and ``on_failure: continue`` so the walker
# doesn't halt — downstream stages (arbitrate-budget, spawn_reviewers) read
# the verdict from ``coverage.json.verify`` and gate themselves on it.

COVERAGE_VERIFY_MARKER = "coverage-verify-blocking"


def _critic_addition_count(plan: dict[str, Any]) -> int:
    """Count entries in best_effort[] tagged ``source: "critic"``."""
    count = 0
    for entry in plan.get("best_effort", []) or []:
        if isinstance(entry, dict) and entry.get("source") == "critic":
            count += 1
    return count


def _plan_reviewer_buckets(
    plan: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return ``(required_entries, best_effort_entries)`` from a plan dict.

    Defensive: filters out non-dict entries silently so the verifier
    doesn't crash on malformed inputs — shape violations are reported
    separately via the ``shape`` check.
    """
    required = [e for e in (plan.get("required", []) or []) if isinstance(e, dict)]
    best_effort = [e for e in (plan.get("best_effort", []) or []) if isinstance(e, dict)]
    return required, best_effort


def _reviewer_names(entries: list[dict[str, Any]]) -> list[str]:
    names: list[str] = []
    for entry in entries:
        reviewer = entry.get("reviewer")
        if isinstance(reviewer, str) and reviewer:
            names.append(reviewer)
    return names


def verify_coverage_plan(
    plan: dict[str, Any],
    plan_initial: dict[str, Any],
    available_reviewers: list[str] | None,
) -> list[dict[str, str]]:
    """Run all deterministic checks against the final coverage plan.

    Returns a list of violation dicts ``{"check": str, "message": str}``.
    Empty list means PASS. Pure function — no I/O.

    Args:
        plan: the final coverage plan (from ``coverage.json.final``)
        plan_initial: the pre-critic coverage plan (from
            ``coverage.json.initial``)
        available_reviewers: roster of allowed reviewers, or None when
            the roster wasn't produced (no-roster skip path). When None
            or empty, the closed-vocabulary check is bypassed — there's
            no roster to enforce against.

    Checks (each appends at most one violation per failure mode):
      - shape: top-level is an object with required[] + best_effort[]
               (lists) AND every entry is a dict carrying a non-empty
               ``reviewer`` string. Shape failures short-circuit all
               other checks since they all assume valid entries.
      - additive: bucket-aware. ``initial.required ⊆ final.required``
               (promotion to required from best_effort is fine;
               demotion to best_effort is NOT — that silently downgrades
               mandatory coverage). ``initial.best_effort ⊆ final.required
               ∪ final.best_effort`` (best-effort may stay or be
               promoted, must not be deleted).
      - closed_vocabulary: every source="critic" entry in best_effort
               is in roster (when roster present and non-empty).
               Core/rule reviewer labels are plugin-internal and NOT
               roster-constrained.
      - critic_best_effort_only: source="critic" entries never in required[]
      - critic_evidence: every source="critic" entry has non-empty evidence
      - critic_cap: critic_addition count <= COVERAGE_CRITIC_MAX_ADDITIONS
      - no_duplicates: each reviewer appears at most once across both buckets
    """
    violations: list[dict[str, str]] = []

    # shape — required[]/best_effort[] must be lists of {reviewer: <str>}
    # dicts. The earlier version only checked that the buckets were
    # lists; ``{"required": [{}], "best_effort": []}`` and
    # ``{"required": [{"reviewer": ""}], ...}`` both PASSED. Since the
    # verifier is the last guard before downstream spawning, malformed
    # entries are caught here as a ``shape`` violation rather than
    # silently dropped by ``_plan_reviewer_buckets`` and ``_reviewer_names``.
    if not isinstance(plan.get("required"), list):
        violations.append({
            "check": "shape",
            "message": "coverage_plan.required is missing or not a list",
        })
    if not isinstance(plan.get("best_effort"), list):
        violations.append({
            "check": "shape",
            "message": "coverage_plan.best_effort is missing or not a list",
        })
    if violations:
        return violations  # downstream checks assume shape is valid
    for bucket_name in ("required", "best_effort"):
        for idx, entry in enumerate(plan.get(bucket_name, []) or []):
            if not isinstance(entry, dict):
                violations.append({
                    "check": "shape",
                    "message": (
                        f"coverage_plan.{bucket_name}[{idx}] is not an object"
                    ),
                })
                continue
            reviewer = entry.get("reviewer")
            if not isinstance(reviewer, str) or not reviewer.strip():
                violations.append({
                    "check": "shape",
                    "message": (
                        f"coverage_plan.{bucket_name}[{idx}] missing or empty "
                        f"'reviewer' field"
                    ),
                })
    if violations:
        # Shape violations short-circuit — additive / closed_vocabulary /
        # critic_* checks all assume valid entries with string reviewer
        # names. Running them on malformed input would generate misleading
        # downstream violations that obscure the actual fault.
        return violations

    required_final, best_effort_final = _plan_reviewer_buckets(plan)
    required_initial, best_effort_initial = _plan_reviewer_buckets(plan_initial)
    final_names = set(_reviewer_names(required_final)) | set(_reviewer_names(best_effort_final))

    # additive — bucket-aware. The earlier check unioned both buckets
    # on each side, so an initial-required reviewer could move into
    # final.best_effort[] and the contract considered it preserved. But
    # the spawn_reviewers stage interprets ``required`` as "mandatory
    # coverage" and ``best_effort`` as "if budget allows" — silently
    # demoting a required reviewer downgrades coverage without any
    # operator-visible signal. Enforce ``initial.required ⊆ final.required``
    # as a separate check from ``initial.best_effort ⊆ final.(required ∪
    # best_effort)``: promotion of an initial best-effort to required
    # IS valid (still additive); demotion of an initial required is NOT.
    required_initial_names = set(_reviewer_names(required_initial))
    required_final_names = set(_reviewer_names(required_final))
    demoted_or_dropped = sorted(required_initial_names - required_final_names)
    if demoted_or_dropped:
        violations.append({
            "check": "additive",
            "message": (
                f"initial required reviewers missing from final required[]: "
                f"{demoted_or_dropped} (required reviewers MUST stay "
                f"required; demotion to best_effort or deletion violates "
                f"the additive-only contract)"
            ),
        })
    best_effort_initial_names = set(_reviewer_names(best_effort_initial))
    dropped_best_effort = sorted(best_effort_initial_names - final_names)
    if dropped_best_effort:
        violations.append({
            "check": "additive",
            "message": (
                f"initial best-effort reviewers missing from final plan: "
                f"{dropped_best_effort} (coverage critic may only ADD; "
                f"deletions violate the contract)"
            ),
        })

    # closed_vocabulary — only enforced when a roster is present and
    # non-empty, AND only against source="critic" entries. The core/rule
    # reviewer labels in the final plan (e.g. ``bug_hunter_a``,
    # ``unified_auditor``) are plugin-internal identifiers that the
    # spawn_reviewers stage translates to actual reviewer prompts —
    # they do NOT need to appear in the project's `.claude/agents/`
    # roster. Only the critic's LLM-proposed additions are constrained
    # to AVAILABLE (matching the prepare-time validator at
    # ``validate_coverage_critic_output``). Without this scoping every
    # project would BLOCK on every review because its rule-resolved
    # plan references plugin-internal labels by design.
    if available_reviewers:
        roster = set(available_reviewers)
        critic_names = {
            e.get("reviewer", "")
            for e in best_effort_final
            if e.get("source") == "critic"
        }
        unknown = sorted(critic_names - roster - {""})
        if unknown:
            violations.append({
                "check": "closed_vocabulary",
                "message": (
                    f"critic-added reviewers not in AVAILABLE roster: {unknown}"
                ),
            })

    # critic_best_effort_only
    critic_in_required = sorted({
        e.get("reviewer", "<missing>")
        for e in required_final
        if e.get("source") == "critic"
    })
    if critic_in_required:
        violations.append({
            "check": "critic_best_effort_only",
            "message": (
                f"source=critic entries in required[]: {critic_in_required} "
                f"(critic additions are best-effort only)"
            ),
        })

    # critic_evidence
    missing_evidence = sorted({
        e.get("reviewer", "<missing>")
        for e in best_effort_final
        if e.get("source") == "critic"
        and not (isinstance(e.get("evidence"), str) and e.get("evidence", "").strip())
    })
    if missing_evidence:
        violations.append({
            "check": "critic_evidence",
            "message": (
                f"source=critic entries with empty evidence: {missing_evidence}"
            ),
        })

    # critic_cap
    addition_count = _critic_addition_count(plan)
    if addition_count > COVERAGE_CRITIC_MAX_ADDITIONS:
        violations.append({
            "check": "critic_cap",
            "message": (
                f"critic additions ({addition_count}) exceed the "
                f"{COVERAGE_CRITIC_MAX_ADDITIONS}-cap"
            ),
        })

    # no_duplicates — across buckets
    seen: set[str] = set()
    dupes: list[str] = []
    for name in _reviewer_names(required_final) + _reviewer_names(best_effort_final):
        if name in seen and name not in dupes:
            dupes.append(name)
        seen.add(name)
    if dupes:
        violations.append({
            "check": "no_duplicates",
            "message": (
                f"reviewers appearing more than once across required[]/best_effort[]: "
                f"{sorted(dupes)}"
            ),
        })

    return violations


def _emit_coverage_verify_blocking_finding(
    cr_dir: Path, violations: list[dict[str, str]], now_iso: str,
) -> None:
    """Write a HIGH system-marker finding when the verifier returns BLOCKING.

    Surfaces violations to the operator so the failing check can be
    diagnosed. Fail-open on write error — telemetry is observational
    and a write failure shouldn't crash the stage.
    """
    summary = [f"{v['check']}: {v['message']}" for v in violations[:10]]
    if len(violations) > 10:
        summary.append(f"… {len(violations) - 10} more")
    finding = {
        # ``coverage-verifier`` is the canonical source registered in
        # ``code_review_schema.SOURCES``. Emitting ``coverage-verify``
        # here would cause schema validation at stage_22 to reject the
        # finding exactly when the verifier needs to surface a BLOCKING
        # result, silently dropping it from the run summary.
        "reviewer": "coverage-verifier",
        "source": "coverage-verifier",
        "finding_scope": "system",
        "system_marker": COVERAGE_VERIFY_MARKER,
        "category": "Coverage",
        "severity": "HIGH",
        "file": None,
        "line": None,
        "issue": (
            "Coverage verifier returned BLOCKING; coverage.json.final fails "
            "the closed-vocabulary, additive-only, or best-effort-only contract."
        ),
        "explanation": (
            "The verifier runs after the critic-consolidate step and "
            "enforces invariants the LLM critic stage cannot self-check: "
            "roster membership, initial-plan preservation, critic-bucket "
            "placement, evidence presence, the 5-cap, and uniqueness. A "
            "BLOCKING verdict means the plan should not drive downstream "
            "reviewer spawning."
        ),
        "recommendation": (
            "Re-run the review. If the failure persists, inspect "
            "coverage.json's `.verify` section for the per-check "
            "violations; common causes include roster drift (AVAILABLE "
            "list changed mid-run), an unexpected critic schema bypass, "
            "or a deletion sneaking into the merge."
        ),
        "confidence": 1.0,
        "rationale_summary": "; ".join(summary)[:1000],
        "emitted_at": now_iso,
    }
    try:
        with open(cr_dir / "agent_coverage-verify-blocking.json", "w") as f:
            json.dump({"findings": [finding]}, f, indent=2)
    except OSError as exc:
        print(
            f"Warning: could not write coverage-verify-blocking finding: {exc}",
            file=sys.stderr,
        )


def cmd_verify_coverage(args: argparse.Namespace) -> int:
    """Deterministic verifier for the final coverage plan (stage_15c).

    Reads the final plan from ``coverage.json``'s ``.final`` section
    and the pre-critic plan from ``.initial``. Optionally reads
    ``available_reviewers.json`` (roster). Computes violations against
    the closed-vocabulary, additive-only, best-effort-only-critic,
    evidence-required, 5-cap, and no-duplicates contracts. Writes the
    verdict into ``coverage.json``'s ``.verify`` section, and on
    BLOCKING also emits an ``agent_coverage-verify-blocking.json``
    system finding.

    Exit code is 0 on PASS and BLOCKING (the walker is observational).
    Downstream stages (arbitrate-budget) gate on the verdict by reading
    the artifact, not the exit code. Returns 1 only on a write failure
    to ``coverage.json.verify`` itself.

    Missing or unreadable verifier inputs (``.final`` or ``.initial``)
    BLOCK with an ``input`` check so an upstream abort is never confused
    with a real PASS in the artifact.

    Roster semantics: missing file → no project agents configured
    (closed-vocabulary check is bypassed; verdict reflects only the
    other checks). Empty file or empty list → same. PRESENT but invalid
    (unreadable, wrong shape) → BLOCK with a ``roster`` check —
    distinguishable from absent so an operator config error is
    surfaced.

    Skip semantics: when the final plan has ``critic_status:
    "skipped"`` (--no-critic, no-roster, or no-candidates path), the
    verifier still runs the shape + additivity + no-duplicates checks.
    The closed-vocabulary check is bypassed when the roster file is
    absent or empty.
    """
    cr_dir = Path(args.cr_dir)
    available_path = (
        Path(args.available_reviewers)
        if getattr(args, "available_reviewers", None)
        else None
    )

    now_iso = datetime.now(timezone.utc).isoformat()

    def _write_verdict(verdict: str, violations: list[dict[str, str]]) -> int:
        result = {
            "verdict": verdict,
            "violations": violations,
            "checked_at": now_iso,
        }
        try:
            _write_coverage_section(cr_dir, "verify", result)
        except OSError as exc:
            print(f"Error writing coverage.json.verify: {exc}", file=sys.stderr)
            return 1
        if verdict == "BLOCKING":
            _emit_coverage_verify_blocking_finding(cr_dir, violations, now_iso)
        summary = {
            "verdict": verdict,
            "violation_count": len(violations),
            "coverage_state": str(cr_dir / _COVERAGE_STATE_FILENAME),
        }
        json.dump(summary, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    # Read plans from coverage.json sections. Missing or unreadable
    # verifier inputs BLOCK with an ``input`` check so "no plan was
    # verified" is distinguishable from a real PASS in the artifact
    # (downstream arbitrate-budget gates on the verdict). Exit code
    # stays 0 so the walker doesn't halt — observational semantics
    # are about the WALKER, the verdict is about the ARTIFACT consumer.
    plan = _read_coverage_state(cr_dir).get("final")
    if plan is None:
        return _write_verdict("BLOCKING", [{
            "check": "input",
            "message": "coverage.json.final missing",
        }])
    if not isinstance(plan, dict):
        return _write_verdict("BLOCKING", [{
            "check": "shape",
            "message": "coverage.json.final is not a JSON object",
        }])

    plan_initial = _read_coverage_state(cr_dir).get("initial")
    if plan_initial is None:
        return _write_verdict("BLOCKING", [{
            "check": "input",
            "message": "coverage.json.initial missing",
        }])
    if not isinstance(plan_initial, dict):
        return _write_verdict("BLOCKING", [{
            "check": "input",
            "message": "coverage.json.initial is not a JSON object",
        }])

    available_reviewers: list[str] | None = None
    if available_path is not None and available_path.exists():
        loaded, err = _load_available_reviewers(available_path)
        if loaded is None:
            # Present-but-malformed roster — distinct from missing/empty.
            # Missing file → no project agents configured (no-roster
            # semantics, closed-vocabulary check is bypassed). Empty file
            # / empty list → same. But a PRESENT INVALID file is an
            # operator config error: previously the read error was
            # silently discarded and ``available_reviewers`` stayed
            # None, causing the closed-vocabulary check to be skipped.
            # That let a corrupted ``available_reviewers.json`` produce
            # a misleading PASS on a plan that should have been gated.
            return _write_verdict("BLOCKING", [{
                "check": "roster",
                "message": f"available_reviewers unparseable: {err}",
            }])
        available_reviewers = loaded if loaded else None

    violations = verify_coverage_plan(plan, plan_initial, available_reviewers)
    verdict = "BLOCKING" if violations else "PASS"
    return _write_verdict(verdict, violations)


# ---------------------------------------------------------------------------
# Subcommand: classify-intent
# ---------------------------------------------------------------------------


def cmd_classify_intent(args: argparse.Namespace) -> int:
    """Classify diff intent for model routing."""
    intent_context_path: str = args.intent_context
    diff_data_path: str | None = getattr(args, "diff_data", None)

    try:
        with open(intent_context_path) as f:
            ctx = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading intent context: {exc}", file=sys.stderr)
        return 1

    # PLN-720 quarantine guard: if detect-injection redacted the context,
    # skip the LLM-classification path and route deterministically. The
    # redacted body has no signal worth classifying — falling through to
    # _classify_intent would surface "mixed" anyway, but the explicit
    # short-circuit makes the path auditable.
    if ctx.get("quarantine") is True:
        json.dump({"intent": "mixed", "source": "quarantine"}, sys.stdout)
        sys.stdout.write("\n")
        return 0

    title = str(ctx.get("title", ""))
    body = str(ctx.get("body", ""))
    commits = str(ctx.get("commits", ""))

    file_statuses: dict[str, str] = {}
    if diff_data_path:
        try:
            with open(diff_data_path) as f:
                diff_data = json.load(f)
            file_statuses = diff_data.get("file_statuses", {})
        except (OSError, json.JSONDecodeError):
            pass  # Proceed without file statuses

    intent = _classify_intent(title, body, commits, file_statuses)
    json.dump({"intent": intent}, sys.stdout)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: collect-findings
# ---------------------------------------------------------------------------


_AGENT_FILENAME_RE = re.compile(r"^agent_(.+)\.json$")
_REVIEWER_ID_RE = re.compile(r"^[a-z][a-z0-9_-]*$")


def _reviewer_from_agent_path(path: Path) -> str:
    """Derive reviewer id from `agent_<reviewer_id>.json` filename.

    Falls back to the raw stem if the pattern does not match.
    """
    match = _AGENT_FILENAME_RE.match(path.name)
    return match.group(1) if match else path.stem


def _coerce_reviewer_id(raw: Any, fallback: str) -> str:
    """Return a canonical reviewer id; fall back when ``raw`` is missing or malformed.

    LLM-emitted findings can carry any string in the ``reviewer`` field
    (e.g. ``"Bug Hunter A"``), which would fail ``make_finding_id``'s
    ``^[a-z][a-z0-9_-]*$`` regex and bubble a ValueError up to the outer
    handler — silently dropping every finding in the affected agent file.
    Falling back to the filename-derived id preserves the findings.
    """
    if isinstance(raw, str) and _REVIEWER_ID_RE.match(raw):
        return raw
    return fallback


def cmd_collect_findings(args: argparse.Namespace) -> int:
    """Merge agent findings and hygiene findings into a single JSON file.

    Findings without an ``id`` are assigned a deterministic one of the form
    ``<reviewer_id>_f<index>`` (PLN-719 Section 4). Reviewer id is derived
    from the source ``agent_<id>.json`` filename when not present in the
    finding itself.
    """
    cr_dir = Path(args.cr_dir)
    output_filename: str = args.output
    hygiene_path: str | None = getattr(args, "hygiene", None)

    findings: list[dict[str, Any]] = []
    agent_files: list[str] = []
    now_iso = datetime.now(timezone.utc).isoformat()

    # Glob agent_*.json files in cr_dir
    for agent_file in sorted(cr_dir.glob("agent_*.json")):
        try:
            with open(agent_file) as f:
                data = json.load(f)
            file_findings = data.get("findings", [])
            if not isinstance(file_findings, list):
                raise ValueError(f"findings is not a list in {agent_file}")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"Warning: skipping malformed agent file {agent_file}: {exc}", file=sys.stderr)
            continue

        reviewer = _reviewer_from_agent_path(agent_file)
        for idx, raw in enumerate(file_findings):
            if not isinstance(raw, dict):
                continue
            # Coerce reviewer to a canonical id; fall back to the filename
            # when the LLM emitted a non-canonical string like "Bug Hunter A".
            # normalize_legacy_finding uses setdefault for reviewer, so we
            # must overwrite the dict directly to ensure the canonical value
            # propagates into make_finding_id.
            raw_normalized = dict(raw)
            raw_normalized["reviewer"] = _coerce_reviewer_id(raw.get("reviewer"), reviewer)
            try:
                promoted = normalize_legacy_finding(
                    raw_normalized,
                    reviewer=raw_normalized["reviewer"],
                    source="agent",
                    index=idx,
                    emitted_at=now_iso,
                )
            except (ValueError, TypeError) as exc:
                print(
                    f"Warning: skipping malformed finding {idx} in {agent_file}: {exc}",
                    file=sys.stderr,
                )
                continue
            findings.append(promoted)
        agent_files.append(str(agent_file))

    # Read hygiene.json if provided
    hygiene_included = False
    if hygiene_path:
        try:
            with open(hygiene_path) as f:
                hygiene_data = json.load(f)
            hygiene_findings = hygiene_data.get("findings", [])
            if isinstance(hygiene_findings, list):
                # Hygiene findings are already canonical (cmd_hygiene normalizes),
                # but pass through normalize_legacy_finding to fill any gaps.
                for idx, raw in enumerate(hygiene_findings):
                    if not isinstance(raw, dict):
                        continue
                    findings.append(
                        normalize_legacy_finding(
                            raw,
                            reviewer=raw.get("reviewer", "hygiene"),
                            source=raw.get("source", "hygiene"),
                            index=idx,
                            emitted_at=now_iso,
                        ),
                    )
                hygiene_included = True
        except (OSError, json.JSONDecodeError):
            pass  # hygiene file missing or malformed -- skip silently

    # Write combined findings
    output_path = cr_dir / output_filename
    with open(output_path, "w") as f:
        json.dump(findings, f, indent=2)

    json.dump(
        {
            "total_findings": len(findings),
            "agent_files": agent_files,
            "hygiene_included": hygiene_included,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: review-dismissed-prepare / review-dismissed-consolidate
# (PLN-773 Phase 5 — second-opinion fleet against prior rejected[])
# ---------------------------------------------------------------------------

# Fixed model for the dismissed-review second opinion. Different from the
# default verifier (sonnet) so the second pass gives an independent vote
# rather than the same model re-agreeing with itself.
_REVIEW_DISMISSED_MODEL = "haiku"


def cmd_review_dismissed_prepare(args: argparse.Namespace) -> int:
    """Stage 1 of `--review-dismissed`: build a haiku-verifier manifest from
    the prior run's ``rejected[]`` bucket.

    Reads ``<CR_DIR>/review_result.json`` (or ``--prior-result`` if given),
    writes per-finding input files at
    ``<CR_DIR>/review_dismissed_inputs/<finding_id>.json``, and emits
    ``<CR_DIR>/review_dismissed_manifest.json`` shaped like
    ``cmd_verify_prepare``'s manifest (so the walker can re-use the same
    fleet-dispatch loop, just keyed on the haiku model).
    """
    cr_dir = Path(args.cr_dir)
    prior_path = (
        Path(args.prior_result) if getattr(args, "prior_result", None)
        else cr_dir / "review_result.json"
    )
    envelope = _read_optional_json(prior_path, None)
    if not isinstance(envelope, dict):
        print(
            f"Error: prior review_result.json not found or malformed at "
            f"{prior_path}",
            file=sys.stderr,
        )
        return 1

    rejected: list[dict[str, Any]] = [
        f for f in envelope.get("rejected", []) or []
        if isinstance(f, dict) and f.get("id")
    ]

    inputs_dir = cr_dir / "review_dismissed_inputs"
    inputs_dir.mkdir(parents=True, exist_ok=True)
    verifier_prompt_path = cr_dir / "verifier_prompt.txt"

    to_verify: list[dict[str, Any]] = []
    for finding in rejected:
        fid = str(finding["id"])
        input_path = inputs_dir / f"{fid}.json"
        # Output target: distinct from the standard verifier's output so the
        # two runs cannot clobber each other if the orchestrator chains them.
        output_path = cr_dir / f"agent_verifier_dismissed_{fid}.json"
        with open(input_path, "w") as fh:
            json.dump(
                {
                    "finding": finding,
                    "verifier_prompt_path": str(verifier_prompt_path),
                    "output_path": str(output_path),
                },
                fh,
                indent=2,
            )
        to_verify.append({
            "finding_id": fid,
            "model": _REVIEW_DISMISSED_MODEL,
            "severity": finding.get("severity"),
            "input_path": str(input_path),
            "output_path": str(output_path),
            "prior_verdict": finding.get("verifier_verdict", "REJECTED"),
        })

    manifest = {
        "to_verify": to_verify,
        "model": _REVIEW_DISMISSED_MODEL,
        "prior_result": str(prior_path),
        "verifier_prompt_path": str(verifier_prompt_path),
    }
    manifest_path = cr_dir / "review_dismissed_manifest.json"
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_review_dismissed_consolidate(args: argparse.Namespace) -> int:
    """Stage 2 of `--review-dismissed`: read haiku verifier outputs and
    auto-promote any non-REJECTED verdict by writing an RE_ASSERT override.

    Writes ``<CR_DIR>/review_dismissed_diff.json`` documenting the
    side-by-side: ``{finding_id, prior_verdict, new_verdict, action}``
    where ``action`` is ``"promoted"`` or ``"no_change"``. The operator
    re-runs ``/start`` afterward; the new overrides are honored by
    ``cmd_verify_prepare`` on that next run.
    """
    cr_dir = Path(args.cr_dir)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    manifest_path = (
        Path(args.manifest) if getattr(args, "manifest", None)
        else cr_dir / "review_dismissed_manifest.json"
    )
    if cache_dir is None:
        print(
            "Error: --cache-dir required so overrides persist across runs.",
            file=sys.stderr,
        )
        return 2

    manifest = _read_optional_json(manifest_path, None)
    if not isinstance(manifest, dict):
        print(
            f"Error: manifest not found at {manifest_path}",
            file=sys.stderr,
        )
        return 1

    prior_path = manifest.get("prior_result")
    prior_envelope = _read_optional_json(Path(prior_path), {}) if prior_path else {}
    prior_findings_by_id: dict[str, dict[str, Any]] = {}
    if isinstance(prior_envelope, dict):
        for f in prior_envelope.get("rejected", []) or []:
            if isinstance(f, dict) and f.get("id"):
                prior_findings_by_id[str(f["id"])] = f

    now_iso = datetime.now(timezone.utc).isoformat()
    diff_entries: list[dict[str, Any]] = []
    promoted = 0
    no_change = 0
    missing = 0

    for entry in manifest.get("to_verify", []) or []:
        if not isinstance(entry, dict):
            continue
        fid = str(entry.get("finding_id", ""))
        if not fid:
            continue
        prior_verdict = str(entry.get("prior_verdict", "REJECTED"))
        output_path = (
            Path(entry["output_path"]) if entry.get("output_path")
            else cr_dir / f"agent_verifier_dismissed_{fid}.json"
        )
        agent_out = _read_verifier_output(output_path)
        if agent_out is None:
            missing += 1
            diff_entries.append({
                "finding_id": fid,
                "prior_verdict": prior_verdict,
                "new_verdict": None,
                "action": "missing_output",
            })
            continue
        new_verdict = str(agent_out.get("verifier_verdict", ""))
        if new_verdict == "REJECTED":
            no_change += 1
            diff_entries.append({
                "finding_id": fid,
                "prior_verdict": prior_verdict,
                "new_verdict": new_verdict,
                "action": "no_change",
            })
            continue
        # Non-REJECTED — auto-promote via override.
        prior = prior_findings_by_id.get(fid, {})
        file_hash = _file_content_hash(
            cr_dir, prior.get("file"), prior.get("line"),
        )
        payload = {
            "finding_id": fid,
            "file": prior.get("file"),
            "line": prior.get("line"),
            "file_content_hash": file_hash,
            "override": "REVIEW_DISMISSED",
            "reason": (
                f"Second-opinion haiku verifier: {prior_verdict} → {new_verdict}"
            ),
            "verified_against": prior_verdict,
            "asserted_at": now_iso,
            "asserted_by": "review-dismissed",
        }
        _write_override(cache_dir, payload)
        promoted += 1
        diff_entries.append({
            "finding_id": fid,
            "prior_verdict": prior_verdict,
            "new_verdict": new_verdict,
            "action": "promoted",
        })

    diff_doc = {
        "diff": diff_entries,
        "stats": {
            "total": len(diff_entries),
            "promoted": promoted,
            "no_change": no_change,
            "missing_output": missing,
        },
    }
    diff_path = cr_dir / "review_dismissed_diff.json"
    with open(diff_path, "w") as fh:
        json.dump(diff_doc, fh, indent=2)
        fh.write("\n")
    json.dump(diff_doc, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: re-assert (PLN-773 Phase 4)
# ---------------------------------------------------------------------------


def _find_finding_in_envelope(
    envelope: dict[str, Any], finding_id: str,
) -> tuple[str | None, dict[str, Any] | None]:
    """Locate ``finding_id`` in any envelope bucket.

    Returns ``(bucket_name, finding)`` or ``(None, None)`` when not found.
    The bucket name is the canonical envelope key (``rejected``,
    ``pending_verification``, ``verified``, ``justified``) so the caller
    can distinguish "promote from rejected" from "already verified".
    """
    for bucket in ("rejected", "pending_verification", "verified", "justified"):
        for f in envelope.get(bucket, []) or []:
            if isinstance(f, dict) and str(f.get("id", "")) == finding_id:
                return bucket, f
    return None, None


def cmd_re_assert(args: argparse.Namespace) -> int:
    """Write operator override files for one or more finding IDs.

    PLN-773 Phase 4. Reads the prior ``review_result.json``, locates each
    requested finding, computes its current file-content hash, and writes
    ``<CACHE_DIR>/overrides/<finding_id>.json``. The next ``cmd_verify_prepare``
    run honors the override and synthesizes a ``RE_ASSERTED`` verdict.

    Stdout: a summary JSON object documenting which ids were re-asserted,
    which were no-ops (already verified), and which were not found.
    """
    cr_dir = Path(args.cr_dir)
    cache_dir = Path(args.cache_dir) if getattr(args, "cache_dir", None) else None
    prior_path = (
        Path(args.prior_result) if getattr(args, "prior_result", None)
        else cr_dir / "review_result.json"
    )
    reason = str(getattr(args, "reason", "") or "")
    asserted_by = str(getattr(args, "asserted_by", "") or "operator")

    raw_ids = str(getattr(args, "finding_ids", "") or "")
    finding_ids = [s.strip() for s in raw_ids.split(",") if s.strip()]
    if not finding_ids:
        print(
            "Error: --finding-ids must be a non-empty comma-separated list.",
            file=sys.stderr,
        )
        return 2
    if cache_dir is None:
        print(
            "Error: --cache-dir is required so overrides persist across runs.",
            file=sys.stderr,
        )
        return 2

    envelope = _read_optional_json(prior_path, None)
    if not isinstance(envelope, dict):
        print(
            f"Error: prior review_result.json not found or malformed at "
            f"{prior_path}",
            file=sys.stderr,
        )
        return 1

    now_iso = datetime.now(timezone.utc).isoformat()
    re_asserted: list[dict[str, Any]] = []
    already_verified: list[str] = []
    # PR #114 review fix — re-asserting a JUSTIFIED-VALID finding is
    # operator-meaningless (the finding is already surfaced in justified[];
    # writing a RE_ASSERT override would silently re-route it through
    # verified[] on the next run, losing the justification record). Bucket
    # it explicitly so the operator sees the no-op rather than getting a
    # success summary that doesn't match observed behavior.
    already_dismissed: list[str] = []
    not_found: list[str] = []

    for fid in finding_ids:
        bucket, finding = _find_finding_in_envelope(envelope, fid)
        if finding is None:
            not_found.append(fid)
            continue
        if bucket == "verified":
            # Already in verified[] — no override needed; record for the
            # summary so the operator sees the no-op.
            already_verified.append(fid)
            continue
        if bucket == "justified":
            # Already in justified[] — re-asserting would re-route to
            # verified[] and erase the justification record. Report and
            # skip; operator who really wants to re-assert can edit the
            # envelope first.
            already_dismissed.append(fid)
            continue
        # PR #114 review fix — system-scoped findings (no file/line)
        # write the SYSTEM_SCOPE sentinel so ``_override_is_valid`` can
        # honor them on the next run. Without the sentinel
        # ``_file_content_hash`` returns "" and the override is dropped
        # at promotion time, making cmd_re_assert silently no-op.
        file_field = finding.get("file")
        line_field = finding.get("line")
        if not file_field or not line_field:
            file_hash = _OVERRIDE_SYSTEM_SCOPE_SENTINEL
        else:
            file_hash = _file_content_hash(cr_dir, file_field, line_field)
        payload = {
            "finding_id": fid,
            "file": file_field,
            "line": line_field,
            "file_content_hash": file_hash,
            "override": "RE_ASSERT",
            "reason": reason,
            "verified_against": finding.get("verifier_verdict"),
            "asserted_at": now_iso,
            "asserted_by": asserted_by,
        }
        path = _write_override(cache_dir, payload)
        if path is None:
            print(
                f"Warning: failed to write override for {fid}",
                file=sys.stderr,
            )
            continue
        re_asserted.append({"finding_id": fid, "prior_bucket": bucket})
        # PLN-773 Phase 6: every re-assert is an event self-learning will
        # consume to detect over-rejection patterns per reviewer.
        _pending_learnings_append(
            _PENDING_LEARNINGS_DIR / _PENDING_LEARNINGS_OVERRIDES,
            dict(payload, prior_bucket=bucket),
        )

    summary = {
        "re_asserted": re_asserted,
        "already_verified": already_verified,
        "already_dismissed": already_dismissed,
        "not_found": not_found,
        "reason": reason,
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: verdict
# ---------------------------------------------------------------------------

_VERDICT_REASON_MAX = 80

# Mapping between canonical envelope verdicts and the legacy verdict
# strings consumed by run-loop.sh (`approve` / `needs_attention` /
# `decline`).
_CANONICAL_TO_LEGACY_VERDICT: dict[str, str] = {
    "APPROVED": "approve",
    "NEEDS_ATTENTION": "needs_attention",
    "CHANGES_REQUESTED": "decline",
}


def _count_gateable_premise_medium(verified: list[dict[str, Any]]) -> int:
    """Return the count Rule 4's Premise-MEDIUM gate fires on.

    Shared between ``_compute_canonical_verdict`` (Rule 4) and
    ``_stats_from_findings`` (telemetry's
    ``premise_cumulative_medium_count``) so the value the gate triggers
    on always matches the value the operator-facing telemetry reports.
    Counting policy:

      - Only ``verified[]`` findings (``justified[]`` is bucketed
        elsewhere; ``rejected[]`` is dropped from the verdict; and
        ``coverage_gaps`` never carry ``category=Premise``).
      - JUSTIFIED-VALID vs JUSTIFIED-INVALID are **asymmetric**:
          * ``JUSTIFIED-VALID`` = author defense was audited and
            accepted; the finding is dismissed and lives in
            ``justified[]``, NOT ``verified[]``. Excluded defensively
            in case a cached entry leaks into ``verified[]`` — its
            concern was waived.
          * ``JUSTIFIED-INVALID`` = author defense was audited and
            REFUSED; the original concern survived. It belongs in the
            count the same way a plain CONFIRMED MEDIUM does. The
            reserved-but-unemitted enum value also lands here if a
            future code path produces one in ``verified[]``.
      - Severity is read post-DOWNGRADE — ``_merge_verifier_fields``
        rewrites ``severity`` from ``verifier_severity`` for valid
        downgrades, so a DOWNGRADE from HIGH → MEDIUM correctly counts.
    """
    count = 0
    for finding in verified:
        if str(finding.get("category", "")) != "Premise":
            continue
        if str(finding.get("severity", "")) != "MEDIUM":
            continue
        if finding.get("verifier_verdict") == "JUSTIFIED-VALID":
            continue
        count += 1
    return count


def _compute_canonical_verdict(
    verified: list[dict[str, Any]],
    coverage_gaps: list[dict[str, Any]],
    *,
    force_human_review: bool = False,
    thresholds: dict[str, int] | None = None,
) -> tuple[str, str]:
    """Apply canonical verdict precedence rules (PLN-719 Section 5).

    Returns (canonical_verdict, reason). PLN-722 added two rules: the
    ``force_human_review`` short-circuit (rule 2.5 — mandatory_human_review_
    paths) and the TENTATIVE → NEEDS_ATTENTION fall-through (rule 3.5).
    PLN-721 fills in Rule 4: cumulative Premise MEDIUM gate. Rule 6
    (Impact analysis count) is still placeholder until plan 06 lands.

    ``thresholds`` (PLN-721): optional dict from ``_load_verdict_thresholds``;
    callers that do not pass it get the built-in default (3) so existing
    test fixtures and back-compat callers keep working.
    """
    thresholds = thresholds or {
        "premise_cumulative_medium": _VERDICT_PREMISE_MEDIUM_THRESHOLD_DEFAULT,
    }

    def _short(text: str) -> str:
        return text[:_VERDICT_REASON_MAX]

    # Rule 1: required coverage gap → CHANGES_REQUESTED.
    # A required reviewer that couldn't run blocks the PR regardless of severity.
    for gap in coverage_gaps:
        if gap.get("required", False):
            return "CHANGES_REQUESTED", _short(f"coverage gap: {gap.get('issue', '')}")

    # Rules 2-3 evaluate severity across both buckets — plan section 5 says
    # "Any BLOCKING finding (verified or system-scoped)" and likewise for HIGH.
    # Coverage gaps are system-scoped findings; including them here is what
    # prevents a non-required HIGH coverage gap from falling through to
    # APPROVED.
    all_findings = verified + coverage_gaps

    # Rule 2: BLOCKING (any scope) or Premise P0 → CHANGES_REQUESTED.
    for finding in all_findings:
        sev = str(finding.get("severity", ""))
        if sev == "BLOCKING":
            return "CHANGES_REQUESTED", _short(str(finding.get("issue", "")))
        if str(finding.get("category", "")) == "Premise" and finding.get("priority") == 0:
            return "CHANGES_REQUESTED", _short(str(finding.get("issue", "")))

    # Rule 2.5 (PLN-722): mandatory_human_review_paths force NEEDS_ATTENTION.
    # Sits between BLOCKING and HIGH so BLOCKING still wins, but HIGH does
    # NOT escalate a force-review-path PR past NEEDS_ATTENTION — the
    # operator policy is "a human triages this PR", not "this PR is
    # automatically rejected".
    if force_human_review:
        return "NEEDS_ATTENTION", _short(
            "mandatory human review path touched; verifier escalated to TENTATIVE",
        )

    # Rule 3: HIGH (any scope) → NEEDS_ATTENTION
    for finding in all_findings:
        if str(finding.get("severity", "")) == "HIGH":
            return "NEEDS_ATTENTION", _short(str(finding.get("issue", "")))

    # Rule 3.5 (PLN-722): any TENTATIVE verifier verdict → NEEDS_ATTENTION.
    # The verifier could not confirm or disprove the underlying claim; the
    # plan calls this out explicitly: "TENTATIVE counts toward NEEDS_ATTENTION
    # (not CHANGES_REQUESTED)". Treat it as a signal to the human reviewer,
    # not a silent approval.
    for finding in verified:
        if finding.get("verifier_verdict") == "TENTATIVE":
            return "NEEDS_ATTENTION", _short(
                f"verifier uncertain: {finding.get('issue', '')}",
            )

    # Rule 4 (PLN-721): cumulative Premise MEDIUM gate. The counting
    # policy is documented on ``_count_gateable_premise_medium`` — this
    # site MUST use that helper so the value the gate fires on matches
    # the value telemetry reports in ``premise_cumulative_medium_count``.
    premise_medium_threshold = int(
        thresholds.get(
            "premise_cumulative_medium",
            _VERDICT_PREMISE_MEDIUM_THRESHOLD_DEFAULT,
        ),
    )
    premise_medium_count = _count_gateable_premise_medium(verified)
    if premise_medium_count >= premise_medium_threshold:
        return "NEEDS_ATTENTION", _short(
            f"{premise_medium_count} MEDIUM Premise findings "
            f"(threshold {premise_medium_threshold})",
        )

    # Rule 6 (plan 06 Impact count) remains placeholder until that plan lands.

    return "APPROVED", ""


def _read_optional_json(path: Path, default: Any) -> Any:
    """Read a JSON file, returning ``default`` if missing or malformed."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return default


# ---------------------------------------------------------------------------
# Shared scaffolding for singleton-agent prepare/consolidate pairs
# (extract-signals and coverage-critic in PLN-725). Both pairs follow
# the same lifecycle: read inputs → cache lookup → emit manifest →
# (later) read agent output → validate → write canonical / fail-closed.
# These helpers de-duplicate the boilerplate.
# ---------------------------------------------------------------------------


def _read_manifest_dict(path: Path) -> dict[str, Any]:
    """Read a manifest JSON file, returning ``{}`` on any failure.

    Both consolidate paths need the manifest's ``status``/``cache_key``/``model``
    fields but must tolerate the manifest being missing or malformed
    (truncated mid-write). An empty dict gives ``manifest.get(...)``
    callers the same ``None``-coalescing behavior as the original try/except
    blocks while collapsing the seven-line pattern into one call.
    """
    if not path.exists():
        return {}
    try:
        with open(path) as f:
            loaded = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _emit_summary(payload: dict[str, Any]) -> int:
    """Dump ``payload`` to stdout as indented JSON + newline and return 0.

    Used by every singleton prepare/consolidate to surface the summary the
    walker reads. Returning the int lets callers write ``return _emit_summary(...)``
    instead of the three-line dump/write/return triple.
    """
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _read_agent_output_or_error(path: Path) -> tuple[Any, str | None]:
    """Read agent JSON output, returning ``(value, None)`` or ``(None, error_msg)``.

    Both consolidate paths immediately route a read error into the fail-closed
    branch with the same diagnostic shape, so the read+except pattern is shared.
    """
    try:
        with open(path) as f:
            return json.load(f), None
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"agent output unreadable: {exc}"


def _write_and_emit_manifest(
    manifest_path: Path, manifest: dict[str, Any],
) -> int:
    """Write a manifest to disk and emit it to stdout as the summary; return 0.

    The walker reads stdout to know what prepare emitted; the manifest file
    serves the consolidate stage. Both prepare paths in extract-signals and
    coverage-critic write the same dict to both places.
    """
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    return _emit_summary(manifest)


# ---------------------------------------------------------------------------
# State-aggregate helpers: shared read/write contract for the ``spawn.json``
# and ``coverage.json`` consolidated artifacts. Each aggregate has a fixed
# section vocabulary; each section is updated by exactly one stage. The writer
# uses atomic read-modify-write (tmp + ``os.replace``) so a crash mid-write
# leaves the prior state intact.
# ``_write_state_sections`` (plural) is the atomic batched variant — used
# by the cache-hit and skipped paths in coverage-critic-prepare which
# must materialize multiple sections without leaving the aggregate in a
# half-written shape if the second write fails.
# ---------------------------------------------------------------------------


_SPAWN_STATE_FILENAME = "spawn.json"
_SPAWN_STATE_SECTIONS: frozenset[str] = frozenset({"route", "spec", "verification"})

_COVERAGE_STATE_FILENAME = "coverage.json"
_COVERAGE_STATE_SECTIONS: frozenset[str] = frozenset({"initial", "critic", "final", "verify"})

_STATE_SECTION_VOCAB: dict[str, frozenset[str]] = {
    _SPAWN_STATE_FILENAME: _SPAWN_STATE_SECTIONS,
    _COVERAGE_STATE_FILENAME: _COVERAGE_STATE_SECTIONS,
}


def _read_state_aggregate(cr_dir: Path, filename: str) -> dict[str, Any]:
    """Return the parsed contents of ``<cr_dir>/<filename>`` or ``{}``.

    Tolerates missing / malformed / non-dict so callers can chain
    ``state.get(section)`` without isinstance checks. Used directly by
    presenters and verifiers whose degraded-output paths fire on the
    same shape (a missing section is structurally indistinguishable
    from a missing file).
    """
    raw = _read_optional_json(cr_dir / filename, {})
    return raw if isinstance(raw, dict) else {}


def _write_state_sections(
    cr_dir: Path, filename: str, updates: dict[str, dict[str, Any]],
) -> None:
    """Atomically merge one or more sections into ``<cr_dir>/<filename>``.

    Read-modify-write via tmp + ``os.replace``: read the current state
    (or ``{}`` if absent), apply every ``(section, payload)`` in
    ``updates``, write the merged state to ``<filename>.tmp``, rename
    over ``<filename>``. POSIX guarantees the rename is atomic — a crash
    mid-write either leaves the prior state intact or installs the full
    update, never a half-written shape.

    Single-call multi-section semantics matter for skip/cache-hit paths
    that must publish both ``.final`` and ``.critic`` (or similar) as a
    unit: an OSError between two single-section writes would leave the
    aggregate readable but inconsistent (one section updated, the other
    stale), and the next stage's consumers would see a contradiction.
    """
    vocab = _STATE_SECTION_VOCAB.get(filename)
    if vocab is None:
        raise ValueError(f"unknown state aggregate {filename!r}")
    bad = [s for s in updates if s not in vocab]
    if bad:
        raise ValueError(
            f"unknown {filename} section(s) {bad!r}; expected subset of "
            f"{sorted(vocab)}",
        )
    cr_dir.mkdir(parents=True, exist_ok=True)
    state = _read_state_aggregate(cr_dir, filename)
    state.update(updates)
    path = cr_dir / filename
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2))
    os.replace(str(tmp), str(path))


def _read_spawn_state(cr_dir: Path) -> dict[str, Any]:
    """Return the parsed contents of ``<cr_dir>/spawn.json`` or ``{}``."""
    return _read_state_aggregate(cr_dir, _SPAWN_STATE_FILENAME)


def _write_spawn_section(
    cr_dir: Path, section: str, payload: dict[str, Any],
) -> None:
    """Atomically update one ``spawn.json`` section."""
    _write_state_sections(cr_dir, _SPAWN_STATE_FILENAME, {section: payload})


def _read_coverage_state(cr_dir: Path) -> dict[str, Any]:
    """Return the parsed contents of ``<cr_dir>/coverage.json`` or ``{}``."""
    return _read_state_aggregate(cr_dir, _COVERAGE_STATE_FILENAME)


def _write_coverage_section(
    cr_dir: Path, section: str, payload: dict[str, Any],
) -> None:
    """Atomically update one ``coverage.json`` section."""
    _write_state_sections(cr_dir, _COVERAGE_STATE_FILENAME, {section: payload})


def _write_coverage_sections(
    cr_dir: Path, updates: dict[str, dict[str, Any]],
) -> None:
    """Atomically update multiple ``coverage.json`` sections in one write.

    Used by the skip / cache-hit paths in coverage-critic-prepare so
    ``.final`` and ``.critic`` land as a unit; sequencing two
    single-section writes would leave the aggregate inconsistent if the
    second write failed mid-OSError.
    """
    _write_state_sections(cr_dir, _COVERAGE_STATE_FILENAME, updates)


def _read_simple_cache_entry(
    cache_dir: Path | None,
    path: Path,
    namespace: str,
    default_ttl_days: int,
) -> dict[str, Any] | None:
    """Return a cached entry from a ``written_at``-stamped JSON file, or None.

    Shared between the ``signals`` and ``coverage_critic`` cache namespaces.
    Both store ``{written_at: ISO, ...payload}`` per entry, apply the namespace
    TTL via ``cache_ttl_days``, sweep stale entries on read, and treat any of
    {missing file, malformed JSON, non-dict payload, missing/unparseable
    written_at, TTL-expired} as a cache miss. Verifications uses a different
    timestamp field and envelope shape and stays on its own reader.
    """
    if cache_dir is None or not path.exists():
        return None
    try:
        with open(path) as f:
            entry = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(entry, dict):
        return None
    ttl = cache_ttl_days(namespace) or default_ttl_days
    written_at = entry.get("written_at")
    try:
        ts = datetime.fromisoformat(str(written_at).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        # Missing/unparseable written_at: a manually seeded or partially
        # written entry. Sweep so the next miss is clean; do NOT serve it.
        with contextlib.suppress(OSError):
            path.unlink()
        return None
    if datetime.now(timezone.utc) - ts > timedelta(days=ttl):
        with contextlib.suppress(OSError):
            path.unlink()
        return None
    return entry


def _write_simple_cache_entry(
    cache_dir: Path | None,
    path: Path,
    payload: dict[str, Any],
    warning_label: str,
) -> None:
    """Persist a successful agent output to a ``written_at``-stamped cache file.

    Fail-open: any OSError logs a one-line warning and returns. The canonical
    file in cr_dir is the source of truth — the cache is purely a re-run cost
    optimization, so a write failure here must never abort the pipeline.
    """
    if cache_dir is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = dict(payload)
        entry["written_at"] = datetime.now(timezone.utc).isoformat()
        with open(path, "w") as f:
            json.dump(entry, f, indent=2)
    except OSError as exc:
        print(
            f"Warning: could not write {warning_label} cache entry: {exc}",
            file=sys.stderr,
        )


def cmd_verdict(args: argparse.Namespace) -> int:
    """Compute PR verdict.

    Reads ``review_result.json`` (canonical envelope) when available; falls
    back to ``findings_validated.json`` otherwise. Emits a JSON object with
    the canonical verdict, the run-loop-compatible legacy verdict string,
    and a reason.
    """
    findings_validated_path: str = args.findings_validated
    review_result_path: str | None = getattr(args, "review_result", None)

    canonical_verdict: str | None = None
    reason = ""

    # Prefer review_result.json when present.
    if review_result_path and Path(review_result_path).is_file():
        envelope = _read_optional_json(Path(review_result_path), None)
        if isinstance(envelope, dict):
            canonical_verdict = envelope.get("verdict")
            reason = str(envelope.get("verdict_reason", ""))[:_VERDICT_REASON_MAX]

    # Fallback: re-derive from findings_validated.json.
    if canonical_verdict is None:
        try:
            with open(findings_validated_path) as f:
                findings_validated = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"Error reading findings_validated: {exc}", file=sys.stderr)
            return 1

        validated: list[dict[str, Any]] = findings_validated.get("validated", [])
        # Split coverage findings out (mirrors finalize-result's bucketing).
        # Partition by index so we avoid dict-equality membership tests —
        # canonical finding ids would also work but findings on this path
        # may lack them.
        coverage_indices: set[int] = {
            i for i, f in enumerate(validated)
            if str(f.get("category", "")) == "Coverage"
            and (f.get("finding_scope") or "diff") == "system"
        }
        coverage_gaps = [f for i, f in enumerate(validated) if i in coverage_indices]
        verified = [f for i, f in enumerate(validated) if i not in coverage_indices]
        # PLN-721: cmd_verdict fallback path. Use the same operator-
        # overridable thresholds as cmd_finalize_result so the gate
        # behaves consistently across both entry points.
        thresholds_arg = getattr(args, "thresholds", None)
        thresholds_path = (
            Path(thresholds_arg) if thresholds_arg
            else _VERDICT_THRESHOLDS_DEFAULT_PATH
        )
        thresholds = _load_verdict_thresholds(thresholds_path)
        canonical_verdict, reason = _compute_canonical_verdict(
            verified, coverage_gaps, thresholds=thresholds,
        )

    legacy_verdict = _CANONICAL_TO_LEGACY_VERDICT.get(canonical_verdict, "approve")

    json.dump(
        {
            "verdict": legacy_verdict,
            "canonical_verdict": canonical_verdict,
            "reason": reason,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: prepare-run (PLN-719 Phase 4)
# ---------------------------------------------------------------------------


# Stages config: declarative pipeline lives in config/stages.json.
# The loader below substitutes template variables ({cr_dir}, {mode}, etc.)
# and resolves the @pr_flag splat marker into ["--pr-number", "<n>"] or [].
# Angle-bracket tokens (<PLUGIN_ROOT>, <DIFF_SCOPE>, <CACHE_DIR>, etc.) are
# pass-through — the walker resolves them at dispatch time from earlier
# stage outputs (scope.json, setup.json, hashes.json, etc.).
_STAGES_CONFIG_PATH = Path(__file__).parent / "config" / "stages.json"

# Known template keys substituted by ``_build_run_plan_stages``. Any other
# ``{...}`` brace pattern in stages.json is rejected at load time — a literal
# ``{`` or ``}`` accidentally introduced by a future editor would otherwise
# raise an opaque ``KeyError``/``ValueError`` from ``str.format`` deep inside
# the loader instead of a clear "this stage's args contains a bad template"
# diagnostic at config-load.
_STAGES_TEMPLATE_KEYS: frozenset[str] = frozenset({
    "cr_dir",
    "mode",
    "schema_version",
    "flags_scope_args",
    "flags_base_ref_override",
    "flags_full_review",
    "flags_since_last_review",
    "depth",
})

# Valid arg splat markers (resolved separately from template substitution).
_STAGES_SPLAT_MARKERS: frozenset[str] = frozenset({"@pr_flag"})

# Valid ``min_depth`` / ``max_depth`` values on stages.json entries. Each
# stage declares the tier band at which it runs; the run-plan builder
# filters by ``min_depth <= invocation_tier <= max_depth``. Most stages
# only need ``min_depth`` (and inherit the default ``max_depth = "deep"``),
# but a stage that REPLACES another at a lower tier (e.g.
# ``stage_19c_derive_static_spec`` replaces ``stage_19b_derive_spawn_spec``
# in shallow) sets both bounds to scope its activation tightly.
# ``min_depth`` default ``"standard"`` keeps untagged new stages out of
# shallow; ``max_depth`` default ``"deep"`` keeps them running through
# the highest tier.
_VALID_MIN_DEPTHS: frozenset[str] = frozenset({"shallow", "standard", "deep"})
_DEPTH_RANK: dict[str, int] = {"shallow": 1, "standard": 2, "deep": 3}
_DEFAULT_MIN_DEPTH: str = "standard"
_DEFAULT_MAX_DEPTH: str = "deep"
_DEFAULT_INVOCATION_DEPTH: str = "standard"

# Single brace-or-key matcher: every ``{`` and every ``}`` MUST be part of a
# ``{identifier}`` pair, and the identifier MUST be in _STAGES_TEMPLATE_KEYS.
_TEMPLATE_KEY_RE = re.compile(r"\{([^{}]*)\}")


def _validate_template_string(value: str, where: str) -> None:
    """Reject stages.json strings whose braces aren't a known ``{key}`` pattern.

    Called per arg/expected_output/stdout at load time. ``where`` is the human-
    readable origin (e.g. ``"stage_03_resolve_scope.args[5]"``) and surfaces in
    the error so an editor can find and fix the bad template fast.
    """
    if value.count("{") != value.count("}"):
        raise ValueError(
            f"stages.json {where}: unbalanced braces in template string "
            f"{value!r} (every '{{' must close with a '}}')",
        )
    for match in _TEMPLATE_KEY_RE.finditer(value):
        key = match.group(1)
        if key not in _STAGES_TEMPLATE_KEYS:
            raise ValueError(
                f"stages.json {where}: unknown template key {{{key}}} in "
                f"{value!r}; known keys: {sorted(_STAGES_TEMPLATE_KEYS)}",
            )


def _validate_stages_config(config: dict[str, Any]) -> None:
    """Validate every templatable string and tier marker in stages.json once at load time."""
    for stage in config.get("stages", []):
        sid = stage.get("id", "<unknown>")
        for i, arg in enumerate(stage.get("args", []) or []):
            if not isinstance(arg, str):
                continue
            if arg in _STAGES_SPLAT_MARKERS:
                continue
            _validate_template_string(arg, f"{sid}.args[{i}]")
        for i, out in enumerate(stage.get("expected_outputs", []) or []):
            if isinstance(out, str):
                _validate_template_string(out, f"{sid}.expected_outputs[{i}]")
        stdout = stage.get("stdout")
        if isinstance(stdout, str):
            _validate_template_string(stdout, f"{sid}.stdout")
        # ``min_depth`` is REQUIRED on every stage entry — every existing
        # stage was explicitly tagged in PLN-807 Phase 1, and the
        # test_every_stage_has_explicit_min_depth invariant requires it
        # at fixture-load. Enforcing the same constraint here means a
        # new stage added to stages.json without a tier tag fails loud
        # at config-load instead of silently inheriting the implicit
        # ``standard`` default. ``max_depth`` stays optional (most
        # stages run through to deep). The band constraint enforced at
        # load time is ``min_depth <= max_depth`` (catches swapped
        # values like ``min=deep, max=shallow``).
        if "min_depth" not in stage:
            raise ValueError(
                f"stages.json {sid}: missing required ``min_depth`` field; "
                f"tag as one of {sorted(_VALID_MIN_DEPTHS)}",
            )
        for field in ("min_depth", "max_depth"):
            if field in stage:
                val = stage[field]
                if val not in _VALID_MIN_DEPTHS:
                    raise ValueError(
                        f"stages.json {sid}.{field}: invalid tier {val!r}; "
                        f"must be one of {sorted(_VALID_MIN_DEPTHS)}",
                    )
        lo = stage["min_depth"]
        hi = stage.get("max_depth", _DEFAULT_MAX_DEPTH)
        if _DEPTH_RANK[lo] > _DEPTH_RANK[hi]:
            raise ValueError(
                f"stages.json {sid}: min_depth={lo!r} > max_depth={hi!r}",
            )


def _filter_stages_by_depth(
    stages: list[dict[str, Any]], invocation_tier: str,
) -> list[dict[str, Any]]:
    """Return only stages whose tier band brackets ``invocation_tier``.

    Tier ranking: ``shallow < standard < deep``. A stage runs iff
    ``min_depth <= invocation_tier <= max_depth``. ``min_depth`` defaults
    to ``"standard"`` (a new stage stays out of shallow until explicitly
    opted in); ``max_depth`` defaults to ``"deep"`` (a new stage runs at
    the highest tier by default).

    Most stages only need ``min_depth``. A stage that REPLACES another
    at a lower tier — e.g. ``stage_19c_derive_static_spec`` replacing
    ``stage_19b_derive_spawn_spec`` in shallow — pins both bounds so
    only one of the alternatives runs per invocation.
    """
    tier_rank = _DEPTH_RANK[invocation_tier]
    return [
        s for s in stages
        if (
            _DEPTH_RANK.get(s.get("min_depth", _DEFAULT_MIN_DEPTH), 2) <= tier_rank
            and tier_rank <= _DEPTH_RANK.get(s.get("max_depth", _DEFAULT_MAX_DEPTH), 3)
        )
    ]


def _filter_validation_gates_by_stages(
    gates: list[dict[str, Any]], stage_ids: set[str],
) -> list[dict[str, Any]]:
    """Drop validation gates whose ``after_stage`` anchor isn't in the run plan.

    When shallow filters out ``stage_16_arbitrate_budget``, the gate
    anchored on that stage has nothing to fire after — left in place it
    would fail-closed on ``missing section-bearing file`` because
    ``coverage.json.final`` is never written. Filtering the gate out
    instead is the correct behavior: the stage didn't run, so its
    post-condition has no meaning.
    """
    return [g for g in gates if g.get("after_stage") in stage_ids]


@functools.lru_cache(maxsize=1)
def _load_stages_config() -> dict[str, Any]:
    """Load, validate, and cache the declarative stage definitions."""
    config = json.loads(_STAGES_CONFIG_PATH.read_text())
    _validate_stages_config(config)
    return config


def _build_run_plan_stages(
    cr_dir: str,
    mode: str,
    pr_number: int | None,
    flags: dict[str, Any],
    depth: str = _DEFAULT_INVOCATION_DEPTH,
) -> list[dict[str, Any]]:
    """Return the canonical pipeline by loading config/stages.json and substituting runtime values.

    Template variables resolved here:
      {cr_dir}                    -- session CR_DIR
      {mode}                      -- "local" | "github"
      {schema_version}            -- str(SCHEMA_VERSION) from code_review_schema
      {flags_scope_args}          -- flags["scope_args"] or ""
      {flags_base_ref_override}   -- flags["base_ref_override"] or ""
      {flags_full_review}         -- "true" | "false"
      {flags_since_last_review}   -- "true" | "false"

    Special arg marker resolved here:
      @pr_flag                    -- splat: ["--pr-number", str(pr_number)] when pr_number is truthy, else []
                                    (argparse rejects ``--pr-number ""`` because the flag is type=int,
                                     so the flag must be omitted entirely when no PR is active.)

    Angle-bracket tokens like <CACHE_DIR>, <DIFF_TIP> stay as literal strings — they're resolved
    by the walker at dispatch time from prior-stage outputs.
    """
    ctx = {
        "cr_dir": cr_dir,
        "mode": mode,
        "schema_version": str(SCHEMA_VERSION),
        "flags_scope_args": flags.get("scope_args", "") or "",
        "flags_base_ref_override": flags.get("base_ref_override", "") or "",
        "flags_full_review": "true" if flags.get("full_review") else "false",
        "flags_since_last_review": "true" if flags.get("since_last_review") else "false",
        "depth": depth,
    }
    # argparse declares --pr-number as type=int, which rejects empty strings.
    # When no PR is active, omit the flag entirely so argparse defaults (None) apply.
    pr_flag: list[str] = ["--pr-number", str(pr_number)] if pr_number else []

    def resolve_args(template_args: list[str]) -> list[str]:
        out: list[str] = []
        for arg in template_args:
            if arg == "@pr_flag":
                out.extend(pr_flag)
            else:
                out.append(arg.format(**ctx))
        return out

    raw_stages = _filter_stages_by_depth(_load_stages_config()["stages"], depth)
    surviving_ids = {s["id"] for s in raw_stages}
    out_stages: list[dict[str, Any]] = []
    for template in raw_stages:
        # Deep-copy: _load_stages_config is lru_cached, so its returned dict's
        # nested lists (depends_on, agent_specs, expected_outputs) are shared
        # across every call. A shallow ``dict(template)`` would leave callers
        # one ``.append()`` away from corrupting the cache for the rest of
        # the process — a regression vs the pre-refactor code that always
        # built fresh list literals.
        stage = copy.deepcopy(template)
        if "args" in stage and isinstance(stage["args"], list):
            stage["args"] = resolve_args(stage["args"])
        if "expected_outputs" in stage and isinstance(stage["expected_outputs"], list):
            stage["expected_outputs"] = [p.format(**ctx) for p in stage["expected_outputs"]]
        if isinstance(stage.get("stdout"), str):
            stage["stdout"] = stage["stdout"].format(**ctx)
        # Drop dangling depends_on entries — a stage referencing a
        # tier-filtered predecessor must not surface that reference to
        # the orchestrator. ``stage_20_spawn_reviewers`` for example
        # depends on both ``stage_19b_derive_spawn_spec`` and
        # ``stage_19c_derive_static_spec``; only one survives the filter
        # per invocation, and the other would otherwise look like an
        # unknown-stage reference to depends-on consistency checks.
        if "depends_on" in stage and isinstance(stage["depends_on"], list):
            stage["depends_on"] = [
                d for d in stage["depends_on"] if d in surviving_ids
            ]
        out_stages.append(stage)
    return out_stages


def _build_validation_gates(cr_dir: str) -> list[dict[str, Any]]:
    """Return canonical inter-stage validation gates.

    The ``outputs`` field lists files that must exist after the gate's
    anchor stage. The optional ``required_sections`` field maps a file
    path to a list of top-level dict keys that must be present in that
    file — the gate enforcer must check each section, not just file
    existence. ``coverage.json`` exists from ``stage_14`` onward
    (sections accumulate), so a bare file-existence check after
    ``stage_16`` would fire-true even if stages 15/15b/15c/16 failed to
    populate their sections. ``required_sections`` distinguishes "any
    coverage state on disk" from "post-arbitrate ``final`` plan present."
    """
    return [
        {
            "after_stage": "stage_05_parse_diff",
            "gate": "expected_outputs_present",
            "outputs": [f"{cr_dir}/diff_data.json"],
            "on_failure_action": "abort",
        },
        {
            "after_stage": "stage_16_arbitrate_budget",
            "gate": "coverage_plan_well_formed",
            "outputs": [f"{cr_dir}/coverage.json"],
            "required_sections": {
                f"{cr_dir}/coverage.json": ["final"],
            },
            "on_failure_action": "abort",
        },
        {
            "after_stage": "stage_20_spawn_reviewers",
            "gate": "all_required_outputs_present",
            "outputs": [f"{cr_dir}/agent_*.json"],
            "on_failure_action": "emit_coverage_gap",
        },
        {
            "after_stage": "stage_22_validate",
            "gate": "validated_output_well_formed",
            "outputs": [f"{cr_dir}/findings_validated.json"],
            "on_failure_action": "abort",
        },
        {
            "after_stage": "stage_25_finalize_result",
            "gate": "review_result_well_formed",
            "outputs": [f"{cr_dir}/review_result.json"],
            "on_failure_action": "abort",
        },
    ]


def evaluate_validation_gate(
    gate: dict[str, Any],
) -> tuple[bool, str | None]:
    """Evaluate a single validation gate against the filesystem.

    Returns ``(passed, reason)``. ``passed`` is True only when:

    1. Every literal-path entry in ``outputs`` exists as a regular file.
    2. Every file listed in ``required_sections`` exists, parses as
       JSON, and is a top-level JSON object.
    3. Every section key listed for a file is present in that file's
       top-level object AND its value is itself a JSON object (dict).

    The dict-value check at (3) catches the corrupt-atomic-write
    scenario where a section key is written as ``null`` mid-replace;
    a downstream consumer expecting ``state[key]`` to be a dict would
    crash on attribute access. The walker MUST treat a section whose
    value is null/scalar/list as a gate failure, not a pass.

    ``reason`` is None on pass, a short diagnostic on fail (suitable
    for the walker to surface to the operator via stderr).

    Glob entries in ``outputs`` (e.g. ``agent_*.json``) are intentionally
    NOT expanded here — the walker's existing ``all_required_outputs_present``
    semantics handle those separately. This helper enforces literal-path
    outputs plus the section-presence contract.

    Defensive: ``required_sections[file]`` MUST be a list of strings.
    A bare string here would silently iterate per-character ("final"
    → ['f','i','n','a','l']) and produce misleading "missing required
    section 'f'" failures. The type guard surfaces the configuration
    bug at the gate boundary instead.
    """
    for path_str in gate.get("outputs", []):
        if "*" in path_str or "?" in path_str:
            continue
        if not Path(path_str).is_file():
            return False, f"missing output: {path_str}"

    required_sections = gate.get("required_sections") or {}
    for path_str, section_keys in required_sections.items():
        if not isinstance(section_keys, list):
            return False, (
                f"gate required_sections[{path_str!r}] must be a list, "
                f"got {type(section_keys).__name__}"
            )
        path = Path(path_str)
        if not path.is_file():
            return False, f"missing section-bearing file: {path_str}"
        try:
            with open(path) as f:
                state = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            return False, f"unreadable section-bearing file {path_str}: {exc}"
        if not isinstance(state, dict):
            return False, f"section-bearing file {path_str} is not a JSON object"
        for key in section_keys:
            if key not in state:
                return False, f"{path_str} missing required section {key!r}"
            if not isinstance(state[key], dict):
                return False, (
                    f"{path_str} section {key!r} is not a JSON object "
                    f"(got {type(state[key]).__name__})"
                )

    return True, None


def cmd_evaluate_gate(args: argparse.Namespace) -> int:
    """Evaluate the validation gate anchored at ``--after-stage``.

    CLI wrapper around ``evaluate_validation_gate``. The walker (the
    LLM following ``start.md`` step 7) shells out to this subcommand
    after each stage finishes, passing ``--cr-dir`` and the just-
    completed stage id as ``--after-stage``. The helper looks up the
    gate dict from the canonical ``_build_validation_gates`` table.
    The same table is the SOURCE that ``prepare-run`` writes into
    ``run_plan.json`` (after PLN-807 also filtering it to drop gates
    whose anchor stage is tier-filtered) — so a single source of truth
    governs both planning and enforcement. This helper consults the
    unfiltered table directly; if the walker calls it with an
    ``--after-stage`` whose gate was tier-filtered out of the run plan,
    the helper still evaluates that gate and either passes (anchor
    stage didn't write its output, but that's expected) or fails. The
    walker should not invoke this helper for tier-filtered stages —
    the run plan's ``validation_gates`` array is the authoritative
    list for any given invocation.

    Exit codes:
        0 — gate passed (no matching gate for this anchor is also pass:
            a stage with no declared gate is unconstrained).
        1 — gate failed; diagnostic on stderr.

    The walker reads exit code and applies the gate's
    ``on_failure_action`` (which the walker still has in scope from
    ``run_plan.json``). The helper itself does NOT consult
    ``on_failure_action`` — that's a walker-level policy decision so
    the same enforcer serves abort, continue, and emit_coverage_gap
    cases without branching.
    """
    cr_dir = str(args.cr_dir)
    after_stage = str(args.after_stage)
    gates = _build_validation_gates(cr_dir)
    matching = [g for g in gates if g.get("after_stage") == after_stage]
    if not matching:
        return 0
    for gate in matching:
        passed, reason = evaluate_validation_gate(gate)
        if not passed:
            print(
                f"gate {gate.get('gate', '?')!r} after {after_stage!r} FAILED: "
                f"{reason}",
                file=sys.stderr,
            )
            return 1
    return 0


def cmd_prepare_run(args: argparse.Namespace) -> int:
    """Emit ``run_plan.json`` describing the full review pipeline.

    PLN-719 Section 6. The output is consumed by the ``/start`` orchestrator,
    which walks the plan stage-by-stage (Phase 4b).

    Determinism: same inputs produce byte-identical output **except for the
    ``review_id`` field**, which is a fresh ``uuid.uuid4()`` per invocation.
    Compare via a JSON pop of ``review_id`` before diffing or hashing —
    every other field, including the entire ``stages`` and
    ``validation_gates`` arrays, is deterministic.
    """
    cr_dir = args.cr_dir
    mode = args.mode

    # Coerce string-bool flags into actual bools.
    def _flag(name: str) -> bool:
        val = getattr(args, name, None)
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.strip().lower() in ("true", "1", "yes")
        return False

    depth = (getattr(args, "depth", None) or _DEFAULT_INVOCATION_DEPTH).lower()
    ok, err = _validate_invocation_depth(depth)
    if not ok:
        print(err, file=sys.stderr)
        return 1

    flags = {
        "hygiene_only": _flag("hygiene_only"),
        "since_last_review": _flag("since_last_review"),
        "full_review": _flag("full_review"),
        "base_ref_override": args.base_ref_override or "",
        "scope_args": args.scope_args or "",
        "pr_number": args.pr_number,
        "depth": depth,
    }

    stages = _build_run_plan_stages(cr_dir, mode, args.pr_number, flags, depth)
    stage_ids = {s["id"] for s in stages}
    gates = _filter_validation_gates_by_stages(
        _build_validation_gates(cr_dir), stage_ids,
    )

    run_plan: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "review_id": str(uuid.uuid4()),
        "cr_dir": cr_dir,
        "mode": mode,
        "depth": depth,
        "flags": flags,
        "scope": {},  # populated by stage_03_resolve_scope at runtime
        "stages": stages,
        "validation_gates": gates,
        "telemetry": {
            "expected_total_duration_ms": 0,
            "estimated_cost_usd": 0.0,
        },
    }

    output_path = Path(args.output) if args.output else Path(cr_dir) / "run_plan.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(run_plan, f, indent=2)

    json.dump(
        {
            "run_plan": str(output_path),
            "stage_count": len(run_plan["stages"]),
            "enabled_stage_count": sum(1 for s in run_plan["stages"] if s["enabled"]),
            "review_id": run_plan["review_id"],
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: arbitrate-budget (PLN-719 Phase 3)
# ---------------------------------------------------------------------------

# Hard cap on total agent fleet size (foundation Section 5).
BUDGET_TOTAL_CAP_DEFAULT = 20
BUDGET_BHA_FLOOR_DEFAULT = 1

# PLN-807: per-source cap on domain critic entries (rule + critic origin
# combined). Independent of the total-fleet cap. Bounds critic-roster
# growth so BHA's coverage budget can't be eaten by a long
# ``critic-gates.json``. Hardcoded for now; if operators ask for
# configurability later, expose via ``.closedloop-ai/settings/code-review.json``.
DOMAIN_CRITIC_CAP = 5

# PLN-807: critic-cap defer reason marker. Differentiates entries
# deferred by the per-source cap from entries deferred by the total
# cap (which carry no explicit reason — that's the historical default).
_DEFER_REASON_DOMAIN_CRITIC_CAP = "domain_critic_cap"


def _validate_invocation_depth(depth: str | None) -> tuple[bool, str | None]:
    """Validate an optional ``--depth`` argument against the canonical tier set.

    Returns ``(ok, error_msg)``. ``ok`` is True when ``depth`` is None
    (no filter) or matches one of ``_VALID_MIN_DEPTHS``. ``error_msg``
    is the rendered diagnostic ready for ``print(... file=sys.stderr)``
    when ``ok`` is False. Centralizes the validation block that
    otherwise duplicates across every cmd_* that accepts ``--depth``
    (cmd_hygiene, cmd_prepare_run, cmd_review_state_read/write,
    cmd_auto_incremental).
    """
    if depth is None:
        return True, None
    if depth in _VALID_MIN_DEPTHS:
        return True, None
    return False, (
        f"Error: --depth must be one of {sorted(_VALID_MIN_DEPTHS)}, "
        f"got {depth!r}"
    )


def _annotate_defer_reason(
    entries: list[dict[str, Any]], reason: str,
) -> list[dict[str, Any]]:
    """Return shallow-copies of ``entries`` with ``defer_reason`` set.

    Used by the budget arithmetic to distinguish cap-deferred from
    budget-deferred entries in ``deferred_for_budget``. Operators reading
    the coverage plan see the reason on each entry; a missing
    ``defer_reason`` means "deferred by total cap" (the historical
    default — kept for backward compat with pre-PLN-807 readers).
    """
    out: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        annotated = dict(entry)
        annotated["defer_reason"] = reason
        out.append(annotated)
    return out


def _is_critic_entry(entry: dict[str, Any]) -> bool:
    """A plan entry counts as a domain critic when its ``source`` is one of
    the operator-facing critic origins. ``rule`` = deterministically matched
    from ``critic-gates.json``'s ``coverage[]`` (including migrated
    ``moduleCritics[]`` entries); ``critic`` = LLM-proposed by
    ``coverage_critic_consolidate``. Both are subject to ``DOMAIN_CRITIC_CAP``.
    Core entries (``source: "core"``) are never capped — BHB, auditor,
    premise are operator-implicit baseline reviewers.
    """
    if not isinstance(entry, dict):
        return False
    return entry.get("source") in {"rule", "critic"}


def _select_domain_critics(
    required_critics: list[dict[str, Any]],
    best_effort_critics: list[dict[str, Any]],
    cap: int,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    """Apply ``DOMAIN_CRITIC_CAP`` to critic entries across both buckets.

    Selection order: required critics by ``(priority asc, reviewer asc)``,
    then best-effort critics by the same key fill remainder. The
    alphabetical secondary sort is cache-friendly — the same plan with
    edits elsewhere in ``critic-gates.json`` produces the same selection
    even when entries shift declaration position.

    Returns ``(selected_required, selected_best_effort, deferred_required,
    deferred_best_effort)``. Cap-deferred entries from EITHER bucket
    land in ``deferred_for_budget`` with
    ``defer_reason: "domain_critic_cap"``; the caller does NOT emit
    coverage-gap findings for cap-deferred required critics (doing so
    would trip ``_compute_canonical_verdict`` Rule 1 on any repo whose
    ``critic-gates.json`` resolves more than ``cap`` required domain
    critics).
    """
    def sort_key(e: dict[str, Any]) -> tuple[int, str]:
        try:
            priority = int(e.get("priority", 2))
        except (TypeError, ValueError):
            priority = 2
        return (priority, str(e.get("reviewer", "") or ""))

    req_sorted = sorted(required_critics, key=sort_key)
    be_sorted = sorted(best_effort_critics, key=sort_key)

    if cap <= 0:
        return [], [], list(req_sorted), list(be_sorted)
    if len(req_sorted) >= cap:
        return req_sorted[:cap], [], req_sorted[cap:], list(be_sorted)

    remaining = cap - len(req_sorted)
    return (
        list(req_sorted),
        be_sorted[:remaining],
        [],
        be_sorted[remaining:],
    )


def _is_docs_only(diff_data: dict[str, Any]) -> bool:
    """Return True when every file in the diff has a docs/markdown extension."""
    files = diff_data.get("files_to_review") or []
    if not files:
        return False
    return all(_is_skip_ext(f) for f in files)


def _max_bha_partitions_by_loc(diff_data: dict[str, Any]) -> int:
    """Cap BHA partitions by changed-LOC budget (mirrors partition heuristics)."""
    total_loc = int(diff_data.get("total_loc") or 0)
    if total_loc <= 0:
        return 1
    by_budget = max(1, (total_loc + REBALANCE_LOC_BUDGET - 1) // REBALANCE_LOC_BUDGET)
    return min(by_budget, DEFAULT_MAX_BHA_AGENTS)


def _make_coverage_gap_finding(
    reviewer_entry: dict[str, Any],
    *,
    reason: str,
    index: int,
    emitted_at: str,
) -> dict[str, Any]:
    """Build a canonical system-scoped coverage-gap finding for a dropped reviewer."""
    reviewer_name = str(reviewer_entry.get("reviewer") or reviewer_entry.get("name") or "unknown")
    marker = (
        "budget-exceeded"
        if reason == "budget_exceeded"
        else f"coverage:{reviewer_name}"
    )
    return normalize_legacy_finding(
        {
            "id": make_finding_id("coverage-verifier", index),
            "reviewer": "coverage-verifier",
            "source": "coverage-verifier",
            "schema_version": SCHEMA_VERSION,
            "finding_scope": "system",
            "file": None,
            "line": None,
            "system_marker": marker,
            "category": "Coverage",
            "severity": "HIGH",
            "priority": 1,
            "confidence": 1.0,
            "issue": f"Required reviewer dropped: {reviewer_name}",
            "explanation": (
                f"The required reviewer {reviewer_name!r} was dropped because "
                f"{reason.replace('_', ' ')} (cap reached). The PR is blocked "
                "until this reviewer can run."
            ),
            "recommendation": (
                "Raise --cap, reduce the number of required reviewers, or "
                "narrow the diff scope so the required reviewer can fit."
            ),
            "code_snippet": "",
            "required": True,
        },
        reviewer="coverage-verifier",
        source="coverage-verifier",
        index=index,
        emitted_at=emitted_at,
    )


def _normalize_coverage_verify_doc(doc: Any) -> tuple[str | None, list[dict[str, str]]]:
    """Coerce a parsed coverage-verify section/file into ``(verdict, violations)``.

    Tolerates a non-dict input (returns ``(None, [])`` so callers treat it
    as PASS — verifier is observational). Shared by the explicit-path
    reader and the canonical section reader so the shape handling lives
    in one place.
    """
    if not isinstance(doc, dict):
        return None, []
    verdict = doc.get("verdict")
    if not isinstance(verdict, str):
        return None, []
    violations = doc.get("violations", [])
    if not isinstance(violations, list):
        violations = []
    typed_violations: list[dict[str, str]] = []
    for v in violations:
        if isinstance(v, dict):
            typed_violations.append({
                "check": str(v.get("check", "")),
                "message": str(v.get("message", "")),
            })
    return verdict, typed_violations


def cmd_arbitrate_budget(args: argparse.Namespace) -> int:
    """Apply budget arbitration to a coverage plan (PLN-719 Section 5).

    Reads the post-consolidate plan from ``coverage.json``'s ``.final``
    section, applies the budget cap, and writes the arbitrated plan
    back into the same ``.final`` section. Emits coverage-gap findings
    for required reviewers that exceed the cap.

    When the verifier's verdict in ``coverage.json.verify`` is
    ``"BLOCKING"``, arbitration short-circuits. The input plan is
    written through to ``coverage.json.final`` as-is (preserving the
    rule floor — no cap, no pruning, no dropped required) with
    ``budget.gated_by_verify: true`` so downstream consumers can see
    why the cap wasn't applied. The same shape is written — including
    ``deferred_for_budget``, ``dropped_required``, and ``budget`` keys
    — so finalize-result and stage_20 readers don't need to branch on a
    different schema. The BLOCKING finding is already emitted by
    ``stage_15c_verify_coverage`` (``agent_coverage-verify-blocking
    .json``); arbitrate-budget does not duplicate it. A missing verify
    section (verifier didn't run, or upstream stage aborted) is treated
    as PASS — the verifier is observational, an absent artifact must
    not block arbitration.
    """
    cr_dir = Path(args.cr_dir)

    coverage_plan_in = _read_coverage_state(cr_dir).get("final")
    if not isinstance(coverage_plan_in, dict):
        print(
            "Error: coverage.json.final not found or malformed",
            file=sys.stderr,
        )
        return 1

    diff_data = _read_optional_json(Path(args.diff_data), {}) or {}
    cap: int = int(args.cap)
    if cap <= 0:
        print(f"Error: --cap must be > 0, got {cap}", file=sys.stderr)
        return 1

    def _persist_plan(plan: dict[str, Any]) -> int:
        try:
            _write_coverage_section(cr_dir, "final", plan)
        except OSError as exc:
            print(f"Error writing coverage.json.final: {exc}", file=sys.stderr)
            return 1
        return 0

    def _gaps_target(findings: list[dict[str, Any]]) -> tuple[int, Path]:
        # coverage_gaps.json stays standalone (multi-writer).
        gaps_path = cr_dir / "coverage_gaps.json"
        try:
            with open(gaps_path, "w") as f:
                json.dump({"findings": findings}, f, indent=2)
        except OSError as exc:
            print(f"Error writing coverage_gaps: {exc}", file=sys.stderr)
            return 1, gaps_path
        return 0, gaps_path

    def _plan_target_str() -> str:
        return str(cr_dir / _COVERAGE_STATE_FILENAME)

    required: list[dict[str, Any]] = list(coverage_plan_in.get("required", []) or [])
    best_effort: list[dict[str, Any]] = list(coverage_plan_in.get("best_effort", []) or [])
    deprecation_warnings: list[str] = list(coverage_plan_in.get("deprecation_warnings", []) or [])

    # PLN-807 Phase 4: separate critic entries (source: rule|critic)
    # from non-critic entries in both buckets so the cap and the
    # BHA-first allocation can target critics independently of core
    # reviewers (BHB, auditor, premise, BHA-as-entry, etc.).
    required_critics_in = [e for e in required if _is_critic_entry(e)]
    required_non_critic = [e for e in required if not _is_critic_entry(e)]
    best_effort_critics_in = [e for e in best_effort if _is_critic_entry(e)]
    best_effort_non_critic = [e for e in best_effort if not _is_critic_entry(e)]

    # PLN-725 Phase 7 BLOCKING gate. Short-circuit BEFORE any budget
    # arithmetic so the input plan flows through untouched on a
    # BLOCKING verdict. Note: the verifier itself stays observational
    # (exit 0 on BLOCKING) — arbitrate-budget is where the verdict
    # first translates into pipeline behavior change.
    verdict, violations = _normalize_coverage_verify_doc(
        _read_coverage_state(cr_dir).get("verify"),
    )
    now_iso_gate = datetime.now(timezone.utc).isoformat()
    if verdict == "BLOCKING":
        # Apply the critic cap on the BLOCKING path too (PLN-807),
        # preserving the "no required drops on BLOCKING" semantics:
        # required critics in excess of the cap land in
        # ``deferred_for_budget`` (not ``dropped_required``), marked
        # with ``defer_reason: "domain_critic_cap"``.
        sel_req_critics, sel_be_critics, def_req_critics, def_be_critics = (
            _select_domain_critics(
                required_critics_in, best_effort_critics_in,
                DOMAIN_CRITIC_CAP,
            )
        )
        required_blocking = required_non_critic + sel_req_critics
        best_effort_blocking = sel_be_critics + best_effort_non_critic
        deferred_blocking = _annotate_defer_reason(
            def_req_critics + def_be_critics,
            _DEFER_REASON_DOMAIN_CRITIC_CAP,
        )
        # BHA is source: "core" and survives derive-spawn-spec's
        # gated_by_verify plan sanitization (rule/critic entries are
        # moved to skipped[], core is preserved). PLN-807 Phase 4
        # aligned this with the PASS path's BHA-first allocation:
        # compute the LOC-derived target up front rather than from
        # leftover capacity, so a BLOCKING verdict on a critic-heavy
        # plan does not crush BHA to its floor=1 the same way the
        # pre-PLN-807 PASS path did. Docs-only PRs still get 0.
        if _is_docs_only(diff_data):
            blocking_bha_partitions = 0
        else:
            blocking_bha_partitions = max(
                BUDGET_BHA_FLOOR_DEFAULT,
                _max_bha_partitions_by_loc(diff_data),
            )
        final_plan: dict[str, Any] = {
            "required": required_blocking,
            "best_effort": best_effort_blocking,
            "deferred_for_budget": deferred_blocking,
            "deprecation_warnings": deprecation_warnings,
            "budget": {
                "total_cap": cap,
                "required_count": len(required_blocking),
                "best_effort_count": len(best_effort_blocking),
                "bha_partitions": blocking_bha_partitions,
                "domain_critic_cap": DOMAIN_CRITIC_CAP,
                "domain_critic_cap_fired": bool(def_req_critics or def_be_critics),
                "gated_by_verify": True,
                "verify_violations": violations,
            },
            "dropped_required": [],
            "arbitrate_status": "blocked_by_verify",
            "generated_at": now_iso_gate,
        }
        rc = _persist_plan(final_plan)
        if rc != 0:
            return rc
        # Empty findings; the canonical BLOCKING finding is already
        # in agent_coverage-verify-blocking.json from stage_15c. The
        # required critics deferred by the cap do NOT emit coverage
        # gaps on the BLOCKING branch because the canonical BLOCKING
        # finding already signals that arbitration is bypassed.
        rc, gaps_path = _gaps_target([])
        if rc != 0:
            return rc
        json.dump(
            {
                "status": "blocked_by_verify",
                "coverage_plan": _plan_target_str(),
                "coverage_gaps": str(gaps_path),
                "required_count": len(required_blocking),
                "best_effort_count": len(best_effort_blocking),
                "verify_violation_count": len(violations),
            },
            sys.stdout,
            indent=2,
        )
        sys.stdout.write("\n")
        return 0

    bha_floor = 0 if _is_docs_only(diff_data) else BUDGET_BHA_FLOOR_DEFAULT
    max_bha = _max_bha_partitions_by_loc(diff_data)

    now_iso = datetime.now(timezone.utc).isoformat()
    coverage_gaps: list[dict[str, Any]] = []
    dropped_required: list[dict[str, Any]] = []

    # PLN-807 Phase 4 Step 1: compute the BHA partition target FIRST so
    # the bug-finding budget is reserved before any critic allocation.
    # Pre-PLN-807 the order was reversed: critics consumed cap first
    # and BHA picked up the leftover (which crushed BHA to its floor=1
    # on critic-heavy reviews). With BHA reserved up front, a
    # ``critic-gates.json`` with 17 triggers no longer eats BHA's
    # coverage budget. ``_max_bha_partitions_by_loc`` already caps at
    # ``DEFAULT_MAX_BHA_AGENTS`` internally, so no second min() is
    # needed.
    if _is_docs_only(diff_data):
        bha_target = 0
    else:
        bha_target = max(bha_floor, max_bha)

    # PLN-807 Phase 4 Step 2: apply DOMAIN_CRITIC_CAP across BOTH buckets.
    # Required critics get priority over best-effort, sorted within
    # bucket by (priority asc, reviewer name asc). Cap-deferred entries
    # — from EITHER bucket — land in ``deferred_for_budget`` with
    # ``defer_reason: "domain_critic_cap"`` and DO NOT emit coverage-gap
    # findings. The cap is a hardcoded per-source soft limit (5),
    # independent of ``--cap``; surfacing required cap drops via
    # coverage gaps would trip ``_compute_canonical_verdict`` Rule 1
    # (any required gap → CHANGES_REQUESTED) and effectively block any
    # repo whose ``critic-gates.json`` resolves more than 5 required
    # domain critics on a single PR. The BLOCKING branch already does
    # the right thing (deferred, no gap); this matches that behavior on
    # the PASS path.
    sel_req_critics, sel_be_critics, def_req_critics, def_be_critics = (
        _select_domain_critics(
            required_critics_in, best_effort_critics_in, DOMAIN_CRITIC_CAP,
        )
    )

    # PLN-807 Phase 4 Step 3: required overflow against the reduced
    # available_for_critics. Required-bucket critics already capped at
    # DOMAIN_CRITIC_CAP, so this branch normally doesn't fire — but it
    # remains the safety net for the cap=tiny edge case (a smaller
    # ``--cap`` override could leave less than required_non_critic +
    # bha_target slots). Drop selected critics FIRST, then non-critic
    # required (which includes core reviewers — operators shouldn't
    # lose BHB/auditor/premise to budget overflow before they lose a
    # non-essential critic).
    required = required_non_critic + sel_req_critics
    required_overflow = len(required) + bha_target - cap
    if required_overflow > 0:
        # Drop selected required critics first.
        drop_critics_n = min(required_overflow, len(sel_req_critics))
        if drop_critics_n:
            dropped_critics = sel_req_critics[-drop_critics_n:]
            sel_req_critics = sel_req_critics[:-drop_critics_n]
            for idx, entry in enumerate(
                dropped_critics, start=len(coverage_gaps),
            ):
                coverage_gaps.append(
                    _make_coverage_gap_finding(
                        entry,
                        reason="budget_exceeded",
                        index=idx,
                        emitted_at=now_iso,
                    ),
                )
            dropped_required.extend(dropped_critics)
            required_overflow -= drop_critics_n
        # If still over, drop non-critic required tail (rare).
        if required_overflow > 0:
            drop_core_n = min(required_overflow, len(required_non_critic))
            if drop_core_n:
                dropped_core = required_non_critic[-drop_core_n:]
                required_non_critic = required_non_critic[:-drop_core_n]
                for idx, entry in enumerate(
                    dropped_core, start=len(coverage_gaps),
                ):
                    coverage_gaps.append(
                        _make_coverage_gap_finding(
                            entry,
                            reason="budget_exceeded",
                            index=idx,
                            emitted_at=now_iso,
                        ),
                    )
                dropped_required.extend(dropped_core)
        required = required_non_critic + sel_req_critics

    # PLN-807 Phase 4 Step 4: best-effort prune against remaining cap.
    # Includes both surviving best-effort critics and best-effort
    # non-critic entries, sorted together by priority asc.
    best_effort_combined = sel_be_critics + best_effort_non_critic
    best_effort_sorted = sorted(
        best_effort_combined,
        key=lambda e: int(e.get("priority", 2)) if isinstance(e, dict) else 2,
    )
    remaining = max(0, cap - len(required) - bha_target)
    if len(best_effort_sorted) > remaining:
        deferred_by_budget = best_effort_sorted[remaining:]
        best_effort_final = best_effort_sorted[:remaining]
    else:
        deferred_by_budget = []
        best_effort_final = best_effort_sorted

    # Annotate cap-deferred entries so operators can tell which bucket
    # capacity rejected them. Both required-bucket and best-effort-bucket
    # cap drops surface here so the plan exposes the cap decision
    # completely (a downstream operator/telemetry reader can enumerate
    # everything the cap dropped without consulting another file).
    # Budget-deferred entries carry no ``defer_reason`` — that's the
    # historical default and the absence is the signal.
    deferred_cap_marked = _annotate_defer_reason(
        def_req_critics + def_be_critics, _DEFER_REASON_DOMAIN_CRITIC_CAP,
    )
    deferred_for_budget = deferred_cap_marked + deferred_by_budget

    bha_partitions = bha_target

    final_plan: dict[str, Any] = {
        "required": required,
        "best_effort": best_effort_final,
        "deferred_for_budget": deferred_for_budget,
        "deprecation_warnings": deprecation_warnings,
        "budget": {
            "total_cap": cap,
            "required_count": len(required),
            "best_effort_count": len(best_effort_final),
            "bha_partitions": bha_partitions,
            "domain_critic_cap": DOMAIN_CRITIC_CAP,
            "domain_critic_cap_fired": bool(def_req_critics or def_be_critics),
        },
        "dropped_required": dropped_required,
    }

    rc = _persist_plan(final_plan)
    if rc != 0:
        return rc
    rc, gaps_path = _gaps_target(coverage_gaps)
    if rc != 0:
        return rc

    json.dump(
        {
            "coverage_plan": _plan_target_str(),
            "coverage_gaps": str(gaps_path),
            "required_count": len(required),
            "best_effort_count": len(best_effort_final),
            "deferred_count": len(deferred_for_budget),
            "dropped_required_count": len(dropped_required),
            "bha_partitions": bha_partitions,
            "docs_only": _is_docs_only(diff_data),
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: derive-spawn-spec (PLN-725)
# ---------------------------------------------------------------------------
#
# Reads the post-arbitrate ``coverage.json.final`` + ``partitions.json``
# and the ``route`` section of ``spawn.json`` (written by Gate B's
# ``cmd_route --cr-dir``), then writes the flat list of agent
# descriptors into ``spawn.json`` under the ``spec`` section. The
# orchestrator (start.md "Reviewer Fleet" section) dispatches Task calls
# from that list — this closes the loop so the deterministic coverage
# signal (PLN-725) shapes the spawned fleet rather than walking a static
# hard-coded table.
#
# The spec is observational: the orchestrator may fall back to the static
# table if ``spawn.json`` is absent, its ``spec`` section is missing, or
# the section's ``arbitrate_status`` field is ``"fallback"`` — a derive
# failure must never break review.

# Canonical role → AGENT_ID + partitioning + patches-file mapping. The
# reviewer names on the left are the SPAWNABLE subset of
# ``COVERAGE_CORE_REQUIRED`` (snake_case identifiers carried in the
# final plan); the deferred subset lives in ``_SPAWN_DEFERRED_ROLES``
# below. The two dicts together must cover every entry in
# ``COVERAGE_CORE_REQUIRED`` — adding a new core role means choosing
# which dict it belongs in. The AGENT_ID strings on the right are the
# display IDs used in agent_*.json filenames (matching the static
# table in start.md).
_SPAWN_CORE_ROLES: dict[str, dict[str, Any]] = {
    "bug_hunter_a": {
        "agent_id_prefix": "bha_p",
        "partitioned": True,
        "patches_template": "patches_p{partition_id}.txt",
    },
    "bug_hunter_b": {
        "agent_id": "bhb",
        "partitioned": False,
        "patches_template": "patches_all.txt",
    },
    "unified_auditor": {
        "agent_id": "auditor",
        "partitioned": False,
        "patches_template": "patches_all.txt",
    },
    "premise_reviewer": {
        "agent_id": "premise",
        "partitioned": False,
        "patches_template": "patches_all.txt",
    },
}

# Roles that are reserved in the coverage plan but not yet spawnable. The
# spawn-spec records them in ``skipped[]`` so the absence is visible to
# operators reading the artifact (vs. silently dropping the entry, which
# masks rollout state).
_SPAWN_DEFERRED_ROLES: dict[str, str] = {
    "test_quality": "deferred_pln723",
}


def _spawn_resolve_models(route: dict[str, Any]) -> dict[str, Any]:
    """Return the ``models`` block from ``spawn.json.route`` with safe defaults.

    A missing or malformed route section falls back to the same canonical
    defaults ``cmd_route`` emits. The orchestrator can read the model
    string straight from the spawn-spec without re-reading ``spawn.json.route``.
    """
    models_raw = route.get("models") if isinstance(route, dict) else None
    models = models_raw if isinstance(models_raw, dict) else {}
    return {
        "bug_hunter_a": models.get(
            "bug_hunter_a", {"default": "opus", "test_only": "sonnet"},
        ),
        "bug_hunter_b": models.get("bug_hunter_b", "sonnet"),
        "unified_auditor": models.get("unified_auditor", "sonnet"),
        "premise_reviewer": models.get("premise_reviewer", "sonnet"),
        "fast_path_reviewer": models.get("fast_path_reviewer", "sonnet"),
    }


def _spawn_bha_model(
    models: dict[str, Any], is_test_only: bool,
) -> str:
    """Pick the BHA model per partition.

    Matches ``stage_20`` model selection: test-only partitions take the
    Sonnet ``test_only`` slot; everything else takes the Opus default.
    The ``spawn.json.route`` shape is ``{"bug_hunter_a": {"default": ..., "test_only": ...}}``;
    we tolerate a plain string for back-compat (treat as the default).
    """
    bha_models = models.get("bug_hunter_a")
    if isinstance(bha_models, dict):
        if is_test_only:
            return str(bha_models.get("test_only", "sonnet"))
        return str(bha_models.get("default", "opus"))
    return str(bha_models or "opus")


def _derive_spawn_agents_from_plan(
    coverage_plan: dict[str, Any],
    partitions: list[dict[str, Any]],
    models: dict[str, Any],
    *,
    bha_partitions_cap: int | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Walk the post-arbitrate plan into a flat (agents, skipped) pair.

    ``required[]`` and ``best_effort[]`` are both consulted; entries that
    map to a known core role expand per ``_SPAWN_CORE_ROLES``; entries
    flagged as critics (``source: "critic"``) become ``domain_<N>``;
    anything else lands in ``skipped[]`` with reason ``unknown_reviewer``
    so the orchestrator surfaces the gap.

    ``bha_partitions_cap`` honors the post-arbitrate budget. When the
    partitioner produced N partitions but arbitrate-budget reserved
    only K < N slots for BHA (the route-level ``max_bha_agents`` cap
    and the post-arbitrate cap are computed at different times and
    can diverge), the first K partitions are spawned and the rest
    land in ``skipped[]`` with ``reason: "budget_capped"``. A cap of 0
    suppresses all BHA spawns (docs-only post-arbitrate). ``None``
    means "no cap" — only used by callers that pre-date the cap
    parameter.
    """
    agents: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen_agent_ids: set[str] = set()
    critic_index = 0

    def _emit_for_entry(entry: dict[str, Any], bucket: str) -> None:
        nonlocal critic_index
        reviewer = str(entry.get("reviewer", "") or "")
        source = str(entry.get("source", "") or "")
        if not reviewer:
            skipped.append({
                "reviewer": "",
                "bucket": bucket,
                "reason": "missing_reviewer_name",
            })
            return
        if reviewer in _SPAWN_DEFERRED_ROLES:
            skipped.append({
                "reviewer": reviewer,
                "bucket": bucket,
                "reason": _SPAWN_DEFERRED_ROLES[reviewer],
            })
            return
        role_cfg = _SPAWN_CORE_ROLES.get(reviewer)
        if role_cfg is not None:
            if role_cfg["partitioned"]:
                # BHA expands per partition. When partitions is empty
                # (all cached or docs-only post-arbitrate), no BHA spawn.
                if not partitions:
                    skipped.append({
                        "reviewer": reviewer,
                        "bucket": bucket,
                        "reason": "no_partitions",
                    })
                    return
                # Budget cap: arbitrate-budget computes a final
                # ``bha_partitions`` count that may be < the number of
                # partitions on disk (the route-level
                # ``max_bha_agents`` and the post-arbitrate cap are
                # computed at different times and can diverge). When
                # the cap is 0, no BHA agents spawn at all
                # (docs-only post-arbitrate). When the cap is positive
                # but < len(partitions), the first cap partitions
                # spawn (partitions are bin-packed by the partitioner
                # in roughly diff-LOC order, so prefix-take is the
                # safest cap policy without re-running the bin-pack).
                effective_partitions = partitions
                dropped_for_cap: list[dict[str, Any]] = []
                if bha_partitions_cap is not None:
                    cap = max(0, int(bha_partitions_cap))
                    if cap == 0:
                        # Docs-only post-arbitrate; skip BHA entirely.
                        skipped.append({
                            "reviewer": reviewer,
                            "bucket": bucket,
                            "reason": "budget_capped",
                            "budget_cap": 0,
                            "partition_count": len(partitions),
                        })
                        return
                    if cap < len(partitions):
                        effective_partitions = partitions[:cap]
                        dropped_for_cap = list(partitions[cap:])
                for part in effective_partitions:
                    part_id = int(part.get("id", 0))
                    is_test_only = bool(part.get("is_test_only", False))
                    agent_id = f"{role_cfg['agent_id_prefix']}{part_id}"
                    # Dedup: BHA partitions are normally unique by id,
                    # but a malformed plan could repeat bug_hunter_a or
                    # ship duplicate partition ids. The orchestrator
                    # would otherwise dispatch two Tasks writing to the
                    # same agent_<id>.json file, racing each other.
                    if agent_id in seen_agent_ids:
                        skipped.append({
                            "reviewer": reviewer,
                            "bucket": bucket,
                            "reason": "duplicate_agent_id",
                            "agent_id": agent_id,
                        })
                        continue
                    seen_agent_ids.add(agent_id)
                    agents.append({
                        "agent_id": agent_id,
                        "reviewer": reviewer,
                        "model": _spawn_bha_model(models, is_test_only),
                        "partitioned": True,
                        "partition_id": part_id,
                        "is_test_only": is_test_only,
                        "patches_file": role_cfg["patches_template"].format(
                            partition_id=part_id,
                        ),
                        "source": source or "core",
                        "bucket": bucket,
                    })
                # Record partitions dropped by the budget cap so
                # operators see that BHA coverage is incomplete vs the
                # partitioner's intended fleet size.
                for part in dropped_for_cap:
                    part_id = int(part.get("id", 0))
                    skipped.append({
                        "reviewer": reviewer,
                        "bucket": bucket,
                        "reason": "budget_capped",
                        "partition_id": part_id,
                        "budget_cap": int(bha_partitions_cap or 0),
                        "partition_count": len(partitions),
                    })
                return
            # Non-partitioned core roles: one agent per entry. The
            # closed-vocabulary check at stage_15c should prevent the
            # same reviewer appearing in both required[] and
            # best_effort[], but this is a downstream consumer —
            # defense in depth via the dedup guard means a single
            # source-of-truth violation upstream doesn't silently
            # produce two agents racing on the same output file.
            agent_id = str(role_cfg["agent_id"])
            if agent_id in seen_agent_ids:
                skipped.append({
                    "reviewer": reviewer,
                    "bucket": bucket,
                    "reason": "duplicate_agent_id",
                    "agent_id": agent_id,
                })
                return
            seen_agent_ids.add(agent_id)
            model_slot = models.get(reviewer, "sonnet")
            model = model_slot if isinstance(model_slot, str) else "sonnet"
            agents.append({
                "agent_id": agent_id,
                "reviewer": reviewer,
                "model": model,
                "partitioned": False,
                "patches_file": role_cfg["patches_template"],
                "source": source or "core",
                "bucket": bucket,
            })
            return
        # Non-core reviewer with a known plan-entry source. Both
        # ``source: "rule"`` (deterministically matched from
        # critic-gates.json ``coverage[]`` rules, including migrated
        # ``moduleCritics[]`` entries) and ``source: "critic"``
        # (LLM-proposed via coverage_critic consolidate) map to a
        # domain_<N> agent. The closed_vocabulary check at stage_15c
        # scopes to source: "critic" only — rule entries are
        # operator-owned names from critic-gates.json that the spawner
        # translates at dispatch time. The critic_index is monotonic
        # so domain_<N> names are inherently unique by construction,
        # but we still record them in seen_agent_ids for symmetry with
        # the core-role guard.
        if source in {"rule", "critic"}:
            agent_id = f"domain_{critic_index}"
            seen_agent_ids.add(agent_id)
            # Echo the entry's actual source so presenters can tell
            # operator-configured (rule) from LLM-proposed (critic)
            # domain coverage.
            agents.append({
                "agent_id": agent_id,
                "reviewer": reviewer,
                "model": "sonnet",
                "partitioned": False,
                "patches_file": "patches_all.txt",
                "source": source,
                "bucket": bucket,
                "priority": int(entry.get("priority", 2)),
            })
            critic_index += 1
            return
        # Genuinely unknown source — not core/rule/critic. Defense-
        # in-depth for a malformed plan or a future source value
        # that wasn't taught to the spawner.
        skipped.append({
            "reviewer": reviewer,
            "bucket": bucket,
            "reason": "unknown_reviewer",
        })

    for entry in coverage_plan.get("required", []) or []:
        if isinstance(entry, dict):
            _emit_for_entry(entry, "required")
    for entry in coverage_plan.get("best_effort", []) or []:
        if isinstance(entry, dict):
            _emit_for_entry(entry, "best_effort")
    return agents, skipped


def _spawn_spec_fallback(
    reason: str,
    cr_dir: Path,
    now_iso: str,
) -> dict[str, Any]:
    """Emit a sentinel spec that signals "fall back to the static table".

    Used when the inputs are missing or malformed. The orchestrator
    treats ``arbitrate_status == "fallback"`` as "ignore the spec; walk
    the start.md static reviewer table." This preserves review even when
    the spawn-spec derivation can't run.
    """
    return {
        "fast_path": False,
        "gated_by_verify": False,
        "arbitrate_status": "fallback",
        "fallback_reason": reason,
        "cr_dir": str(cr_dir),
        "agents": [],
        "skipped": [],
        "stats": {
            "agent_count": 0,
            "bha_count": 0,
            "domain_critic_count": 0,
            "from_required": 0,
            "from_best_effort": 0,
        },
        "generated_at": now_iso,
    }


def cmd_derive_spawn_spec(args: argparse.Namespace) -> int:
    """Translate the post-arbitrate coverage plan into a flat spawn spec.

    Reads ``coverage.json.final`` (post-arbitrate), ``partitions.json``
    (post-partition), and the ``route`` section of ``spawn.json``
    (post-route — written by Gate B's ``cmd_route --cr-dir``) and
    writes the ``spec`` section of ``spawn.json`` enumerating every
    agent the orchestrator should spawn at ``stage_20_spawn_reviewers``.

    Fast-path passthrough: when ``route.fast_path`` is true, the spec
    emits exactly one agent (``agent_id: "fast"``) and the bucket walk
    is skipped — matching the Fast Path branch in start.md.

    BLOCKING verdict propagation: when ``coverage_plan.budget.gated_by_verify``
    is true (set by ``arbitrate-budget`` on a BLOCKING verify verdict),
    the spec is still derived from the input plan, but the
    ``gated_by_verify`` flag is propagated so presenters/operators can
    see that arbitration was bypassed. The BLOCKING verdict is
    signaled, not a hard halt — review still runs against the
    unbudgeted plan.

    Failure modes: any unreadable input emits a fallback spec
    (``arbitrate_status: "fallback"``) and returns 0. The orchestrator
    falls back to the start.md static reviewer table on the fallback
    sentinel — a derive failure must never block review.
    """
    cr_dir = Path(args.cr_dir)
    now_iso = datetime.now(timezone.utc).isoformat()

    coverage_plan = _read_coverage_state(cr_dir).get("final")
    if not isinstance(coverage_plan, dict):
        spec = _spawn_spec_fallback(
            "coverage_plan_missing_or_malformed", cr_dir, now_iso,
        )
        return _write_spawn_spec(spec, cr_dir)

    route = _read_spawn_state(cr_dir).get("route", {}) or {}
    if not isinstance(route, dict):
        route = {}
    models = _spawn_resolve_models(route)
    fast_path = bool(route.get("fast_path", False))

    budget = (
        coverage_plan.get("budget", {})
        if isinstance(coverage_plan.get("budget", {}), dict)
        else {}
    )
    gated_by_verify = bool(budget.get("gated_by_verify", False))
    arbitrate_status = str(
        coverage_plan.get("arbitrate_status", "ok") or "ok",
    )

    # Fast-path: spawn a single agent regardless of coverage plan shape.
    # The fast-path agent does all review passes in one run; the
    # coverage plan's bucket distinctions don't apply.
    if fast_path:
        spec = {
            "fast_path": True,
            "gated_by_verify": gated_by_verify,
            "arbitrate_status": arbitrate_status,
            "cr_dir": str(cr_dir),
            "agents": [{
                "agent_id": "fast",
                "reviewer": "fast_path_reviewer",
                "model": str(models.get("fast_path_reviewer", "sonnet")),
                "partitioned": False,
                "patches_file": "patches_all.txt",
                "source": "fast_path",
                "bucket": "fast_path",
            }],
            "skipped": [],
            "stats": {
                "agent_count": 1,
                "bha_count": 0,
                "domain_critic_count": 0,
                "from_required": 0,
                "from_best_effort": 0,
            },
            "generated_at": now_iso,
        }
        return _write_spawn_spec(spec, cr_dir)

    # Distinguish missing partitions.json (upstream stage_17 failure)
    # from valid empty partitions (all files cached). A missing file
    # means the standard flow can't know if there's nothing to review
    # or if the partitioner crashed; silently skipping BHA in that
    # case would suppress coverage. Treat as a fallback sentinel so
    # the orchestrator walks the static reviewer table where the
    # existing "Skip BHA when all files cached" logic can re-derive
    # the answer from primary inputs.
    partitions_path = Path(args.partitions)
    partitions_blob = _read_optional_json(partitions_path, None)
    if not isinstance(partitions_blob, dict):
        spec = _spawn_spec_fallback(
            "partitions_missing_or_malformed", cr_dir, now_iso,
        )
        return _write_spawn_spec(spec, cr_dir)
    partitions = partitions_blob.get("partitions", []) or []
    partitions = [p for p in partitions if isinstance(p, dict)]

    # BLOCKING verdict sanitization. The verifier's BLOCKING reasons
    # include closed-vocabulary (LLM proposed a critic not in roster),
    # shape (malformed entries), evidence (missing required evidence),
    # and cap (>5 best_effort additions) — dispatching the unverified
    # plan as-is could silently spawn agents the verifier explicitly
    # flagged as unsafe. The canonical BLOCKING finding already lives
    # in agent_coverage-verify-blocking.json, so the run surfaces the
    # failure to operators; we sanitize the plan by dropping everything
    # that isn't ``source: "core"`` so only the canonical static fleet
    # runs. The "review still runs against the plan" intent is preserved
    # (core BHA/BHB/Auditor/Premise still spawn).
    plan_for_spawn = coverage_plan
    sanitized_extras: list[dict[str, Any]] = []
    if gated_by_verify:
        plan_for_spawn = dict(coverage_plan)
        plan_for_spawn["required"] = [
            e for e in (coverage_plan.get("required") or [])
            if isinstance(e, dict) and e.get("source") == "core"
        ]
        plan_for_spawn["best_effort"] = [
            e for e in (coverage_plan.get("best_effort") or [])
            if isinstance(e, dict) and e.get("source") == "core"
        ]
        for bucket_name, original in (
            ("required", coverage_plan.get("required") or []),
            ("best_effort", coverage_plan.get("best_effort") or []),
        ):
            for entry in original:
                if not isinstance(entry, dict):
                    continue
                if entry.get("source") != "core":
                    sanitized_extras.append({
                        "reviewer": str(entry.get("reviewer", "") or ""),
                        "bucket": bucket_name,
                        "reason": "gated_by_verify",
                        "source": str(entry.get("source", "") or ""),
                    })

    # Budget cap on BHA (#fix-1). arbitrate-budget computes a final
    # ``bha_partitions`` that honors the LOC cap + total reviewer cap;
    # the partitioner runs separately and may emit more partitions.
    # Pass the cap into the resolver so the spawn-spec never exceeds
    # the post-arbitrate fleet size.
    bha_cap_raw = budget.get("bha_partitions")
    bha_cap: int | None = int(bha_cap_raw) if isinstance(bha_cap_raw, int) else None

    agents, skipped = _derive_spawn_agents_from_plan(
        plan_for_spawn, partitions, models,
        bha_partitions_cap=bha_cap,
    )
    skipped.extend(sanitized_extras)

    # Required coverage-gap findings (#fix-2). When a required[]
    # reviewer was skipped for a non-benign reason, the static-table
    # path used to fail-closed (orchestrator-level coverage-gap on
    # missing required reviewer). The spawn-spec path now emits the
    # same canonical Coverage finding so finalize-result picks it up
    # via coverage_gaps.json. Benign reasons (test_quality deferral,
    # all-cached/docs-only no_partitions, gated_by_verify suppression)
    # are explicitly excluded — those are intentional omissions, not
    # coverage gaps.
    _SPAWN_BENIGN_REQUIRED_SKIPS = {
        "deferred_pln723",      # PLN-723 placeholder slot
        "no_partitions",        # all-cached / docs-only
        "gated_by_verify",      # BLOCKING sanitization
    }
    spawn_gap_findings = _build_spawn_required_gap_findings(
        skipped, _SPAWN_BENIGN_REQUIRED_SKIPS, emitted_at=now_iso,
    )
    if spawn_gap_findings:
        _append_to_coverage_gaps(cr_dir / "coverage_gaps.json", spawn_gap_findings)

    bha_count = sum(1 for a in agents if a["reviewer"] == "bug_hunter_a")
    # Domain critics span both source values (``rule`` for
    # deterministically resolved critic-gates rules including migrated
    # moduleCritics, ``critic`` for LLM-proposed additions). Both spawn
    # as ``domain_<N>`` so both count toward the telemetry.
    critic_count = sum(1 for a in agents if a["source"] in {"rule", "critic"})
    from_required = sum(1 for a in agents if a.get("bucket") == "required")
    from_best_effort = sum(
        1 for a in agents if a.get("bucket") == "best_effort"
    )

    spec = {
        "fast_path": False,
        "gated_by_verify": gated_by_verify,
        "arbitrate_status": arbitrate_status,
        "cr_dir": str(cr_dir),
        "agents": agents,
        "skipped": skipped,
        "stats": {
            "agent_count": len(agents),
            "bha_count": bha_count,
            "domain_critic_count": critic_count,
            "from_required": from_required,
            "from_best_effort": from_best_effort,
            "required_coverage_gaps": len(spawn_gap_findings),
        },
        "generated_at": now_iso,
    }
    return _write_spawn_spec(spec, cr_dir)


def cmd_derive_static_spec(args: argparse.Namespace) -> int:
    """Emit a static spawn spec for shallow-tier reviews (PLN-807).

    Shallow skips ``stage_15*`` (coverage critic), ``stage_16``
    (arbitrate-budget), and ``stage_19b_derive_spawn_spec`` because the
    routing/critic layer has nothing to decide — the fleet is fixed:
    BHA × N partitions + BHB + unified_auditor. This subcommand writes
    that fleet directly into ``spawn.json.spec`` so ``stage_20`` can
    spawn it via the same orchestration path standard runs use.

    ``arbitrate_status: "static"`` differentiates this spec from
    ``"fallback"`` (a derive failure) — stage_20 treats both
    identically (use the spec verbatim, skip the bucket walk), but the
    distinct status preserves telemetry so operators can tell "user
    explicitly chose shallow" from "the standard derive crashed".

    Fast-path passthrough mirrors ``cmd_derive_spawn_spec``: when
    ``route.fast_path`` is true the spec emits one ``fast`` agent and
    the bucket walk is skipped. The fast-path branch behaves
    identically across tiers — it's a small-PR optimization, not a
    tier opinion.

    Failure modes: missing/malformed ``partitions.json`` emits a
    ``"fallback"`` sentinel (same as ``cmd_derive_spawn_spec``) so the
    orchestrator walks the static reviewer table — review must never be
    blocked by an upstream stage's output failure.
    """
    cr_dir = Path(args.cr_dir)
    now_iso = datetime.now(timezone.utc).isoformat()

    route = _read_spawn_state(cr_dir).get("route", {}) or {}
    if not isinstance(route, dict):
        route = {}
    models = _spawn_resolve_models(route)
    fast_path = bool(route.get("fast_path", False))

    if fast_path:
        spec = {
            "fast_path": True,
            "gated_by_verify": False,
            "arbitrate_status": "static",
            "cr_dir": str(cr_dir),
            "agents": [{
                "agent_id": "fast",
                "reviewer": "fast_path_reviewer",
                "model": str(models.get("fast_path_reviewer", "sonnet")),
                "partitioned": False,
                "patches_file": "patches_all.txt",
                "source": "fast_path",
                "bucket": "fast_path",
            }],
            "skipped": [],
            "stats": {
                "agent_count": 1,
                "bha_count": 0,
                "domain_critic_count": 0,
                "from_required": 0,
                "from_best_effort": 0,
            },
            "generated_at": now_iso,
        }
        return _write_spawn_spec(spec, cr_dir)

    partitions_path = Path(args.partitions)
    partitions_blob = _read_optional_json(partitions_path, None)
    if not isinstance(partitions_blob, dict):
        spec = _spawn_spec_fallback(
            "partitions_missing_or_malformed", cr_dir, now_iso,
        )
        return _write_spawn_spec(spec, cr_dir)
    partitions = [
        p for p in (partitions_blob.get("partitions") or []) if isinstance(p, dict)
    ]

    # Synthetic plan: shallow fleet is exactly BHA + BHB + unified_auditor.
    # Reusing _derive_spawn_agents_from_plan keeps BHA partition expansion,
    # docs-only (no_partitions) handling, dedup, and patches-file naming
    # in one place instead of duplicating per-tier logic.
    static_plan: dict[str, Any] = {
        "required": [
            {"reviewer": "bug_hunter_a", "source": "core"},
            {"reviewer": "bug_hunter_b", "source": "core"},
            {"reviewer": "unified_auditor", "source": "core"},
        ],
        "best_effort": [],
    }

    agents, skipped = _derive_spawn_agents_from_plan(
        static_plan, partitions, models,
        bha_partitions_cap=DEFAULT_MAX_BHA_AGENTS,
    )

    bha_count = sum(1 for a in agents if a["reviewer"] == "bug_hunter_a")
    spec = {
        "fast_path": False,
        "gated_by_verify": False,
        "arbitrate_status": "static",
        "cr_dir": str(cr_dir),
        "agents": agents,
        "skipped": skipped,
        "stats": {
            "agent_count": len(agents),
            "bha_count": bha_count,
            "domain_critic_count": 0,
            "from_required": len(agents),
            "from_best_effort": 0,
            "required_coverage_gaps": 0,
        },
        "generated_at": now_iso,
    }
    return _write_spawn_spec(spec, cr_dir)


def _build_spawn_required_gap_findings(
    skipped: list[dict[str, Any]],
    benign_reasons: set[str],
    *,
    emitted_at: str,
) -> list[dict[str, Any]]:
    """Build coverage-gap findings for non-benign required-bucket skips.

    A required reviewer that lands in ``spawn_spec.skipped[]`` for a
    non-benign reason (anything outside ``benign_reasons``) is a real
    coverage gap — the orchestrator's spec-driven dispatch will omit
    that reviewer, and without an explicit finding the omission goes
    silent. The finalize-result step glob-reads ``coverage_gaps.json``
    findings into the canonical coverage gaps list, where they
    contribute to the NEEDS_ATTENTION/CHANGES_REQUESTED verdict.

    Benign reasons (intentional omissions, not coverage gaps): the
    PLN-723 ``deferred_pln723`` placeholder, ``no_partitions``
    (all-cached / docs-only — BHA legitimately has nothing to do),
    and ``gated_by_verify`` (BLOCKING sanitization already surfaces
    via agent_coverage-verify-blocking.json).
    """
    findings: list[dict[str, Any]] = []
    idx = 0
    for entry in skipped:
        if entry.get("bucket") != "required":
            continue
        reason = str(entry.get("reason", "") or "")
        if reason in benign_reasons:
            continue
        # Map spawn-spec reasons to the arbitrate-budget reason
        # vocabulary expected by _make_coverage_gap_finding's marker
        # synthesis (it special-cases "budget_exceeded" → marker
        # "budget-exceeded"; other reasons become "coverage:<name>").
        findings.append(
            _make_coverage_gap_finding(
                {"reviewer": entry.get("reviewer", "unknown")},
                reason=f"spawn_{reason}",
                index=idx,
                emitted_at=emitted_at,
            ),
        )
        idx += 1
    return findings


def _append_to_coverage_gaps(
    gaps_path: Path, new_findings: list[dict[str, Any]],
) -> None:
    """Append findings to ``coverage_gaps.json`` preserving existing entries.

    ``arbitrate-budget`` is the original producer of this file
    (writing the ``budget_exceeded`` findings); ``derive-spawn-spec``
    is the second producer (writing the ``spawn_*`` reason findings).
    Both run before ``stage_21_collect_findings`` which globs
    ``agent_*.json`` and ``cmd_finalize_result`` which reads
    ``coverage_gaps.json`` directly. The append-not-overwrite
    contract keeps both producers' findings visible in the final
    envelope.
    """
    existing = _read_optional_json(gaps_path, None)
    if isinstance(existing, dict):
        merged = list(existing.get("findings", []) or [])
    else:
        merged = []
    merged.extend(new_findings)
    try:
        with open(gaps_path, "w") as f:
            json.dump({"findings": merged}, f, indent=2)
    except OSError as exc:
        print(f"Warning: could not append spawn coverage gaps: {exc}", file=sys.stderr)


def _write_spawn_spec(spec: dict[str, Any], cr_dir: Path) -> int:
    """Write the spec into spawn.json.spec and emit a short summary to stdout.

    Writes via the atomic ``_write_spawn_section`` helper; the stdout
    summary points at ``<cr_dir>/spawn.json`` so operators know where
    to look.
    """
    try:
        _write_spawn_section(cr_dir, "spec", spec)
    except OSError as exc:
        print(f"Error writing spawn.json.spec: {exc}", file=sys.stderr)
        return 1
    json.dump(
        {
            "spawn_state": str(cr_dir / _SPAWN_STATE_FILENAME),
            "fast_path": spec["fast_path"],
            "gated_by_verify": spec["gated_by_verify"],
            "arbitrate_status": spec["arbitrate_status"],
            "agent_count": spec["stats"]["agent_count"],
            "bha_count": spec["stats"]["bha_count"],
            "domain_critic_count": spec["stats"]["domain_critic_count"],
            "skipped_count": len(spec["skipped"]),
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: verify-spawn (PLN-725 / stage_20b)
# ---------------------------------------------------------------------------
#
# Closes the runtime side of the spawn-spec contract. ``derive-spawn-spec``
# enumerates the intended fleet; ``stage_20_spawn_reviewers`` dispatches
# one Task per agent descriptor; ``verify-spawn`` (this stage) checks
# that every required agent_id from the spec produced an output file on
# disk. Missing required agents become coverage-gap findings appended to
# ``coverage_gaps.json`` so the canonical envelope's verdict computation
# sees them.
#
# This is the symmetric pair to the derive-time required-skip findings:
# derive-spawn-spec catches required reviewers the spec couldn't even
# describe; verify-spawn catches required agents that crashed at runtime.
# Together they make the "required reviewer missing" failure mode
# observable in the run summary instead of silently dropping coverage.


def cmd_verify_spawn(args: argparse.Namespace) -> int:
    """Compare ``spawn_spec.agents[]`` against on-disk ``agent_*.json``.

    For every agent descriptor with ``bucket == "required"`` that has
    no corresponding ``agent_<agent_id>.json`` file on disk, emit a
    coverage-gap finding to ``coverage_gaps.json``. Non-required
    (best_effort) missing agents emit no finding — those are
    budget-driven omissions, not coverage gaps.

    Reads:
      - ``<cr_dir>/spawn.json`` ``.spec`` section (derived by stage_19b)
      - All ``<cr_dir>/agent_*.json`` files (written by stage_20)

    Writes:
      - ``<cr_dir>/spawn.json`` ``.verification`` section (telemetry only)
      - Appends coverage-gap findings to ``<cr_dir>/coverage_gaps.json``

    Fallback behavior: when ``spawn.json`` is missing, its ``.spec``
    section is absent, marks ``arbitrate_status: "fallback"``, or has
    no agents (e.g. fast-path collapse), the stage no-ops and returns
    0 — the static-table path doesn't have a spec to verify against.

    ``on_failure: continue`` at the walker — a verification failure
    must never block review.
    """
    cr_dir = Path(args.cr_dir)
    state = _read_spawn_state(cr_dir)
    spec = state.get("spec")
    now_iso = datetime.now(timezone.utc).isoformat()

    def _emit_no_op(reason: str) -> int:
        verification = {
            "verified": False,
            "reason": reason,
            "present_agents": [],
            "missing_agents": [],
            "missing_required": [],
            "generated_at": now_iso,
        }
        try:
            _write_spawn_section(cr_dir, "verification", verification)
        except OSError as exc:
            print(f"Warning: could not write spawn.json.verification: {exc}", file=sys.stderr)
        return _emit_summary({"verified": False, "reason": reason})

    if not isinstance(spec, dict):
        return _emit_no_op("spec_missing")
    if str(spec.get("arbitrate_status", "")) == "fallback":
        return _emit_no_op("spec_fallback")
    agents = spec.get("agents") or []
    if not isinstance(agents, list) or not agents:
        return _emit_no_op("spec_empty")

    # Intended agent IDs from the spec. Scoping ``present_ids`` to
    # this set is critical: the orchestrator writes spawned outputs
    # to ``agent_<agent_id>.json`` per the spawn-spec contract, but
    # the same ``agent_*.json`` glob also matches non-spec artifacts
    # — ``agent_coverage-verify-blocking.json`` from stage_15c,
    # ``agent_cached_bha.json`` from the cache replay, the future
    # ``agent_injection.json`` from the injection detector, etc.
    # Counting those toward ``present_count`` over-reports runtime
    # presence and pollutes the operator-facing fleet tally.
    intended_ids: set[str] = {
        str(d.get("agent_id", "") or "")
        for d in agents
        if isinstance(d, dict) and d.get("agent_id")
    }

    # Glob the on-disk agent outputs and intersect with the intended
    # set. Files that exist but weren't enumerated by stage_19b are
    # outside the spawn-spec contract and don't belong in the
    # fleet's runtime tally.
    present_ids: set[str] = set()
    for path in cr_dir.glob("agent_*.json"):
        name = path.stem  # e.g. "agent_bha_p0"
        if not name.startswith("agent_"):
            continue
        candidate = name[len("agent_"):]
        if candidate in intended_ids:
            present_ids.add(candidate)

    missing_agents: list[dict[str, Any]] = []
    missing_required: list[dict[str, Any]] = []
    for desc in agents:
        if not isinstance(desc, dict):
            continue
        agent_id = str(desc.get("agent_id", "") or "")
        if not agent_id or agent_id in present_ids:
            continue
        record = {
            "agent_id": agent_id,
            "reviewer": str(desc.get("reviewer", "") or ""),
            "bucket": str(desc.get("bucket", "") or ""),
            "source": str(desc.get("source", "") or ""),
        }
        missing_agents.append(record)
        if desc.get("bucket") == "required":
            missing_required.append(record)

    # Emit one coverage-gap finding per missing REQUIRED agent. Best-
    # effort omissions are budget-driven (the spec already records
    # ``budget_capped``/etc. in skipped[]) and don't warrant a
    # blocking coverage gap.
    findings: list[dict[str, Any]] = []
    for idx, rec in enumerate(missing_required):
        findings.append(
            _make_coverage_gap_finding(
                {"reviewer": rec["reviewer"] or rec["agent_id"]},
                reason="spawn_missing_required_agent",
                index=idx,
                emitted_at=now_iso,
            ),
        )
    if findings:
        _append_to_coverage_gaps(
            cr_dir / "coverage_gaps.json", findings,
        )

    verification = {
        "verified": True,
        "present_count": len(present_ids),
        "intended_count": len([a for a in agents if isinstance(a, dict)]),
        "present_agents": sorted(present_ids),
        "missing_agents": missing_agents,
        "missing_required": missing_required,
        "missing_required_gaps": len(findings),
        "generated_at": now_iso,
    }
    try:
        _write_spawn_section(cr_dir, "verification", verification)
    except OSError as exc:
        print(f"Error writing spawn.json.verification: {exc}", file=sys.stderr)
        return 1
    return _emit_summary({
        "verified": True,
        "intended_count": verification["intended_count"],
        "present_count": verification["present_count"],
        "missing_required_count": len(missing_required),
        "missing_best_effort_count": (
            len(missing_agents) - len(missing_required)
        ),
    })


# ---------------------------------------------------------------------------
# Subcommand: render-fleet-summary (PLN-725 — presenter)
# ---------------------------------------------------------------------------
#
# Consumes the spawn-spec + spawn-verification artifacts ("who was intended
# to run, and who actually ran") and emits a deterministic markdown block.
# The present-local skill and github-review.md substitute it into their
# existing Reviewers / Model Routing slot. Moving the derivation into
# Python (vs prose instructions in the skill) makes the rendering testable
# via golden-fixture-style assertions.

# Canonical snake_case → display-name mapping. Reviewers not in this
# table render with their original ``reviewer`` string so
# operator-configured critic names (e.g. ``ts-expert``,
# ``graphql-architect``) appear verbatim — they're the names the
# operator wrote into ``critic-gates.json``.
_FLEET_DISPLAY_NAMES: dict[str, str] = {
    "bug_hunter_a": "Bug Hunter A",
    "bug_hunter_b": "Bug Hunter B",
    "unified_auditor": "Unified Auditor",
    "premise_reviewer": "Premise Reviewer",
    "fast_path_reviewer": "Fast Path Reviewer",
    "test_quality": "Test Quality",
}


def _fleet_display_name(reviewer: str) -> str:
    """Map a snake_case reviewer label to its operator-facing display name."""
    return _FLEET_DISPLAY_NAMES.get(reviewer, reviewer)


def _safe_int(value: Any, default: int) -> int:
    """Coerce ``value`` to int; return ``default`` on failure.

    Used for numeric fields inside artifacts where a half-written
    file or operator-mangled input could plausibly land a string or
    ``None`` where a number was expected. The renderer would
    otherwise raise ``ValueError`` mid-output and produce no Fleet
    line at all — degrading the count to ``default`` is preferable
    to halting the entire summary block.
    """
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _render_fast_path_fleet(
    spec: dict[str, Any], route: dict[str, Any],
) -> list[str]:
    """Render the fast-path branch: single agent does all review passes."""
    agents = spec.get("agents") or []
    fast_agent = agents[0] if agents and isinstance(agents[0], dict) else {}
    # ``route.models`` may be malformed (non-dict) — guard before
    # subscripting so a wrong-shape route doesn't raise. The same
    # guard exists in ``_spawn_resolve_models``.
    route_models = route.get("models")
    fallback = "sonnet"
    if isinstance(route_models, dict):
        fp = route_models.get("fast_path_reviewer")
        if isinstance(fp, str) and fp:
            fallback = fp
    model = str(fast_agent.get("model") or fallback)
    lines = [
        "**Reviewers:** Fast Path Reviewer (single-agent mode)",
        f"**Model Routing:** Fast path — {model} single reviewer",
    ]
    return lines


def _render_fleet_breakdown(spec: dict[str, Any]) -> list[str]:
    """Render the standard-flow Reviewers line.

    The Reviewers line shows BHA partition count, the
    non-partitioned core trio, and the domain critic count split by
    source (rule vs critic) so operators can distinguish
    operator-configured coverage from LLM-proposed additions. Note
    selection (BLOCKING / runtime / budget / deferral) is driven
    independently by ``_render_fleet_notes`` reading ``spec``
    directly — no derived tally needs to flow through here.
    """
    agents = spec.get("agents") or []
    bha_count = sum(
        1 for a in agents
        if isinstance(a, dict) and a.get("reviewer") == "bug_hunter_a"
    )
    rule_critics = [
        a for a in agents
        if isinstance(a, dict) and a.get("source") == "rule"
    ]
    llm_critics = [
        a for a in agents
        if isinstance(a, dict) and a.get("source") == "critic"
    ]
    # Core non-partitioned reviewers actually present (the canonical
    # trio is BHB / Auditor / Premise but sanitization or fallback
    # paths may drop entries).
    core_non_partitioned: list[str] = []
    for reviewer in ("bug_hunter_b", "unified_auditor", "premise_reviewer"):
        if any(
            isinstance(a, dict) and a.get("reviewer") == reviewer
            for a in agents
        ):
            core_non_partitioned.append(_fleet_display_name(reviewer))

    pieces: list[str] = []
    if bha_count > 0:
        if bha_count == 1:
            pieces.append("Bug Hunter A")
        else:
            pieces.append(f"Bug Hunter A × {bha_count}")
    pieces.extend(core_non_partitioned)
    domain_total = len(rule_critics) + len(llm_critics)
    if domain_total > 0:
        # Show the split so operators can tell config-driven coverage
        # apart from one-off LLM proposals — the two have very
        # different audit implications.
        provenance: list[str] = []
        if rule_critics:
            provenance.append(f"{len(rule_critics)} rule-resolved")
        if llm_critics:
            provenance.append(f"{len(llm_critics)} LLM-proposed")
        suffix = (
            f" ({', '.join(provenance)})" if provenance else ""
        )
        if domain_total == 1:
            critic_entry = rule_critics[0] if rule_critics else llm_critics[0]
            critic_name = str(critic_entry.get("reviewer", "domain critic"))
            pieces.append(f"domain critic: {critic_name}{suffix}")
        else:
            pieces.append(f"{domain_total} domain critics{suffix}")

    reviewers_line = (
        f"**Reviewers:** {', '.join(pieces)}"
        if pieces
        else "**Reviewers:** (none — fleet derivation failed)"
    )
    return [reviewers_line]


def _render_model_summary(
    spec: dict[str, Any], route: dict[str, Any],
) -> str:
    """Build the Model Routing summary from the actual spawned models.

    Walks ``spawn_spec.agents[].model`` so the rendered summary
    reflects what each agent dispatched with. BHA shows the set of
    models in use across partitions (so a mixed Opus + Sonnet
    test-only run shows both, instead of just route's default).
    Non-partitioned core slots show their actual descriptor model.
    Domain critics get a single ``Critics`` aggregate when present
    (the per-critic model is uniform in practice — sonnet — but
    surfacing the slot lets operators see they participated).

    ``route`` is consulted only as a fallback when the spec has no
    descriptor for a slot (defensive — shouldn't happen on the standard
    flow but keeps the route-based summary working if the spec is partial).
    """
    agents = spec.get("agents") or []
    if not isinstance(agents, list):
        return "see `spawn.json.route`"

    # Collect per-role model assignments. Use dict-by-role-of-set so
    # mixed assignments (BHA Opus on impl, Sonnet on test-only)
    # surface as ``BHA=opus/sonnet`` rather than silently picking
    # one.
    role_models: dict[str, list[str]] = {}
    critic_models: list[str] = []
    for a in agents:
        if not isinstance(a, dict):
            continue
        reviewer = str(a.get("reviewer", "") or "")
        model = str(a.get("model", "") or "")
        if not reviewer or not model:
            continue
        if a.get("source") in {"rule", "critic"}:
            critic_models.append(model)
        else:
            role_models.setdefault(reviewer, []).append(model)

    summary_parts: list[str] = []
    # Render canonical core slots in fixed order; mirror the
    # display-name table so the summary key matches the Reviewers
    # line shorthand (BHA / BHB / Auditor / Premise).
    for reviewer, label in (
        ("bug_hunter_a", "BHA"),
        ("bug_hunter_b", "BHB"),
        ("unified_auditor", "Auditor"),
        ("premise_reviewer", "Premise"),
    ):
        seen = role_models.get(reviewer)
        if seen:
            # Preserve first-appearance order while deduping so
            # mixed assignments render as ``opus/sonnet`` not the
            # reverse depending on dict iteration order.
            unique: list[str] = []
            for m in seen:
                if m not in unique:
                    unique.append(m)
            summary_parts.append(f"{label}={'/'.join(unique)}")
            continue
        # Fallback to spawn.json.route defaults when the spec has no
        # descriptor for this slot (partial spec / fallback paths).
        models_dict = route.get("models")
        if not isinstance(models_dict, dict):
            continue
        raw = models_dict.get(reviewer)
        if isinstance(raw, dict):
            default = raw.get("default")
            if isinstance(default, str) and default:
                summary_parts.append(f"{label}={default}")
        elif isinstance(raw, str) and raw:
            # Plain-string form of the route models entry.
            summary_parts.append(f"{label}={raw}")
    if critic_models:
        unique_critic: list[str] = []
        for m in critic_models:
            if m not in unique_critic:
                unique_critic.append(m)
        summary_parts.append(f"Critics={'/'.join(unique_critic)}")
    return ", ".join(summary_parts) if summary_parts else "see `spawn.json.route`"


def _render_fleet_notes(
    spec: dict[str, Any], verification: dict[str, Any] | None,
) -> list[str]:
    """Emit conditional note blocks for non-default fleet outcomes.

    Each note is a single bullet so the section stays scannable. The
    notes are mutually independent — a run can simultaneously be
    BLOCKING-sanitized AND have a runtime crash AND a budget-capped
    BHA partition, so all four blocks may fire together.
    """
    notes: list[str] = []
    skipped = spec.get("skipped") or []
    if not isinstance(skipped, list):
        skipped = []

    # BLOCKING sanitization — emit before any runtime notes so the
    # operator reads the upstream-cause line first.
    if spec.get("gated_by_verify") is True:
        suppressed = [
            s for s in skipped
            if isinstance(s, dict) and s.get("reason") == "gated_by_verify"
        ]
        suppressed_names = ", ".join(
            sorted({str(s.get("reviewer", "")) for s in suppressed if s.get("reviewer")})
        )
        suffix = f" Suppressed: {suppressed_names}." if suppressed_names else ""
        notes.append(
            "- 🛡️ **Arbitration bypassed** (BLOCKING verify verdict). "
            "Sanitized to core fleet only."
            f"{suffix} See `agent_coverage-verify-blocking.json`.",
        )

    # Runtime — missing required agents (from stage_20b_verify_spawn).
    if isinstance(verification, dict) and verification.get("verified") is True:
        missing_required = verification.get("missing_required") or []
        if missing_required:
            missing_names = ", ".join(sorted({
                _fleet_display_name(str(m.get("reviewer") or m.get("agent_id", "")))
                for m in missing_required
                if isinstance(m, dict)
            }))
            notes.append(
                f"- ⚠️ **{len(missing_required)} required reviewer(s) did not "
                f"produce output:** {missing_names}. "
                "See `coverage_gaps.json`.",
            )

    # BHA budget cap — collapse multiple partition_id entries into
    # one note. Two emission shapes from _derive_spawn_agents_from_plan:
    #   - cap > 0: one capped entry per dropped partition (each
    #     carries ``partition_id``). Dropped count = len(entries).
    #   - cap == 0 (docs-only post-arbitrate): a single aggregate
    #     entry covers ALL N suppressed partitions (no
    #     ``partition_id``; ``partition_count`` reflects the total).
    #     Dropped count = ``partition_count`` from the aggregate.
    # Counting len(capped_entries) under-reports the docs-only case
    # as "1 partition(s)" when N partitions were actually suppressed
    # via a single aggregate entry.
    capped_entries = [
        s for s in skipped
        if isinstance(s, dict) and s.get("reason") == "budget_capped"
    ]
    if capped_entries:
        first = capped_entries[0]
        cap = first.get("budget_cap", 0)
        total = first.get("partition_count", len(capped_entries))
        # Aggregate-shape detection: a cap=0 entry has no
        # partition_id and represents every suppressed partition.
        if "partition_id" not in first:
            dropped = _safe_int(total, len(capped_entries))
        else:
            dropped = len(capped_entries)
        notes.append(
            f"- ⚠️ **BHA partition cap:** {dropped} partition(s) "
            f"exceeded the post-arbitrate budget ({cap}/{total}).",
        )

    # PLN-723 deferral — informational only.
    if any(
        isinstance(s, dict) and s.get("reason") == "deferred_pln723"
        for s in skipped
    ):
        notes.append("- ℹ️ `test_quality` slot reserved for PLN-723.")

    # Other skip reasons (unknown_reviewer / duplicate_agent_id /
    # missing_reviewer_name) → already produce coverage_gaps.json
    # findings via stage_19b. Surface them as a single line so the
    # operator sees the count without us re-listing each finding.
    other_required_skips = [
        s for s in skipped
        if isinstance(s, dict)
        and s.get("bucket") == "required"
        and s.get("reason") in {
            "unknown_reviewer", "duplicate_agent_id", "missing_reviewer_name",
        }
    ]
    if other_required_skips:
        notes.append(
            f"- ⚠️ **{len(other_required_skips)} required reviewer(s) could "
            "not be spawned** (malformed plan entry). See "
            "`coverage_gaps.json`.",
        )

    return notes


def cmd_render_fleet_summary(args: argparse.Namespace) -> int:
    """Render the operator-facing Reviewer Fleet markdown block.

    Reads ``<cr-dir>/spawn.json`` (``.spec``, ``.verification``, and
    ``.route`` sections) and emits a self-contained markdown block to
    stdout (or ``--output``). The block reflects the deterministic
    coverage selection — including BLOCKING sanitization, budget-capped
    BHA partitions, runtime crashes, and the rule vs critic provenance
    distinction on domain agents.

    Fallback behavior: when ``spawn.json`` is missing, its ``.spec``
    section is absent, or the section marks ``arbitrate_status:
    "fallback"``, the helper emits a minimal block that says
    "spawn-spec unavailable" + the fallback_reason and instructs the
    presenter to walk the static reviewer table.
    """
    cr_dir = Path(args.cr_dir)
    # All three sources live in spawn.json under .route, .spec, and
    # .verification. Each ``.get()`` falls through to None/{} so the
    # degraded-output paths fire on the same semantics: no spec →
    # "spawn-spec unavailable", no verification → "runtime tally
    # unavailable", no route → omit Model Routing line.
    state = _read_spawn_state(cr_dir)
    spec = state.get("spec")
    verification = state.get("verification")
    route = state.get("route") or {}
    if not isinstance(route, dict):
        route = {}

    out_lines: list[str] = []

    if not isinstance(spec, dict):
        out_lines.append(
            "**Reviewer Fleet:** spawn-spec unavailable; walking static "
            "reviewer table fallback.",
        )
        out_lines.append(
            "**Model Routing:** (see `spawn.json.route`)",
        )
        return _write_fleet_summary(out_lines, args)

    if str(spec.get("arbitrate_status", "")) == "fallback":
        reason = str(spec.get("fallback_reason", "unknown"))
        out_lines.append(
            f"**Reviewer Fleet:** spawn-spec fell back (`{reason}`); the "
            "orchestrator walked the static reviewer table for this run.",
        )
        out_lines.append("**Model Routing:** (see `spawn.json.route`)")
        return _write_fleet_summary(out_lines, args)

    fast_path = spec.get("fast_path") is True
    if fast_path:
        # Fast-path emits its own Reviewers + Model Routing lines
        # (the bucket/role logic doesn't apply when a single agent
        # runs every pass), then falls through to the shared Fleet
        # + Notes block below so a fast-path run with a missing
        # ``agent_fast.json`` shows ``1 intended | 0 ran`` instead
        # of looking like a clean run.
        out_lines.extend(_render_fast_path_fleet(spec, route))
    else:
        # Standard flow.
        out_lines.extend(_render_fleet_breakdown(spec))

    # Model Routing — standard flow only; fast-path already emitted
    # its own Fast-path-mode routing line above. Derived from
    # spec.agents[].model so the operator sees the models actually
    # used at dispatch, not the spawn.json.route defaults. This
    # matters when:
    #   - a test-only BHA partition ran on Sonnet while route's
    #     bug_hunter_a.default says Opus (the spec wins);
    #   - route.models.bug_hunter_a is a plain string (single-model
    #     form) — both dict and string shapes are respected;
    #   - domain critics carry their models per-descriptor and
    #     spawn.json.route never had them.
    # route.size_category is still used as the header label.
    if not fast_path:
        size_category = str(route.get("size_category", "")).strip()
        if size_category:
            model_summary = _render_model_summary(spec, route)
            out_lines.append(f"**Model Routing:** {size_category} — {model_summary}")

    # Fleet outcome line — surface the intended vs ran counts so the
    # operator sees runtime tally without scrolling to Verifier
    # Stats. The numeric fields are coerced through ``_safe_int`` so
    # a malformed artifact (e.g. ``stats.agent_count: "five"`` from
    # a half-written file) degrades to 0 rather than raising
    # ValueError mid-render.
    raw_stats = spec.get("stats")
    stats: dict[str, Any] = raw_stats if isinstance(raw_stats, dict) else {}
    intended = _safe_int(stats.get("agent_count"), 0)
    if isinstance(verification, dict) and verification.get("verified") is True:
        present = _safe_int(verification.get("present_count"), 0)
        missing_required_raw = verification.get("missing_required")
        missing_required_count = (
            len(missing_required_raw)
            if isinstance(missing_required_raw, list)
            else 0
        )
        fleet_line = (
            f"**Fleet:** {intended} intended | {present} ran"
            f" | {missing_required_count} required missing"
        )
        out_lines.append(fleet_line)
    elif intended:
        out_lines.append(f"**Fleet:** {intended} intended (runtime tally unavailable)")

    # Notes — conditional bullets for non-default outcomes.
    notes = _render_fleet_notes(spec, verification)
    if notes:
        out_lines.append("")  # blank line so notes render as a separate block
        out_lines.extend(notes)

    return _write_fleet_summary(out_lines, args)


def _write_fleet_summary(lines: list[str], args: argparse.Namespace) -> int:
    """Emit the rendered markdown to stdout OR ``--output`` (mutually exclusive).

    The argparse help on ``--output`` documents the flag as
    "Optional output file path; default stdout-only" — providing
    ``--output`` suppresses stdout, so a shell pipeline that captures
    stdout while also persisting via ``--output`` doesn't receive
    duplicate content.
    """
    text = "\n".join(lines) + "\n"
    if getattr(args, "output", None):
        try:
            Path(args.output).write_text(text)
        except OSError as exc:
            print(f"Error writing fleet summary: {exc}", file=sys.stderr)
            return 1
    else:
        sys.stdout.write(text)
    return 0


# ---------------------------------------------------------------------------
# Subcommand: finalize-result (PLN-719 Phase 2)
# ---------------------------------------------------------------------------


def _empty_coverage_plan() -> dict[str, Any]:
    """Stub coverage plan used until plan 05 fills it in."""
    return {
        "required": [],
        "best_effort": [],
        "deferred_for_budget": [],
        "deprecation_warnings": [],
        "budget": {
            "total_cap": 20,
            "required_count": 0,
            "best_effort_count": 0,
            "bha_partitions": 0,
        },
    }


_PLN773_PREMISE_SUBCATEGORIES: tuple[str, ...] = (
    "necessity", "cohesion", "workaround", "complexity",
)


def _justification_stats(
    verified: list[dict[str, Any]],
    justified: list[dict[str, Any]],
    *,
    rate_alert_threshold: float,
) -> dict[str, Any]:
    """PLN-773 Phase 2 — Premise justification telemetry sub-block.

    The denominator is total Premise findings across ``verified[]`` AND
    ``justified[]`` (the JUSTIFIED-VALID bucket lives in ``justified[]``
    after cmd_verify_consolidate routes; JUSTIFIED-INVALID stays in
    ``verified[]``). NaN-safe: empty inputs return zeros, not divisions.
    """
    valid_count = sum(
        1 for f in justified
        if str(f.get("category", "")) == "Premise"
    )
    invalid_count = sum(
        1 for f in verified
        if str(f.get("category", "")) == "Premise"
        and f.get("verifier_verdict") == "JUSTIFIED-INVALID"
    )
    premise_in_verified = sum(
        1 for f in verified if str(f.get("category", "")) == "Premise"
    )
    total_premise = premise_in_verified + valid_count
    emitted = valid_count + invalid_count
    rate = (emitted / total_premise) if total_premise > 0 else 0.0
    rejection_rate = (invalid_count / emitted) if emitted > 0 else 0.0
    return {
        "rate": rate,
        "rejection_rate": rejection_rate,
        "total_premise": total_premise,
        "justified_emitted": emitted,
        "justified_valid": valid_count,
        "justified_invalid": invalid_count,
        "threshold_alert": rate > rate_alert_threshold,
    }


def _by_subcategory_stats(verified: list[dict[str, Any]]) -> dict[str, int]:
    """PLN-773 Phase 2 — Premise findings partitioned by subcategory.

    Counts only ``category=Premise`` findings in ``verified[]``. Subcategories
    are pinned to the canonical four (PLN-721) so a typo in a reviewer
    output doesn't introduce spurious buckets; non-canonical subcategories
    are silently ignored.
    """
    counts: dict[str, int] = {k: 0 for k in _PLN773_PREMISE_SUBCATEGORIES}
    for f in verified:
        if str(f.get("category", "")) != "Premise":
            continue
        sub = str(f.get("subcategory", ""))
        if sub in counts:
            counts[sub] += 1
    return counts


def _verification_by_reviewer(
    verified: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """PLN-773 Phase 2 — per-reviewer verification outcomes + FP rate.

    Each reviewer entry carries:
      - ``verified`` / ``rejected`` counts (the inputs to the FP rate)
      - ``fp_rate`` = rejected / (verified + rejected); 0.0 when no audited
        findings exist for the reviewer (NaN-safe)
      - ``re_asserted`` = how many of THIS reviewer's findings carry the
        new ``RE_ASSERTED`` verdict (the inverse health metric — high
        FP-rate AND high re-assert = reviewer is over-rejecting AND
        operators are correcting back)

    Buckets key off the ``reviewer`` field already set by
    ``cmd_collect_findings`` from the agent output filename
    (``agent_bha_p0.json`` → ``reviewer='bha_p0'``). This means BHA is
    naturally per-partition under partitioned mode (``bha_p0``,
    ``bha_p1``, …) and a single ``bha_p0`` bucket under unified mode
    (only one BHA partition exists). No partition-aware regex is needed
    — the per-partition labeling falls out of the filename-derived
    reviewer field.
    """
    counts: dict[str, dict[str, int]] = {}

    def _ensure(reviewer: str) -> dict[str, int]:
        return counts.setdefault(
            reviewer, {"verified": 0, "rejected": 0, "re_asserted": 0},
        )

    for f in verified:
        entry = _ensure(str(f.get("reviewer", "unknown")))
        entry["verified"] += 1
        if f.get("verifier_verdict") == "RE_ASSERTED":
            entry["re_asserted"] += 1
    for f in rejected:
        entry = _ensure(str(f.get("reviewer", "unknown")))
        entry["rejected"] += 1

    out: dict[str, dict[str, Any]] = {}
    for reviewer, c in counts.items():
        audited = c["verified"] + c["rejected"]
        out[reviewer] = {
            "verified": c["verified"],
            "rejected": c["rejected"],
            "re_asserted": c["re_asserted"],
            "fp_rate": (c["rejected"] / audited) if audited > 0 else 0.0,
        }
    return out


def _stats_from_findings(
    verified: list[dict[str, Any]],
    rejected: list[dict[str, Any]],
    justified: list[dict[str, Any]],
    coverage_gaps: list[dict[str, Any]],
    *,
    thresholds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute the ``stats`` block of the result envelope.

    ``thresholds`` (PLN-773): optional dict from ``_load_verdict_thresholds``.
    Callers that omit it get the built-in default for the
    ``justification_rate_alert`` toggle (0.30). All existing call sites
    keep working through the optional kwarg.
    """
    thresholds = thresholds or {
        "premise_cumulative_medium": _VERDICT_PREMISE_MEDIUM_THRESHOLD_DEFAULT,
        "justification_rate_alert": _VERDICT_JUSTIFICATION_RATE_ALERT_DEFAULT,
    }

    by_severity: dict[str, int] = {"BLOCKING": 0, "HIGH": 0, "MEDIUM": 0}
    by_category: dict[str, int] = {}
    by_reviewer: dict[str, dict[str, int]] = {}
    by_scope: dict[str, int] = {"diff": 0, "system": 0, "pr_metadata": 0}

    def _bump(finding: dict[str, Any], bucket: str) -> None:
        sev = str(finding.get("severity", "MEDIUM"))
        if sev in by_severity:
            by_severity[sev] += 1
        cat = str(finding.get("category", "Unknown"))
        by_category[cat] = by_category.get(cat, 0) + 1
        reviewer = str(finding.get("reviewer", "unknown"))
        entry = by_reviewer.setdefault(
            reviewer, {"verified": 0, "rejected": 0, "tentative": 0, "justified": 0},
        )
        if bucket in entry:
            entry[bucket] += 1
        scope = str(finding.get("finding_scope") or "diff")
        if scope in by_scope:
            by_scope[scope] += 1

    for f in verified:
        _bump(f, "verified")
    for f in rejected:
        _bump(f, "rejected")
    for f in justified:
        _bump(f, "justified")
    for f in coverage_gaps:
        _bump(f, "verified")

    return {
        "by_severity": by_severity,
        "by_category": by_category,
        "by_reviewer": by_reviewer,
        "by_finding_scope": by_scope,
        # PLN-773 Phase 2 — Premise telemetry sub-blocks (additive; the
        # envelope schema accepts arbitrary stats keys).
        "by_subcategory": _by_subcategory_stats(verified),
        "justification": _justification_stats(
            verified, justified,
            rate_alert_threshold=float(
                thresholds.get(
                    "justification_rate_alert",
                    _VERDICT_JUSTIFICATION_RATE_ALERT_DEFAULT,
                ),
            ),
        ),
        "verification": {
            "verified_count": len(verified),
            "rejected_count": len(rejected),
            "tentative_count": 0,
            "downgrade_count": 0,
            "justified_valid_count": len(justified),
            # PLN-721: JUSTIFIED-INVALID lands in verified[] (the
            # justification was audited and refuted, original finding
            # stands). Count them here so telemetry surfaces the audit
            # outcome without needing a separate JUSTIFIED-INVALID bucket.
            "justified_invalid_count": sum(
                1 for f in verified
                if f.get("verifier_verdict") == "JUSTIFIED-INVALID"
            ),
            "skipped_count": 0,
            "false_positive_rate": 0.0,
            # PLN-773 Phase 2 — per-reviewer FP rate + override counter.
            "by_reviewer": _verification_by_reviewer(verified, rejected),
        },
        # Must match the count Rule 4 actually fires on —
        # _count_gateable_premise_medium is the single source of truth
        # for that policy (excludes JUSTIFIED-VALID / JUSTIFIED-INVALID).
        "premise_cumulative_medium_count": _count_gateable_premise_medium(verified),
        "agent_failures": [],
    }


def _extract_bha_cache_hit_rate(cr_dir: Path) -> float | None:
    """Return the BHA cache hit rate (0.0-1.0) from cache_result.json, or None.

    ``cache_result.json`` records ``stats.hit_rate_pct`` (0-100) per
    cache-check; we normalize to the canonical [0, 1] domain that
    ``validate_telemetry`` enforces. Missing or malformed files degrade
    silently to None so runs without a cache-check stage (e.g.
    ``--hygiene-only``) don't crash finalize.
    """
    doc = _read_optional_json(cr_dir / "cache_result.json", None)
    if not isinstance(doc, dict):
        return None
    stats = doc.get("stats")
    if not isinstance(stats, dict):
        return None
    pct = stats.get("hit_rate_pct")
    if not isinstance(pct, (int, float)) or isinstance(pct, bool):
        return None
    if pct < 0 or pct > 100:
        return None
    return round(pct / 100.0, 4)


def _build_telemetry_block(cr_dir: Path) -> dict[str, Any]:
    """Assemble the canonical telemetry block for the result envelope.

    Starts from ``empty_telemetry()`` and deep-merges ``<cr_dir>/telemetry.json``
    when present, so the orchestrator (or any helper that wraps a stage) can
    record per-run metrics by writing partial telemetry. Always forces the
    ``schema_versions_seen`` block to this run's canonical schema version so
    it cannot be silently spoofed by a stale upstream file. PLN-719 Phase 7:
    populate ``cache_hit_rate["bha"]`` from ``cache_result.json`` when a
    cache-check ran for this review.
    """
    base = empty_telemetry()
    overlay_raw = _read_optional_json(cr_dir / "telemetry.json", None)
    overlay = overlay_raw if isinstance(overlay_raw, dict) else {}
    block = merge_telemetry(base, overlay)
    bha_rate = _extract_bha_cache_hit_rate(cr_dir)
    if bha_rate is not None:
        block["cache_hit_rate"][CACHE_NAMESPACE_BHA] = bha_rate
    block["schema_versions_seen"] = {
        "finding": SCHEMA_VERSION,
        "result": SCHEMA_VERSION,
    }
    return block


def cmd_finalize_result(args: argparse.Namespace) -> int:
    """Consolidate findings + coverage state + verdict into review_result.json.

    Prefers the bucket-split output of ``cmd_verify_consolidate``
    (``<cr_dir>/findings_verified.json``) when present — that file
    carries ``verified[]`` / ``rejected[]`` / ``pending_verification[]``
    already shaped for the envelope, plus the ``force_human_review``
    flag from sensitive-path escalation. Falls back to
    ``findings_validated.json`` when verify-consolidate didn't run
    (stage_23 disabled, verify-prepare/consolidate infrastructure
    failure, or a pre-verifier cache hit) — everything lands in
    ``verified[]``.

    Coverage-scoped findings (``category=Coverage`` + ``finding_scope=
    system``) are routed to ``coverage_gaps[]`` after the verifier
    bucketing, since coverage routing is verifier-independent and
    applies to both source paths uniformly.
    """
    cr_dir = Path(args.cr_dir)
    findings_validated_path = Path(args.findings_validated)

    findings_validated = _read_optional_json(findings_validated_path, None)
    if not isinstance(findings_validated, dict):
        print(f"Error: findings_validated not found or malformed at {findings_validated_path}", file=sys.stderr)
        return 1

    # Prefer the verify-consolidate output when present (PLN-722).
    consolidated_path = cr_dir / "findings_verified.json"
    consolidated = _read_optional_json(consolidated_path, None)
    using_verifier = (
        isinstance(consolidated, dict)
        and isinstance(consolidated.get("verified"), list)
    )

    if using_verifier:
        raw_verified: list[dict[str, Any]] = consolidated.get("verified", []) or []
        raw_rejected: list[dict[str, Any]] = consolidated.get("rejected", []) or []
        raw_pending: list[dict[str, Any]] = consolidated.get("pending_verification", []) or []
        # justified[] bucket from cmd_verify_consolidate. Defensive
        # default to [] so older findings_verified.json files (before
        # the bucket was emitted) keep finalizing without keying on a
        # missing field.
        raw_justified: list[dict[str, Any]] = consolidated.get("justified", []) or []
        force_human_review = bool(consolidated.get("force_human_review", False))
    else:
        raw_verified = findings_validated.get("validated", []) or []
        raw_rejected = []
        raw_pending = []
        raw_justified = []
        force_human_review = False

    # Promote findings to canonical schema (defensive — collect-findings
    # should already have done this, but cached producers may bypass it).
    # Mirror cmd_collect_findings: coerce non-canonical reviewer strings
    # (e.g. "Bug Hunter A") so make_finding_id doesn't ValueError, and
    # skip individually malformed findings rather than aborting the run.
    now_iso = datetime.now(timezone.utc).isoformat()

    def _normalize_bucket(
        bucket: list[dict[str, Any]], label: str,
    ) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for idx, raw in enumerate(bucket):
            if not isinstance(raw, dict):
                continue
            raw_normalized = dict(raw)
            raw_normalized["reviewer"] = _coerce_reviewer_id(
                raw.get("reviewer"), "unknown",
            )
            try:
                out.append(
                    normalize_legacy_finding(
                        raw_normalized,
                        reviewer=raw_normalized["reviewer"],
                        source=raw.get("source", "agent"),
                        index=idx,
                        emitted_at=raw.get("emitted_at") or now_iso,
                    ),
                )
            except (ValueError, TypeError) as exc:
                print(
                    f"Warning: skipping malformed finding {idx} in {label}: {exc}",
                    file=sys.stderr,
                )
                continue
        return out

    canonical_verified = _normalize_bucket(raw_verified, "verified")
    canonical_rejected = _normalize_bucket(raw_rejected, "rejected")
    canonical_pending = _normalize_bucket(raw_pending, "pending_verification")
    canonical_justified = _normalize_bucket(raw_justified, "justified")

    # Partition by index to avoid dict-equality membership tests; legacy
    # findings normalized in-place may not have stable ids yet. Coverage
    # routing applies only to verified[] — the verifier never sees Coverage
    # gaps (they bypass the tier table by category) so rejected and pending
    # buckets can't carry Coverage findings.
    coverage_indices: set[int] = {
        i for i, f in enumerate(canonical_verified)
        if str(f.get("category", "")) == "Coverage"
        and (f.get("finding_scope") or "diff") == "system"
    }
    coverage_gaps = [f for i, f in enumerate(canonical_verified) if i in coverage_indices]
    verified = [f for i, f in enumerate(canonical_verified) if i not in coverage_indices]
    rejected = canonical_rejected
    pending = canonical_pending
    justified = canonical_justified

    # Pull additional coverage gaps emitted by arbitrate-budget, if any.
    extra_gaps_doc = _read_optional_json(cr_dir / "coverage_gaps.json", None)
    if isinstance(extra_gaps_doc, dict):
        for entry in extra_gaps_doc.get("findings", []) or []:
            if isinstance(entry, dict):
                coverage_gaps.append(entry)

    # PLN-721: load operator-overridable thresholds (defaults bake in).
    thresholds_path = (
        Path(args.thresholds) if getattr(args, "thresholds", None)
        else _VERDICT_THRESHOLDS_DEFAULT_PATH
    )
    thresholds = _load_verdict_thresholds(thresholds_path)
    canonical_verdict, reason = _compute_canonical_verdict(
        verified, coverage_gaps,
        force_human_review=force_human_review,
        thresholds=thresholds,
    )

    # Pull optional run-context inputs.
    setup_data = _read_optional_json(cr_dir / "setup.json", {}) or {}
    scope_data = _read_optional_json(cr_dir / "scope.json", {}) or {}
    intent_data = _read_optional_json(cr_dir / "intent.json", {}) or {}
    # Coverage plan lives in the ``.final`` section of coverage.json.
    coverage_plan = _read_coverage_state(cr_dir).get("final")
    if not isinstance(coverage_plan, dict):
        coverage_plan = _empty_coverage_plan()

    mode = args.mode or setup_data.get("mode") or "local"
    diff_tip = (
        args.diff_tip
        or scope_data.get("diff_tip")
        or setup_data.get("head_sha")
        or "unknown"
    )

    envelope: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "review_id": str(uuid.uuid4()),
        "pr_number": args.pr_number if args.pr_number else scope_data.get("pr_number"),
        "head_sha": setup_data.get("head_sha") or scope_data.get("head_sha"),
        "diff_tip": str(diff_tip),
        "review_branch": setup_data.get("current_branch") or scope_data.get("review_branch"),
        "base_ref": scope_data.get("base_ref"),
        "diff_scope": scope_data.get("diff_scope"),
        "mode": mode,
        "intent": intent_data.get("intent", "mixed"),
        "verified": verified,
        "justified": justified,
        "rejected": rejected,
        "pending_verification": pending,
        "coverage_plan": coverage_plan,
        "coverage_gaps": coverage_gaps,
        "verdict": canonical_verdict,
        "verdict_reason": reason,
        "stats": _stats_from_findings(
            verified, rejected, justified, coverage_gaps,
            thresholds=thresholds,
        ),
        # PLN-719 Phase 9: telemetry is sourced from the canonical zero-valued
        # factory and deep-merged with optional <cr_dir>/telemetry.json, which
        # the orchestrator (or any upstream stage) may populate with timings,
        # token usage, and cache hit rates. finalize-result always overwrites
        # schema_versions_seen so it reflects this run's schema version.
        "telemetry": _build_telemetry_block(cr_dir),
    }

    errors = validate_result_envelope(envelope)

    output_path = cr_dir / "review_result.json"
    with open(output_path, "w") as f:
        json.dump(envelope, f, indent=2)

    json.dump(
        {
            "review_result": str(output_path),
            "verdict": canonical_verdict,
            "verified_count": len(verified),
            "rejected_count": len(rejected),
            "pending_verification_count": len(pending),
            "justified_count": len(justified),
            "coverage_gaps_count": len(coverage_gaps),
            "force_human_review": force_human_review,
            "used_verifier": using_verifier,
            "validation_errors": errors,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")

    # Surface validation errors so the orchestrator can honor stage_25's
    # on_failure: "abort" rather than silently flowing an invalid envelope
    # into verdict / present. The file is still written above so operators
    # can inspect it; the non-zero exit + stderr give them a clear signal.
    if errors:
        print(
            f"Error: review_result.json failed schema validation "
            f"({len(errors)} error(s)):",
            file=sys.stderr,
        )
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    return 0


# ---------------------------------------------------------------------------
# Subcommand: prep-assets
# ---------------------------------------------------------------------------


def cmd_prep_assets(args: argparse.Namespace) -> int:
    """Copy prompt assets from plugin to CR_DIR.

    PLN-722 added ``verifier_prompt.txt`` to the per-run asset set. The
    Verifier Fleet (stage_23) reads it from CR_DIR rather than from the
    plugin root so verify-* runs after a plugin upgrade still use the
    prompt that the prompt-hash was computed against. PLN-721 adds
    ``premise_prompt.txt`` on the same contract — the Premise Reviewer
    reads it from CR_DIR.
    """
    plugin_root = Path(args.plugin_root)
    cr_dir = Path(args.cr_dir)

    shared_src = plugin_root / "tools" / "prompts" / "shared_prompt.txt"
    bha_src = plugin_root / "tools" / "prompts" / "bha_suffix.txt"
    verifier_src = plugin_root / "tools" / "prompts" / "verifier_prompt.txt"
    premise_src = plugin_root / "tools" / "prompts" / "premise_prompt.txt"

    shared_dst = cr_dir / "shared_prompt.txt"
    bha_dst = cr_dir / "bha_suffix.txt"
    verifier_dst = cr_dir / "verifier_prompt.txt"
    premise_dst = cr_dir / "premise_prompt.txt"

    shutil.copy2(shared_src, shared_dst)
    shutil.copy2(bha_src, bha_dst)
    shutil.copy2(verifier_src, verifier_dst)
    shutil.copy2(premise_src, premise_dst)

    json.dump(
        {
            "shared_prompt": str(shared_dst),
            "bha_suffix": str(bha_dst),
            "verifier_prompt": str(verifier_dst),
            "premise_prompt": str(premise_dst),
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: extract-patches
# ---------------------------------------------------------------------------

_EXTRACT_PATCHES_BATCH_SIZE = 50
_EXTRACT_PATCHES_BATCH_THRESHOLD = 200


def cmd_extract_patches(args: argparse.Namespace) -> int:
    """Materialize ``patches_all.txt`` from the full diff.

    PLN-719 Phase 5 relocates this stage to run right after ``parse-diff``,
    well before partitioning. It now produces only the full-diff artifact;
    per-partition patches (``patches_p<N>.txt``) are emitted by the
    ``partition`` subcommand.
    """
    diff_scope: str = args.diff_scope
    cr_dir = Path(args.cr_dir)
    diff_data_path: str = args.diff_data
    workdir: str | None = getattr(args, "workdir", None)
    batch_size: int = getattr(args, "batch_size", _EXTRACT_PATCHES_BATCH_SIZE)

    with open(diff_data_path) as f:
        diff_data = json.load(f)
    all_files: list[str] = diff_data.get("files_to_review", [])

    run_kwargs: dict[str, Any] = {"capture_output": False, "text": True, "check": False}
    if workdir:
        run_kwargs["cwd"] = workdir

    # Strip any embedded pathspec (-- file1 file2) from diff_scope since we add explicit file lists
    range_scope = diff_scope.split(" -- ")[0] if " -- " in diff_scope else diff_scope
    range_parts = range_scope.split()

    full_patch_name = "patches_all.txt"
    full_patch_path = cr_dir / full_patch_name

    if len(all_files) > _EXTRACT_PATCHES_BATCH_THRESHOLD:
        first_batch = True
        for i in range(0, len(all_files), batch_size):
            batch_files = all_files[i : i + batch_size]
            cmd = ["git", "diff"] + range_parts + ["--"] + batch_files
            mode = "w" if first_batch else "a"
            with open(full_patch_path, mode) as out:
                subprocess.run(cmd, stdout=out, stderr=subprocess.DEVNULL, **run_kwargs)
            first_batch = False
    else:
        cmd = ["git", "diff"] + range_parts
        if all_files:
            cmd += ["--"] + all_files
        with open(full_patch_path, "w") as out:
            subprocess.run(cmd, stdout=out, stderr=subprocess.DEVNULL, **run_kwargs)

    json.dump({"full_patch": full_patch_name}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# CLI config: declarative subparser/argument definitions live in config/cli.json.
# The loader below resolves $$NAME references to imported constants/computed
# choices and routes args into mutually-exclusive groups where declared.
_CLI_CONFIG_PATH = Path(__file__).parent / "config" / "cli.json"

_CLI_TYPE_MAP: dict[str, type] = {"int": int, "float": float, "str": str}


@functools.lru_cache(maxsize=1)
def _load_cli_config() -> dict[str, Any]:
    return json.loads(_CLI_CONFIG_PATH.read_text())


def _resolve_cli_constant(name: str) -> Any:
    """Resolve a $$NAME reference from cli.json to its runtime value.

    Centralizing the map here means constant edits at the import site propagate
    without touching cli.json. Adding a new constant slot requires both an
    entry here and a matching ``"$$NAME"`` reference in cli.json.
    """
    if name == "DEFAULT_MAX_BHA_AGENTS":
        return DEFAULT_MAX_BHA_AGENTS
    if name == "SIGNAL_EXTRACTION_MODEL_DEFAULT":
        return SIGNAL_EXTRACTION_MODEL_DEFAULT
    if name == "COVERAGE_CRITIC_MODEL_DEFAULT":
        return COVERAGE_CRITIC_MODEL_DEFAULT
    if name == "BUDGET_TOTAL_CAP_DEFAULT":
        return BUDGET_TOTAL_CAP_DEFAULT
    if name == "CACHE_GC_TTL_DAYS_DEFAULT":
        return CACHE_GC_TTL_DAYS_DEFAULT
    if name == "CACHE_GC_MAX_PER_FILE_DEFAULT":
        return CACHE_GC_MAX_PER_FILE_DEFAULT
    if name == "_EXTRACT_PATCHES_BATCH_SIZE":
        return _EXTRACT_PATCHES_BATCH_SIZE
    if name == "COVERAGE_SCOPES_SORTED":
        return sorted(COVERAGE_SCOPES)
    raise KeyError(f"unknown CLI constant reference: $${name}")


def _resolve_cli_value(val: Any) -> Any:
    if isinstance(val, str) and val.startswith("$$"):
        return _resolve_cli_constant(val[2:])
    return val


@functools.lru_cache(maxsize=1)
def _cli_cmd_registry() -> dict[str, Any]:
    """Allowlist registry mapping cmd_* function names to their callables.

    Restricts ``func`` resolution in cli.json to module-level functions whose
    name begins with ``cmd_``. The previous direct ``globals()`` lookup made
    every name in the module's namespace — imported modules, internal helpers,
    constants — reachable as a subcommand handler. The cmd_ prefix is the
    convention every subcommand handler follows; nothing else should be a valid
    func target.
    """
    return {
        name: obj
        for name, obj in globals().items()
        if name.startswith("cmd_") and callable(obj)
    }


def _register_subparsers(subparsers: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    """Register all subcommands by loading config/cli.json.

    Per-subparser entries declare flags, types, defaults, choices, action,
    help text, and the cmd_* callable name resolved against this module's
    globals. Computed defaults and computed choices that come from imported
    constants (DEFAULT_MAX_BHA_AGENTS, sorted(COVERAGE_SCOPES), etc.) are
    encoded in cli.json as ``"$$NAME"`` strings and resolved via
    _resolve_cli_constant below — so a constant value change at the import
    site propagates everywhere without editing cli.json.

    Mutually exclusive groups (one parser currently uses them) declare
    the participating flags under mutex_groups and the loader routes
    those args into the group instead of the main parser.
    """
    cfg = _load_cli_config()
    for parser_spec in cfg["parsers"]:
        name = parser_spec["name"]
        sub_p = subparsers.add_parser(name, help=parser_spec.get("help"))
        mutex_routes: dict[str, Any] = {}
        for grp_spec in parser_spec.get("mutex_groups", []):
            grp = sub_p.add_mutually_exclusive_group()
            for flag in grp_spec["actions"]:
                mutex_routes[flag] = grp
        for arg in parser_spec.get("args", []):
            flags = arg["flags"]
            target = mutex_routes.get(flags[0], sub_p)
            kwargs: dict[str, Any] = {}
            if arg.get("required"):
                kwargs["required"] = True
            if "default" in arg:
                kwargs["default"] = _resolve_cli_value(arg["default"])
            if arg.get("action") == "store_true":
                kwargs["action"] = "store_true"
            if arg.get("nargs"):
                kwargs["nargs"] = arg["nargs"]
            if "type" in arg:
                kwargs["type"] = _CLI_TYPE_MAP[arg["type"]]
            if "choices" in arg:
                kwargs["choices"] = _resolve_cli_value(arg["choices"])
            if "help" in arg:
                kwargs["help"] = arg["help"]
            target.add_argument(*flags, **kwargs)
        # Resolve the subcommand handler through the cmd_* allowlist registry.
        # Raising at config-load time (vs ``globals()[...]`` KeyError) keeps the
        # diagnostic clean: a mistyped func name in cli.json no longer escapes
        # as an unhandled traceback past main()'s except block.
        registry = _cli_cmd_registry()
        func_name = parser_spec["func"]
        if func_name not in registry:
            raise ValueError(
                f"cli.json parser {parser_spec['name']!r} references unknown "
                f"command function {func_name!r} (must be a cmd_* callable in "
                f"code_review_helpers)",
            )
        extra_defaults = parser_spec.get("extra_defaults", {})
        if "func" in extra_defaults:
            raise ValueError(
                f"cli.json parser {parser_spec['name']!r} extra_defaults must "
                f"not include 'func' (use the parser-level 'func' field)",
            )
        defaults: dict[str, Any] = {"func": registry[func_name]}
        defaults.update(extra_defaults)
        sub_p.set_defaults(**defaults)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Code review deterministic helpers"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    _register_subparsers(subparsers)

    args = parser.parse_args()
    try:
        return args.func(args)
    except (subprocess.CalledProcessError, json.JSONDecodeError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
