#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Merge Goal Outcome

Merges goal evaluation outcome into outcomes.log for correlation analysis.
"""

import argparse
import json
import sys
from pathlib import Path

# Log format field indices
OUTCOMES_LOG_MIN_FIELDS = 2  # timestamp|run_id


def load_goal_outcome(outcome_path: Path) -> dict:
    """Load goal outcome from JSON file."""
    if not outcome_path.exists():
        return {}

    with open(outcome_path, 'r') as f:
        return json.load(f)


def merge_into_outcomes_log(log_path: Path, outcome: dict) -> None:
    """Merge goal outcome fields into outcomes.log.

    Appends goal|goal_success|goal_score to each line for the matching run_id.
    """
    if not log_path.exists() or not outcome:
        return

    run_id = outcome.get('run_id', '')
    goal_name = outcome.get('goal', '')
    goal_success = '1' if outcome.get('success', False) else '0'
    goal_score = str(outcome.get('score', 0.0))

    lines = []
    updated_count = 0

    with open(log_path, 'r') as f:
        for line in f:
            line = line.rstrip('\n')
            parts = line.split('|')

            # Format: timestamp|run_id|iteration|agent|pattern|status|file_citations[|relevance|method]
            if len(parts) >= OUTCOMES_LOG_MIN_FIELDS and parts[1] == run_id:
                # Check if goal fields already appended
                if not any('goal_' in p for p in parts):
                    line = f"{line}|{goal_name}|{goal_success}|{goal_score}"
                    updated_count += 1

            lines.append(line + '\n')

    # Write back atomically
    tmp_path = log_path.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        f.writelines(lines)
    tmp_path.rename(log_path)

    print(f"Updated {updated_count} entries in outcomes.log with goal outcome")


def main():
    parser = argparse.ArgumentParser(description='Merge goal outcome into outcomes.log')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--outcome-file', help='JSON file with goal outcome (default: .learnings/goal-outcome.json)')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    learnings_dir = workdir / '.learnings'

    # Load goal outcome
    outcome_file = Path(args.outcome_file) if args.outcome_file else learnings_dir / 'goal-outcome.json'
    outcome = load_goal_outcome(outcome_file)

    if not outcome:
        print("No goal outcome to merge")
        return 0

    # Merge into outcomes.log
    merge_into_outcomes_log(learnings_dir / 'outcomes.log', outcome)

    return 0


if __name__ == '__main__':
    sys.exit(main())
