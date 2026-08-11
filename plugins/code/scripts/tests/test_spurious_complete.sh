#!/usr/bin/env bash
# Tests for detect_spurious_complete() in run-loop.sh.
#
# The case that motivated these: a PLAN run emitted the completion promise while
# plan-draft-writer was still running in the BACKGROUND. The loop ended, the
# writer was abandoned, post-loop code review passed vacuously over an empty
# diff, and the run exited 0 having written no plan.json at all -- so the user's
# implementation-plan artifact looked done and was empty. The guard could not
# see it: its checks only validate pendingTasks INSIDE an existing plan.json.
#
# run-loop.sh guards main() with [[ "${BASH_SOURCE[0]}" == "$0" ]], so sourcing
# it defines the functions without running the loop.
#
# Usage:
#   bash plugins/code/scripts/tests/test_spurious_complete.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_LOOP="$SCRIPT_DIR/../run-loop.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "  PASS: $1"
  PASS_COUNT=$(( PASS_COUNT + 1 ))
}

fail() {
  echo "  FAIL: $1 -- $2"
  FAIL_COUNT=$(( FAIL_COUNT + 1 ))
}

assert_subcode() {
  local name="$1" json="$2" expected="$3"
  local actual
  actual=$(echo "$json" | jq -r '.subcode // ""' 2>/dev/null || echo "")
  if [[ "$actual" == "$expected" ]]; then
    pass "$name (subcode=$actual)"
  else
    fail "$name" "expected subcode '$expected', got '$actual' in: $json"
  fi
}

assert_not_spurious() {
  local name="$1" json="$2"
  local actual
  actual=$(echo "$json" | jq -r '.subcode // ""' 2>/dev/null || echo "")
  if [[ -z "$actual" ]]; then
    pass "$name (not flagged)"
  else
    fail "$name" "expected no subcode, got '$actual' in: $json"
  fi
}

# shellcheck source=/dev/null
source "$RUN_LOOP"

echo "detect_spurious_complete"

# --- A --prd run that produced no plan is the reported defect ---------------
WORKDIR=$(mktemp -d)
printf '%s' '{"phase":"Phase 1: Planning","status":"IN_PROGRESS"}' > "$WORKDIR/state.json"
assert_subcode "COMPLETE with no plan.json on a --prd run is spurious" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PLAN_MISSING_AT_COMPLETION"
rm -rf "$WORKDIR"

# --- A run that never owed a plan is left alone ----------------------------
WORKDIR=$(mktemp -d)
assert_not_spurious "COMPLETE with no plan.json and no PRD is not spurious" \
  "$(detect_spurious_complete "$WORKDIR" "")"
rm -rf "$WORKDIR"

# --- The AWAITING_USER hard stop must keep winning -------------------------
# A drafted plan parked for review legitimately has no finished plan yet; the
# new branch must not turn that documented stop into a failure.
WORKDIR=$(mktemp -d)
printf '%s' '{"phase":"Phase 1.1","status":"AWAITING_USER"}' > "$WORKDIR/state.json"
assert_not_spurious "AWAITING_USER outranks the missing-plan check" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")"
rm -rf "$WORKDIR"

# --- Existing behaviour: a complete plan is still clean ---------------------
WORKDIR=$(mktemp -d)
printf '%s' '{"pendingTasks":[],"openQuestions":[]}' > "$WORKDIR/plan.json"
assert_not_spurious "a plan with no pending tasks is not spurious" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")"
rm -rf "$WORKDIR"

# --- Existing behaviour: pending tasks still flagged, and not as the new code -
WORKDIR=$(mktemp -d)
printf '%s' '{"pendingTasks":[{"id":"T-1.1"}],"openQuestions":[]}' > "$WORKDIR/plan.json"
assert_subcode "pending tasks at completion still flagged" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PENDING_TASKS_AT_COMPLETION"
rm -rf "$WORKDIR"

WORKDIR=$(mktemp -d)
printf '%s' '{"pendingTasks":[{"id":"T-1.1"}],"openQuestions":[{"id":"Q-1"}]}' > "$WORKDIR/plan.json"
assert_subcode "pending tasks blocked by open questions still flagged" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PENDING_TASKS_BLOCKED_BY_QUESTIONS"
rm -rf "$WORKDIR"

echo
echo "passed: $PASS_COUNT  failed: $FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
