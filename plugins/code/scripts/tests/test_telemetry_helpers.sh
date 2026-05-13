#!/usr/bin/env bash
# Unit tests for telemetry-helpers.sh
# Run with: bash test_telemetry_helpers.sh
# shellcheck disable=SC1090  # dynamic source path resolved at runtime

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS="$SCRIPT_DIR/../telemetry-helpers.sh"

# ---------------------------------------------------------------------------
# Minimal test harness
# ---------------------------------------------------------------------------

PASS_COUNT=0
FAIL_COUNT=0
FAILURES=()

assert_pass() {
  local description="$1"
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  PASS: $description"
}

assert_fail() {
  local description="$1"
  local detail="${2:-}"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILURES+=("$description${detail:+ — $detail}")
  echo "  FAIL: $description${detail:+ — $detail}"
}

assert_equals() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    assert_pass "$description"
  else
    assert_fail "$description" "expected='$expected' actual='$actual'"
  fi
}

assert_contains() {
  local description="$1"
  local needle="$2"
  local haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    assert_pass "$description"
  else
    assert_fail "$description" "needle='$needle' not found in output"
  fi
}

assert_file_exists() {
  local description="$1"
  local path="$2"
  if [[ -f "$path" ]]; then
    assert_pass "$description"
  else
    assert_fail "$description" "file not found: $path"
  fi
}

assert_file_line_count() {
  local description="$1"
  local path="$2"
  local expected="$3"
  local actual
  actual=$(wc -l < "$path" | tr -d ' ')
  if [[ "$actual" == "$expected" ]]; then
    assert_pass "$description"
  else
    assert_fail "$description" "expected $expected lines, got $actual"
  fi
}

# ---------------------------------------------------------------------------
# Setup / teardown helpers
# ---------------------------------------------------------------------------

setup_tmpdir() {
  mktemp -d
}

teardown_tmpdir() {
  local dir="$1"
  rm -rf "$dir"
}

# ---------------------------------------------------------------------------
# Tests: emit_perf_event
# ---------------------------------------------------------------------------

test_emit_perf_event_appends_to_perf_jsonl() {
  echo "--- emit_perf_event: appends to perf.jsonl ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test_command"
    source "$HELPERS"
    emit_perf_event '{"event":"test","value":1}'
  )

  assert_file_exists "perf.jsonl is created" "$tmpdir/perf.jsonl"
  assert_file_line_count "one line appended" "$tmpdir/perf.jsonl" 1

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_appends_multiple_lines() {
  echo "--- emit_perf_event: multiple calls append multiple lines ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test_command"
    source "$HELPERS"
    emit_perf_event '{"event":"first"}'
    emit_perf_event '{"event":"second"}'
    emit_perf_event '{"event":"third"}'
  )

  assert_file_line_count "three lines appended" "$tmpdir/perf.jsonl" 3

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_injects_command_field() {
  echo "--- emit_perf_event: injects command field from CLOSEDLOOP_COMMAND ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="my_custom_command"
    source "$HELPERS"
    emit_perf_event '{"event":"test"}'
  )

  local line
  line=$(cat "$tmpdir/perf.jsonl")
  assert_contains "command field present" '"command"' "$line"
  assert_contains "command value matches CLOSEDLOOP_COMMAND" '"my_custom_command"' "$line"

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_defaults_command_to_interactive() {
  echo "--- emit_perf_event: defaults command to 'interactive' when CLOSEDLOOP_COMMAND unset ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    unset CLOSEDLOOP_COMMAND 2>/dev/null || true
    source "$HELPERS"
    emit_perf_event '{"event":"test"}'
  )

  local line
  line=$(cat "$tmpdir/perf.jsonl")
  assert_contains "command defaults to interactive" '"interactive"' "$line"

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_empty_input_guard() {
  echo "--- emit_perf_event: empty input is a no-op (does not append blank line) ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    source "$HELPERS"
    emit_perf_event ""
  )

  # perf.jsonl should NOT be created (no output at all)
  if [[ -f "$tmpdir/perf.jsonl" ]]; then
    local lines
    lines=$(wc -l < "$tmpdir/perf.jsonl" | tr -d ' ')
    assert_equals "empty input does not append lines" "0" "$lines"
  else
    assert_pass "empty input does not create perf.jsonl"
  fi

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_empty_input_returns_zero() {
  echo "--- emit_perf_event: empty input returns exit code 0 ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  local exit_code=0
  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    source "$HELPERS"
    emit_perf_event "" || exit $?
  ) || exit_code=$?

  assert_equals "empty input returns exit 0" "0" "$exit_code"

  teardown_tmpdir "$tmpdir"
}

test_emit_perf_event_output_is_valid_json() {
  echo "--- emit_perf_event: appended line is valid JSON ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    source "$HELPERS"
    emit_perf_event '{"event":"pipeline_step","step":1}'
  )

  local parse_exit=0
  jq -e . "$tmpdir/perf.jsonl" > /dev/null 2>&1 || parse_exit=$?
  assert_equals "appended line parses as valid JSON" "0" "$parse_exit"

  teardown_tmpdir "$tmpdir"
}

# ---------------------------------------------------------------------------
# Tests: run_timed_step
# ---------------------------------------------------------------------------

test_run_timed_step_propagates_exit_code_success() {
  echo "--- run_timed_step: propagates exit code 0 from successful command ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  local exit_code=99
  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    run_timed_step 1 "noop_step" true
  ) && exit_code=0 || exit_code=$?

  assert_equals "exit code 0 propagated" "0" "$exit_code"

  teardown_tmpdir "$tmpdir"
}

test_run_timed_step_propagates_exit_code_failure() {
  echo "--- run_timed_step: propagates non-zero exit code from failing command ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  local exit_code=0
  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    # Must turn off set -e inside subshell so we can capture non-zero exit
    set +e
    source "$HELPERS"
    run_timed_step 1 "failing_step" bash -c "exit 42"
    exit_code=$?
    exit $exit_code
  ) || exit_code=$?

  assert_equals "exit code 42 propagated" "42" "$exit_code"

  teardown_tmpdir "$tmpdir"
}

test_run_timed_step_emits_perf_event() {
  echo "--- run_timed_step: emits a perf event to perf.jsonl ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    set +e
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    run_timed_step 1 "test_step" true
  )

  assert_file_exists "perf.jsonl created by run_timed_step" "$tmpdir/perf.jsonl"

  teardown_tmpdir "$tmpdir"
}

test_run_timed_step_duration_is_non_negative() {
  echo "--- run_timed_step: duration_s field is a non-negative integer ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    set +e
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    run_timed_step 1 "test_step" true
  )

  local duration
  duration=$(jq '.duration_s' "$tmpdir/perf.jsonl")
  # duration_s should be a non-negative integer (0 or more)
  local valid=0
  [[ "$duration" =~ ^[0-9]+$ ]] && valid=1
  assert_equals "duration_s is a non-negative integer" "1" "$valid"

  teardown_tmpdir "$tmpdir"
}

test_run_timed_step_records_exit_code_in_event() {
  echo "--- run_timed_step: records exit_code in perf event ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    set +e
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    run_timed_step 2 "failing_step" bash -c "exit 5" || true
  )

  local recorded_exit
  recorded_exit=$(jq '.exit_code' "$tmpdir/perf.jsonl")
  assert_equals "exit_code recorded in event" "5" "$recorded_exit"

  teardown_tmpdir "$tmpdir"
}

test_run_timed_step_skipped_is_false() {
  echo "--- run_timed_step: skipped field is false in event ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    set +e
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    run_timed_step 1 "test_step" true
  )

  local skipped
  skipped=$(jq '.skipped' "$tmpdir/perf.jsonl")
  assert_equals "skipped is false for run_timed_step" "false" "$skipped"

  teardown_tmpdir "$tmpdir"
}

# ---------------------------------------------------------------------------
# Tests: emit_skipped_step
# ---------------------------------------------------------------------------

test_emit_skipped_step_sets_skipped_true() {
  echo "--- emit_skipped_step: skipped field is true ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 3 "skipped_step"
  )

  local skipped
  skipped=$(jq '.skipped' "$tmpdir/perf.jsonl")
  assert_equals "skipped field is true" "true" "$skipped"

  teardown_tmpdir "$tmpdir"
}

test_emit_skipped_step_emits_perf_event() {
  echo "--- emit_skipped_step: emits a perf event to perf.jsonl ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 3 "skipped_step"
  )

  assert_file_exists "perf.jsonl created by emit_skipped_step" "$tmpdir/perf.jsonl"
  assert_file_line_count "exactly one line in perf.jsonl" "$tmpdir/perf.jsonl" 1

  teardown_tmpdir "$tmpdir"
}

test_emit_skipped_step_exit_code_is_zero() {
  echo "--- emit_skipped_step: exit_code field is 0 ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 3 "skipped_step"
  )

  local exit_code
  exit_code=$(jq '.exit_code' "$tmpdir/perf.jsonl")
  assert_equals "exit_code is 0 for skipped step" "0" "$exit_code"

  teardown_tmpdir "$tmpdir"
}

test_emit_skipped_step_duration_is_zero() {
  echo "--- emit_skipped_step: duration_s field is 0 ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 3 "skipped_step"
  )

  local duration
  duration=$(jq '.duration_s' "$tmpdir/perf.jsonl")
  assert_equals "duration_s is 0 for skipped step" "0" "$duration"

  teardown_tmpdir "$tmpdir"
}

test_emit_skipped_step_step_name_in_event() {
  echo "--- emit_skipped_step: step_name is recorded correctly ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="code"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 7 "my_skipped_step"
  )

  local step_name
  step_name=$(jq -r '.step_name' "$tmpdir/perf.jsonl")
  assert_equals "step_name recorded in event" "my_skipped_step" "$step_name"

  teardown_tmpdir "$tmpdir"
}

test_emit_skipped_step_command_field_injected() {
  echo "--- emit_skipped_step: command field is injected from CLOSEDLOOP_COMMAND ---"
  local tmpdir
  tmpdir=$(setup_tmpdir)

  (
    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="amend_plan"
    export RUN_ID="test-run-id"
    export CLOSEDLOOP_ITERATION=0
    source "$HELPERS"
    emit_skipped_step 3 "skipped_step"
  )

  local command
  command=$(jq -r '.command' "$tmpdir/perf.jsonl")
  assert_equals "command field injected correctly" "amend_plan" "$command"

  teardown_tmpdir "$tmpdir"
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------

echo "========================================"
echo "telemetry-helpers.sh unit tests"
echo "========================================"
echo ""

echo "== emit_perf_event =="
test_emit_perf_event_appends_to_perf_jsonl
test_emit_perf_event_appends_multiple_lines
test_emit_perf_event_injects_command_field
test_emit_perf_event_defaults_command_to_interactive
test_emit_perf_event_empty_input_guard
test_emit_perf_event_empty_input_returns_zero
test_emit_perf_event_output_is_valid_json
echo ""

echo "== run_timed_step =="
test_run_timed_step_propagates_exit_code_success
test_run_timed_step_propagates_exit_code_failure
test_run_timed_step_emits_perf_event
test_run_timed_step_duration_is_non_negative
test_run_timed_step_records_exit_code_in_event
test_run_timed_step_skipped_is_false
echo ""

echo "== emit_skipped_step =="
test_emit_skipped_step_sets_skipped_true
test_emit_skipped_step_emits_perf_event
test_emit_skipped_step_exit_code_is_zero
test_emit_skipped_step_duration_is_zero
test_emit_skipped_step_step_name_in_event
test_emit_skipped_step_command_field_injected
echo ""

echo "========================================"
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "========================================"

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo ""
  echo "Failed tests:"
  for f in "${FAILURES[@]}"; do
    echo "  - $f"
  done
  exit 1
fi

exit 0
