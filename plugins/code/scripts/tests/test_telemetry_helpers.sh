#!/usr/bin/env bash
# Tests for telemetry-helpers.sh
#
# Validates that the three functions extracted from run-loop.sh produce correct
# JSONL output:
#   emit_perf_event  — appends a single-line JSON event to perf.jsonl
#   run_timed_step   — wraps a command, emits a pipeline_step event with timing
#   emit_skipped_step — emits a pipeline_step event with skipped=true
#
# Also validates that the env-var-based approach (CLOSEDLOOP_RUN_ID,
# CLOSEDLOOP_ITERATION, CLOSEDLOOP_WORKDIR, CLOSEDLOOP_COMMAND) works correctly
# when the helpers are sourced in an isolated context (no run-loop.sh globals).
#
# Usage:
#   bash plugins/code/scripts/tests/test_telemetry_helpers.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPERS="$SCRIPT_DIR/../telemetry-helpers.sh"

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
    value=$(echo "$json" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null || echo "")
    if [[ -n "$value" ]] && [[ "$value" != "null" ]]; then
        pass "$test_name: field '$field' present (value: $value)"
    else
        fail "$test_name: field '$field' present" "missing or null in: $json"
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
    # Asserts that a JSON field has the given jq type string.
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

# ---- Setup helpers -------------------------------------------------------
setup_temp_workdir() {
    # Creates an isolated temp directory that acts as CLOSEDLOOP_WORKDIR.
    # Returns the path via stdout.
    local tmpdir
    tmpdir=$(mktemp -d)
    echo "$tmpdir"
}

# ---- Tests ---------------------------------------------------------------

echo "Running tests for telemetry-helpers.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: emit_perf_event appends valid JSONL to perf.jsonl
# ------------------------------------------------------------------
echo "Test 1: emit_perf_event appends valid JSONL to perf.jsonl"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test-command"
    # Source helpers in a subshell to avoid polluting the outer environment
    actual_exit=0
    bash -c "
        source '$HELPERS'
        emit_perf_event '{\"event\":\"test_event\",\"run_id\":\"run-123\"}'
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "emit_perf_event exits 0"
    else
        fail "emit_perf_event exits 0" "got exit $actual_exit"
    fi

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        pass "perf.jsonl was created"
        line=$(tail -1 "$perf_file")

        if echo "$line" | jq empty 2>/dev/null; then
            pass "emit_perf_event: perf.jsonl line is valid JSON"
        else
            fail "emit_perf_event: perf.jsonl line is valid JSON" "not valid JSON: $line"
        fi

        assert_field_equals "emit_perf_event" "$line" "event" "test_event"
        assert_field_equals "emit_perf_event" "$line" "run_id" "run-123"
        # command field is injected by emit_perf_event
        assert_field_equals "emit_perf_event" "$line" "command" "test-command"
    else
        fail "perf.jsonl was created" "file not found at $perf_file"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: emit_perf_event is a no-op for empty input (does not corrupt perf.jsonl)
# ------------------------------------------------------------------
echo "Test 2: emit_perf_event no-op on empty input"
{
    tmpdir=$(setup_temp_workdir)
    perf_file="$tmpdir/perf.jsonl"

    # Pre-populate with a valid line
    echo '{"event":"existing"}' > "$perf_file"

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    bash -c "
        source '$HELPERS'
        emit_perf_event ''
    "

    # File must still have exactly one line (no blank line appended)
    line_count=$(wc -l < "$perf_file" | tr -d ' ')
    if [[ "$line_count" -eq 1 ]]; then
        pass "emit_perf_event: empty input does not append to perf.jsonl"
    else
        fail "emit_perf_event: empty input does not append to perf.jsonl" \
             "expected 1 line but got $line_count"
    fi

    # Existing content must be untouched
    existing=$(head -1 "$perf_file")
    if echo "$existing" | jq empty 2>/dev/null; then
        pass "emit_perf_event: existing perf.jsonl content not corrupted"
    else
        fail "emit_perf_event: existing perf.jsonl content not corrupted" \
             "first line is invalid JSON: $existing"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: emit_perf_event uses CLOSEDLOOP_COMMAND default "interactive"
#         when CLOSEDLOOP_COMMAND is unset
# ------------------------------------------------------------------
echo "Test 3: emit_perf_event defaults command to 'interactive' when CLOSEDLOOP_COMMAND unset"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    bash -c "
        unset CLOSEDLOOP_COMMAND
        source '$HELPERS'
        emit_perf_event '{\"event\":\"probe\"}'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "emit_perf_event default command" "$line" "command" "interactive"
    else
        fail "emit_perf_event default command" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: run_timed_step emits a pipeline_step event with all required fields
# ------------------------------------------------------------------
echo "Test 4: run_timed_step emits a pipeline_step event with all required fields"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="plan_execute"
    export CLOSEDLOOP_RUN_ID="run-timed-test"
    export CLOSEDLOOP_ITERATION="2"

    bash -c "
        source '$HELPERS'
        run_timed_step 3 'test_step' true
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ ! -f "$perf_file" ]]; then
        fail "run_timed_step: perf.jsonl was created" "file not found"
    else
        pass "run_timed_step: perf.jsonl was created"
        line=$(tail -1 "$perf_file")

        if echo "$line" | jq empty 2>/dev/null; then
            pass "run_timed_step: perf.jsonl line is valid JSON"
        else
            fail "run_timed_step: perf.jsonl line is valid JSON" "not valid JSON: $line"
        fi

        assert_field_equals "run_timed_step" "$line" "event" "pipeline_step"
        assert_field_equals "run_timed_step" "$line" "run_id" "run-timed-test"
        assert_field_equals "run_timed_step" "$line" "iteration" "2"
        assert_field_equals "run_timed_step" "$line" "step" "3"
        assert_field_equals "run_timed_step" "$line" "step_name" "test_step"
        assert_field_equals "run_timed_step" "$line" "skipped" "false"
        assert_field_equals "run_timed_step" "$line" "exit_code" "0"
        assert_field_equals "run_timed_step" "$line" "command" "plan_execute"
        assert_field_present "run_timed_step" "$line" "started_at"
        assert_field_present "run_timed_step" "$line" "ended_at"
        assert_field_type "run_timed_step" "$line" "duration_s" "number"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: run_timed_step preserves the exit code of the wrapped command
# ------------------------------------------------------------------
echo "Test 5: run_timed_step preserves exit code of wrapped command"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_RUN_ID="run-exit-test"
    export CLOSEDLOOP_ITERATION="0"

    actual_exit=0
    bash -c "
        source '$HELPERS'
        run_timed_step 1 'failing_step' bash -c 'exit 42'
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 42 ]]; then
        pass "run_timed_step: preserves exit code 42"
    else
        fail "run_timed_step: preserves exit code 42" "got exit $actual_exit"
    fi

    # Also verify the exit_code field in the emitted event
    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "run_timed_step exit_code field" "$line" "exit_code" "42"
    else
        fail "run_timed_step exit_code field" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: run_timed_step uses CLOSEDLOOP_RUN_ID (env-var approach)
#         and falls back to RUN_ID shell global for backward-compat
# ------------------------------------------------------------------
echo "Test 6: run_timed_step run_id fallback to RUN_ID shell global"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_ITERATION="0"
    # Explicitly unset CLOSEDLOOP_RUN_ID — the helper should fall back to RUN_ID
    unset CLOSEDLOOP_RUN_ID 2>/dev/null || true

    bash -c "
        RUN_ID='fallback-run-id'
        source '$HELPERS'
        run_timed_step 1 'fallback_step' true
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "run_timed_step RUN_ID fallback" "$line" "run_id" "fallback-run-id"
    else
        fail "run_timed_step RUN_ID fallback" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 7: emit_skipped_step emits a pipeline_step event with skipped=true
# ------------------------------------------------------------------
echo "Test 7: emit_skipped_step emits correct pipeline_step event"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="plan_execute"
    export CLOSEDLOOP_RUN_ID="run-skip-test"
    export CLOSEDLOOP_ITERATION="5"

    bash -c "
        source '$HELPERS'
        emit_skipped_step 7 'merge_build_result'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ ! -f "$perf_file" ]]; then
        fail "emit_skipped_step: perf.jsonl was created" "file not found"
    else
        pass "emit_skipped_step: perf.jsonl was created"
        line=$(tail -1 "$perf_file")

        if echo "$line" | jq empty 2>/dev/null; then
            pass "emit_skipped_step: perf.jsonl line is valid JSON"
        else
            fail "emit_skipped_step: perf.jsonl line is valid JSON" "not valid JSON: $line"
        fi

        assert_field_equals "emit_skipped_step" "$line" "event" "pipeline_step"
        assert_field_equals "emit_skipped_step" "$line" "run_id" "run-skip-test"
        assert_field_equals "emit_skipped_step" "$line" "iteration" "5"
        assert_field_equals "emit_skipped_step" "$line" "step" "7"
        assert_field_equals "emit_skipped_step" "$line" "step_name" "merge_build_result"
        assert_field_equals "emit_skipped_step" "$line" "skipped" "true"
        assert_field_equals "emit_skipped_step" "$line" "duration_s" "0"
        assert_field_equals "emit_skipped_step" "$line" "exit_code" "0"
        assert_field_equals "emit_skipped_step" "$line" "command" "plan_execute"
        assert_field_present "emit_skipped_step" "$line" "started_at"
        assert_field_present "emit_skipped_step" "$line" "ended_at"

        # started_at and ended_at must be equal for a skipped step (no elapsed time)
        started_at=$(echo "$line" | jq -r '.started_at')
        ended_at=$(echo "$line" | jq -r '.ended_at')
        if [[ "$started_at" == "$ended_at" ]]; then
            pass "emit_skipped_step: started_at == ended_at"
        else
            fail "emit_skipped_step: started_at == ended_at" \
                 "started_at=$started_at ended_at=$ended_at"
        fi
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 8: emit_skipped_step uses CLOSEDLOOP_RUN_ID env var
# ------------------------------------------------------------------
echo "Test 8: emit_skipped_step uses CLOSEDLOOP_RUN_ID env var"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_RUN_ID="env-run-id"
    export CLOSEDLOOP_ITERATION="3"

    bash -c "
        source '$HELPERS'
        emit_skipped_step 2 'pattern_relevance'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "emit_skipped_step CLOSEDLOOP_RUN_ID" "$line" "run_id" "env-run-id"
    else
        fail "emit_skipped_step CLOSEDLOOP_RUN_ID" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 9: emit_skipped_step falls back to RUN_ID shell global
# ------------------------------------------------------------------
echo "Test 9: emit_skipped_step run_id fallback to RUN_ID shell global"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_ITERATION="0"
    unset CLOSEDLOOP_RUN_ID 2>/dev/null || true

    bash -c "
        RUN_ID='global-run-id'
        source '$HELPERS'
        emit_skipped_step 4 'evaluate_goal'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "emit_skipped_step RUN_ID fallback" "$line" "run_id" "global-run-id"
    else
        fail "emit_skipped_step RUN_ID fallback" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 10: CLOSEDLOOP_ITERATION defaults to 0 when unset
# ------------------------------------------------------------------
echo "Test 10: CLOSEDLOOP_ITERATION defaults to 0 when unset"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_RUN_ID="run-iter-default"
    unset CLOSEDLOOP_ITERATION 2>/dev/null || true

    bash -c "
        unset CLOSEDLOOP_ITERATION
        source '$HELPERS'
        emit_skipped_step 1 'changed_files'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")
        assert_field_equals "CLOSEDLOOP_ITERATION default" "$line" "iteration" "0"
    else
        fail "CLOSEDLOOP_ITERATION default" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 11: multiple events are appended as separate JSONL lines
# ------------------------------------------------------------------
echo "Test 11: multiple emit calls produce separate JSONL lines"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="test"
    export CLOSEDLOOP_RUN_ID="run-multi"
    export CLOSEDLOOP_ITERATION="1"

    bash -c "
        source '$HELPERS'
        emit_skipped_step 1 'step_one'
        emit_skipped_step 2 'step_two'
        emit_skipped_step 3 'step_three'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line_count=$(wc -l < "$perf_file" | tr -d ' ')
        if [[ "$line_count" -eq 3 ]]; then
            pass "multiple emit calls: 3 lines in perf.jsonl"
        else
            fail "multiple emit calls: 3 lines in perf.jsonl" "got $line_count lines"
        fi

        # Every line must be valid JSON
        bad=0
        while IFS= read -r l; do
            if [[ -n "$l" ]] && ! echo "$l" | jq empty 2>/dev/null; then
                bad=$(( bad + 1 ))
            fi
        done < "$perf_file"
        if [[ "$bad" -eq 0 ]]; then
            pass "multiple emit calls: all lines are valid JSON"
        else
            fail "multiple emit calls: all lines are valid JSON" "$bad invalid line(s)"
        fi
    else
        fail "multiple emit calls" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 12: run_timed_step output matches the schema produced by
#          the original inline jq block in run-loop.sh (structural
#          equivalence: same keys, same field types)
# ------------------------------------------------------------------
echo "Test 12: run_timed_step schema matches run-loop.sh inline block schema"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="plan_execute"
    export CLOSEDLOOP_RUN_ID="run-schema-check"
    export CLOSEDLOOP_ITERATION="1"

    bash -c "
        source '$HELPERS'
        run_timed_step 1 'changed_files' true
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")

        # Required keys from the original inline jq block in post_iteration_processing
        required_keys=("event" "run_id" "iteration" "step" "step_name" "started_at" "ended_at" "duration_s" "exit_code" "skipped" "command")
        all_present=true
        for key in "${required_keys[@]}"; do
            val=$(echo "$line" | jq -r --arg k "$key" '.[$k] // empty' 2>/dev/null || echo "")
            if [[ -z "$val" ]] && [[ "$val" != "0" ]] && [[ "$val" != "false" ]]; then
                # Re-check with tostring to catch 0 / false
                val=$(echo "$line" | jq -r --arg k "$key" 'if has($k) then "present" else empty end' 2>/dev/null || echo "")
                if [[ "$val" != "present" ]]; then
                    fail "schema check: key '$key' present" "missing from: $line"
                    all_present=false
                fi
            fi
        done
        if [[ "$all_present" == "true" ]]; then
            pass "run_timed_step schema: all required keys present"
        fi

        # Numeric fields must be numbers
        assert_field_type "run_timed_step schema" "$line" "duration_s" "number"
        assert_field_type "run_timed_step schema" "$line" "exit_code" "number"
        assert_field_type "run_timed_step schema" "$line" "iteration" "number"
        assert_field_type "run_timed_step schema" "$line" "step" "number"

        # Boolean fields must be boolean
        assert_field_type "run_timed_step schema" "$line" "skipped" "boolean"
    else
        fail "run_timed_step schema" "perf.jsonl not created"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 13: emit_skipped_step schema matches run-loop.sh inline block schema
# ------------------------------------------------------------------
echo "Test 13: emit_skipped_step schema matches run-loop.sh inline block schema"
{
    tmpdir=$(setup_temp_workdir)

    export CLOSEDLOOP_WORKDIR="$tmpdir"
    export CLOSEDLOOP_COMMAND="plan_execute"
    export CLOSEDLOOP_RUN_ID="run-skip-schema"
    export CLOSEDLOOP_ITERATION="2"

    bash -c "
        source '$HELPERS'
        emit_skipped_step 6 'verify_citations'
    "

    perf_file="$tmpdir/perf.jsonl"
    if [[ -f "$perf_file" ]]; then
        line=$(tail -1 "$perf_file")

        required_keys=("event" "run_id" "iteration" "step" "step_name" "started_at" "ended_at" "duration_s" "exit_code" "skipped" "command")
        all_present=true
        for key in "${required_keys[@]}"; do
            val=$(echo "$line" | jq -r --arg k "$key" 'if has($k) then "present" else empty end' 2>/dev/null || echo "")
            if [[ "$val" != "present" ]]; then
                fail "skip schema: key '$key' present" "missing from: $line"
                all_present=false
            fi
        done
        if [[ "$all_present" == "true" ]]; then
            pass "emit_skipped_step schema: all required keys present"
        fi

        assert_field_type "emit_skipped_step schema" "$line" "duration_s" "number"
        assert_field_type "emit_skipped_step schema" "$line" "exit_code" "number"
        assert_field_type "emit_skipped_step schema" "$line" "iteration" "number"
        assert_field_type "emit_skipped_step schema" "$line" "step" "number"
        assert_field_type "emit_skipped_step schema" "$line" "skipped" "boolean"
    else
        fail "emit_skipped_step schema" "perf.jsonl not created"
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
