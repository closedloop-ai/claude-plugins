#!/usr/bin/env python3
"""
ClosedLoop Self-Learning System - Merge Relevance Scores

Merges relevance scores into outcomes.log for weighted success rate calculation.
"""

import argparse
import json
import sys
from pathlib import Path

# Log format field indices
OUTCOMES_LOG_MIN_FIELDS = 5  # timestamp|run_id|iteration|agent|pattern


def load_relevance_scores(relevance_path: Path) -> dict[str, dict]:
    """Load relevance scores from JSON file."""
    if not relevance_path.exists():
        return {}

    with open(relevance_path, 'r') as f:
        scores = json.load(f)

    # Index by pattern_id
    return {s['pattern_id']: s for s in scores}


def merge_into_outcomes_log(log_path: Path, relevance_scores: dict[str, dict]) -> None:
    """Merge relevance scores into outcomes.log.

    Appends relevance_score|relevance_method to each line.
    """
    if not log_path.exists():
        return

    lines = []
    with open(log_path, 'r') as f:
        for line in f:
            line = line.rstrip('\n')
            parts = line.split('|')

            # Format: timestamp|run_id|iteration|agent|pattern|status|file_citations
            if len(parts) >= OUTCOMES_LOG_MIN_FIELDS:
                pattern = parts[4]

                # Check if relevance already appended
                if not any(p.startswith('relevance_') or p.replace('.', '').isdigit()
                          for p in parts[7:] if p):
                    # Look up relevance score
                    # Pattern might be a trigger or ID
                    score_data = None
                    for pid, data in relevance_scores.items():
                        if pattern in pid or pid in pattern:
                            score_data = data
                            break

                    if score_data:
                        score = score_data.get('score', 0.0)
                        method = score_data.get('method', 'unknown')
                        line = f"{line}|{score}|{method}"
                    else:
                        # No relevance data - use default
                        line = f"{line}|0.5|default"

            lines.append(line + '\n')

    # Write back atomically
    tmp_path = log_path.with_suffix('.tmp')
    with open(tmp_path, 'w') as f:
        f.writelines(lines)
    tmp_path.rename(log_path)

    print(f"Updated {len(lines)} entries in outcomes.log with relevance scores")


def main():
    parser = argparse.ArgumentParser(description='Merge relevance scores into outcomes.log')
    parser.add_argument('--workdir', default='.', help='Working directory')
    parser.add_argument('--relevance-file', required=True, help='JSON file with relevance scores')

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    learnings_dir = workdir / '.learnings'

    # Load relevance scores
    relevance_scores = load_relevance_scores(Path(args.relevance_file))

    if not relevance_scores:
        print("No relevance scores to merge")
        return 0

    # Merge into outcomes.log
    merge_into_outcomes_log(learnings_dir / 'outcomes.log', relevance_scores)

    return 0


if __name__ == '__main__':
    sys.exit(main())
