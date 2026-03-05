#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Pruning Script
# Cleans up old learnings and rotates log files according to retention policy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="${CLOSEDLOOP_WORKDIR:-.}"
LEARNINGS_DIR="$WORKDIR/.learnings"
PROTECTED_RUN_ID="${1:-}"  # First arg can specify a run to protect

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Default retention settings
MAX_RUNS=100
MAX_SESSIONS=50
MAX_LOG_LINES=10000
MAX_ARCHIVE_AGE_DAYS=30
LOCK_STALE_HOURS=4
PROTECTED_WINDOW_MINUTES=30

# Load retention config if exists
load_retention_config() {
    local config_file="$LEARNINGS_DIR/retention.yaml"

    if [[ -f "$config_file" ]] && command -v python3 &> /dev/null; then
        # Parse YAML using Python
        eval "$(python3 -c "
import yaml
import sys
try:
    with open('$config_file') as f:
        config = yaml.safe_load(f) or {}
    print(f'MAX_RUNS={config.get(\"max_runs\", 100)}')
    print(f'MAX_SESSIONS={config.get(\"max_sessions\", 50)}')
    print(f'MAX_LOG_LINES={config.get(\"max_log_lines\", 10000)}')
    print(f'MAX_ARCHIVE_AGE_DAYS={config.get(\"max_archive_age_days\", 30)}')
    print(f'LOCK_STALE_HOURS={config.get(\"lock_stale_hours\", 4)}')
    print(f'PROTECTED_WINDOW_MINUTES={config.get(\"protected_window_minutes\", 30)}')
except:
    pass
" 2>/dev/null)" || true
    fi
}

# Check if lock file exists and is not stale
check_lock() {
    local lock_file="$LEARNINGS_DIR/.lock"

    if [[ ! -f "$lock_file" ]]; then
        return 0  # No lock, safe to proceed
    fi

    # Check lock age
    local lock_age_seconds
    if [[ "$(uname)" == "Darwin" ]]; then
        lock_age_seconds=$(( $(date +%s) - $(stat -f %m "$lock_file") ))
    else
        lock_age_seconds=$(( $(date +%s) - $(stat -c %Y "$lock_file") ))
    fi

    local stale_seconds=$((LOCK_STALE_HOURS * 3600))

    if [[ $lock_age_seconds -gt $stale_seconds ]]; then
        log_warn "Lock file is stale ($((lock_age_seconds / 3600))h old), proceeding with pruning"
        rm -f "$lock_file"
        return 0
    fi

    log_info "Active lock file found, skipping pruning"
    return 1
}

# Get protected runs (recent activity)
get_protected_runs() {
    local protected=()

    # Add explicitly protected run
    if [[ -n "$PROTECTED_RUN_ID" ]]; then
        protected+=("$PROTECTED_RUN_ID")
    fi

    # Add runs with recent activity (within PROTECTED_WINDOW_MINUTES)
    local cutoff_seconds=$((PROTECTED_WINDOW_MINUTES * 60))
    local now=$(date +%s)

    if [[ -d "$LEARNINGS_DIR/sessions" ]]; then
        for dir in "$LEARNINGS_DIR/sessions"/run-*; do
            [[ -d "$dir" ]] || continue

            local dir_mtime
            if [[ "$(uname)" == "Darwin" ]]; then
                dir_mtime=$(stat -f %m "$dir")
            else
                dir_mtime=$(stat -c %Y "$dir")
            fi

            if [[ $((now - dir_mtime)) -lt $cutoff_seconds ]]; then
                local run_id=$(basename "$dir" | sed 's/^run-//')
                protected+=("$run_id")
            fi
        done
    fi

    echo "${protected[@]}"
}

# Prune old session directories
prune_sessions() {
    local sessions_dir="$LEARNINGS_DIR/sessions"
    [[ -d "$sessions_dir" ]] || return 0

    # Get protected runs
    local -a protected
    IFS=' ' read -r -a protected <<< "$(get_protected_runs)"

    # Get all session directories sorted by modification time (oldest first)
    local -a all_sessions
    mapfile -t all_sessions < <(ls -1t "$sessions_dir" 2>/dev/null | tac)

    local total=${#all_sessions[@]}
    local to_delete=$((total - MAX_SESSIONS))
    local deleted=0

    if [[ $to_delete -le 0 ]]; then
        log_info "Sessions within limit ($total <= $MAX_SESSIONS)"
        return 0
    fi

    log_info "Pruning $to_delete old sessions (keeping $MAX_SESSIONS of $total)"

    for session in "${all_sessions[@]}"; do
        [[ $deleted -ge $to_delete ]] && break

        local run_id=$(echo "$session" | sed 's/^run-//')

        # Check if protected
        local is_protected=false
        for p in "${protected[@]}"; do
            if [[ "$run_id" == "$p" ]]; then
                is_protected=true
                break
            fi
        done

        if $is_protected; then
            log_info "Skipping protected session: $session"
            continue
        fi

        rm -rf "$sessions_dir/$session"
        ((deleted++))
    done

    log_info "Deleted $deleted session directories"
}

# Rotate log file if too large
rotate_log() {
    local log_file="$1"
    [[ -f "$log_file" ]] || return 0

    local line_count=$(wc -l < "$log_file")

    if [[ $line_count -le $MAX_LOG_LINES ]]; then
        return 0
    fi

    log_info "Rotating $log_file ($line_count lines > $MAX_LOG_LINES)"

    # Atomic rotation using lock directory
    local lock_dir="$log_file.lock"
    if ! mkdir "$lock_dir" 2>/dev/null; then
        log_warn "Could not acquire lock for $log_file rotation"
        return 1
    fi

    trap "rmdir '$lock_dir' 2>/dev/null" RETURN

    # Keep last MAX_LOG_LINES lines
    local tmp_file="$log_file.tmp.$$"
    tail -n "$MAX_LOG_LINES" "$log_file" > "$tmp_file"
    mv "$tmp_file" "$log_file"

    # Delete old rotated file if exists
    rm -f "$log_file.1"

    log_info "Rotated $log_file (kept last $MAX_LOG_LINES lines)"
}

# Clean up old archived pending files
clean_archived() {
    local archive_dir="$LEARNINGS_DIR/pending/archived"
    [[ -d "$archive_dir" ]] || return 0

    local deleted=0

    # Find and delete files older than MAX_ARCHIVE_AGE_DAYS
    while IFS= read -r -d '' file; do
        rm -f "$file"
        ((deleted++))
    done < <(find "$archive_dir" -type f -mtime +$MAX_ARCHIVE_AGE_DAYS -print0 2>/dev/null)

    if [[ $deleted -gt 0 ]]; then
        log_info "Deleted $deleted old archived files"
    fi
}

# Sync runs.log with existing sessions
sync_runs_log() {
    local runs_log="$LEARNINGS_DIR/runs.log"
    [[ -f "$runs_log" ]] || return 0

    local sessions_dir="$LEARNINGS_DIR/sessions"
    [[ -d "$sessions_dir" ]] || return 0

    # Get list of existing session run IDs
    local -a existing_runs
    for dir in "$sessions_dir"/run-*; do
        [[ -d "$dir" ]] || continue
        existing_runs+=("$(basename "$dir" | sed 's/^run-//')")
    done

    # Filter runs.log to only include existing sessions
    local tmp_file="$runs_log.tmp.$$"
    while IFS= read -r line; do
        local run_id=$(echo "$line" | cut -d'|' -f1)
        for existing in "${existing_runs[@]}"; do
            if [[ "$run_id" == "$existing" ]]; then
                echo "$line"
                break
            fi
        done
    done < "$runs_log" > "$tmp_file"

    mv "$tmp_file" "$runs_log"
}

# Main
main() {
    log_info "ClosedLoop Self-Learning System - Pruning"
    log_info "Working directory: $WORKDIR"

    if [[ ! -d "$LEARNINGS_DIR" ]]; then
        log_info "No .learnings directory found, nothing to prune"
        exit 0
    fi

    # Load retention config
    load_retention_config

    # Check for active lock
    if ! check_lock; then
        exit 0
    fi

    # Run pruning tasks
    prune_sessions

    rotate_log "$LEARNINGS_DIR/runs.log"
    rotate_log "$LEARNINGS_DIR/outcomes.log"
    rotate_log "$LEARNINGS_DIR/acknowledgments.log"

    clean_archived
    sync_runs_log

    log_info "Pruning complete"
}

main "$@"
