#!/usr/bin/env python3
"""
Merge build-validator results into outcomes.log as implementation-subagent signal.

Reads build-result.json and appends a build attribution suffix (|build_passed or
|build_failed) to outcomes.log entries for implementation-subagent patterns in the
current iteration. This lets compute_success_rates.py weigh build results when
computing rates for implementation-subagent patterns.
"""

import argparse
import json
import sys
from pathlib import Path

# Minimum fields in an outcomes.log entry (pipe-delimited)
OUTCOMES_MIN_FIELDS = 6


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Merge build-validator results into outcomes.log"
    )
    parser.add_argument(
        "--workdir",
        required=True,
        help="CLOSEDLOOP_WORKDIR containing .learnings/",
    )

    args = parser.parse_args()
    workdir = Path(args.workdir).resolve()
    learnings_dir = workdir / ".learnings"
    build_result_path = learnings_dir / "build-result.json"
    outcomes_path = learnings_dir / "outcomes.log"

    if not build_result_path.exists():
        print("No build-result.json found, skipping")
        return 0

    if not outcomes_path.exists():
        print("No outcomes.log found, skipping")
        # Clean up build-result.json even if no outcomes
        build_result_path.unlink()
        return 0

    # Read build result
    with open(build_result_path) as f:
        build_result = json.load(f)

    status = build_result.get("status", "")
    iteration = build_result.get("iteration", "")

    if status not in ("passed", "failed"):
        print(f"Unknown build status: {status}, skipping")
        build_result_path.unlink()
        return 0

    suffix = f"|build_{status}"

    # Read and update outcomes.log
    lines = outcomes_path.read_text().splitlines()
    updated_lines: list[str] = []
    updated_count = 0

    for line in lines:
        if not line.strip():
            updated_lines.append(line)
            continue

        parts = line.split("|")
        # Match implementation-subagent entries in this iteration
        # Format: timestamp|run_id|iteration|agent|pattern_trigger|status|...
        if (
            len(parts) >= OUTCOMES_MIN_FIELDS
            and parts[3] == "implementation-subagent"
            and parts[2] == str(iteration)
            and not line.endswith(f"|build_{status}")
            and "|build_passed" not in line
            and "|build_failed" not in line
        ):
            updated_lines.append(line + suffix)
            updated_count += 1
        else:
            updated_lines.append(line)

    # Write back
    outcomes_path.write_text("\n".join(updated_lines) + "\n" if updated_lines else "")

    # Clean up build-result.json
    build_result_path.unlink()

    print(f"Appended {suffix} to {updated_count} implementation-subagent outcomes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
