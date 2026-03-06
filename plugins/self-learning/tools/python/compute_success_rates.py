#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Deterministic Success Rate Computation

Reads outcomes.log and updates org-patterns.toon with computed success rates,
confidence levels, and flags. Replaces LLM-based success rate calculation with
deterministic computation.
"""

import argparse
import csv
import io
import re
import sys
from pathlib import Path


# --- TOON parsing ---

# TOON field order (comma-delimited, 10 fields):
# id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo
# Legacy 9-field rows are accepted (repo defaults to "*")
TOON_FIELD_COUNT = 10
TOON_LEGACY_FIELD_COUNT = 9


def _parse_toon_row(row_text: str) -> list[str]:
    """Parse a comma-delimited TOON row, respecting quoted fields."""
    reader = csv.reader(io.StringIO(row_text))
    for row in reader:
        return row
    return []


def parse_toon_patterns(toon_path: Path) -> tuple[list[str], list[dict[str, str]]]:
    """Parse org-patterns.toon, returning header lines and pattern dicts.

    Returns:
        (header_lines, patterns) where header_lines includes comments/blanks/schema
        and patterns is a list of dicts with keys matching field names.
    """
    header_lines: list[str] = []
    patterns: list[dict[str, str]] = []

    if not toon_path.exists():
        return header_lines, patterns

    with open(toon_path, "r") as f:
        for raw_line in f:
            line = raw_line.rstrip("\n")
            stripped = line.strip()

            # Header: comments, blank lines, schema declarations
            if not stripped or stripped.startswith("#") or stripped.startswith("patterns["):
                header_lines.append(line)
                continue

            # Parse comma-delimited TOON row (strip leading indent)
            fields = _parse_toon_row(stripped)
            if len(fields) < TOON_LEGACY_FIELD_COUNT:
                header_lines.append(line)
                continue

            patterns.append({
                "id": fields[0].strip(),
                "category": fields[1].strip(),
                "summary": fields[2].strip(),
                "confidence": fields[3].strip(),
                "seen_count": fields[4].strip(),
                "success_rate": fields[5].strip(),
                "flags": fields[6].strip(),
                "applies_to": fields[7].strip(),
                "context": fields[8].strip(),
                "repo": fields[9].strip() if len(fields) >= TOON_FIELD_COUNT else "*",
            })

    return header_lines, patterns


def _quote_if_needed(value: str) -> str:
    """Quote a TOON field value if it contains commas, quotes, or other special chars."""
    if "," in value or '"' in value or "\n" in value:
        escaped = value.replace('"', '""')
        return f'"{escaped}"'
    return value


def serialize_toon(header_lines: list[str], patterns: list[dict[str, str]]) -> str:
    """Serialize header lines and patterns back to TOON format."""
    lines: list[str] = []

    for h in header_lines:
        # Update the count in the schema declaration if present
        if h.strip().startswith("patterns["):
            lines.append(f"patterns[{len(patterns)}]{{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}}:")
        else:
            lines.append(h)

    for p in patterns:
        # summary is always quoted (contains natural language with commas)
        summary_escaped = p["summary"].replace('"', '""')
        summary_quoted = f'"{summary_escaped}"'
        row = ",".join([
            p["id"],
            p["category"],
            summary_quoted,
            p["confidence"],
            p["seen_count"],
            p["success_rate"],
            _quote_if_needed(p["flags"]),
            p["applies_to"],
            p["context"],
            p.get("repo", "*"),
        ])
        lines.append(f"  {row}")

    # Ensure trailing newline
    text = "\n".join(lines)
    if not text.endswith("\n"):
        text += "\n"
    return text


# --- Outcomes parsing ---

# outcomes.log variable-length fields (pipe-delimited):
# timestamp|run_id|iteration|agent|pattern_trigger|status|citations[|unverified][|relevance_score|method][|goal_name|goal_success|goal_score]
OUTCOMES_MIN_FIELDS = 6
OUTCOMES_CITATIONS_INDEX = 6
OUTCOMES_REMAINING_START = 7

# Matching thresholds
JACCARD_MATCH_THRESHOLD = 0.6

# Confidence thresholds
CONFIDENCE_HIGH_THRESHOLD = 0.70
CONFIDENCE_MEDIUM_THRESHOLD = 0.40

# Staleness threshold (iterations without application)
STALE_ITERATION_GAP = 10

# Auto-prune thresholds
PRUNE_MIN_APPLIED = 20
PRUNE_MAX_SUCCESS_RATE = 0.40


def parse_outcomes_log(log_path: Path) -> list[dict[str, str]]:
    """Parse outcomes.log into a list of outcome dicts."""
    outcomes: list[dict[str, str]] = []

    if not log_path.exists():
        return outcomes

    with open(log_path, "r") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue

            parts = line.split("|")
            if len(parts) < OUTCOMES_MIN_FIELDS:
                continue

            entry: dict[str, str] = {
                "timestamp": parts[0],
                "run_id": parts[1],
                "iteration": parts[2],
                "agent": parts[3],
                "pattern_trigger": parts[4],
                "status": parts[5],
                "citations": parts[OUTCOMES_CITATIONS_INDEX] if len(parts) > OUTCOMES_CITATIONS_INDEX else "",
            }

            # Scan remaining fields for known markers
            remaining = parts[OUTCOMES_REMAINING_START:] if len(parts) > OUTCOMES_REMAINING_START else []
            # "injected" status means pattern was sent to agent but not explicitly applied
            # Treat as unverified since we can't confirm the agent used it
            entry["unverified"] = "1" if ("unverified" in remaining or entry["status"] == "injected") else ""

            # Find relevance_score and method (numeric followed by text)
            for i, field in enumerate(remaining):
                if field == "unverified":
                    continue
                try:
                    float(field)
                    entry["relevance_score"] = field
                    if i + 1 < len(remaining) and remaining[i + 1] != "unverified":
                        entry["relevance_method"] = remaining[i + 1]
                    break
                except ValueError:
                    continue

            # Find goal fields (goal_name|goal_success|goal_score) - look from end
            for i in range(len(remaining) - 2):
                if remaining[i + 1] in ("0", "1"):
                    try:
                        float(remaining[i + 2])
                        entry["goal_name"] = remaining[i]
                        entry["goal_success"] = remaining[i + 1]
                        entry["goal_score"] = remaining[i + 2]
                        break
                    except ValueError:
                        continue

            outcomes.append(entry)

    return outcomes


# --- Matching ---

def jaccard_similarity(a: str, b: str) -> float:
    """Compute Jaccard similarity between two strings (word-level)."""
    words_a = set(re.findall(r"\w+", a.lower()))
    words_b = set(re.findall(r"\w+", b.lower()))
    if not words_a or not words_b:
        return 0.0
    intersection = words_a & words_b
    union = words_a | words_b
    return len(intersection) / len(union)


def match_outcome_to_pattern(outcome_trigger: str, pattern_summary: str) -> bool:
    """Tiered matching: exact -> case-insensitive -> substring -> Jaccard > 0.6."""
    if outcome_trigger == pattern_summary:
        return True
    if outcome_trigger.lower() == pattern_summary.lower():
        return True
    if outcome_trigger.lower() in pattern_summary.lower() or pattern_summary.lower() in outcome_trigger.lower():
        return True
    if jaccard_similarity(outcome_trigger, pattern_summary) > JACCARD_MATCH_THRESHOLD:
        return True
    return False


# --- Success rate computation ---

def compute_rates(
    patterns: list[dict[str, str]],
    outcomes: list[dict[str, str]],
    max_iteration: int,
) -> list[dict[str, str]]:
    """Compute success_rate, confidence, and flags for each pattern.

    Args:
        patterns: Parsed TOON patterns.
        outcomes: Parsed outcomes.log entries.
        max_iteration: The highest iteration number seen (for staleness check).

    Returns:
        Updated patterns list.
    """
    for pattern in patterns:
        summary = pattern["summary"]

        # Find all matching outcomes
        matched = [o for o in outcomes if match_outcome_to_pattern(o["pattern_trigger"], summary)]

        if not matched:
            # No applications - mark as untested
            pattern["flags"] = "[UNTESTED]"
            # Don't overwrite existing success_rate if present
            if not pattern["success_rate"]:
                pattern["success_rate"] = ""
            continue

        # Update seen_count from actual matched outcomes
        pattern["seen_count"] = str(len(matched))

        # Check staleness: no applications in last 10 iterations
        matched_iterations = []
        for o in matched:
            try:
                matched_iterations.append(int(o["iteration"]))
            except (ValueError, KeyError):
                pass

        stale = False
        if matched_iterations and max_iteration > 0:
            latest_application = max(matched_iterations)
            if max_iteration - latest_application >= STALE_ITERATION_GAP:
                stale = True

        # Compute success rate
        total = len(matched)
        has_goal_data = any("goal_success" in o for o in matched)

        if has_goal_data:
            # Goal-weighted mode
            weighted_success = 0.0
            for o in matched:
                if o.get("unverified") == "1":
                    continue

                goal_success = o.get("goal_success")
                if goal_success == "1":
                    weighted_success += 1.0
                elif goal_success == "0":
                    relevance = 0.5  # default
                    if "relevance_score" in o:
                        try:
                            relevance = float(o["relevance_score"])
                        except ValueError:
                            pass
                    weighted_success += relevance * 0.5
                else:
                    # No goal data for this outcome - count as success if not unverified
                    weighted_success += 1.0

            success_rate = weighted_success / total if total > 0 else 0.0
        else:
            # Simple mode: applied without |unverified = success
            successful = sum(1 for o in matched if o.get("unverified") != "1")
            success_rate = successful / total if total > 0 else 0.0

        # Clamp to [0, 1]
        success_rate = max(0.0, min(1.0, success_rate))
        pattern["success_rate"] = f"{success_rate:.2f}"

        # Compute confidence
        if success_rate >= CONFIDENCE_HIGH_THRESHOLD:
            pattern["confidence"] = "high"
        elif success_rate >= CONFIDENCE_MEDIUM_THRESHOLD:
            pattern["confidence"] = "medium"
        else:
            pattern["confidence"] = "low"

        # Assign flags
        applied_count = len(matched)
        if applied_count > PRUNE_MIN_APPLIED and success_rate < PRUNE_MAX_SUCCESS_RATE:
            pattern["flags"] = "[PRUNE]"
        elif stale:
            pattern["flags"] = "[STALE]"
        elif success_rate < CONFIDENCE_MEDIUM_THRESHOLD:
            pattern["flags"] = "[REVIEW]"
        else:
            pattern["flags"] = ""

    return patterns


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compute deterministic success rates for org-patterns.toon"
    )
    parser.add_argument(
        "--workdir",
        required=True,
        help="CLOSEDLOOP_WORKDIR containing .learnings/outcomes.log",
    )
    parser.add_argument(
        "--toon-file",
        default=None,
        help="Path to org-patterns.toon (default: ~/.closedloop-ai/learnings/org-patterns.toon)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print changes without writing",
    )

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    outcomes_path = workdir / ".learnings" / "outcomes.log"
    toon_path = Path(args.toon_file) if args.toon_file else Path.home() / ".closedloop-ai" / "learnings" / "org-patterns.toon"
    # Fall back to legacy location during migration
    if not args.toon_file and not toon_path.exists():
        legacy = Path.home() / ".claude" / ".learnings" / "org-patterns.toon"
        if legacy.exists():
            toon_path = legacy

    # Exit cleanly if files don't exist
    if not toon_path.exists():
        print(f"No TOON file found at {toon_path}", file=sys.stderr)
        return 0

    if not outcomes_path.exists():
        print(f"No outcomes.log found at {outcomes_path}", file=sys.stderr)
        return 0

    # Parse inputs
    header_lines, patterns = parse_toon_patterns(toon_path)
    outcomes = parse_outcomes_log(outcomes_path)

    if not patterns:
        print("No patterns found in TOON file")
        return 0

    if not outcomes:
        print("No outcomes found in outcomes.log")
        return 0

    # Determine max iteration
    max_iteration = 0
    for o in outcomes:
        try:
            it = int(o["iteration"])
            max_iteration = max(max_iteration, it)
        except (ValueError, KeyError):
            pass

    # Compute rates
    updated_patterns = compute_rates(patterns, outcomes, max_iteration)

    # Serialize
    output = serialize_toon(header_lines, updated_patterns)

    if args.dry_run:
        print("=== Dry run - would write: ===")
        print(output)
        return 0

    # Write atomically
    tmp_path = toon_path.with_suffix(".tmp")
    with open(tmp_path, "w") as f:
        f.write(output)
    tmp_path.rename(toon_path)

    print(f"Updated {len(updated_patterns)} patterns in {toon_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
