#!/usr/bin/env bash
# Tests for command-telemetry-complete.sh.
#
# Covers:
#   1. State file read-back   — values persisted in .cmd-state.env are recovered
#   2. Duration calculation   — computed duration is reasonable (>= 0)
#   3. command_complete event — perf.jsonl contains the event (no exit_status field)
#   4. State file cleanup     — .cmd-state.env is removed after a successful run
#   5. Fail-open              — script exits 0 when state file is missing
#   6. No-argv Stop hook path — workdir recovered from CLOSEDLOOP_WORKDIR env
#   7. No-argv sidecar path   — workdir recovered from .last-cmd-state sidecar pointer
#
# Usage:
#   bash plugins/code/scripts/tests/test_command_telemetry_complete.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPLETE_SCRIPT="$SCRIPTS_DIR/command-telemetry-complete.sh"

# ---- Portable epoch → ISO 8601 UTC timestamp formatter -------------------
# GNU date supports `-d @epoch`; BSD date supports `-r epoch`; POSIX uses
# `-j -f "%s"`. Try each in turn. Returns empty string if none work.
_iso_from_epoch() {
    date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || date -u -j -f "%s" "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
        || echo ""
}

# ---- Counters and reporters ----------------------------------------------
PASS_COUNT=0
FAIL_COUNT=0

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

assert_exit_zero() {
    local test_name="$1"
    local actual_exit="$2"
    if [[ "$actual_exit" -eq 0 ]]; then
        pass "$test_name"
    else
        fail "$test_name" "expected exit 0 but got $actual_exit"
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
        fail "$test_name: field '$field' expected '$expected' but got '$actual' in: $json"
    fi
}

assert_field_present() {
    local test_name="$1"
    local json="$2"
    local field="$3"
    local value
    value=$(echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null || echo "")
    if [[ -n "$value" ]] && [[ "$value" != "null" ]]; then
        pass "$test_name: field '$field' present (value: $value)"
    else
        fail "$test_name: field '$field' missing or null in: $json"
    fi
}

# ---- Temp env setup ------------------------------------------------------
setup_temp_workdir() {
    # Creates an isolated temp directory with the layout expected by the script:
    #   $tmpdir/workdir/            -- CLOSEDLOOP_WORKDIR
    #   $tmpdir/workdir/.cmd-state.env  -- state file (written by caller as needed)
    local tmpdir
    tmpdir=$(mktemp -d)
    local workdir="$tmpdir/workdir"
    mkdir -p "$workdir"
    echo "$tmpdir $workdir"
}

write_state_file() {
    # Writes a .cmd-state.env with the given fields.
    local workdir="$1"
    local cmd_start="$2"
    local run_id="$3"
    local command="$4"
    local state_file="$workdir/.cmd-state.env"
    cat > "$state_file" <<EOF
CLOSEDLOOP_WORKDIR=${workdir}
CLOSEDLOOP_CMD_START=${cmd_start}
CLOSEDLOOP_RUN_ID=${run_id}
CLOSEDLOOP_COMMAND=${command}
EOF
}

# ---- Tests ---------------------------------------------------------------

echo "Running tests for command-telemetry-complete.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: State file read-back — values written to .cmd-state.env are
#         recovered and appear in the emitted perf event.
# ------------------------------------------------------------------
echo "Test 1: state file read-back"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    # Use a start time 10 seconds in the past so duration is computable.
    start_epoch=$(( $(date +%s) - 10 ))
    cmd_start=$(_iso_from_epoch "$start_epoch")

    known_run_id="test-run-id-readback-$$"
    known_command="test_command"

    write_state_file "$workdir" "$cmd_start" "$known_run_id" "$known_command"

    actual_exit=0
    bash "$COMPLETE_SCRIPT" "$workdir" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "state file read-back: script exits 0" "$actual_exit"

    # The emitted event should contain the recovered run_id and command.
    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && [[ -s "$perf_file" ]]; then
        last_event=$(tail -1 "$perf_file")
        assert_field_equals "state file read-back" "$last_event" "run_id" "$known_run_id"
        assert_field_equals "state file read-back" "$last_event" "command" "$known_command"
    else
        fail "state file read-back: run_id recovered" "perf.jsonl absent or empty"
        fail "state file read-back: command recovered" "perf.jsonl absent or empty"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: Duration calculation — computed duration_s is >= 0 and > 0
#         when a start time 5+ seconds in the past is supplied.
# ------------------------------------------------------------------
echo "Test 2: duration calculation"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    start_epoch=$(( $(date +%s) - 5 ))
    # Format epoch → ISO 8601 timestamp. Three fallbacks to cover GNU
    # (Linux CI: -d @epoch), BSD (macOS: -r epoch), and POSIX (-j -f).
    cmd_start=$(_iso_from_epoch "$start_epoch")

    write_state_file "$workdir" "$cmd_start" "run-duration-test-$$" "duration_test"

    actual_exit=0
    bash "$COMPLETE_SCRIPT" "$workdir" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "duration calculation: script exits 0" "$actual_exit"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && [[ -s "$perf_file" ]]; then
        last_event=$(tail -1 "$perf_file")
        duration=$(echo "$last_event" | jq -r '.duration_s // empty' 2>/dev/null || echo "")
        if [[ -n "$duration" ]] && [[ "$duration" -ge 0 ]] 2>/dev/null; then
            pass "duration calculation: duration_s >= 0 (got $duration)"
        else
            fail "duration calculation: duration_s >= 0" "got: '$duration'"
        fi
        if [[ -n "$duration" ]] && [[ "$duration" -gt 0 ]] 2>/dev/null; then
            pass "duration calculation: duration_s > 0 for 5s start offset (got $duration)"
        else
            fail "duration calculation: duration_s > 0 for 5s start offset" "got: '$duration'"
        fi
    else
        fail "duration calculation: duration_s >= 0" "perf.jsonl absent or empty"
        fail "duration calculation: duration_s > 0" "perf.jsonl absent or empty"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: command_complete event emission — perf.jsonl must contain an
#         event with event=command_complete. The exit_status field is
#         intentionally absent (the Stop hook cannot observe the exit code).
# ------------------------------------------------------------------
echo "Test 3: command_complete event emission (no exit_status field)"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    start_epoch=$(( $(date +%s) - 2 ))
    cmd_start=$(_iso_from_epoch "$start_epoch")

    write_state_file "$workdir" "$cmd_start" "run-event-test-$$" "event_test_cmd"

    actual_exit=0
    bash "$COMPLETE_SCRIPT" "$workdir" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "event emission: script exits 0" "$actual_exit"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && [[ -s "$perf_file" ]]; then
        last_event=$(tail -1 "$perf_file")
        assert_field_equals "event emission" "$last_event" "event" "command_complete"
        assert_field_present "event emission" "$last_event" "ended_at"
        assert_field_present "event emission" "$last_event" "run_id"
        # exit_status must NOT be present — the Stop hook cannot observe it
        exit_status_val=$(echo "$last_event" | jq -r '.exit_status // "ABSENT"' 2>/dev/null || echo "ABSENT")
        if [[ "$exit_status_val" == "ABSENT" ]] || [[ "$exit_status_val" == "null" ]]; then
            pass "event emission: exit_status field absent (as expected)"
        else
            fail "event emission: exit_status field absent" "found exit_status=$exit_status_val in event"
        fi
    else
        fail "event emission: event=command_complete" "perf.jsonl absent or empty"
        fail "event emission: ended_at field present" "perf.jsonl absent or empty"
        fail "event emission: run_id field present" "perf.jsonl absent or empty"
        fail "event emission: exit_status field absent" "perf.jsonl absent or empty"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: State file cleanup — .cmd-state.env must be removed after
#         the script completes successfully.
# ------------------------------------------------------------------
echo "Test 4: state file cleanup"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    start_epoch=$(( $(date +%s) - 1 ))
    cmd_start=$(_iso_from_epoch "$start_epoch")

    write_state_file "$workdir" "$cmd_start" "run-cleanup-test-$$" "cleanup_test"

    state_file="$workdir/.cmd-state.env"

    # Confirm state file exists before running the script
    if [[ -f "$state_file" ]]; then
        pass "state file cleanup: .cmd-state.env exists before script run"
    else
        fail "state file cleanup: .cmd-state.env exists before script run" "file was not created"
    fi

    actual_exit=0
    bash "$COMPLETE_SCRIPT" "$workdir" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "state file cleanup: script exits 0" "$actual_exit"

    if [[ ! -f "$state_file" ]]; then
        pass "state file cleanup: .cmd-state.env removed after completion"
    else
        fail "state file cleanup: .cmd-state.env removed after completion" "state file still exists: $state_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: Fail-open — when state file is missing the script must exit 0
#         and must not write any event to perf.jsonl.
# ------------------------------------------------------------------
echo "Test 5: fail-open behavior when state file is missing"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    # Deliberately do NOT write any .cmd-state.env
    state_file="$workdir/.cmd-state.env"
    if [[ -f "$state_file" ]]; then
        fail "fail-open: no state file present before run" "state file unexpectedly exists"
    else
        pass "fail-open: no state file present before run"
    fi

    actual_exit=0
    bash "$COMPLETE_SCRIPT" "$workdir" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "fail-open: script exits 0 when state file is missing" "$actual_exit"

    # The script should skip telemetry entirely — perf.jsonl must not be created
    # or must remain empty.
    perf_file="$workdir/perf.jsonl"
    if [[ ! -f "$perf_file" ]] || [[ ! -s "$perf_file" ]]; then
        pass "fail-open: no perf event emitted when state file is missing"
    else
        fail "fail-open: no perf event emitted when state file is missing" \
             "perf.jsonl has content: $(cat "$perf_file")"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: No-argv invocation (Stop hook context) via CLOSEDLOOP_WORKDIR.
#         The Stop hook calls the script with no positional arguments.
#         The script must recover the workdir from CLOSEDLOOP_WORKDIR env.
# ------------------------------------------------------------------
echo "Test 6: no-argv invocation via CLOSEDLOOP_WORKDIR env (Stop hook path)"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    start_epoch=$(( $(date +%s) - 1 ))
    cmd_start=$(_iso_from_epoch "$start_epoch")

    write_state_file "$workdir" "$cmd_start" "run-no-argv-$$" "no_argv_test"

    actual_exit=0
    CLOSEDLOOP_WORKDIR="$workdir" bash "$COMPLETE_SCRIPT" 2>/dev/null ; actual_exit=$?

    assert_exit_zero "no-argv invocation: script exits 0" "$actual_exit"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && [[ -s "$perf_file" ]]; then
        last_event=$(tail -1 "$perf_file")
        assert_field_equals "no-argv invocation: event type" "$last_event" "event" "command_complete"
        assert_field_present "no-argv invocation: run_id present" "$last_event" "run_id"
    else
        fail "no-argv invocation: event=command_complete" "perf.jsonl absent or empty"
        fail "no-argv invocation: run_id present" "perf.jsonl absent or empty"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 7: No-argv invocation via sidecar pointer (Stop hook path when
#         CLOSEDLOOP_WORKDIR is not exported into the subprocess).
# ------------------------------------------------------------------
echo "Test 7: no-argv invocation via sidecar pointer (Stop hook fallback path)"
{
    read -r tmpdir workdir <<< "$(setup_temp_workdir)"

    start_epoch=$(( $(date +%s) - 1 ))
    cmd_start=$(_iso_from_epoch "$start_epoch")

    write_state_file "$workdir" "$cmd_start" "run-sidecar-$$" "sidecar_test"

    # Write the sidecar pointer that init.sh would have written.
    sidecar_dir="$tmpdir/.closedloop-ai/telemetry"
    mkdir -p "$sidecar_dir"
    printf '%s\n' "$workdir" > "$sidecar_dir/.last-cmd-state"

    actual_exit=0
    # Run with no CLOSEDLOOP_WORKDIR and no argv, but from a PWD where the
    # sidecar pointer exists under .closedloop-ai/telemetry/.last-cmd-state.
    (
        cd "$tmpdir" || exit 1
        unset CLOSEDLOOP_WORKDIR
        bash "$COMPLETE_SCRIPT" 2>/dev/null
    ) ; actual_exit=$?

    assert_exit_zero "sidecar recovery: script exits 0" "$actual_exit"

    perf_file="$workdir/perf.jsonl"
    if [[ -f "$perf_file" ]] && [[ -s "$perf_file" ]]; then
        last_event=$(tail -1 "$perf_file")
        assert_field_equals "sidecar recovery: event type" "$last_event" "event" "command_complete"
        assert_field_present "sidecar recovery: run_id present" "$last_event" "run_id"
    else
        fail "sidecar recovery: event=command_complete" "perf.jsonl absent or empty"
        fail "sidecar recovery: run_id present" "perf.jsonl absent or empty"
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
