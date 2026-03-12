#!/usr/bin/env bash
# Test harness for preflight_judges.sh.
# Creates temp directories with various file combinations, runs the script,
# and asserts JSON output via jq.
#
# Usage: bash test_preflight_judges.sh
# Exit 0 = all passed, exit 1 = at least one failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="$SCRIPT_DIR/preflight_judges.sh"
RESOLVE_INV="$SCRIPT_DIR/resolve_investigation_log.sh"
PASS=0
FAIL=0

# ---- helpers ----

setup_workdir() {
  mktemp -d
}

teardown_workdir() {
  rm -rf "$1"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label — expected '$expected', got '$actual'"
  fi
}

read_field() {
  jq -r "$1" "$2"
}

read_field_raw() {
  jq "$1" "$2"
}

run_preflight() {
  bash "$PREFLIGHT" "$1" "$2" 2>/dev/null
}

# ---- scenarios ----

test_plan_skip_missing_prd() {
  echo "--- test_plan_skip_missing_prd ---"
  local w; w=$(setup_workdir)
  echo '{}' > "$w/plan.json"

  run_preflight plan "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"      "skip"   "$(read_field '.status' "$r")"
  assert_eq "skip_reason" "prd.md not found" "$(read_field '.skip_reason' "$r")"
  assert_eq "artifact_type" "plan" "$(read_field '.artifact_type' "$r")"

  teardown_workdir "$w"
}

test_plan_skip_missing_plan_json() {
  echo "--- test_plan_skip_missing_plan_json ---"
  local w; w=$(setup_workdir)
  echo '# PRD' > "$w/prd.md"

  run_preflight plan "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"      "skip"             "$(read_field '.status' "$r")"
  assert_eq "skip_reason" "plan.json not found" "$(read_field '.skip_reason' "$r")"
  assert_eq "files.prd_md" "true"            "$(read_field '.files.prd_md' "$r")"

  teardown_workdir "$w"
}

test_plan_needs_action() {
  echo "--- test_plan_needs_action ---"
  local w; w=$(setup_workdir)
  echo '# PRD' > "$w/prd.md"
  echo '{}' > "$w/plan.json"

  run_preflight plan "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"       "needs_action" "$(read_field '.status' "$r")"
  assert_eq "actions_count" "2"           "$(read_field_raw '.actions | length' "$r")"
  assert_eq "action_0"     "resolve_investigation_log" "$(read_field '.actions[0].action' "$r")"
  assert_eq "action_1"     "launch_context_manager"    "$(read_field '.actions[1].action' "$r")"
  assert_eq "files.investigation_log" "false" "$(read_field '.files.investigation_log' "$r")"
  assert_eq "files.plan_context"      "false" "$(read_field '.files.plan_context' "$r")"

  teardown_workdir "$w"
}

test_plan_ready_all_files_present() {
  echo "--- test_plan_ready_all_files_present ---"
  local w; w=$(setup_workdir)
  echo '# PRD' > "$w/prd.md"
  echo '{}' > "$w/plan.json"
  echo '# log' > "$w/investigation-log.md"
  echo '{}' > "$w/plan-context.json"

  run_preflight plan "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"       "ready" "$(read_field '.status' "$r")"
  assert_eq "eval_cache"   "n/a"   "$(read_field '.eval_cache.status' "$r")"
  assert_eq "actions_count" "0"    "$(read_field_raw '.actions | length' "$r")"

  teardown_workdir "$w"
}

test_code_needs_action() {
  echo "--- test_code_needs_action ---"
  local w; w=$(setup_workdir)

  run_preflight code "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"        "needs_action" "$(read_field '.status' "$r")"
  assert_eq "artifact_type" "code"         "$(read_field '.artifact_type' "$r")"
  assert_eq "eval_cache"    "n/a"          "$(read_field '.eval_cache.status' "$r")"

  local has_ctx_action
  has_ctx_action=$(jq '[.actions[] | select(.action=="launch_context_manager")] | length' "$r")
  assert_eq "has_launch_context_manager" "1" "$has_ctx_action"

  local has_inv_action
  has_inv_action=$(jq '[.actions[] | select(.action=="resolve_investigation_log")] | length' "$r")
  assert_eq "has_resolve_investigation_log" "1" "$has_inv_action"

  teardown_workdir "$w"
}

test_code_ready_all_files() {
  echo "--- test_code_ready_all_files ---"
  local w; w=$(setup_workdir)
  echo '# log' > "$w/investigation-log.md"
  echo '{}' > "$w/code-context.json"

  run_preflight code "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status"        "ready" "$(read_field '.status' "$r")"
  assert_eq "actions_count" "0"     "$(read_field_raw '.actions | length' "$r")"

  teardown_workdir "$w"
}

test_invalid_artifact_type() {
  echo "--- test_invalid_artifact_type ---"
  local w; w=$(setup_workdir)

  run_preflight banana "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "status" "error" "$(read_field '.status' "$r")"
  assert_eq "error_contains_invalid" "true" \
    "$(jq -r '.error | test("Invalid artifact type")' "$r")"

  teardown_workdir "$w"
}

test_manifest_fields_populated() {
  echo "--- test_manifest_fields_populated ---"
  local w; w=$(setup_workdir)
  echo '# PRD' > "$w/prd.md"
  echo '{}' > "$w/plan.json"
  echo '{}' > "$w/plan-context.json"
  echo '# log' > "$w/investigation-log.md"

  run_preflight plan "$w"
  local r="$w/.closedloop/preflight-report.json"

  assert_eq "manifest.output_file"    "judges.json" "$(read_field '.manifest.output_file' "$r")"
  assert_eq "manifest.report_id_suffix" "-judges"   "$(read_field '.manifest.report_id_suffix' "$r")"
  local judge_count
  judge_count=$(jq '.manifest.judges | length' "$r")
  assert_eq "manifest.judges_nonempty" "true" "$([ "$judge_count" -ge 1 ] && echo true || echo false)"

  teardown_workdir "$w"
}

# ---- resolve_investigation_log.sh scenarios ----

run_resolve() {
  bash "$RESOLVE_INV" "$@" 2>/dev/null
}

test_resolve_already_exists() {
  echo "--- test_resolve_already_exists ---"
  local w; w=$(setup_workdir)
  echo '# log' > "$w/investigation-log.md"

  local out; out=$(run_resolve "$w")
  assert_eq "resolution" "already_exists" "$(echo "$out" | jq -r '.resolution')"

  teardown_workdir "$w"
}

test_resolve_try_pre_explorer() {
  echo "--- test_resolve_try_pre_explorer ---"
  local w; w=$(setup_workdir)

  local out; out=$(run_resolve "$w")
  assert_eq "resolution" "try_pre_explorer" "$(echo "$out" | jq -r '.resolution')"
  assert_eq "has_instructions" "true" \
    "$(echo "$out" | jq -r '.instructions | test("pre-explorer")')"

  teardown_workdir "$w"
}

test_resolve_internal_fallback() {
  echo "--- test_resolve_internal_fallback ---"
  local w; w=$(setup_workdir)
  echo '# PRD' > "$w/prd.md"

  local out; out=$(run_resolve "$w" --pre-explorer-failed)
  assert_eq "resolution" "internal_fallback" "$(echo "$out" | jq -r '.resolution')"
  assert_eq "has_sections" "5" "$(echo "$out" | jq '.canonical_sections | length')"
  assert_eq "first_section" "## Search Strategy" \
    "$(echo "$out" | jq -r '.canonical_sections[0]')"

  teardown_workdir "$w"
}

test_resolve_continue_without() {
  echo "--- test_resolve_continue_without ---"
  local w; w=$(setup_workdir)

  local out; out=$(run_resolve "$w" --pre-explorer-failed)
  assert_eq "resolution" "continue_without" "$(echo "$out" | jq -r '.resolution')"

  teardown_workdir "$w"
}

test_resolve_file_appears_after_pre_explorer() {
  echo "--- test_resolve_file_appears_after_pre_explorer ---"
  local w; w=$(setup_workdir)
  echo '# log' > "$w/investigation-log.md"

  local out; out=$(run_resolve "$w" --pre-explorer-failed)
  assert_eq "resolution" "already_exists" "$(echo "$out" | jq -r '.resolution')"

  teardown_workdir "$w"
}

# ---- run all ----

test_plan_skip_missing_prd
test_plan_skip_missing_plan_json
test_plan_needs_action
test_plan_ready_all_files_present
test_code_needs_action
test_code_ready_all_files
test_invalid_artifact_type
test_manifest_fields_populated
test_resolve_already_exists
test_resolve_try_pre_explorer
test_resolve_internal_fallback
test_resolve_continue_without
test_resolve_file_appears_after_pre_explorer

echo ""
echo "========================================="
echo "  PASS: $PASS   FAIL: $FAIL"
echo "========================================="

[ "$FAIL" -eq 0 ] || exit 1
