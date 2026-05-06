---
description: Analyzes goal performance across runs, showing pass rates, pattern effectiveness, and improvement trends
---

# Goal Stats Command

Analyzes goal performance by examining runs.log and outcomes.log to compute statistics.

## Metrics Computed

1. **Pass Rate**: Percentage of runs that achieved the active goal
2. **Average Score**: Mean goal score across all evaluated runs
3. **Top Contributing Patterns**: Patterns with highest correlation to success
4. **Underperforming Patterns**: Patterns with high apply rate but low success rate
5. **Improvement Trends**: Score changes over time

## Process

1. Read `runs.log` for run outcomes. Rows are pipe-delimited:
   `run_id|timestamp|goal|iteration|status[|command|last_session_id]`.
   Treat `command` and `last_session_id` as optional append-only fields so
   legacy rows remain valid.
2. Read `outcomes.log` for pattern applications and goal results
3. Correlate pattern usage with goal success/failure
4. Calculate aggregate statistics
5. Identify patterns to review or promote

## Output Format

```
Goal Performance Report: {goal_name}
=====================================

Summary:
  Total Runs: 25
  Pass Rate: 72% (18/25)
  Average Score: 0.68

Top Contributing Patterns:
  1. "auth_flow" - 90% success when applied (10 applications)
  2. "null_check" - 85% success when applied (7 applications)
  3. "api_retry" - 80% success when applied (5 applications)

Patterns to Review [REVIEW]:
  1. "deprecated_api" - 30% success (flagged for review)
  2. "old_pattern" - 25% success (consider removal)

Trends (last 10 runs):
  Score: 0.55 → 0.68 → 0.75 (+36% improvement)
  Pass Rate: 60% → 72% → 80% (+33% improvement)

Recommendations:
  - Pattern "auth_flow" consistently helps - consider promoting to HIGH confidence
  - Pattern "deprecated_api" hurting performance - review or remove
```

## Usage

```bash
# View goal stats (invoked via ClosedLoop orchestrator)
# Requires runs.log and outcomes.log to exist
```

## Dependencies

- `runs.log`: Contains run metadata with goal outcomes and optional command/session correlation
- `outcomes.log`: Contains pattern applications with success tracking
- `goal.yaml`: Defines active goal for filtering

## Notes

- Statistics require at least 5 runs for meaningful analysis
- Patterns need 3+ applications to be included in correlation analysis
- Trends require at least 10 runs for reliable direction indicators
