---
description: Manual command to invoke the pruning script for cleaning up old learnings
---

# Prune Learnings Command

Manually invokes the pruning script to clean up old learnings and rotate log files.

## Purpose

Over time, the learnings system accumulates:
- Old session directories
- Large log files
- Archived pending files

This command runs the pruning script to clean up old data according to retention policy.

## Retention Configuration

Edit `.learnings/retention.yaml` to customize:

```yaml
# Maximum number of runs to keep in runs.log
max_runs: 100

# Maximum number of session directories to keep
max_sessions: 50

# Maximum lines per log file before rotation
max_log_lines: 10000

# Maximum age (days) for archived pending files
max_archive_age_days: 30

# Lock staleness threshold (hours) before force-pruning
lock_stale_hours: 4

# Protected run window (minutes) - recent runs won't be pruned
protected_window_minutes: 30
```

## What Gets Pruned

1. **Session directories**: Oldest sessions beyond `max_sessions` limit
2. **Log files**: Rotated when exceeding `max_log_lines`
   - `runs.log` → `runs.log.1` → deleted
   - `outcomes.log` → `outcomes.log.1` → deleted
   - `acknowledgments.log` → `acknowledgments.log.1` → deleted
3. **Archived pending files**: Older than `max_archive_age_days`
4. **Stale lock files**: Lock files older than `lock_stale_hours`

## Safety Mechanisms

- **Protected runs**: Current run and runs active within `protected_window_minutes` are never pruned
- **Lock checking**: Won't prune if `.learnings/.lock` exists (unless stale)
- **Atomic operations**: Uses atomic file replacement to prevent corruption

## Usage

```bash
# Run pruning script directly
./plugins/self-learning/scripts/prune-learnings.sh

# Or via ClosedLoop orchestrator command
# This is automatically run after each completed run
```

## Automatic Pruning

Pruning runs automatically:
1. After each run completes (in background)
2. Current run is always protected
3. Failures are logged but don't block the run

## Manual Pruning

Use manual pruning when:
- Disk space is low
- You want to clean up before sharing repository
- You've changed retention settings and want immediate effect

## Output

The script outputs:
- Number of sessions pruned
- Number of log lines rotated
- Number of archived files cleaned
- Any errors encountered
