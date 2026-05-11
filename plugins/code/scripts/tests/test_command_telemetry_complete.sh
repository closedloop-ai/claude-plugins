#!/usr/bin/env bash
# Tests for command-telemetry-complete.sh
#
# Validates:
#   - Emitted JSONL event has correct fields: event type "command_complete",
#     run_id, command, started_at, ended_at, duration_s, exit_status
#   - duration_s is a non-negative number
#   - exit_status is recorded accurately
#   - Fail-open behaviour: script exits 0 even when env vars are missing
#     or CLOSEDLOOP_WORKDIR doesn't exist
#   - Multiple fields are numeric/string types as expected
#
# Usage:
#   bash plugins/code/scripts/tests/test_command_telemetry_complete.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPLETE_SCRIPT="$SCRIPT_DIR/../command-telemetry-complete.sh"

# ---- Counters ------------------------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0

# ---- Reporters -----------------------------------------------------------
pass() {
    local name="$1"
    echo "  PASS: $name"
    PASS_COUNT=$(( PASS_COUNT + 1 ))
}

fail() {
    local name="$1"
    local reason="$2"
    echo "  FAIL: $name -- $reason"
    FAIL_COUNT=$(( FAIL_COUNT + 1 ))
}

# ---- JSON field assertions -----------------------------------------------
assert_field_present() {
    local test_name="$1"
    local json="$2"
    local field="$3"
    local value
    value=$(echo "$json" | jq -r --arg f "$field" 'if has($f) then "present" else empty end' 2>/dev/null || echo "")
    if [[ "$value" == "present" ]]; then
        pass "$test_name: field '$field' present"
    else
        fail "$test_name: field '$field' present" "missing in: $json"
    fi
}

assert_field_equals() {
    local test_name="$1"
    local json="$2"
    local field="$3"
    local expected="$4"
    local actual
    actual=$(echo "$json" | jq -r --arg f "$field" '.[$f] | tostring' 2>/dev/null || echo "")
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name: field '$field' = '$expected'"
    else
        fail "$test_name: field '$field'" "expected '$expected' but got '$actual'"
    fi
}

assert_field_type() {
    local test_name="$1"
    local json="$2"
    local field="$3"
    local expected_type="$4"
    local actual_type
    actual_type=$(echo "$json" | jq -r --arg f "$field" '.[$f] | type' 2>/dev/null || echo "")
    if [[ "$actual_type" == "$expected_type" ]]; then
        pass "$test_name: field '$field' is $expected_type"
    else
        fail "$test_name: field '$field' type" "expected '$expected_type' but got '$actual_type'"
    fi
}

assert_field_nonempty() {
    local test_name="$1"
    local json="$2"
    local field="$3"
    local value
    value=$(echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null || echo "")
    if [[ -n "$value" ]] && [[ "$value" != "null" ]]; then
        pass "$test_name: field '$field' is non-empty"
    else
        fail "$test_name: field '$field' is non-empty" "was empty or null in: $json"
    fi
}

# ---- Setup helpers -------------------------------------------------------
setup_temp_workdir() {
    mktemp -d
}

run_complete_script() {
    # Runs command-telemetry-complete.sh with the given env and args in a subshell.
    # All environment variables are passed as bash -c assignments to keep isolation.
    # $1 = exit_status arg (optional, may be empty)
    # $2 = CLOSEDLOOP_WORKDIR value (empty = unset)
    # $3 = CLOSEDLOOP_RUN_ID value  (empty = unset)
    # $4 = CLOSEDLOOP_COMMAND value (empty = unset)
    # $5 = CLOSEDLOOP_START_TIME value (empty = unset)
    local exit_arg="${1:-}"
    local workdir="${2:-}"
    local run_id="${3:-}"
    local command="${4:-}"
    local start_time="${5:-}"

    bash -c "
        $([ -n '$workdir' ]    && echo "export CLOSEDLOOP_WORKDIR='$workdir'"    || echo "unset CLOSEDLOOP_WORKDIR")
        $([ -n '$run_id' ]     && echo "export CLOSEDLOOP_RUN_ID='$run_id'"      || echo "unset CLOSEDLOOP_RUN_ID")
        $([ -n '$command' ]    && echo "export CLOSEDLOOP_COMMAND='$command'"    || echo "unset CLOSEDLOOP_COMMAND")
        $([ -n '$start_time' ] && echo "export CLOSEDLOOP_START_TIME='$start_time'" || echo "unset CLOSEDLOOP_START_TIME")
        bash '$COMPLETE_SCRIPT' $exit_arg
    "
}

# ---- Tests ---------------------------------------------------------------

echo "Running tests for command-telemetry-complete.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: Script exits 0 when all env vars are set correctly
# ------------------------------------------------------------------
echo "Test 1: Script exits 0 with all env vars set"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    actual_exit=0
    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-001'
        export CLOSEDLOOP_COMMAND='test-command'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "exits 0 with all env vars set"
    else
        fail "exits 0 with all env vars set" "got exit $actual_exit"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: Emitted event has event type "command_complete"
# ------------------------------------------------------------------
echo "Test 2: Emitted event has event type 'command_complete'"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-002'
        export CLOSEDLOOP_COMMAND='my-command'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        pass "perf.jsonl was created"
        line=$(tail -1 "$perf_file")

        if echo "$line" | jq empty 2>/dev/null; then
            pass "event type test: perf.jsonl line is valid JSON"
        else
            fail "event type test: perf.jsonl line is valid JSON" "not valid JSON: $line"
        fi

        assert_field_equals "event type" "$line" "event" "command_complete"
    else
        fail "perf.jsonl was created" "file not found at $perf_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: Emitted event contains all required fields
# ------------------------------------------------------------------
echo "Test 3: Emitted event contains all required fields"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-003'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")

        required_keys=("event" "run_id" "command" "started_at" "ended_at" "duration_s" "exit_status")
        for key in "${required_keys[@]}"; do
            val=$(echo "$line" | jq -r --arg k "$key" 'if has($k) then "present" else empty end' 2>/dev/null || echo "")
            if [[ "$val" == "present" ]]; then
                pass "required fields: key '$key' present"
            else
                fail "required fields: key '$key' present" "missing from: $line"
            fi
        done
    else
        fail "required fields" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: run_id field matches CLOSEDLOOP_RUN_ID
# ------------------------------------------------------------------
echo "Test 4: run_id field matches CLOSEDLOOP_RUN_ID"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='my-unique-run-id'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "run_id field" "$line" "run_id" "my-unique-run-id"
    else
        fail "run_id field" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: command field matches CLOSEDLOOP_COMMAND
# ------------------------------------------------------------------
echo "Test 5: command field matches CLOSEDLOOP_COMMAND"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-005'
        export CLOSEDLOOP_COMMAND='plan-execute'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "command field" "$line" "command" "plan-execute"
    else
        fail "command field" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: exit_status field matches the argument passed to the script
# ------------------------------------------------------------------
echo "Test 6: exit_status field is recorded accurately"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-006'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 42
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "exit_status 42" "$line" "exit_status" "42"
    else
        fail "exit_status 42" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 7: exit_status defaults to 0 when no argument is passed
# ------------------------------------------------------------------
echo "Test 7: exit_status defaults to 0 when no argument passed"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-007'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "exit_status default 0" "$line" "exit_status" "0"
    else
        fail "exit_status default 0" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 8: duration_s is a non-negative number
# ------------------------------------------------------------------
echo "Test 8: duration_s is a non-negative number"
{
    tmpdir=$(setup_temp_workdir)
    # Use a start time 5 seconds in the past to guarantee non-zero duration
    start_time=$(( $(date +%s) - 5 ))

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-008'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")

        assert_field_type "duration_s type" "$line" "duration_s" "number"

        duration=$(echo "$line" | jq -r '.duration_s' 2>/dev/null || echo "")
        if [[ -n "$duration" ]] && [[ "$duration" -ge 0 ]] 2>/dev/null; then
            pass "duration_s is non-negative (value: $duration)"
        else
            fail "duration_s is non-negative" "got: $duration"
        fi
    else
        fail "duration_s type" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 9: duration_s calculation is reasonable (>= elapsed time - 1)
# ------------------------------------------------------------------
echo "Test 9: duration_s calculation is reasonable"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(( $(date +%s) - 10 ))

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-009'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        duration=$(echo "$line" | jq -r '.duration_s' 2>/dev/null || echo "")

        # Should be at least 9 seconds (10s start_time offset - 1 for rounding)
        if [[ -n "$duration" ]] && [[ "$duration" -ge 9 ]] 2>/dev/null; then
            pass "duration_s is reasonable (>= 9s, got: $duration)"
        else
            fail "duration_s is reasonable" "expected >= 9 but got: $duration"
        fi
    else
        fail "duration_s calculation" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 10: started_at and ended_at are non-empty ISO-8601 timestamps
# ------------------------------------------------------------------
echo "Test 10: started_at and ended_at are ISO-8601 timestamps"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(( $(date +%s) - 2 ))

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-010'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")

        assert_field_nonempty "timestamps" "$line" "started_at"
        assert_field_nonempty "timestamps" "$line" "ended_at"

        # Both must look like ISO-8601: YYYY-MM-DDTHH:MM:SSZ
        started_at=$(echo "$line" | jq -r '.started_at' 2>/dev/null || echo "")
        ended_at=$(echo "$line"   | jq -r '.ended_at'   2>/dev/null || echo "")

        iso_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
        if [[ "$started_at" =~ $iso_pattern ]]; then
            pass "timestamps: started_at matches ISO-8601 pattern"
        else
            fail "timestamps: started_at matches ISO-8601 pattern" "got: $started_at"
        fi

        if [[ "$ended_at" =~ $iso_pattern ]]; then
            pass "timestamps: ended_at matches ISO-8601 pattern"
        else
            fail "timestamps: ended_at matches ISO-8601 pattern" "got: $ended_at"
        fi
    else
        fail "timestamps" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 11: exit_status and duration_s are JSON numbers, not strings
# ------------------------------------------------------------------
echo "Test 11: exit_status and duration_s are JSON numbers"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-011'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 1
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_type "numeric fields" "$line" "exit_status" "number"
        assert_field_type "numeric fields" "$line" "duration_s"  "number"
    else
        fail "numeric fields" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 12: Fail-open — script exits 0 when CLOSEDLOOP_WORKDIR is unset
# ------------------------------------------------------------------
echo "Test 12: Fail-open — exits 0 when CLOSEDLOOP_WORKDIR is unset"
{
    actual_exit=0
    bash -c "
        unset CLOSEDLOOP_WORKDIR
        export CLOSEDLOOP_RUN_ID='run-fail-open'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$(date +%s)'
        bash '$COMPLETE_SCRIPT' 0
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "fail-open: exits 0 when CLOSEDLOOP_WORKDIR unset"
    else
        fail "fail-open: exits 0 when CLOSEDLOOP_WORKDIR unset" "got exit $actual_exit"
    fi
}

# ------------------------------------------------------------------
# Test 13: Fail-open — script exits 0 when all env vars are missing
# ------------------------------------------------------------------
echo "Test 13: Fail-open — exits 0 when all env vars are missing"
{
    actual_exit=0
    bash -c "
        unset CLOSEDLOOP_WORKDIR
        unset CLOSEDLOOP_RUN_ID
        unset CLOSEDLOOP_COMMAND
        unset CLOSEDLOOP_START_TIME
        bash '$COMPLETE_SCRIPT' 0
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "fail-open: exits 0 with all env vars missing"
    else
        fail "fail-open: exits 0 with all env vars missing" "got exit $actual_exit"
    fi
}

# ------------------------------------------------------------------
# Test 14: Fail-open — script exits 0 when CLOSEDLOOP_WORKDIR points
#          to a non-existent directory
# ------------------------------------------------------------------
echo "Test 14: Fail-open — exits 0 when CLOSEDLOOP_WORKDIR doesn't exist"
{
    actual_exit=0
    bash -c "
        export CLOSEDLOOP_WORKDIR='/tmp/does-not-exist-closedloop-test-$$'
        export CLOSEDLOOP_RUN_ID='run-fail-open'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$(date +%s)'
        bash '$COMPLETE_SCRIPT' 0
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "fail-open: exits 0 when CLOSEDLOOP_WORKDIR doesn't exist"
    else
        fail "fail-open: exits 0 when CLOSEDLOOP_WORKDIR doesn't exist" "got exit $actual_exit"
    fi
}

# ------------------------------------------------------------------
# Test 15: Fail-open — script exits 0 when CLOSEDLOOP_START_TIME is missing
#          (duration calculation should degrade gracefully)
# ------------------------------------------------------------------
echo "Test 15: Fail-open — exits 0 when CLOSEDLOOP_START_TIME is unset"
{
    tmpdir=$(setup_temp_workdir)

    actual_exit=0
    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-no-start-time'
        export CLOSEDLOOP_COMMAND='test-cmd'
        unset CLOSEDLOOP_START_TIME
        bash '$COMPLETE_SCRIPT' 0
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "fail-open: exits 0 when CLOSEDLOOP_START_TIME unset"
    else
        fail "fail-open: exits 0 when CLOSEDLOOP_START_TIME unset" "got exit $actual_exit"
    fi

    # Event should still be emitted with duration_s=0
    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        if echo "$line" | jq empty 2>/dev/null; then
            pass "no start time: event is valid JSON"
            assert_field_equals "no start time" "$line" "duration_s" "0"
        else
            fail "no start time: event is valid JSON" "not valid JSON: $line"
        fi
    else
        fail "no start time: perf.jsonl created" "file not found"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 16: CLOSEDLOOP_RUN_ID defaults to "unknown" when unset
# ------------------------------------------------------------------
echo "Test 16: run_id defaults to 'unknown' when CLOSEDLOOP_RUN_ID is unset"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        unset CLOSEDLOOP_RUN_ID
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "run_id default" "$line" "run_id" "unknown"
    else
        fail "run_id default" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 17: CLOSEDLOOP_COMMAND defaults to "interactive" when unset
# ------------------------------------------------------------------
echo "Test 17: command defaults to 'interactive' when CLOSEDLOOP_COMMAND is unset"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        export CLOSEDLOOP_RUN_ID='run-test-017'
        unset CLOSEDLOOP_COMMAND
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "command default" "$line" "command" "interactive"
    else
        fail "command default" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 18: perf.jsonl is created even when the directory doesn't exist yet
# ------------------------------------------------------------------
echo "Test 18: perf.jsonl directory is created if it doesn't exist"
{
    tmpdir=$(setup_temp_workdir)
    # Use a nested path that doesn't exist yet
    nested_workdir="$tmpdir/nested/path/work"
    start_time=$(date +%s)

    bash -c "
        export CLOSEDLOOP_WORKDIR='$nested_workdir'
        export CLOSEDLOOP_RUN_ID='run-test-018'
        export CLOSEDLOOP_COMMAND='test-cmd'
        export CLOSEDLOOP_START_TIME='$start_time'
        bash '$COMPLETE_SCRIPT' 0
    "

    perf_file="$nested_workdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        pass "nested directory: perf.jsonl created in new nested directory"
        line=$(tail -1 "$perf_file")
        if echo "$line" | jq empty 2>/dev/null; then
            pass "nested directory: emitted event is valid JSON"
        else
            fail "nested directory: emitted event is valid JSON" "not valid JSON: $line"
        fi
    else
        fail "nested directory: perf.jsonl created in new nested directory" \
             "file not found at $perf_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 19: Multiple invocations append separate JSONL lines
# ------------------------------------------------------------------
echo "Test 19: Multiple invocations append separate JSONL lines"
{
    tmpdir=$(setup_temp_workdir)
    start_time=$(date +%s)

    for i in 1 2 3; do
        bash -c "
            export CLOSEDLOOP_WORKDIR='$tmpdir'
            export CLOSEDLOOP_RUN_ID='run-multi-$i'
            export CLOSEDLOOP_COMMAND='test-cmd'
            export CLOSEDLOOP_START_TIME='$start_time'
            bash '$COMPLETE_SCRIPT' $i
        "
    done

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line_count=$(wc -l < "$perf_file" | tr -d ' ')
        if [[ "$line_count" -eq 3 ]]; then
            pass "multiple invocations: 3 lines in perf.jsonl"
        else
            fail "multiple invocations: 3 lines in perf.jsonl" "got $line_count lines"
        fi

        bad=0
        while IFS= read -r l; do
            if [[ -n "$l" ]] && ! echo "$l" | jq empty 2>/dev/null; then
                bad=$(( bad + 1 ))
            fi
        done < "$perf_file"
        if [[ "$bad" -eq 0 ]]; then
            pass "multiple invocations: all lines are valid JSON"
        else
            fail "multiple invocations: all lines are valid JSON" "$bad invalid line(s)"
        fi
    else
        fail "multiple invocations" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ---- Summary -------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
