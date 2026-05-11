#!/usr/bin/env bash
# Tests for command-telemetry-init.sh
#
# Validates:
#   - CLOSEDLOOP_WORKDIR detection: from $2 argument, CLOSEDLOOP_WORKDIR env var, or default
#   - CLOSEDLOOP_RUN_ID generation: format YYYYMMDD-HHMMSS-HEXHEX
#   - CLOSEDLOOP_COMMAND export
#   - CLOSEDLOOP_START_TIME export
#   - Fail-open behaviour: errors inside the init do not abort the caller
#
# Usage:
#   bash plugins/code/scripts/tests/test_command_telemetry_init.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT_SCRIPT="$SCRIPT_DIR/../command-telemetry-init.sh"

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

assert_equals() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name"
    else
        fail "$test_name" "expected '$expected' but got '$actual'"
    fi
}

assert_nonempty() {
    local test_name="$1"
    local value="$2"
    if [[ -n "$value" ]]; then
        pass "$test_name"
    else
        fail "$test_name" "value was empty"
    fi
}

assert_matches() {
    local test_name="$1"
    local pattern="$2"
    local value="$3"
    if [[ "$value" =~ $pattern ]]; then
        pass "$test_name"
    else
        fail "$test_name" "value '$value' did not match pattern '$pattern'"
    fi
}

# ---- Helper: source the init script in a clean subshell and print env vars ---
# Invocation: run_init [arg1] [arg2] [env_overrides...]
# Prints one line per exported var: NAME=VALUE
run_init_and_dump() {
    # $1 = command_name arg (may be empty string)
    # $2 = workdir arg     (may be empty string)
    # $3 = CLOSEDLOOP_WORKDIR env override (may be empty string)
    local cmd_arg="${1:-}"
    local workdir_arg="${2:-}"
    local env_workdir="${3:-}"

    bash -c "
        $([ -n '$env_workdir' ] && echo "export CLOSEDLOOP_WORKDIR='$env_workdir'" || echo "unset CLOSEDLOOP_WORKDIR")
        source '$INIT_SCRIPT' '$cmd_arg' '$workdir_arg'
        echo \"CLOSEDLOOP_WORKDIR=\$CLOSEDLOOP_WORKDIR\"
        echo \"CLOSEDLOOP_RUN_ID=\$CLOSEDLOOP_RUN_ID\"
        echo \"CLOSEDLOOP_COMMAND=\$CLOSEDLOOP_COMMAND\"
        echo \"CLOSEDLOOP_START_TIME=\$CLOSEDLOOP_START_TIME\"
    "
}

# ---- Setup helpers -------------------------------------------------------
setup_temp_workdir() {
    mktemp -d
}

# ---- Tests ---------------------------------------------------------------

echo "Running tests for command-telemetry-init.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: WORKDIR from $2 argument overrides everything
# ------------------------------------------------------------------
echo "Test 1: WORKDIR detection — from \$2 argument"
{
    tmpdir=$(setup_temp_workdir)

    # Pass workdir as $2; also set env var to ensure $2 wins
    output=$(bash -c "
        export CLOSEDLOOP_WORKDIR='/should/not/be/used'
        source '$INIT_SCRIPT' 'test-cmd' '$tmpdir'
        echo \"\$CLOSEDLOOP_WORKDIR\"
    ")

    assert_equals "WORKDIR from \$2 argument" "$tmpdir" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: WORKDIR from CLOSEDLOOP_WORKDIR env var when no $2 argument
# ------------------------------------------------------------------
echo "Test 2: WORKDIR detection — from CLOSEDLOOP_WORKDIR env var"
{
    tmpdir=$(setup_temp_workdir)

    output=$(bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_WORKDIR\"
    ")

    assert_equals "WORKDIR from env var" "$tmpdir" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: WORKDIR defaults to .closedloop-ai/telemetry when neither arg nor env var
# ------------------------------------------------------------------
echo "Test 3: WORKDIR detection — default fallback"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_WORKDIR\"
    ")

    assert_equals "WORKDIR default" ".closedloop-ai/telemetry" "$output"
}

# ------------------------------------------------------------------
# Test 4: $2 argument takes precedence over CLOSEDLOOP_WORKDIR env var
# ------------------------------------------------------------------
echo "Test 4: WORKDIR precedence — \$2 arg wins over env var"
{
    tmpdir_arg=$(setup_temp_workdir)
    tmpdir_env=$(setup_temp_workdir)

    output=$(bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir_env'
        source '$INIT_SCRIPT' 'test-cmd' '$tmpdir_arg'
        echo \"\$CLOSEDLOOP_WORKDIR\"
    ")

    assert_equals "WORKDIR arg beats env var" "$tmpdir_arg" "$output"

    rm -rf "$tmpdir_arg" "$tmpdir_env"
}

# ------------------------------------------------------------------
# Test 5: CLOSEDLOOP_COMMAND is exported with the value of $1
# ------------------------------------------------------------------
echo "Test 5: CLOSEDLOOP_COMMAND is exported"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'my-slash-command'
        echo \"\$CLOSEDLOOP_COMMAND\"
    ")

    assert_equals "CLOSEDLOOP_COMMAND set" "my-slash-command" "$output"
}

# ------------------------------------------------------------------
# Test 6: CLOSEDLOOP_RUN_ID is generated and non-empty
# ------------------------------------------------------------------
echo "Test 6: CLOSEDLOOP_RUN_ID is generated and non-empty"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_RUN_ID\"
    ")

    assert_nonempty "CLOSEDLOOP_RUN_ID non-empty" "$output"
}

# ------------------------------------------------------------------
# Test 7: CLOSEDLOOP_RUN_ID matches YYYYMMDD-HHMMSS-HEXHEX format
# ------------------------------------------------------------------
echo "Test 7: CLOSEDLOOP_RUN_ID format matches YYYYMMDD-HHMMSS-<hex>"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_RUN_ID\"
    ")

    # Format: 8 digits - 6 digits - hex chars (8 hex chars from 4-byte xxd)
    assert_matches "CLOSEDLOOP_RUN_ID format" \
        '^[0-9]{8}-[0-9]{6}-[0-9a-f]+$' \
        "$output"
}

# ------------------------------------------------------------------
# Test 8: CLOSEDLOOP_RUN_ID timestamp portion matches today's date (YYYYMMDD)
# ------------------------------------------------------------------
echo "Test 8: CLOSEDLOOP_RUN_ID date portion matches today"
{
    today=$(date +%Y%m%d)
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_RUN_ID\"
    ")

    date_part="${output:0:8}"
    assert_equals "CLOSEDLOOP_RUN_ID date portion" "$today" "$date_part"
}

# ------------------------------------------------------------------
# Test 9: CLOSEDLOOP_START_TIME is exported and non-empty
# ------------------------------------------------------------------
echo "Test 9: CLOSEDLOOP_START_TIME is exported and non-empty"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_START_TIME\"
    ")

    assert_nonempty "CLOSEDLOOP_START_TIME non-empty" "$output"
}

# ------------------------------------------------------------------
# Test 10: CLOSEDLOOP_START_TIME is a unix epoch integer
# ------------------------------------------------------------------
echo "Test 10: CLOSEDLOOP_START_TIME is a unix epoch integer"
{
    output=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_START_TIME\"
    ")

    # Must be all digits and greater than a fixed past epoch (2020-01-01 = 1577836800)
    if [[ "$output" =~ ^[0-9]+$ ]] && [[ "$output" -gt 1577836800 ]]; then
        pass "CLOSEDLOOP_START_TIME is a valid epoch"
    else
        fail "CLOSEDLOOP_START_TIME is a valid epoch" "got '$output'"
    fi
}

# ------------------------------------------------------------------
# Test 11: Missing COMMAND_NAME (empty $1) — script still exits 0,
#          env vars are NOT set (init bails early)
# ------------------------------------------------------------------
echo "Test 11: Empty command name — script exits 0 (fail-open)"
{
    actual_exit=0
    bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' ''
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "empty command name: exits 0"
    else
        fail "empty command name: exits 0" "got exit $actual_exit"
    fi
}

# ------------------------------------------------------------------
# Test 12: Fail-open — record_run.sh missing does not abort the caller
#
# We override PATH to a temp dir where record_run.sh does not exist,
# but the script should still exit 0.
# ------------------------------------------------------------------
echo "Test 12: Fail-open — missing record_run.sh does not abort"
{
    # Create a temp scripts dir that has command-telemetry-init.sh but no record_run.sh
    tmpscripts=$(setup_temp_workdir)
    cp "$INIT_SCRIPT" "$tmpscripts/command-telemetry-init.sh"
    # Note: we do NOT copy record_run.sh — it won't be found

    actual_exit=0
    bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$tmpscripts/command-telemetry-init.sh' 'test-cmd'
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "missing record_run.sh: exits 0"
    else
        fail "missing record_run.sh: exits 0" "got exit $actual_exit"
    fi

    rm -rf "$tmpscripts"
}

# ------------------------------------------------------------------
# Test 13: Fail-open — record_run.sh failing does not abort the caller
# ------------------------------------------------------------------
echo "Test 13: Fail-open — failing record_run.sh does not abort"
{
    # Create a temp scripts dir with a record_run.sh that exits non-zero
    tmpscripts=$(setup_temp_workdir)
    cp "$INIT_SCRIPT" "$tmpscripts/command-telemetry-init.sh"
    cat > "$tmpscripts/record_run.sh" <<'INNER'
#!/usr/bin/env bash
exit 99
INNER
    chmod +x "$tmpscripts/record_run.sh"

    actual_exit=0
    bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$tmpscripts/command-telemetry-init.sh' 'test-cmd'
    " ; actual_exit=$?

    if [[ "$actual_exit" -eq 0 ]]; then
        pass "failing record_run.sh: exits 0"
    else
        fail "failing record_run.sh: exits 0" "got exit $actual_exit"
    fi

    rm -rf "$tmpscripts"
}

# ------------------------------------------------------------------
# Test 14: All four env vars are exported together in one invocation
# ------------------------------------------------------------------
echo "Test 14: All four env vars exported together"
{
    tmpdir=$(setup_temp_workdir)

    output=$(bash -c "
        export CLOSEDLOOP_WORKDIR='$tmpdir'
        source '$INIT_SCRIPT' 'combined-test'
        echo \"WORKDIR=\$CLOSEDLOOP_WORKDIR\"
        echo \"RUN_ID=\$CLOSEDLOOP_RUN_ID\"
        echo \"COMMAND=\$CLOSEDLOOP_COMMAND\"
        echo \"START_TIME=\$CLOSEDLOOP_START_TIME\"
    ")

    workdir_val=$(echo "$output" | grep '^WORKDIR=' | cut -d= -f2-)
    run_id_val=$(echo "$output" | grep '^RUN_ID=' | cut -d= -f2-)
    command_val=$(echo "$output" | grep '^COMMAND=' | cut -d= -f2-)
    start_time_val=$(echo "$output" | grep '^START_TIME=' | cut -d= -f2-)

    assert_equals  "combined: CLOSEDLOOP_WORKDIR"    "$tmpdir"         "$workdir_val"
    assert_equals  "combined: CLOSEDLOOP_COMMAND"    "combined-test"   "$command_val"
    assert_nonempty "combined: CLOSEDLOOP_RUN_ID"    "$run_id_val"
    assert_nonempty "combined: CLOSEDLOOP_START_TIME" "$start_time_val"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 15: CLOSEDLOOP_RUN_ID is unique across two successive invocations
# ------------------------------------------------------------------
echo "Test 15: CLOSEDLOOP_RUN_ID is unique per invocation"
{
    run_id_1=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_RUN_ID\"
    ")

    # Small sleep to ensure different timestamp (1 second resolution)
    sleep 1

    run_id_2=$(bash -c "
        unset CLOSEDLOOP_WORKDIR
        source '$INIT_SCRIPT' 'test-cmd'
        echo \"\$CLOSEDLOOP_RUN_ID\"
    ")

    if [[ "$run_id_1" != "$run_id_2" ]]; then
        pass "CLOSEDLOOP_RUN_ID uniqueness across invocations"
    else
        # IDs could technically collide on a fast machine; report but don't hard-fail
        # (the random suffix makes this extremely unlikely)
        fail "CLOSEDLOOP_RUN_ID uniqueness across invocations" \
             "both runs produced '$run_id_1' (may be timing issue)"
    fi
}

# ---- Summary -------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
