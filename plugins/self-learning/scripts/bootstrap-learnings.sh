#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Bootstrap Script
# Initializes the learning system directory structure
# Usage: ./bootstrap-learnings.sh [output_dir]
#   output_dir: Where to create learnings (default: .closedloop-ai/learnings)
#
# Examples:
#   ./bootstrap-learnings.sh                     # Creates .closedloop-ai/learnings/ (org learnings)
#   ./bootstrap-learnings.sh /tmp/run/.learnings # Creates run-specific learnings

set -e

# Single source of truth for the state directory name
CLOSEDLOOP_STATE_DIR=".closedloop-ai"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEARNINGS_DIR="${1:-$CLOSEDLOOP_STATE_DIR/learnings}"
PROJECT_LEARNINGS_SUFFIX="/$CLOSEDLOOP_STATE_DIR/learnings"

# Derive PROJECT_DIR for gitignore updates (only if using default path)
if [[ "$LEARNINGS_DIR" == "$CLOSEDLOOP_STATE_DIR/learnings" ]] || [[ "$LEARNINGS_DIR" == *"$PROJECT_LEARNINGS_SUFFIX" ]]; then
    PROJECT_DIR="${LEARNINGS_DIR%"$PROJECT_LEARNINGS_SUFFIX"}"
    PROJECT_DIR="${PROJECT_DIR:-.}"
    UPDATE_PROJECT_GITIGNORE=true
else
    PROJECT_DIR=""
    UPDATE_PROJECT_GITIGNORE=false
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Create directory structure
create_directories() {
    log_info "Creating learnings directory structure at $LEARNINGS_DIR..."

    mkdir -p "$LEARNINGS_DIR/pending/archived"
    mkdir -p "$LEARNINGS_DIR/sessions"

    log_info "Directory structure created"
}

# Initialize org-patterns.toon (empty header)
init_org_patterns() {
    local PATTERNS_FILE="$LEARNINGS_DIR/org-patterns.toon"

    if [[ -f "$PATTERNS_FILE" ]]; then
        log_warn "org-patterns.toon already exists, skipping"
        return 0
    fi

    log_info "Initializing org-patterns.toon..."

    cat > "$PATTERNS_FILE" << 'EOF'
# Organization Patterns (TOON format)
# Comma-delimited, 10 fields: id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo
# applies_to: pipe-separated agent names or * for all
# context: pipe-separated tags
# repo: repository name or * for all repos
# FLAGS: [REVIEW] <40% success, [STALE] never applied 10+ iters, [UNTESTED] new, [PRUNE] auto-prune candidate

patterns[0]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:
EOF

    log_info "org-patterns.toon initialized"
}

# Initialize goal.yaml with defaults
init_goal_yaml() {
    local GOAL_FILE="$LEARNINGS_DIR/goal.yaml"

    if [[ -f "$GOAL_FILE" ]]; then
        log_warn "goal.yaml already exists, skipping"
        return 0
    fi

    log_info "Initializing goal.yaml..."

    cat > "$GOAL_FILE" << 'EOF'
# ClosedLoop Self-Learning Goal Configuration
# See schema at plugins/self-learning/schemas/goal.schema.json

active_goal: reduce-failures

goals:
  reduce-failures:
    description: "Minimize iterations needed to complete tasks"
    pattern_priority:
      - mistake
      - pattern
      - convention
      - insight
    success_criteria:
      type: threshold
      metric: iterations
      target: 3
      direction: below
    metrics:
      - iterations_to_complete
      - error_count

  swe-bench:
    description: "Pass SWE-bench test cases"
    pattern_priority:
      - mistake
      - pattern
    success_criteria:
      type: binary
      test_command: "pytest tests/ -x"
    metrics:
      - tests_passed
      - tests_failed

  minimize-tokens:
    description: "Reduce token usage while maintaining quality"
    pattern_priority:
      - convention
      - pattern
      - insight
    success_criteria:
      type: threshold
      metric: total_tokens
      target: 50000
      direction: below
    metrics:
      - input_tokens
      - output_tokens
      - cache_tokens

  maximize-coverage:
    description: "Improve test coverage"
    pattern_priority:
      - pattern
      - convention
    success_criteria:
      type: threshold
      metric: coverage_percent
      target: 80
      direction: above
    metrics:
      - coverage_percent
      - lines_covered
EOF

    log_info "goal.yaml initialized"
}

# Initialize retention.yaml with defaults
init_retention_yaml() {
    local RETENTION_FILE="$LEARNINGS_DIR/retention.yaml"

    if [[ -f "$RETENTION_FILE" ]]; then
        log_warn "retention.yaml already exists, skipping"
        return 0
    fi

    log_info "Initializing retention.yaml..."

    cat > "$RETENTION_FILE" << 'EOF'
# ClosedLoop Self-Learning Retention Configuration
# Controls how learnings are pruned and rotated

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
EOF

    log_info "retention.yaml initialized"
}

# Create .gitignore for learnings directory
init_gitignore() {
    local GITIGNORE_FILE="$LEARNINGS_DIR/.gitignore"

    if [[ -f "$GITIGNORE_FILE" ]]; then
        log_warn ".gitignore already exists, skipping"
        return 0
    fi

    log_info "Creating $LEARNINGS_DIR/.gitignore..."

    cat > "$GITIGNORE_FILE" << 'EOF'
# ClosedLoop Self-Learning .gitignore
# Only shareable learnings should be committed

# Session data (local only)
sessions/
pending/

# Lock files
.lock

# Log files (local only)
*.log

# Keep these (shareable):
# - org-patterns.toon
# - goal.yaml
# - retention.yaml
!org-patterns.toon
!goal.yaml
!retention.yaml
EOF

    log_info ".gitignore created"
}

# Update project .gitignore if needed
update_project_gitignore() {
    local PROJECT_GITIGNORE="$PROJECT_DIR/.gitignore"

    if [[ ! -f "$PROJECT_GITIGNORE" ]]; then
        log_warn "No .gitignore found in project root"
        return 0
    fi

    # Check if .learnings is already in gitignore
    if grep -q "^\.learnings/" "$PROJECT_GITIGNORE" 2>/dev/null; then
        log_info ".learnings already in project .gitignore"
        return 0
    fi

    log_info "Adding .learnings/ rules to project .gitignore..."

    cat >> "$PROJECT_GITIGNORE" << 'EOF'

# ClosedLoop Self-Learning System
# Run-specific learnings (ephemeral, per-workdir)
.learnings/

# Org learnings are in .closedloop-ai/learnings/ and SHOULD be committed
EOF

    log_info "Project .gitignore updated"
}

# Main
main() {
    log_info "ClosedLoop Self-Learning System - Bootstrap"
    log_info "Output directory: $LEARNINGS_DIR"
    echo

    create_directories
    init_org_patterns
    init_goal_yaml
    init_retention_yaml
    init_gitignore

    # Only update project .gitignore if creating org learnings in $CLOSEDLOOP_STATE_DIR/learnings
    if [[ "$UPDATE_PROJECT_GITIGNORE" == "true" ]]; then
        update_project_gitignore
    fi

    echo
    log_info "Bootstrap complete!"
    log_info "Learning system initialized at $LEARNINGS_DIR"
}

main
