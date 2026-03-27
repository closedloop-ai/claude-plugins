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
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
from collections.abc import Generator
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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

# Fast-path routing thresholds
FAST_PATH_MAX_LOC = 150
FAST_PATH_MAX_FILES = 5

# Validation thresholds
CONFIDENCE_DISCARD_THRESHOLD = 0.5
LINE_TOLERANCE = 3
JACCARD_DEDUP_THRESHOLD = 0.6

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
    include_patch_lines = not args.no_patch_lines
    if len(files_to_review) > U0_FILE_THRESHOLD:
        all_ranges: dict[str, dict[str, list[list[int]]]] = {}
        all_patch_lines: dict[str, dict[str, dict[str, str]]] = {}
        for i in range(0, len(files_to_review), U0_BATCH_SIZE):
            batch = files_to_review[i : i + U0_BATCH_SIZE]
            u0_raw = _run_git(
                ["diff", "-U0"] + scope_args + ["--"] + batch, workdir
            )
            ranges, plines = _parse_u0_output(u0_raw, include_patch_lines)
            all_ranges.update(ranges)
            all_patch_lines.update(plines)
        changed_ranges = all_ranges
        patch_lines = all_patch_lines
    else:
        u0_raw = _run_git(["diff", "-U0"] + scope_args, workdir)
        changed_ranges, patch_lines = _parse_u0_output(u0_raw, include_patch_lines)

    result = {
        "files_to_review": files_to_review,
        "file_statuses": file_statuses,
        "file_loc": file_loc,
        "total_loc": total_loc,
        "changed_ranges": changed_ranges,
    }
    if include_patch_lines:
        result["patch_lines"] = patch_lines

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
        "issue": f"[P1] Sensitive file — {basename} may contain secrets",
        "explanation": f"File '{filepath}' matches a sensitive file pattern.",
        "recommendation": "Verify this file does not contain credentials or secrets. Consider using a secrets manager.",
        "priority": 1,
        "confidence": 0.9,
    }]


def cmd_hygiene(args: argparse.Namespace) -> int:
    """Execute hygiene subcommand."""
    diff_data_path: str | None = getattr(args, "diff_data", None)
    diff_data = json.load(open(diff_data_path)) if diff_data_path else json.load(sys.stdin)
    file_statuses: dict[str, str] = diff_data.get("file_statuses", {})
    changed_ranges: dict[str, dict[str, list[list[int]]]] = diff_data.get("changed_ranges", {})
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {})
    workdir: str | None = args.workdir

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

    json.dump({"findings": findings}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: partition
# ---------------------------------------------------------------------------

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

    partitions: list[dict[str, Any]] = []
    test_file_paths: list[str] = [
        str(e["file"]) for e in file_entries if e["is_test"]
    ]

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

    json.dump(
        {"partitions": partitions, "test_file_paths": test_file_paths, "force_merged_count": force_merged_count},
        sys.stdout,
        indent=2,
    )
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
    """Execute route subcommand."""
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

    fast_path = (
        total_loc <= FAST_PATH_MAX_LOC
        and len(files_to_review) <= FAST_PATH_MAX_FILES
        and not selected_domain_critics
    )

    json.dump(
        {
            "size_category": size_category,
            "total_loc": total_loc,
            "fast_path": fast_path,
            "models": models,
            "high_risk_files": high_risk_files,
            "domain_critics": selected_domain_critics,
            "max_bha_agents": max_bha_agents,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


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
) -> list[dict[str, Any]]:
    """Phases 2-4: Filter by file scope, line range, and confidence."""
    result: list[dict[str, Any]] = []

    for finding in findings:
        filepath = str(finding.get("file", ""))
        if filepath not in files_to_review:
            discarded.append({"finding": finding, "reason": "DISCARD_FILE_NOT_CHANGED"})
            continue

        line = int(finding.get("line", 0))
        priority = int(finding.get("priority", 2))
        confidence = float(finding.get("confidence", 1.0))

        file_ranges = changed_ranges.get(filepath, {})
        added = file_ranges.get("added", [])
        removed = file_ranges.get("removed", [])

        in_range = _line_in_range(line, added) or _line_in_range(line, removed)
        if not in_range and priority > 1:
            discarded.append({"finding": finding, "reason": "DISCARD_LINE_NOT_CHANGED"})
            continue

        if priority > 1 and confidence < CONFIDENCE_DISCARD_THRESHOLD:
            discarded.append({"finding": finding, "reason": "DISCARD_LOW_CONFIDENCE"})
            continue

        result.append(finding)

    return result


def _merge_duplicates(
    findings: list[dict[str, Any]],
    discarded: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Phases 5-6: Duplicate merge + root-cause dedup."""
    merged: list[dict[str, Any]] = []

    for finding in findings:
        filepath = str(finding.get("file", ""))
        line = int(finding.get("line", 0))
        category = str(finding.get("category", ""))
        recommendation = str(finding.get("recommendation", ""))
        sev = str(finding.get("severity", "MEDIUM"))

        is_dup = False
        for existing in merged:
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

    # Root-cause dedup via Jaccard similarity
    final: list[dict[str, Any]] = []
    for finding in merged:
        issue = str(finding.get("issue", ""))
        filepath = str(finding.get("file", ""))
        line = int(finding.get("line", 0))
        sev = str(finding.get("severity", "MEDIUM"))

        is_root_dup = False
        for existing in final:
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

    Groups findings across different files that share the same category
    and similar issue text (Jaccard > threshold). Keeps the highest-severity
    finding as primary and attaches others as ``other_locations``.
    """
    absorbed: set[int] = set()
    result: list[dict[str, Any]] = []

    for i, finding in enumerate(findings):
        if i in absorbed:
            continue

        category = str(finding.get("category", ""))
        issue = str(finding.get("issue", ""))

        # Collect cross-file siblings
        siblings: list[tuple[int, dict[str, Any]]] = []
        for j in range(i + 1, len(findings)):
            if j in absorbed:
                continue
            other = findings[j]
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

    discarded: list[dict[str, Any]] = []
    total_input = len(raw_findings)

    normalized, normalization_warnings, non_standard_values = _normalize_findings(
        raw_findings, discarded
    )
    filtered = _filter_scope_and_range(normalized, files_to_review, changed_ranges, discarded)
    deduped = _merge_duplicates(filtered, discarded)
    validated = _group_cross_file(deduped)

    cross_file_grouped = sum(
        len(f.get("other_locations", [])) for f in validated
    )

    stats = {
        "total_input": total_input,
        "validated": len(validated),
        "cross_file_grouped": cross_file_grouped,
        "discarded_file_not_changed": sum(1 for d in discarded if d["reason"] == "DISCARD_FILE_NOT_CHANGED"),
        "discarded_line_not_changed": sum(1 for d in discarded if d["reason"] == "DISCARD_LINE_NOT_CHANGED"),
        "discarded_low_confidence": sum(1 for d in discarded if d["reason"] == "DISCARD_LOW_CONFIDENCE"),
        "discarded_low_severity": sum(1 for d in discarded if d["reason"] == "DISCARD_LOW_SEVERITY"),
        "discarded_duplicate": sum(1 for d in discarded if d["reason"] == "DISCARD_DUPLICATE"),
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
    """Legacy V1 cache-check path."""
    manifest_file_existed = (cache_dir / CACHE_MANIFEST_FILENAME).exists()
    manifest = _load_manifest(cache_dir)

    cached_files: list[str] = []
    uncached_files: list[str] = []
    cached_findings: list[dict[str, Any]] = []

    for filepath in files_to_review:
        file_patch = patch_lines.get(filepath, {})
        patch_hash = _compute_patch_hash(filepath, file_patch)
        entry = manifest.get(filepath)

        if entry and isinstance(entry, dict) and _entry_matches(
            entry, schema_version, model_id, prompt_hash, patch_hash
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

                if entry and isinstance(entry, dict) and _entry_matches_v2(
                    entry, model_id, prompt_hash, patch_hash, context_key,
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
    """Legacy V1 cache-update path."""
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

        path = finding.get("file", "")
        line = int(finding.get("line", 0))

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


def cmd_review_state_read(args: argparse.Namespace) -> int:
    """Read review state for a branch:base key. Outputs JSON or empty."""
    cache_dir = Path(args.cache_dir)
    key = args.key
    lock_path = cache_dir / CACHE_LOCK_FILENAME

    try:
        with _manifest_lock(lock_path, exclusive=False):
            state = _load_review_state(cache_dir)
            reviews = state.get("reviews", {})
            entry = reviews.get(key)

            if entry and isinstance(entry, dict):
                json.dump(entry, sys.stdout)
                sys.stdout.write("\n")
            else:
                print("{}")
    except Exception as exc:
        print(f"Warning: review-state-read failed: {exc}", file=sys.stderr)
        print("{}")

    return 0


def cmd_review_state_write(args: argparse.Namespace) -> int:
    """Write review state entry. Atomic write via tmp+rename."""
    cache_dir = Path(args.cache_dir)
    key = args.key
    sha: str | None = getattr(args, "sha", None)
    ref: str | None = getattr(args, "ref", None)

    if not sha and not ref:
        print("Error: one of --sha or --ref is required", file=sys.stderr)
        return 1

    if ref and not sha:
        try:
            sha = _run_git(["rev-parse", ref]).strip()
        except subprocess.CalledProcessError as exc:
            print(f"Error: git rev-parse {ref} failed: {exc}", file=sys.stderr)
            return 1

    lock_path = cache_dir / CACHE_LOCK_FILENAME

    try:
        with _manifest_lock(lock_path, exclusive=True):
            state = _load_review_state(cache_dir)
            reviews = state.setdefault("reviews", {})
            reviews[key] = {
                "sha": sha,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "success": True,
            }
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


def cmd_compute_hashes(args: argparse.Namespace) -> int:
    """Compute prompt hash and context key for cache operations."""
    shared_prompt: str = args.shared_prompt
    bha_suffix: str = args.bha_suffix
    diff_tip: str = args.diff_tip
    base_ref: str = args.base_ref

    # Read both files and hash together
    content = b""
    try:
        with open(shared_prompt, "rb") as f:
            content += f.read()
    except OSError as exc:
        print(f"Error: cannot read shared prompt: {exc}", file=sys.stderr)
        return 1
    try:
        with open(bha_suffix, "rb") as f:
            content += f.read()
    except OSError as exc:
        print(f"Error: cannot read BHA suffix: {exc}", file=sys.stderr)
        return 1

    prompt_hash = hashlib.sha256(content).hexdigest()

    # Compute context key via git merge-base
    context_key = ""
    try:
        context_key = _run_git(["merge-base", diff_tip, f"origin/{base_ref}"]).strip()
    except subprocess.CalledProcessError:
        pass

    json.dump(
        {"prompt_hash": prompt_hash, "context_key": context_key},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: auto-incremental
# ---------------------------------------------------------------------------


def cmd_auto_incremental(args: argparse.Namespace) -> int:  # noqa: PLR0911
    """Evaluate auto-incremental eligibility. Outputs JSON with diff_scope and review_mode_line."""
    cache_dir: str = args.cache_dir
    key: str = args.key
    diff_tip: str = args.diff_tip
    original_scope: str = args.original_scope
    full_review: bool = args.full_review.lower() == "true" if args.full_review else False
    since_last_review: bool = args.since_last_review.lower() == "true" if args.since_last_review else False
    mode: str = args.mode

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


def cmd_collect_findings(args: argparse.Namespace) -> int:
    """Merge agent findings and hygiene findings into a single JSON file."""
    cr_dir = Path(args.cr_dir)
    output_filename: str = args.output
    hygiene_path: str | None = getattr(args, "hygiene", None)

    findings: list[Any] = []
    agent_files: list[str] = []

    # Glob agent_*.json files in cr_dir
    for agent_file in sorted(cr_dir.glob("agent_*.json")):
        try:
            with open(agent_file) as f:
                data = json.load(f)
            file_findings = data.get("findings", [])
            if not isinstance(file_findings, list):
                raise ValueError(f"findings is not a list in {agent_file}")
            findings.extend(file_findings)
            agent_files.append(str(agent_file))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"Warning: skipping malformed agent file {agent_file}: {exc}", file=sys.stderr)

    # Read hygiene.json if provided
    hygiene_included = False
    if hygiene_path:
        try:
            with open(hygiene_path) as f:
                hygiene_data = json.load(f)
            hygiene_findings = hygiene_data.get("findings", [])
            if isinstance(hygiene_findings, list):
                findings.extend(hygiene_findings)
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
# Subcommand: verdict
# ---------------------------------------------------------------------------

_VERDICT_REASON_MAX = 80


def cmd_verdict(args: argparse.Namespace) -> int:
    """Compute PR verdict from validated findings."""
    validate_output_path: str = args.validate_output

    try:
        with open(validate_output_path) as f:
            validate_output = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Error reading validate output: {exc}", file=sys.stderr)
        return 1

    validated: list[dict[str, Any]] = validate_output.get("validated", [])

    verdict = "approve"
    reason = ""

    # Priority 1: BLOCKING findings or Premise P0 -> decline
    for finding in validated:
        severity = str(finding.get("severity", ""))
        category = str(finding.get("category", ""))
        priority = finding.get("priority", 2)
        if severity == "BLOCKING" or (category == "Premise" and priority == 0):
            verdict = "decline"
            issue = str(finding.get("issue", ""))
            reason = issue[:_VERDICT_REASON_MAX]
            break

    # Priority 2: HIGH findings -> needs_attention (only if not already decline)
    if verdict != "decline":
        for finding in validated:
            severity = str(finding.get("severity", ""))
            if severity == "HIGH":
                verdict = "needs_attention"
                issue = str(finding.get("issue", ""))
                reason = issue[:_VERDICT_REASON_MAX]
                break

    tag_payload = json.dumps({"verdict": verdict, "reason": reason})
    tag = f"<pr_verdict>{tag_payload}</pr_verdict>"

    json.dump(
        {"verdict": verdict, "reason": reason, "tag": tag},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Subcommand: prep-assets
# ---------------------------------------------------------------------------


def cmd_prep_assets(args: argparse.Namespace) -> int:
    """Copy prompt assets from plugin to CR_DIR."""
    plugin_root = Path(args.plugin_root)
    cr_dir = Path(args.cr_dir)

    shared_src = plugin_root / "tools" / "prompts" / "shared_prompt.txt"
    bha_src = plugin_root / "tools" / "prompts" / "bha_suffix.txt"

    shared_dst = cr_dir / "shared_prompt.txt"
    bha_dst = cr_dir / "bha_suffix.txt"

    shutil.copy2(shared_src, shared_dst)
    shutil.copy2(bha_src, bha_dst)

    json.dump(
        {"shared_prompt": str(shared_dst), "bha_suffix": str(bha_dst)},
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
    """Extract git diff patches to disk files for each partition and full diff."""
    partitions_file = args.partitions_file
    diff_scope: str = args.diff_scope
    cr_dir = Path(args.cr_dir)
    diff_data_path: str = args.diff_data
    workdir: str | None = getattr(args, "workdir", None)
    batch_size: int = getattr(args, "batch_size", _EXTRACT_PATCHES_BATCH_SIZE)

    # Read partitions for per-partition patches
    if partitions_file is not None:
        with open(partitions_file) as f:
            pdata = json.load(f)
        partitions: list[dict[str, Any]] = pdata.get("partitions", [])
    else:
        partitions = []

    # Read full diff_data for patches_all.txt (includes cached files too)
    with open(diff_data_path) as f:
        diff_data = json.load(f)
    all_files: list[str] = diff_data.get("files_to_review", [])

    run_kwargs: dict[str, Any] = {"capture_output": False, "text": True, "check": False}
    if workdir:
        run_kwargs["cwd"] = workdir

    # Strip any embedded pathspec (-- file1 file2) from diff_scope since we add explicit file lists
    range_scope = diff_scope.split(" -- ")[0] if " -- " in diff_scope else diff_scope
    range_parts = range_scope.split()

    # Per-partition patches
    partition_patches: list[str] = []
    for part in partitions:
        part_id = part["id"]
        files_in_part = [entry["file"] for entry in part.get("files", [])]
        patch_name = f"patches_p{part_id}.txt"
        patch_path = cr_dir / patch_name

        cmd = ["git", "diff"] + range_parts + ["--"] + files_in_part
        with open(patch_path, "w") as out:
            subprocess.run(cmd, stdout=out, stderr=subprocess.DEVNULL, **run_kwargs)
        partition_patches.append(patch_name)

    # Full diff (for BHB, Auditor, Premise, Domain Critic)
    full_patch_name = "patches_all.txt"
    full_patch_path = cr_dir / full_patch_name

    if len(all_files) > _EXTRACT_PATCHES_BATCH_THRESHOLD:
        # Batch extraction
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

    json.dump(
        {"partition_patches": partition_patches, "full_patch": full_patch_name},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _register_subparsers(subparsers: argparse._SubParsersAction) -> None:  # type: ignore[type-arg]
    """Register all subcommands."""
    # parse-diff
    p_diff = subparsers.add_parser("parse-diff", help="Parse git diff into structured JSON")
    p_diff.add_argument("--scope", required=True, help='Git diff scope (e.g. "main...HEAD", "--cached")')
    p_diff.add_argument("--workdir", default=None, help="Git working directory")
    p_diff.add_argument("--no-patch-lines", action="store_true", help="Omit patch_lines from output")
    p_diff.set_defaults(func=cmd_parse_diff)

    # hygiene
    p_hyg = subparsers.add_parser("hygiene", help="Run deterministic hygiene checks")
    p_hyg.add_argument("--diff-data", default=None, help="Path to diff_data.json (reads stdin if omitted)")
    p_hyg.add_argument("--workdir", default=None, help="Git working directory for check-ignore")
    p_hyg.set_defaults(func=cmd_hygiene)

    # partition
    p_part = subparsers.add_parser("partition", help="Bin-pack files into partitions")
    p_part.add_argument("--diff-data", default=None, help="Path to diff_data.json (reads stdin if omitted)")
    p_part.add_argument("--loc-budget", type=int, default=400, help="LOC budget per partition")
    p_part.add_argument("--max-files", type=int, default=20, help="Max files per partition")
    p_part.add_argument("--max-bha-agents", type=int, default=DEFAULT_MAX_BHA_AGENTS, help="Max BHA agent partitions (cap enforcement)")
    p_part.set_defaults(func=cmd_partition)

    # route
    p_route = subparsers.add_parser("route", help="Compute risk scores and model routing")
    p_route.add_argument("--diff-data", default=None, help="Path to diff_data.json (reads stdin if omitted)")
    p_route.add_argument("--critic-gates", default=None, help="Path to critic-gates.json")
    p_route.add_argument("--intent", default="mixed", choices=["feature", "fix", "refactor", "mixed"],
                         help="PR intent classification (from classify-intent)")
    p_route.set_defaults(func=cmd_route)

    # validate
    p_val = subparsers.add_parser("validate", help="Normalize, filter, and deduplicate findings")
    p_val.add_argument("--findings", required=True, help="Path to findings JSON file")
    p_val.add_argument("--diff-data", required=True, help="Path to diff data JSON file")
    p_val.set_defaults(func=cmd_validate)

    # cache-check
    p_cc = subparsers.add_parser("cache-check", help="Check BHA cache for previously reviewed files")
    p_cc.add_argument("--cache-dir", required=True, help="Path to cache directory")
    p_cc.add_argument("--diff-data", required=True, help="Path to diff_data.json")
    p_cc.add_argument("--prompt-hash", required=True, help="SHA256 of shared prompt")
    p_cc.add_argument("--model-id", required=True, help="Model identifier (e.g. opus)")
    p_cc.add_argument("--schema-version", type=int, required=True, help="Cache schema version")
    p_cc.add_argument("--output-dir", required=True, help="Directory for output files")
    p_cc.add_argument("--global-cache", type=int, default=0, help="Enable global V2 cache (0 or 1)")
    p_cc.add_argument("--context-key", default="", help="Context key (merge-base SHA)")
    p_cc.set_defaults(func=cmd_cache_check)

    # cache-update
    p_cu = subparsers.add_parser("cache-update", help="Update BHA cache with new findings")
    p_cu.add_argument("--cache-dir", required=True, help="Path to cache directory")
    p_cu.add_argument("--diff-data", required=True, help="Path to diff_data.json")
    p_cu.add_argument("--bha-dir", required=True, help="Directory containing agent_bha_*.json files")
    p_cu.add_argument("--prompt-hash", required=True, help="SHA256 of shared prompt")
    p_cu.add_argument("--model-id", required=True, help="Model identifier (e.g. opus)")
    p_cu.add_argument("--schema-version", type=int, required=True, help="Cache schema version")
    p_cu.add_argument("--reviewed-files", nargs="*", default=[], help="Files that were reviewed")
    p_cu.add_argument("--partitions-file", default=None, help="Path to partitions JSON (extracts reviewed files)")
    p_cu.add_argument("--global-cache", type=int, default=0, help="Enable global V2 cache (0 or 1)")
    p_cu.add_argument("--context-key", default="", help="Context key (merge-base SHA)")
    p_cu.add_argument("--gc-ttl-days", type=int, default=CACHE_GC_TTL_DAYS_DEFAULT, help="GC TTL in days")
    p_cu.add_argument("--gc-max-per-file", type=int, default=CACHE_GC_MAX_PER_FILE_DEFAULT, help="Max cache entries per file")
    p_cu.add_argument("--exclude-test-partitions", action="store_true",
                      help="Skip caching files from is_test_only partitions")
    p_cu.set_defaults(func=cmd_cache_update)

    # post-comments
    p_pc = subparsers.add_parser("post-comments", help="Post inline review comments to GitHub PR")
    p_pc.add_argument("--findings", required=True, help="Path to code-review-findings.json")
    p_pc.add_argument("--repo", default=None, help="owner/repo (defaults to GITHUB_REPOSITORY env)")
    p_pc.add_argument("--dry-run", action="store_true", help="Print actions without executing")
    p_pc.set_defaults(func=cmd_post_comments)

    # resolve-threads
    p_rt = subparsers.add_parser("resolve-threads", help="Resolve outdated review threads on GitHub PR")
    p_rt.add_argument("--threads", required=True, help="Path to code-review-threads.json")
    p_rt.add_argument("--dry-run", action="store_true", help="Print actions without executing")
    p_rt.set_defaults(func=cmd_resolve_threads)

    # review-state-read
    p_rsr = subparsers.add_parser("review-state-read", help="Read review state for a branch:base key")
    p_rsr.add_argument("--cache-dir", required=True, help="Path to cache directory")
    p_rsr.add_argument("--key", required=True, help="State key (branch:base_ref)")
    p_rsr.set_defaults(func=cmd_review_state_read)

    # review-state-write
    p_rsw = subparsers.add_parser("review-state-write", help="Write review state entry")
    p_rsw.add_argument("--cache-dir", required=True, help="Path to cache directory")
    p_rsw.add_argument("--key", required=True, help="State key (branch:base_ref)")
    p_rsw.add_argument("--sha", default=None, help="HEAD SHA at time of review")
    p_rsw.add_argument("--ref", default=None, help="Git ref to resolve to SHA (alternative to --sha)")
    p_rsw.set_defaults(func=cmd_review_state_write)

    # session-tokens
    p_st = subparsers.add_parser("session-tokens", help="Sum token usage from session transcript")
    p_st.add_argument("--project-dir", default=None, help="Project directory (defaults to cwd)")
    p_st.add_argument("--start-time", required=True, type=float, help="Epoch seconds when review started")
    p_st.set_defaults(func=cmd_session_tokens)

    # setup
    p_setup = subparsers.add_parser("setup", help="Session setup: start_time, repo_name, current_branch, global_cache")
    p_setup.add_argument("--mode", required=True, choices=["local", "github"], help="Review mode")
    p_setup.add_argument("--cr-dir-prefix", default=None,
                         help="CR dir prefix (e.g. .closedloop-ai/code-review/cr-); random suffix appended")
    p_setup.set_defaults(func=cmd_setup)

    # resolve-scope
    p_rs = subparsers.add_parser("resolve-scope", help="Resolve diff scope from arguments")
    p_rs.add_argument("--mode", required=True, choices=["local", "github"])
    p_rs.add_argument("--pr-number", type=int, default=None)
    p_rs.add_argument("--scope-args", default="", help="Remaining scope arguments")
    p_rs.add_argument("--base-ref-override", default=None)
    p_rs.add_argument("--setup-json", required=True, help="Path to setup.json")
    p_rs.set_defaults(func=cmd_resolve_scope)

    # fetch-intent
    p_fi = subparsers.add_parser("fetch-intent", help="Fetch intent context for premise review")
    p_fi.add_argument("--pr-number", type=int, default=None)
    p_fi.add_argument("--base-ref", default="main")
    p_fi.add_argument("--diff-tip", default="HEAD")
    p_fi.add_argument("--scope-kind", required=True, choices=["pr", "branch", "staged", "file_paths", "github_pending"])
    p_fi.add_argument("--cr-dir", required=True)
    p_fi.set_defaults(func=cmd_fetch_intent)

    # compute-hashes
    p_ch = subparsers.add_parser("compute-hashes", help="Compute prompt hash and context key")
    p_ch.add_argument("--shared-prompt", required=True, help="Path to shared_prompt.txt")
    p_ch.add_argument("--bha-suffix", required=True, help="Path to bha_suffix.txt")
    p_ch.add_argument("--diff-tip", required=True, help="Git ref for diff tip (e.g. HEAD, origin/branch)")
    p_ch.add_argument("--base-ref", required=True, help="Base ref name (e.g. main)")
    p_ch.set_defaults(func=cmd_compute_hashes)

    # auto-incremental
    p_ai = subparsers.add_parser("auto-incremental", help="Evaluate auto-incremental eligibility")
    p_ai.add_argument("--cache-dir", default="", help="Path to cache directory")
    p_ai.add_argument("--key", required=True, help="State key (branch:base_ref)")
    p_ai.add_argument("--diff-tip", required=True, help="Git ref for diff tip")
    p_ai.add_argument("--base-ref", default="main", help="Base ref name")
    p_ai.add_argument("--original-scope", required=True, help="Original DIFF_SCOPE value")
    p_ai.add_argument("--full-review", default="false", help="true if --full-review flag set")
    p_ai.add_argument("--since-last-review", default="false", help="true if --since-last-review flag set")
    p_ai.add_argument("--mode", default="local", help="Review mode (local or github)")
    p_ai.set_defaults(func=cmd_auto_incremental)

    # finalize-cache
    p_fc = subparsers.add_parser("finalize-cache", help="Resolve final CACHE_DIR from setup.json")
    p_fc.add_argument("--setup-json", required=True, help="Path to setup.json")
    p_fc.add_argument("--mode", required=True, help="Review mode (local or github)")
    p_fc.add_argument("--pr-number", default=None, help="PR number (if reviewing a PR)")
    p_fc.set_defaults(func=cmd_finalize_cache)

    # footer
    p_footer = subparsers.add_parser("footer", help="Compute review footer with timing and token stats")
    p_footer.add_argument("--start-time", required=True, type=float, help="Epoch seconds when review started")
    p_footer.add_argument("--cache-result", default=None, help="Path to cache_result.json")
    p_footer.add_argument("--review-mode-line", default=None, help="Review mode line (falls back to cr-dir/auto_incremental.json)")
    p_footer.add_argument("--cr-dir", default=None, help="CR session dir (fallback for --review-mode-line)")
    p_footer.set_defaults(func=cmd_footer, project_dir=None)

    # classify-intent
    p_ci = subparsers.add_parser("classify-intent", help="Classify diff intent for model routing")
    p_ci.add_argument("--intent-context", required=True, help="Path to intent_context.json")
    p_ci.add_argument("--diff-data", default=None, help="Path to diff_data.json for file statuses")
    p_ci.set_defaults(func=cmd_classify_intent)

    # collect-findings
    p_cf = subparsers.add_parser("collect-findings", help="Merge agent + hygiene findings")
    p_cf.add_argument("--cr-dir", required=True, help="Directory containing agent_*.json files")
    p_cf.add_argument("--output", default="findings.json", help="Output filename (written to cr-dir)")
    p_cf.add_argument("--hygiene", default=None, help="Path to hygiene.json")
    p_cf.set_defaults(func=cmd_collect_findings)

    # verdict
    p_v = subparsers.add_parser("verdict", help="Compute PR verdict from validated findings")
    p_v.add_argument("--validate-output", required=True, help="Path to validate_output.json")
    p_v.set_defaults(func=cmd_verdict)

    # prep-assets
    p_pa = subparsers.add_parser("prep-assets", help="Copy prompt assets from plugin to CR_DIR")
    p_pa.add_argument("--plugin-root", required=True, help="Resolved CLAUDE_PLUGIN_ROOT path")
    p_pa.add_argument("--cr-dir", required=True, help="Session CR_DIR path")
    p_pa.set_defaults(func=cmd_prep_assets)

    # extract-patches
    p_ep = subparsers.add_parser("extract-patches", help="Extract git diff patches to disk files")
    p_ep.add_argument("--partitions-file", default=None, help="Path to partitions.json")
    p_ep.add_argument("--diff-scope", required=True, help="Git diff scope string")
    p_ep.add_argument("--diff-data", required=True, help="Path to full diff_data.json (for patches_all.txt)")
    p_ep.add_argument("--cr-dir", required=True, help="Output directory for patch files")
    p_ep.add_argument("--workdir", default=None, help="Git working directory")
    p_ep.add_argument("--batch-size", type=int, default=_EXTRACT_PATCHES_BATCH_SIZE, help="Batch size for large diffs")
    p_ep.set_defaults(func=cmd_extract_patches)


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
