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

# The two-argument call sites below default the command to $CLOSEDLOOP_COMMAND,
# so an ambient value -- this suite may well be run from inside a live loop --
# would silently decide the per-command branch for them. Clear it first.
unset CLOSEDLOOP_COMMAND PRD_FILE || true

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

# --- A file that EXISTS but holds no plan is still an unproduced plan --------
# The incident evidence is literally a 0-byte plan.json. [[ -f ]] passes on it,
# jq yields nothing, and the pendingTasks checks then read 0 pending tasks and
# call the run clean -- so the exact condition this guard exists to catch was
# reported as success.
WORKDIR=$(mktemp -d)
: > "$WORKDIR/plan.json"
assert_subcode "a zero-byte plan.json is treated as missing" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PLAN_MISSING_AT_COMPLETION"
rm -rf "$WORKDIR"

WORKDIR=$(mktemp -d)
printf '%s' '{"pendingTasks": [' > "$WORKDIR/plan.json"
assert_subcode "a plan.json that is not parseable JSON is treated as missing" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PLAN_MISSING_AT_COMPLETION"
rm -rf "$WORKDIR"

WORKDIR=$(mktemp -d)
printf '%s' '   ' > "$WORKDIR/plan.json"
assert_subcode "a whitespace-only plan.json is treated as missing" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md")" \
  "PLAN_MISSING_AT_COMPLETION"
rm -rf "$WORKDIR"

# A run that never owed a plan is still left alone, empty file or not.
WORKDIR=$(mktemp -d)
: > "$WORKDIR/plan.json"
assert_not_spurious "a zero-byte plan.json on a run that owed no plan is not spurious" \
  "$(detect_spurious_complete "$WORKDIR" "")"
rm -rf "$WORKDIR"

# --- An absent WORKSPACE is not an unproduced artifact: fail open ------------
# Live-exit and boot-recovery delete the temp workdir right after finalization.
# Adjudicating a run whose directory is already reclaimed would flip a genuine
# success to FAILED, and no re-run repairs that. Missing workdir = cannot judge.
WORKDIR=$(mktemp -d)
rm -rf "$WORKDIR"
assert_not_spurious "an absent workspace fails open rather than reporting spurious" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md" "PLAN")"

# --- Per-command contract: EXECUTE is excluded ------------------------------
# EXECUTE's required artifact is execution-result.json, written only after a
# successful commit AND push, so a legitimate no-changes run ends without it --
# and without a plan.json either. It must never be flagged.
WORKDIR=$(mktemp -d)
printf '%s' '{"phase":"Phase 7","status":"IN_PROGRESS"}' > "$WORKDIR/state.json"
assert_not_spurious "a legitimate no-changes EXECUTE run is not spurious" \
  "$(detect_spurious_complete "$WORKDIR" "" "EXECUTE")"
assert_not_spurious "EXECUTE is excluded by name even when a PRD was passed" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md" "EXECUTE")"
assert_not_spurious "the execute-prompt CLI spelling resolves to EXECUTE" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md" "execute-prompt")"
rm -rf "$WORKDIR"

# --- Per-command contract: REQUEST_CHANGES owes a plan ----------------------
# Its result bundle requires plan.json, so "no plan at all" is still caught,
# with or without a PRD. Presence, however, proves nothing on an amend run --
# the harness seeds plan.json before it starts -- so a zero-byte seed must be
# caught too, and a clean result must not be read as proof the amend did work.
WORKDIR=$(mktemp -d)
assert_subcode "REQUEST_CHANGES with no plan.json is spurious even without a PRD" \
  "$(detect_spurious_complete "$WORKDIR" "" "REQUEST_CHANGES")" \
  "PLAN_MISSING_AT_COMPLETION"
: > "$WORKDIR/plan.json"
assert_subcode "REQUEST_CHANGES with a zero-byte seeded plan.json is spurious" \
  "$(detect_spurious_complete "$WORKDIR" "" "REQUEST_CHANGES")" \
  "PLAN_MISSING_AT_COMPLETION"
rm -rf "$WORKDIR"

# --- Version skew, both directions -----------------------------------------
# A command this script has never heard of (an older desktop sending nothing, a
# newer one sending a command added after this release) must not crash or block.
# It falls back to the --prd proxy, i.e. the behaviour before commands existed.
WORKDIR=$(mktemp -d)
assert_subcode "an unknown command with a PRD falls back to the --prd proxy" \
  "$(detect_spurious_complete "$WORKDIR" "/tmp/prd.md" "SOME_FUTURE_COMMAND")" \
  "PLAN_MISSING_AT_COMPLETION"
assert_not_spurious "an unknown command with no PRD is left alone" \
  "$(detect_spurious_complete "$WORKDIR" "" "SOME_FUTURE_COMMAND")"
assert_not_spurious "an empty command with no PRD is left alone" \
  "$(detect_spurious_complete "$WORKDIR" "" "")"
rm -rf "$WORKDIR"

echo
echo "passed: $PASS_COUNT  failed: $FAIL_COUNT"
[[ "$FAIL_COUNT" -eq 0 ]]
