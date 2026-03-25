#!/bin/bash

# ClosedLoop External Loop Runner
# Runs Claude iterations with fresh context by launching claude -p in a loop
# State maintained in .claude/closedloop-loop.local.md
# Integrates with the ClosedLoop Self-Learning System

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# State file location
STATE_FILE=".claude/closedloop-loop.local.md"
PROGRESS_LOG=".claude/closedloop-progress.log"

# Learning system paths
LOCK_FILE=".learnings/.lock"
AGENTS_SNAPSHOT_DIR="agents-snapshot"
readonly CLOSEDLOOP_JUDGES_STEP=11
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run identification
RUN_ID=""
START_SHA=""

# Check for jq dependency (required for learning system)
check_jq_dependency() {
  if ! command -v jq &> /dev/null; then
    echo -e "${RED}Error: jq is required for the learning system but not found${NC}"
    echo "Install with: brew install jq (macOS) or apt-get install jq (Linux)"
    exit 1
  fi
}

# Generate unique run ID
generate_run_id() {
  local timestamp=$(date +%Y%m%d-%H%M%S)
  local random_suffix=$(head -c 4 /dev/urandom | xxd -p)
  echo "${timestamp}-${random_suffix}"
}

# Acquire lock file for concurrent protection
acquire_lock() {
  local workdir="$1"
  local lock_file="$workdir/$LOCK_FILE"
  local lock_dir=$(dirname "$lock_file")

  mkdir -p "$lock_dir"

  if [[ -f "$lock_file" ]]; then
    local lock_content=$(cat "$lock_file" 2>/dev/null || echo "")
    local lock_age_seconds=0

    if [[ "$(uname)" == "Darwin" ]]; then
      lock_age_seconds=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || echo "$(date +%s)") ))
    else
      lock_age_seconds=$(( $(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo "$(date +%s)") ))
    fi

    # Consider lock stale after 4 hours
    local stale_seconds=$((4 * 3600))

    if [[ $lock_age_seconds -lt $stale_seconds ]]; then
      echo -e "${RED}Error: Another ClosedLoop loop is already running${NC}"
      echo "Lock file: $lock_file"
      echo "Lock content: $lock_content"
      echo "Lock age: $((lock_age_seconds / 60)) minutes"
      echo ""
      echo "If you're sure no other loop is running, remove the lock file:"
      echo "  rm $lock_file"
      exit 1
    else
      echo -e "${YELLOW}Warning: Found stale lock file ($((lock_age_seconds / 3600))h old), removing${NC}"
      rm -f "$lock_file"
    fi
  fi

  # Create lock file with run info
  echo "run_id=$RUN_ID|pid=$$|started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock_file"
  log_progress "Lock acquired: $lock_file"
}

# Release lock file
release_lock() {
  local workdir="$1"
  local lock_file="$workdir/$LOCK_FILE"

  if [[ -f "$lock_file" ]]; then
    rm -f "$lock_file"
    log_progress "Lock released: $lock_file"
  fi
}

# Bootstrap run-specific learnings directories
bootstrap_learnings() {
  local workdir="$1"
  local bootstrap_script="$SCRIPTS_DIR/bootstrap-learnings.sh"

  if [[ ! -d "$workdir/.learnings" ]]; then
    echo -e "${BLUE}Initializing learning system...${NC}"

    # Use bootstrap script to create directory structure
    if [[ -x "$bootstrap_script" ]]; then
      "$bootstrap_script" "$workdir/.learnings"
    else
      # Minimal bootstrap if script not available
      mkdir -p "$workdir/.learnings/pending"
      mkdir -p "$workdir/.learnings/sessions"
      echo -e "${GREEN}Created minimal .learnings structure${NC}"
    fi

    # Copy org learnings from .claude/learnings/ if available (overwrite defaults)
    local org_learnings_dir=""
    # Check project root first, then workdir
    if [[ -d ".claude/learnings" ]]; then
      org_learnings_dir=".claude/learnings"
    elif [[ -d "$workdir/.claude/learnings" ]]; then
      org_learnings_dir="$workdir/.claude/learnings"
    fi

    if [[ -n "$org_learnings_dir" ]]; then
      echo -e "${BLUE}Copying org learnings from $org_learnings_dir${NC}"
      [[ -f "$org_learnings_dir/org-patterns.toon" ]] && cp "$org_learnings_dir/org-patterns.toon" "$workdir/.learnings/"
      [[ -f "$org_learnings_dir/goal.yaml" ]] && cp "$org_learnings_dir/goal.yaml" "$workdir/.learnings/"
      [[ -f "$org_learnings_dir/retention.yaml" ]] && cp "$org_learnings_dir/retention.yaml" "$workdir/.learnings/"
    fi
  fi
}

# Returns 0 if the directory exists and includes at least one markdown file.
is_valid_judges_agents_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  find "$dir" -type f -name "*.md" -print -quit | grep -q .
}

# Resolve judges agents dir under a root (e.g., .../judges/<version>/agents).
# Iterates candidates from newest to oldest semver and returns the first valid
# one, so a corrupt or partially-installed latest version falls back gracefully
# to an older usable release rather than failing outright.
resolve_versioned_judges_agents_dir() {
  local judges_root="$1"
  local versioned_candidates=""

  if [[ ! -d "$judges_root" ]]; then
    return 1
  fi

  # Semver: no leading zeros in core; optional prerelease (-id.id) and build (+id.id).
  local semver_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

  while IFS= read -r agents_dir; do
    local version_dir
    version_dir="$(basename "$(dirname "$agents_dir")")"
    if [[ "$version_dir" =~ $semver_re ]]; then
      versioned_candidates+="${version_dir}|${agents_dir}"$'\n'
    fi
  done < <(find "$judges_root" -mindepth 2 -maxdepth 2 -type d -name "agents" 2>/dev/null)

  # Walk candidates newest → oldest; return the first one that passes validation.
  while IFS='|' read -r _version agents_dir; do
    [[ -z "$agents_dir" ]] && continue
    if is_valid_judges_agents_dir "$agents_dir"; then
      echo "$agents_dir"
      return 0
    fi
  done < <(printf "%s" "$versioned_candidates" | LC_ALL=C sort -t'|' -k1,1V -r)

  return 1
}

# Resolve judges/agents path across monorepo, cache, and marketplace layouts.
resolve_judges_agents_dir() {
  local code_plugin_dir
  code_plugin_dir="$(cd "$SCRIPTS_DIR/.." 2>/dev/null && pwd || echo "")"
  local code_root_dir="$code_plugin_dir"

  # For versioned cache layout (.../code/<version>/scripts), normalize to .../code.
  if [[ "$(basename "$code_plugin_dir")" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*$ ]]; then
    code_root_dir="$(dirname "$code_plugin_dir")"
  fi

  local plugins_parent
  plugins_parent="$(dirname "$code_root_dir")"

  local sibling_judges_agents="$plugins_parent/judges/agents"
  local sibling_judges_root="$plugins_parent/judges"
  local tried=()

  sibling_judges_agents="$(cd "$sibling_judges_agents" 2>/dev/null && pwd || echo "$sibling_judges_agents")"
  sibling_judges_root="$(cd "$sibling_judges_root" 2>/dev/null && pwd || echo "$sibling_judges_root")"

  # 1) Explicit env override (best for deterministic tests and custom installs)
  if [[ -n "${CLOSEDLOOP_JUDGES_AGENTS_DIR:-}" ]]; then
    local override_dir
    override_dir="$(cd "$CLOSEDLOOP_JUDGES_AGENTS_DIR" 2>/dev/null && pwd || echo "$CLOSEDLOOP_JUDGES_AGENTS_DIR")"
    tried+=("$override_dir")
    if is_valid_judges_agents_dir "$override_dir"; then
      log_progress "resolve_judges_agents_dir: using CLOSEDLOOP_JUDGES_AGENTS_DIR=$override_dir"
      echo "$override_dir"
      return 0
    fi
  fi

  # 2) Non-versioned sibling plugin layout (.../judges/agents).
  tried+=("$sibling_judges_agents")
  if is_valid_judges_agents_dir "$sibling_judges_agents"; then
    log_progress "resolve_judges_agents_dir: using sibling plugin path $sibling_judges_agents"
    echo "$sibling_judges_agents"
    return 0
  fi

  # 3) Versioned sibling plugin layout (.../judges/<version>/agents), newest valid semver wins.
  tried+=("$sibling_judges_root/<version>/agents")
  local versioned_agents_dir
  versioned_agents_dir="$(resolve_versioned_judges_agents_dir "$sibling_judges_root" || true)"
  if [[ -n "$versioned_agents_dir" ]]; then
    log_progress "resolve_judges_agents_dir: using versioned path $versioned_agents_dir"
    echo "$versioned_agents_dir"
    return 0
  fi

  log_progress "resolve_judges_agents_dir: no valid judges agents dir found; tried: ${tried[*]}"
  return 1
}

# Ensure agents snapshot exists in workdir; create if missing (runs on first launch or re-launch)
ensure_agents_snapshot() {
  local workdir="$1"
  local snapshot_dir="$workdir/$AGENTS_SNAPSHOT_DIR"
  local manifest="$snapshot_dir/manifest.json"

  if [[ -f "$manifest" ]]; then
    return 0
  fi

  store_agents_snapshot "$workdir"
}

# Snapshot all .md judge agent files into workdir/$AGENTS_SNAPSHOT_DIR with manifest.json
store_agents_snapshot() {
  local workdir="$1"
  local snapshot_dir="$workdir/$AGENTS_SNAPSHOT_DIR"
  local plugin_name="judges"
  local agents_src
  agents_src="$(resolve_judges_agents_dir || true)"
  local plugin_dir=""

  # AC-004: Check for agents directory existence
  if [[ -z "$agents_src" ]] || [[ ! -d "$agents_src" ]]; then
    log_progress "store_agents_snapshot: agents directory could not be resolved, skipping"
    return 0
  fi

  plugin_dir="$(dirname "$agents_src")"

  mkdir -p "$snapshot_dir" || { log_progress "WARNING: store_agents_snapshot: failed to create snapshot dir $snapshot_dir"; return 0; }

  # AC-002: Build file list with deterministic, deduplicated output
  local file_list
  file_list=$(find "$agents_src" -type f -name "*.md" | LC_ALL=C sort -u)

  if [[ -z "$file_list" ]]; then
    log_progress "store_agents_snapshot: no .md files found in $agents_src, skipping"
    return 0
  fi

  # AC-001, AC-005: Copy all .md files preserving directory structure
  while IFS= read -r src_file; do
    local rel_path
    rel_path=$(echo "$src_file" | sed "s|^$agents_src/||")
    local dest_file="$snapshot_dir/$rel_path"
    local dest_dir
    dest_dir="$(dirname "$dest_file")"

    mkdir -p "$dest_dir" || { log_progress "WARNING: store_agents_snapshot: failed to create dir $dest_dir"; return 0; }
    cp "$src_file" "$dest_file" || { log_progress "WARNING: store_agents_snapshot: failed to copy $src_file"; return 0; }
  done <<< "$file_list"

  # AC-002, AC-006: Build JSON array of relative paths and generate manifest.json
  local files_json
  files_json=$(echo "$file_list" | sed "s|^$agents_src/||" | jq -R . | jq -s .)

  local file_count
  file_count=$(echo "$file_list" | grep -c . || echo "0")

  local plugin_version
  plugin_version=$(jq -r '.version // "unknown"' "$plugin_dir/.claude-plugin/plugin.json" 2>/dev/null || echo "unknown")

  local run_id
  run_id="${RUN_ID:-$(basename "$workdir")}"

  local created_at
  created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  jq -n \
    --arg plugin "$plugin_name" \
    --arg plugin_version "$plugin_version" \
    --arg run_id "$run_id" \
    --arg created_at "$created_at" \
    --arg source_dir "$agents_src" \
    --argjson files "$files_json" \
    --argjson file_count "$file_count" \
    '{plugin:$plugin,plugin_version:$plugin_version,run_id:$run_id,created_at:$created_at,source_dir:$source_dir,files:$files,file_count:$file_count}' \
    > "$snapshot_dir/manifest.json" || { log_progress "WARNING: store_agents_snapshot: failed to write manifest.json"; return 0; }

  # AC-006: Validate manifest with explicit type and cross-checks
  jq -e '(.file_count | type == "number") and (.file_count == (.files | length))' \
    "$snapshot_dir/manifest.json" > /dev/null 2>&1 \
    || log_progress "WARNING: manifest validation failed"

  log_progress "store_agents_snapshot: snapshot complete — $file_count files in $snapshot_dir"
}

# Load goal configuration
load_goal_config() {
  local workdir="$1"
  local goal_file="$workdir/.learnings/goal.yaml"

  if [[ -f "$goal_file" ]] && command -v python3 &> /dev/null; then
    # Extract active goal using Python
    local active_goal=$(python3 -c "
import yaml
try:
    with open('$goal_file') as f:
        config = yaml.safe_load(f) or {}
    print(config.get('active_goal', ''))
except:
    pass
" 2>/dev/null)

    if [[ -n "$active_goal" ]]; then
      export CLOSEDLOOP_ACTIVE_GOAL="$active_goal"
      echo -e "Active goal: ${GREEN}$active_goal${NC}"
    fi
  fi
}

# Capture git SHA at start for citation verification
capture_start_sha() {
  local workdir="$1"

  if [[ -d "$workdir/.git" ]] || git -C "$workdir" rev-parse --git-dir &> /dev/null 2>&1; then
    START_SHA=$(git -C "$workdir" rev-parse HEAD 2>/dev/null || echo "")
    if [[ -n "$START_SHA" ]]; then
      log_progress "Start SHA: $START_SHA"
    fi
  fi
}

# Create iteration marker file
create_iteration_marker() {
  local workdir="$1"
  local iteration="$2"
  local session_dir="$workdir/.learnings/sessions/run-$RUN_ID"

  mkdir -p "$session_dir"
  echo "$iteration" > "$session_dir/current-iteration"
}

# Write runs.log entry for goal evaluation
write_runs_log_entry() {
  local workdir="$1"
  local iteration="$2"
  local status="${3:-in_progress}"
  local runs_log="$workdir/.learnings/runs.log"
  local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$(dirname "$runs_log")"
  echo "$RUN_ID|$timestamp|${CLOSEDLOOP_ACTIVE_GOAL:-reduce-failures}|$iteration|$status" >> "$runs_log"
}

# Returns 0 when implementation code changes exist, 1 otherwise.
# Excludes plan artifacts and .learnings/ paths.
has_code_changes() {
  local workdir="$1"
  local changed_files="$workdir/.learnings/changed-files.json"
  if [[ ! -f "$changed_files" ]]; then
    return 1
  fi

  if jq -e '[.[] | select(
    (endswith("plan.json") | not) and
    (endswith("plan.md") | not) and
    (endswith("prd.md") | not) and
    (endswith("judges.json") | not) and
    ((startswith(".learnings/") or contains("/.learnings/")) | not)
  )] | length > 0' "$changed_files" >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

# Run plan or code judges as the last post-iteration step. Runs at most one: plan judges
# when plan.json exists and judges.json does not; code judges when judges.json exists
# and there are implementation changes. Reports skip reasons.
run_judges_if_needed() {
  local workdir="$1"
  local IMPORTED_PLAN_MARKER="$workdir/.closedloop/imported-plan"
  if [[ ! -f "$workdir/plan.json" ]]; then
    echo -e "${BLUE}[Judges] Skipping: plan.json missing${NC}"
    log_progress "Judges skipped: plan.json missing"
    emit_skipped_step "$CLOSEDLOOP_JUDGES_STEP" "plan_judges"
    return 0
  fi
  if [[ ! -f "$workdir/judges.json" ]]; then
    if [[ -f "$IMPORTED_PLAN_MARKER" ]]; then
      echo -e "${BLUE}[Judges] Skipping plan judges: imported-plan marker found${NC}"
      log_progress "Judges skipped: imported-plan marker"
      emit_skipped_step "$CLOSEDLOOP_JUDGES_STEP" "plan_judges"
    elif [[ ! -f "$workdir/prd.md" ]]; then
      echo -e "${BLUE}[Judges] Skipping: prd.md missing (required for plan judges)${NC}"
      log_progress "Judges skipped: prd.md missing"
      emit_skipped_step "$CLOSEDLOOP_JUDGES_STEP" "plan_judges"
      return 0
    else
      echo -e "${BLUE}[Judges] Running plan judges (plan.json exists, judges.json missing)...${NC}"
      log_progress "Running plan judges"
      run_timed_step "$CLOSEDLOOP_JUDGES_STEP" "plan_judges" bash -c "
        CLOSEDLOOP_WORKDIR='$workdir' \
        CLOSEDLOOP_PARENT_STEP='$CLOSEDLOOP_JUDGES_STEP' \
        CLOSEDLOOP_PARENT_STEP_NAME='plan_judges' \
        claude -p 'Activate judges:run-judges skill. --workdir $workdir --artifact-type plan. Write judges.json to $workdir.' \
          --allowed-tools=Bash,Grep,Glob,Read,Write,Task,Skill,TodoWrite \
          --max-turns 150 2>&1 | tee -a '$PROGRESS_LOG'
      " || log_progress "Plan judges encountered errors (continuing)"
      return 0
    fi
  fi
  if [[ ! -f "$workdir/.learnings/changed-files.json" ]]; then
    echo -e "${BLUE}[Judges] Skipping: changed-files.json missing (cannot detect code changes)${NC}"
    log_progress "Judges skipped: changed-files.json missing"
    emit_skipped_step "$CLOSEDLOOP_JUDGES_STEP" "code_judges"
    return 0
  fi
  if ! has_code_changes "$workdir"; then
    echo -e "${BLUE}[Judges] Skipping: no implementation changes (only plan artifacts)${NC}"
    log_progress "Judges skipped: no code changes"
    emit_skipped_step "$CLOSEDLOOP_JUDGES_STEP" "code_judges"
    return 0
  fi
  if [[ -n "${START_SHA:-}" ]] && [[ ! -f "$workdir/.start-sha" ]]; then
    echo "$START_SHA" > "$workdir/.start-sha"
  fi
  echo -e "${BLUE}[Judges] Running code judges (judges.json exists, implementation changes detected)...${NC}"
  log_progress "Running code judges (implementation changes detected)"
  run_timed_step "$CLOSEDLOOP_JUDGES_STEP" "code_judges" bash -c "
    CLOSEDLOOP_WORKDIR='$workdir' \
    CLOSEDLOOP_PARENT_STEP='$CLOSEDLOOP_JUDGES_STEP' \
    CLOSEDLOOP_PARENT_STEP_NAME='code_judges' \
    claude -p 'Activate judges:run-judges skill. --workdir $workdir --artifact-type code. Write code-judges.json to $workdir.' \
      --allowed-tools=Bash,Grep,Glob,Read,Write,Task,Skill,TodoWrite \
      --max-turns 150 2>&1 | tee -a '$PROGRESS_LOG'
  " || log_progress "Code judges encountered errors (continuing)"
}

# Post-iteration processing: enrichment pipeline, learning capture, citation verification, success rates
post_iteration_processing() {
  local workdir="$1"
  local iteration="$2"

  log_progress "Starting post-iteration processing for iteration $iteration"

  # Export environment variables for process-learnings command
  export CLOSEDLOOP_WORKDIR="$workdir"
  export CLOSEDLOOP_RUN_ID="$RUN_ID"
  export CLOSEDLOOP_ITERATION="$iteration"

  local tools_dir="$SCRIPTS_DIR/../tools/python"
  local sl_tools_dir="$SCRIPTS_DIR/../../self-learning/tools/python"

  # Step 1: Generate changed-files.json from git diff
  if [[ -n "$START_SHA" ]]; then
    echo -e "${BLUE}[1/10] Generating changed-files.json...${NC}"
    log_progress "Step 1: Generating changed-files.json"
    mkdir -p "$workdir/.learnings"
    run_timed_step 1 "changed_files" bash -c "
      { git diff --name-only '$START_SHA' HEAD 2>/dev/null; \
        git diff --name-only HEAD 2>/dev/null; \
        git diff --name-only --cached 2>/dev/null; } \
        | sort -u \
        | python3 -c \"import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))\" \
        > '$workdir/.learnings/changed-files.json'
    " || log_progress "Step 1: changed-files.json generation encountered errors (continuing)"
  else
    emit_skipped_step 1 "changed_files"
  fi

  # Step 2: pattern_relevance.py (score patterns -> relevance-scores.json)
  local relevance_script="$sl_tools_dir/pattern_relevance.py"
  if [[ -f "$relevance_script" ]] && [[ -f "$workdir/.learnings/changed-files.json" ]]; then
    echo -e "${BLUE}[2/10] Computing pattern relevance...${NC}"
    log_progress "Step 2: Running pattern_relevance.py"
    if run_timed_step 2 "pattern_relevance" bash -c "
      python3 '$relevance_script' \
          --workdir '$workdir' \
          --changed-files '$workdir/.learnings/changed-files.json' \
          --output '$workdir/.learnings/relevance-scores.json' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 2: Pattern relevance completed"
    else
      log_progress "Step 2: pattern_relevance.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 2 "pattern_relevance"
  fi

  # Step 3: merge_relevance.py (append relevance to outcomes.log)
  local merge_rel_script="$sl_tools_dir/merge_relevance.py"
  if [[ -f "$merge_rel_script" ]] && [[ -f "$workdir/.learnings/relevance-scores.json" ]]; then
    echo -e "${BLUE}[3/10] Merging relevance scores...${NC}"
    log_progress "Step 3: Running merge_relevance.py"
    if run_timed_step 3 "merge_relevance" bash -c "
      python3 '$merge_rel_script' \
          --workdir '$workdir' \
          --relevance-file '$workdir/.learnings/relevance-scores.json' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 3: Relevance merge completed"
    else
      log_progress "Step 3: merge_relevance.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 3 "merge_relevance"
  fi

  # Step 4: evaluate_goal.py (evaluate goal -> goal-outcome.json)
  local eval_script="$sl_tools_dir/evaluate_goal.py"
  if [[ -f "$eval_script" ]]; then
    echo -e "${BLUE}[4/10] Evaluating goal...${NC}"
    log_progress "Step 4: Running evaluate_goal.py"
    if run_timed_step 4 "evaluate_goal" bash -c "
      python3 '$eval_script' \
          --workdir '$workdir' \
          --run-id '$RUN_ID' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 4: Goal evaluation completed"
    else
      log_progress "Step 4: evaluate_goal.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 4 "evaluate_goal"
  fi

  # Step 5: merge_goal_outcome.py (append goal data to outcomes.log)
  local merge_goal_script="$sl_tools_dir/merge_goal_outcome.py"
  if [[ -f "$merge_goal_script" ]] && [[ -f "$workdir/.learnings/goal-outcome.json" ]]; then
    echo -e "${BLUE}[5/10] Merging goal outcome...${NC}"
    log_progress "Step 5: Running merge_goal_outcome.py"
    if run_timed_step 5 "merge_goal_outcome" bash -c "
      python3 '$merge_goal_script' \
          --workdir '$workdir' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 5: Goal outcome merge completed"
    else
      log_progress "Step 5: merge_goal_outcome.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 5 "merge_goal_outcome"
  fi

  # Step 6: verify_citations.py (mark |unverified in outcomes.log)
  if [[ -n "$START_SHA" ]]; then
    local verify_script="$sl_tools_dir/verify_citations.py"
    if [[ -f "$verify_script" ]]; then
      echo -e "${BLUE}[6/10] Verifying citations...${NC}"
      log_progress "Step 6: Running verify_citations.py"
      if run_timed_step 6 "verify_citations" bash -c "
        python3 '$verify_script' --start-sha '$START_SHA' --workdir '$workdir' 2>&1 | tee -a '$PROGRESS_LOG'
      "; then
        log_progress "Step 6: Citation verification passed"
      else
        log_progress "Step 6: Citation verification found issues (see failures.md)"
      fi
    else
      emit_skipped_step 6 "verify_citations"
    fi
  else
    emit_skipped_step 6 "verify_citations"
  fi

  # Step 7: Merge build-validator results into outcomes.log
  local merge_build_script="$sl_tools_dir/merge_build_result.py"
  if [[ -f "$merge_build_script" ]] && [[ -f "$workdir/.learnings/build-result.json" ]]; then
    echo -e "${BLUE}[7/10] Merging build-validator results...${NC}"
    log_progress "Step 7: Running merge_build_result.py"
    if run_timed_step 7 "merge_build_result" bash -c "
      python3 '$merge_build_script' --workdir '$workdir' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 7: Build result merge completed"
    else
      log_progress "Step 7: merge_build_result.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 7 "merge_build_result"
  fi

  # Step 8: Process pending learnings (LLM classifies and aggregates into org-patterns.toon)
  local pending_dir="$workdir/.learnings/pending"
  if [[ -d "$pending_dir" ]] && [[ -n "$(ls -A "$pending_dir"/*.json 2>/dev/null)" ]]; then
    echo -e "${BLUE}[8/10] Processing pending learnings...${NC}"
    log_progress "Step 8: Running process-learnings"
    if run_timed_step 8 "process_learnings" bash -c "
      claude -p 'Run /self-learning:process-learnings $workdir' \
          --allowed-tools=Bash,Grep,Glob,Read,Write \
          --max-turns 100 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 8: Learning processing completed"
    else
      log_progress "Step 8: Learning processing encountered errors (continuing)"
    fi
  else
    emit_skipped_step 8 "process_learnings"
  fi

  # Step 8.5: Write merge-result.json → org-patterns.toon (deterministic)
  local merge_script="$sl_tools_dir/write_merged_patterns.py"
  local merge_result="$workdir/.learnings/merge-result.json"
  if [[ -f "$merge_result" ]] && [[ -f "$merge_script" ]]; then
    echo -e "${BLUE}[8.5/10] Writing merged patterns to TOON...${NC}"
    log_progress "Step 8.5: Running write_merged_patterns.py"
    if run_timed_step 8.5 "write_merged_patterns" bash -c "
      python3 '$merge_script' --merge-result '$merge_result' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 8.5: TOON write completed"
      # Cleanup session files only after successful TOON write
      rm -rf "$workdir/.learnings/sessions/run-"* 2>/dev/null || true
    else
      log_progress "Step 8.5: TOON write failed — session files preserved for retry"
    fi
  else
    emit_skipped_step 8.5 "write_merged_patterns"
  fi

  # Step 9: compute_success_rates.py (deterministic rates -> update org-patterns.toon)
  local rates_script="$sl_tools_dir/compute_success_rates.py"
  if [[ -f "$rates_script" ]]; then
    echo -e "${BLUE}[9/10] Computing success rates...${NC}"
    log_progress "Step 9: Running compute_success_rates.py"
    if run_timed_step 9 "compute_success_rates" bash -c "
      python3 '$rates_script' --workdir '$workdir' 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 9: Success rate computation completed"
    else
      log_progress "Step 9: compute_success_rates.py encountered errors (continuing)"
    fi
  else
    emit_skipped_step 9 "compute_success_rates"
  fi

  # Step 10: Export closedloop learnings to global location
  if [[ -f "$workdir/.learnings/pending-closedloop.json" ]]; then
    echo -e "${BLUE}[10/10] Exporting closedloop learnings...${NC}"
    log_progress "Step 10: Running export-closedloop-learnings"
    if run_timed_step 10 "export_closedloop_learnings" bash -c "
      claude -p '/self-learning:export-closedloop-learnings $workdir' \
          --allowed-tools=Bash,Grep,Glob,Read,Write \
          --max-turns 20 2>&1 | tee -a '$PROGRESS_LOG'
    "; then
      log_progress "Step 10: ClosedLoop learning export completed"
    else
      log_progress "Step 10: ClosedLoop learning export encountered errors (continuing)"
    fi
  else
    emit_skipped_step 10 "export_closedloop_learnings"
  fi

  # Step 11: Judges (plan or code, never both)
  run_judges_if_needed "$workdir"
}

# Run pruning in background after loop completes
run_background_pruning() {
  local workdir="$1"
  local prune_script="$SCRIPTS_DIR/prune-learnings.sh"

  if [[ -x "$prune_script" ]]; then
    log_progress "Starting background pruning"
    CLOSEDLOOP_WORKDIR="$workdir" nohup "$prune_script" "$RUN_ID" >> "$PROGRESS_LOG" 2>&1 &
    echo -e "${BLUE}Background pruning started (PID: $!)${NC}"
  fi
}

# Show help
show_help() {
  cat << 'EOF'
ClosedLoop Loop - External development loop with fresh context per iteration

USAGE:
  run-loop.sh <workdir> [OPTIONS]
  run-loop.sh                          # Resume existing loop from state file

ARGUMENTS:
  workdir      Path to working directory (creates new loop)

OPTIONS:
  --prd <file>                   Path to requirements/PRD file (auto-discovered if not provided)
  --prompt <name>                Orchestrator prompt name from prompts/ folder (default: prompt)
  --max-iterations <n>           Maximum iterations (default: 50)
  --completion-promise '<text>'  Promise phrase to signal completion (default: COMPLETE)
  -h, --help                     Show this help message

DESCRIPTION:
  Runs Claude in a loop with fresh context on each iteration. Each iteration
  invokes `claude -p "/code:code <workdir>"`.

  State is persisted to .claude/closedloop-loop.local.md so loops can be resumed.

  To signal completion, Claude must output: <promise>COMPLETE</promise>

LEARNING SYSTEM:
  The loop integrates with the ClosedLoop Self-Learning System:
  - Bootstraps .learnings/ directory structure on first run
  - Captures learnings from each iteration
  - Aggregates patterns into org-patterns.toon
  - Verifies citation accuracy against git diff
  - Prunes old sessions in background after completion

  Environment variables exported to each iteration:
  - CLOSEDLOOP_WORKDIR: Working directory path
  - CLOSEDLOOP_RUN_ID: Unique run identifier
  - CLOSEDLOOP_ITERATION: Current iteration number
  - CLOSEDLOOP_ACTIVE_GOAL: Active goal from goal.yaml (if set)

EXAMPLES:
  # Start a new loop
  run-loop.sh ./my-project --max-iterations 20

  # Resume an interrupted loop
  run-loop.sh

STOPPING:
  - Press Ctrl+C
  - Reach --max-iterations limit
  - Claude outputs the --completion-promise

MONITORING:
  # View current iteration:
  grep '^iteration:' .claude/closedloop-loop.local.md

  # View progress log:
  tail -20 .claude/closedloop-progress.log

  # View learning system status:
  ls -la .learnings/sessions/
EOF
}

# Parse arguments
WORKDIR=""
PRD_FILE=""
PROMPT_NAME=""
MAX_ITERATIONS=50
COMPLETION_PROMISE="COMPLETE"

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      show_help
      exit 0
      ;;
    --prd)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --prd requires a file path${NC}" >&2
        exit 1
      fi
      PRD_FILE="$2"
      shift 2
      ;;
    --prompt)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --prompt requires a prompt name${NC}" >&2
        exit 1
      fi
      if [[ "$2" =~ [[:space:]] || "$2" == */* || "$2" == *..* ]]; then
        echo -e "${RED}Error: --prompt name must not contain spaces or path separators${NC}" >&2
        exit 1
      fi
      if [[ ! -f "$SCRIPTS_DIR/../prompts/$2.md" ]]; then
        echo -e "${RED}Error: prompt file not found: prompts/$2.md${NC}" >&2
        exit 1
      fi
      PROMPT_NAME="$2"
      shift 2
      ;;
    --max-iterations)
      if [[ -z "${2:-}" ]] || ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo -e "${RED}Error: --max-iterations requires a positive integer${NC}" >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    --completion-promise)
      if [[ -z "${2:-}" ]]; then
        echo -e "${RED}Error: --completion-promise requires a text argument${NC}" >&2
        exit 1
      fi
      COMPLETION_PROMISE="$2"
      shift 2
      ;;
    -*)
      echo -e "${RED}Error: Unknown option: $1${NC}" >&2
      echo "Use --help for usage information"
      exit 1
      ;;
    *)
      if [[ -z "$WORKDIR" ]]; then
        WORKDIR="$1"
      else
        echo -e "${RED}Error: Unexpected argument: $1${NC}" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

# Parse YAML frontmatter from state file
parse_frontmatter() {
  sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE"
}

get_field() {
  local field="$1"
  parse_frontmatter | grep "^${field}:" | sed "s/${field}: *//" | sed 's/^"\(.*\)"$/\1/'
}

# Extract prompt (everything after the closing ---)
get_prompt() {
  awk '/^---$/{i++; next} i>=2' "$STATE_FILE"
}

# Log to progress file
log_progress() {
  local message="$1"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $message" >> "$PROGRESS_LOG"
}

# --- Performance instrumentation helpers ---

# Append a single-line JSON event to perf.jsonl
emit_perf_event() {
  local json_line="$1"
  local perf_file="${CLOSEDLOOP_WORKDIR:-.}/perf.jsonl"
  echo "$json_line" >> "$perf_file"
}

# Run a command with timing, emit a pipeline_step perf event, return original exit code
run_timed_step() {
  local step_num="$1"
  local step_name="$2"
  shift 2
  local step_start_epoch
  step_start_epoch=$(date +%s)
  local step_started_at
  step_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local step_exit=0
  "$@" || step_exit=$?

  local step_end_epoch
  step_end_epoch=$(date +%s)
  local step_ended_at
  step_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local step_duration=$((step_end_epoch - step_start_epoch))

  emit_perf_event "$(jq -n -c \
    --arg event "pipeline_step" \
    --arg run_id "$RUN_ID" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --argjson step "$step_num" \
    --arg step_name "$step_name" \
    --arg started_at "$step_started_at" \
    --arg ended_at "$step_ended_at" \
    --argjson duration_s "$step_duration" \
    --argjson exit_code "$step_exit" \
    --argjson skipped false \
    '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}'
  )"

  return "$step_exit"
}

# Emit a skipped pipeline_step event
emit_skipped_step() {
  local step_num="$1"
  local step_name="$2"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  emit_perf_event "$(jq -n -c \
    --arg event "pipeline_step" \
    --arg run_id "$RUN_ID" \
    --argjson iteration "${CLOSEDLOOP_ITERATION:-0}" \
    --argjson step "$step_num" \
    --arg step_name "$step_name" \
    --arg started_at "$now" \
    --arg ended_at "$now" \
    --argjson duration_s 0 \
    --argjson exit_code 0 \
    --argjson skipped true \
    '{event:$event,run_id:$run_id,iteration:$iteration,step:$step,step_name:$step_name,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,exit_code:$exit_code,skipped:$skipped}'
  )"
}

# Update iteration in state file
update_iteration() {
  local new_iter="$1"
  local temp_file="${STATE_FILE}.tmp.$$"
  sed "s/^iteration: .*/iteration: $new_iter/" "$STATE_FILE" > "$temp_file"
  mv "$temp_file" "$STATE_FILE"
}

# Create state file
create_state_file() {
  mkdir -p .claude

  # WORKDIR is the closedloop work directory passed by the caller
  # (e.g., /path/to/worktree/.claude/work)
  mkdir -p "$WORKDIR"

  # Build the prompt - this is what gets passed to claude -p
  local prompt="/code:code $WORKDIR"
  if [[ -n "$PROMPT_NAME" ]]; then
    prompt="$prompt --prompt $PROMPT_NAME"
  fi
  if [[ -n "$PRD_FILE" ]]; then
    prompt="$prompt --prd $PRD_FILE"
  fi

  cat > "$STATE_FILE" <<EOF
---
active: true
iteration: 1
max_iterations: $MAX_ITERATIONS
completion_promise: "$COMPLETION_PROMISE"
workdir: "$WORKDIR"
prd_file: "$PRD_FILE"
run_id: "$RUN_ID"
start_sha: "$START_SHA"
started_at: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
---
$prompt
EOF

  echo -e "${GREEN}Created new ClosedLoop loop state${NC}"
  echo -e "Working directory: ${BLUE}$WORKDIR${NC}"
  if [[ -n "$PRD_FILE" ]]; then
    echo -e "PRD file: ${BLUE}$PRD_FILE${NC}"
  fi
  echo -e "Run ID: ${BLUE}$RUN_ID${NC}"
}

# Check for completion promise in output
check_completion() {
  local output="$1"
  local promise="$2"

  if [[ -z "$promise" ]]; then
    return 1  # No promise set, never complete
  fi

  # Extract text from <promise> tags
  local promise_text=$(echo "$output" | perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")

  if [[ -n "$promise_text" ]] && [[ "$promise_text" = "$promise" ]]; then
    return 0  # Complete
  fi

  return 1  # Not complete
}

# Main loop
main() {
  # Check for jq dependency
  check_jq_dependency

  # If workdir provided, create new state file
  if [[ -n "$WORKDIR" ]]; then
    # Resolve to absolute path
    WORKDIR=$(cd "$WORKDIR" 2>/dev/null && pwd || echo "$WORKDIR")

    # Generate run ID for new loop
    RUN_ID=$(generate_run_id)

    # Capture start SHA for citation verification
    capture_start_sha "$WORKDIR"

    # Bootstrap learnings directory
    bootstrap_learnings "$WORKDIR"

    # Acquire lock to prevent concurrent loops
    acquire_lock "$WORKDIR"

    create_state_file
  fi

  # Check for state file
  if [[ ! -f "$STATE_FILE" ]]; then
    echo -e "${RED}Error: No active ClosedLoop loop found${NC}"
    echo ""
    echo "To start a new loop:"
    echo "  run-loop.sh ./path/to/workdir"
    echo ""
    echo "For help: run-loop.sh --help"
    exit 1
  fi

  local iteration=$(get_field "iteration")
  local max_iterations=$(get_field "max_iterations")
  local completion_promise=$(get_field "completion_promise")
  local workdir=$(get_field "workdir")
  local prompt=$(get_prompt)

  # Restore RUN_ID and START_SHA from state file if resuming
  if [[ -z "$RUN_ID" ]]; then
    RUN_ID=$(get_field "run_id")
    START_SHA=$(get_field "start_sha")

    # If resuming, re-acquire lock
    if [[ -n "$workdir" ]]; then
      acquire_lock "$workdir"
    fi
  fi

  # Ensure agents snapshot exists (create if missing; runs on first launch or re-launch)
  ensure_agents_snapshot "${workdir:-$WORKDIR}"

  # Validate state
  if [[ ! "$iteration" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Invalid iteration in state file: $iteration${NC}"
    exit 1
  fi

  if [[ ! "$max_iterations" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Error: Invalid max_iterations in state file: $max_iterations${NC}"
    exit 1
  fi

  if [[ -z "$prompt" ]]; then
    echo -e "${RED}Error: No prompt found in state file${NC}"
    exit 1
  fi

  # Export environment variables for learning system
  export CLOSEDLOOP_WORKDIR="${workdir:-$WORKDIR}"
  export CLOSEDLOOP_RUN_ID="$RUN_ID"

  # Load goal configuration
  load_goal_config "${workdir:-$WORKDIR}"

  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BLUE}ClosedLoop External Loop${NC}"
  echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
  echo ""
  echo -e "Started: ${GREEN}$(date "+%m/%d/%Y %H:%M:%S")${NC}"
  echo -e "Prompt: ${GREEN}$prompt${NC}"
  echo -e "Starting iteration: ${GREEN}$iteration${NC}"
  echo -e "Max iterations: ${YELLOW}$max_iterations${NC}"
  echo -e "Completion promise: ${YELLOW}$completion_promise${NC}"
  echo -e "Run ID: ${BLUE}$RUN_ID${NC}"
  if [[ -n "${CLOSEDLOOP_ACTIVE_GOAL:-}" ]]; then
    echo -e "Active goal: ${GREEN}${CLOSEDLOOP_ACTIVE_GOAL}${NC}"
  fi
  echo ""
  echo -e "${YELLOW}Press Ctrl+C to stop the loop at any time${NC}"
  echo ""

  log_progress "Loop started - run_id=$RUN_ID iteration=$iteration max=$max_iterations promise=$completion_promise"

  # jq filter to extract final result
  local final_result='select(.type == "result").result // empty'

  while true; do
    # Check max iterations
    if [[ $max_iterations -gt 0 ]] && [[ $iteration -gt $max_iterations ]]; then
      # Emit iteration perf event for the max-iterations boundary (no Claude run happened)
      local now_ts
      now_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      emit_perf_event "$(jq -n -c \
        --arg event "iteration" \
        --arg run_id "$RUN_ID" \
        --argjson iteration "$iteration" \
        --arg started_at "$now_ts" \
        --arg ended_at "$now_ts" \
        --argjson duration_s 0 \
        --argjson claude_exit_code 0 \
        --arg status "max_iterations" \
        '{event:$event,run_id:$run_id,iteration:$iteration,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,claude_exit_code:$claude_exit_code,status:$status}'
      )"

      echo -e "\n${GREEN}Max iterations ($max_iterations) reached. Loop complete.${NC}"
      log_progress "Loop ended - max iterations reached"

      # Write runs.log entry
      write_runs_log_entry "${workdir:-$WORKDIR}" "$iteration" "max_iterations"

      # Final post-iteration processing
      post_iteration_processing "${workdir:-$WORKDIR}" "$iteration"

      # Clean up
      release_lock "${workdir:-$WORKDIR}"
      rm -f "$STATE_FILE"

      # Run pruning in background
      run_background_pruning "${workdir:-$WORKDIR}"

      exit 0
    fi

    echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}Iteration $iteration${NC} (Run: $RUN_ID)"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    log_progress "Starting iteration $iteration"

    # Export iteration number for learning system
    export CLOSEDLOOP_ITERATION="$iteration"

    # Create iteration marker
    create_iteration_marker "${workdir:-$WORKDIR}" "$iteration"

    # Capture iteration start time for perf instrumentation
    local iter_start_epoch
    iter_start_epoch=$(date +%s)
    local iter_started_at
    iter_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

    # Build the full prompt - skill invocation must be the first line
    # so that claude -p recognizes and expands it properly.
    # Iteration/promise info is handled by prompt.md, not duplicated here.
    local full_prompt="$prompt"

    # Run Claude with fresh context
    local output_file=$(mktemp)
    local stderr_file=$(mktemp)

    # Run claude -p and capture output (temp file for completion check + output log)
    # Pipeline: claude -> grep JSON -> tee to output_file -> tee to jsonl log -> format for terminal
    #
    # The pipeline runs inside a background subshell so that `wait` is the
    # foreground operation.  `wait` is interruptible by trapped signals,
    # which means Ctrl+C will fire cleanup_on_interrupt immediately instead
    # of being blocked until `claude` (which catches SIGINT) exits on its own.
    local formatter="$SCRIPTS_DIR/../tools/python/stream_formatter.py"
    local exit_code_file
    exit_code_file=$(mktemp)
    set +e
    (
      claude \
          --allowed-tools=Bash,Grep,Glob,Read,Edit,Write,Task,TodoWrite,WebSearch,WebFetch,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot,mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_evaluate \
          --output-format stream-json \
          --verbose \
          -p "$full_prompt" 2>"$stderr_file" \
          | { grep --line-buffered '^{' || true; } \
          | tee "$output_file" \
          | tee -a "${CLOSEDLOOP_WORKDIR}/claude-output.jsonl" \
          | python3 "$formatter"
      echo "${PIPESTATUS[0]}" > "$exit_code_file"
    ) &
    wait $! 2>/dev/null || true
    local claude_exit
    claude_exit=$(cat "$exit_code_file" 2>/dev/null || echo 1)
    rm -f "$exit_code_file"
    set -e

    if [[ $claude_exit -eq 0 ]]; then
      local result=$(jq -r "$final_result" "$output_file")
      rm -f "$output_file"

      # Post-iteration processing: learning capture, aggregation, citation verification
      post_iteration_processing "${workdir:-$WORKDIR}" "$iteration"

      # Check for completion
      if [[ "$result" == *"<promise>$completion_promise</promise>"* ]]; then
        # Emit iteration perf event for the completing iteration
        local iter_end_epoch
        iter_end_epoch=$(date +%s)
        local iter_ended_at
        iter_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        local iter_duration=$((iter_end_epoch - iter_start_epoch))
        emit_perf_event "$(jq -n -c \
          --arg event "iteration" \
          --arg run_id "$RUN_ID" \
          --argjson iteration "$iteration" \
          --arg started_at "$iter_started_at" \
          --arg ended_at "$iter_ended_at" \
          --argjson duration_s "$iter_duration" \
          --argjson claude_exit_code 0 \
          --arg status "completed" \
          '{event:$event,run_id:$run_id,iteration:$iteration,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,claude_exit_code:$claude_exit_code,status:$status}'
        )"

        echo -e "\n${GREEN}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${GREEN}Completion promise detected: $completion_promise${NC}"
        echo -e "${GREEN}Loop complete after $iteration iterations!${NC}"
        echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
        log_progress "Loop completed - promise fulfilled after $iteration iterations"

        # Write runs.log entry
        write_runs_log_entry "${workdir:-$WORKDIR}" "$iteration" "completed"

        # Clean up
        release_lock "${workdir:-$WORKDIR}"
        rm -f "$STATE_FILE"

        # Run pruning in background
        run_background_pruning "${workdir:-$WORKDIR}"

        exit 0
      fi

      log_progress "Iteration $iteration completed - continuing"

      # Write runs.log entry
      write_runs_log_entry "${workdir:-$WORKDIR}" "$iteration" "in_progress"

    else
      echo -e "\n${YELLOW}Warning: Claude exited with non-zero status (exit code: $claude_exit)${NC}"
      if [[ -s "$stderr_file" ]]; then
        echo -e "${YELLOW}Claude stderr:${NC}"
        cat "$stderr_file"
      fi
      log_progress "Iteration $iteration - Claude exited with error (code: $claude_exit)"

      # Write runs.log entry
      write_runs_log_entry "${workdir:-$WORKDIR}" "$iteration" "error"

      # Still run post-iteration processing even on error
      post_iteration_processing "${workdir:-$WORKDIR}" "$iteration"
    fi

    rm -f "$output_file" "$stderr_file" 2>/dev/null || true

    # Emit iteration perf event
    local iter_end_epoch
    iter_end_epoch=$(date +%s)
    local iter_ended_at
    iter_ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local iter_duration=$((iter_end_epoch - iter_start_epoch))
    local iter_status="ok"
    if [[ $claude_exit -ne 0 ]]; then
      iter_status="error"
    fi
    emit_perf_event "$(jq -n -c \
      --arg event "iteration" \
      --arg run_id "$RUN_ID" \
      --argjson iteration "$iteration" \
      --arg started_at "$iter_started_at" \
      --arg ended_at "$iter_ended_at" \
      --argjson duration_s "$iter_duration" \
      --argjson claude_exit_code "$claude_exit" \
      --arg status "$iter_status" \
      '{event:$event,run_id:$run_id,iteration:$iteration,started_at:$started_at,ended_at:$ended_at,duration_s:$duration_s,claude_exit_code:$claude_exit_code,status:$status}'
    )"

    # Increment iteration
    iteration=$((iteration + 1))
    update_iteration "$iteration"

    echo -e "\n${YELLOW}Continuing to iteration $iteration...${NC}"
    sleep 1  # Brief pause between iterations
  done
}

# Handle Ctrl+C gracefully
# NOTE: The pipeline is run in the background so that `wait` (which IS
# interruptible by trapped signals) is the foreground operation.  If the
# pipeline were foreground, bash would wait for it to finish before running
# the trap handler — and since `claude` catches SIGINT internally, Ctrl+C
# would appear to do nothing.
cleanup_on_interrupt() {
  echo -e "\n${YELLOW}Loop interrupted by user${NC}"
  log_progress "Loop interrupted by user at iteration $(get_field iteration 2>/dev/null || echo unknown)"

  # Kill all child processes of this script (the backgrounded pipeline)
  local pids
  pids=$(jobs -p 2>/dev/null)
  if [[ -n "$pids" ]]; then
    kill $pids 2>/dev/null || true
    sleep 0.5
    kill -9 $pids 2>/dev/null || true
  fi

  # Release lock on interrupt
  local workdir
  workdir=$(get_field "workdir" 2>/dev/null || echo "")
  if [[ -n "$workdir" ]]; then
    release_lock "$workdir"
  fi

  exit 130
}

trap cleanup_on_interrupt INT TERM

main "$@"
