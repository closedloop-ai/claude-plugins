#!/usr/bin/env python3
"""
Write merge-result.json to org-patterns.toon (deterministic serialization).

Reads the LLM-produced merge-result.json and converts it to valid TOON format
using the same parse/serialize functions as compute_success_rates.py. This
separates the LLM reasoning (dedup, validation, merge) from the mechanical
serialization step that LLMs struggle with at scale.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# Import TOON helpers from sibling module
from compute_success_rates import parse_toon_patterns, serialize_toon

# --- Constants ---

CLOSEDLOOP_STATE_DIR = ".closedloop-ai"
DEFAULT_TOON_PATH = Path.home() / CLOSEDLOOP_STATE_DIR / "learnings" / "org-patterns.toon"
PATTERN_CAP = 50

VALID_CATEGORIES = {"mistake", "pattern", "convention", "insight"}
VALID_CONFIDENCES = {"high", "medium", "low"}
VALID_FLAGS = {"[UNTESTED]", "[REVIEW]", "[STALE]", "[PRUNE]", ""}
ID_PATTERN = re.compile(r"^P-\d{3,}$")

REQUIRED_FIELDS = [
    "id", "category", "summary", "confidence", "seen_count",
    "success_rate", "flags", "applies_to", "context", "repo",
]

DEFAULT_HEADER = [
    "# Organization Patterns (TOON format)",
    f"# Last updated: {__import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
    "",
    "patterns[0]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:",
]

# Priority sort: trim by staleness/prune flags only — confidence is earned through
# exposure, so we never deprioritize low-confidence patterns (they'd never get seen).
FLAGS_ORDER = {"": 0, "[UNTESTED]": 0, "[REVIEW]": 1, "[STALE]": 2, "[PRUNE]": 3}


def validate_pattern(pattern: dict, index: int) -> list[str]:
    """Validate a single pattern dict, returning a list of error strings."""
    errors: list[str] = []

    for field in REQUIRED_FIELDS:
        if field not in pattern:
            errors.append(f"Pattern {index}: missing field '{field}'")

    if "id" in pattern and not ID_PATTERN.match(pattern["id"]):
        errors.append(f"Pattern {index} (id={pattern.get('id')}): id must match P-NNN (3+ digits)")

    if "category" in pattern and pattern["category"] not in VALID_CATEGORIES:
        errors.append(f"Pattern {index} (id={pattern.get('id')}): invalid category '{pattern['category']}' (valid: {VALID_CATEGORIES})")

    if "confidence" in pattern and pattern["confidence"] not in VALID_CONFIDENCES:
        errors.append(f"Pattern {index} (id={pattern.get('id')}): invalid confidence '{pattern['confidence']}' (valid: {VALID_CONFIDENCES})")

    if "flags" in pattern and pattern["flags"] not in VALID_FLAGS:
        errors.append(f"Pattern {index} (id={pattern.get('id')}): invalid flags '{pattern['flags']}' (valid: {VALID_FLAGS})")

    if "seen_count" in pattern:
        try:
            val = int(pattern["seen_count"])
            if val < 0:
                errors.append(f"Pattern {index} (id={pattern.get('id')}): seen_count must be non-negative")
        except (ValueError, TypeError):
            errors.append(f"Pattern {index} (id={pattern.get('id')}): seen_count '{pattern['seen_count']}' not parseable as integer")

    if "success_rate" in pattern:
        sr = pattern["success_rate"]
        if sr != "":
            try:
                val = float(sr)
                if not (0.0 <= val <= 1.0):
                    errors.append(f"Pattern {index} (id={pattern.get('id')}): success_rate {val} not in [0.0, 1.0]")
            except (ValueError, TypeError):
                errors.append(f"Pattern {index} (id={pattern.get('id')}): success_rate '{sr}' not parseable as float")

    return errors


def priority_sort_key(pattern: dict) -> tuple:
    """Sort key: trim by staleness only. PRUNE/STALE sort last, everything else equal.

    Within the same flag tier, sort by seen_count descending so more-observed
    patterns are kept when trimming at the cap boundary.
    """
    flag = FLAGS_ORDER.get(pattern.get("flags", ""), 0)
    try:
        seen = -int(pattern.get("seen_count", "0"))
    except (ValueError, TypeError):
        seen = 0
    return (flag, seen)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Write merge-result.json to org-patterns.toon (deterministic)"
    )
    parser.add_argument(
        "--merge-result",
        required=True,
        help="Path to merge-result.json produced by process-learnings",
    )
    parser.add_argument(
        "--toon-path",
        default=None,
        help=f"Path to org-patterns.toon (default: {DEFAULT_TOON_PATH})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print TOON output without writing to disk",
    )

    args = parser.parse_args()

    merge_result_path = Path(args.merge_result)
    toon_path = Path(args.toon_path) if args.toon_path else DEFAULT_TOON_PATH

    # Read merge-result.json
    if not merge_result_path.exists():
        print(f"Error: merge-result.json not found at {merge_result_path}", file=sys.stderr)
        return 1

    with open(merge_result_path) as f:
        merge_data = json.load(f)

    patterns_raw = merge_data.get("patterns", [])
    stats = merge_data.get("stats", {})

    if not patterns_raw:
        print("No patterns in merge-result.json, nothing to write")
        return 0

    # Validate all patterns
    all_errors: list[str] = []
    for i, p in enumerate(patterns_raw):
        all_errors.extend(validate_pattern(p, i))

    if all_errors:
        print("Validation errors in merge-result.json:", file=sys.stderr)
        for err in all_errors:
            print(f"  {err}", file=sys.stderr)
        return 1

    # Convert string fields to proper types for TOON serialization
    patterns = []
    for p in patterns_raw:
        patterns.append({
            "id": str(p["id"]),
            "category": str(p["category"]),
            "summary": str(p["summary"]),
            "confidence": str(p["confidence"]),
            "seen_count": str(p["seen_count"]),
            "success_rate": str(p["success_rate"]),
            "flags": str(p["flags"]),
            "applies_to": str(p["applies_to"]),
            "context": str(p["context"]),
            "repo": str(p.get("repo", "*")),
        })

    # Priority sort and cap at PATTERN_CAP
    patterns.sort(key=priority_sort_key)
    dropped = 0
    if len(patterns) > PATTERN_CAP:
        dropped = len(patterns) - PATTERN_CAP
        patterns = patterns[:PATTERN_CAP]
        print(f"Warning: {dropped} patterns dropped to enforce {PATTERN_CAP}-pattern cap", file=sys.stderr)

    # Read existing TOON for header preservation
    if toon_path.exists():
        header_lines, _ = parse_toon_patterns(toon_path)
    else:
        header_lines = list(DEFAULT_HEADER)

    # Serialize
    output = serialize_toon(header_lines, patterns)

    if args.dry_run:
        print("=== Dry run - would write: ===")
        print(output)
        _print_summary(stats, len(patterns), dropped)
        return 0

    # Ensure parent directory exists
    toon_path.parent.mkdir(parents=True, exist_ok=True)

    # Create .bak backup before overwriting
    if toon_path.exists():
        bak_path = toon_path.with_suffix(".bak")
        bak_path.write_text(toon_path.read_text())

    # Atomic write: .tmp then rename
    tmp_path = toon_path.with_suffix(".tmp")
    tmp_path.write_text(output)
    os.rename(str(tmp_path), str(toon_path))

    _print_summary(stats, len(patterns), dropped)

    # Clean up merge-result.json on success
    merge_result_path.unlink()

    return 0


def _print_summary(stats: dict, total: int, dropped: int) -> None:
    """Print a human-readable summary."""
    added = stats.get("added", 0)
    merged = stats.get("merged", 0)
    pruned = stats.get("pruned", 0)
    rejected = stats.get("rejected", 0)
    cl_extracted = stats.get("closedloop_extracted", 0)

    print(f"TOON write complete: {total} patterns")
    print(f"  Added: {added}, Merged: {merged}, Pruned: {pruned}, Rejected: {rejected}")
    if cl_extracted:
        print(f"  ClosedLoop extracted: {cl_extracted}")
    if dropped:
        print(f"  Dropped (over cap): {dropped}")


if __name__ == "__main__":
    sys.exit(main())
