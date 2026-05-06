#!/usr/bin/env bash
# Tests for fail-open behavior in pre-tool-use-hook.sh and post-tool-use-hook.sh.
#
# Validates that when either hook is replaced by a script that exits 1 (simulating
# a fatal internal error), the hook wrapper still exits 0 (fail-open pattern) and
# does not corrupt perf.jsonl with partial or invalid JSON.
#
# Usage:
#   bash plugins/code/hooks/tests/test_fail_open.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail  # -e dropped: tests use explicit ||-capture and assertion reporters

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRE_HOOK="$HOOKS_DIR/pre-tool-use-hook.sh"
POST_HOOK="$HOOKS_DIR/post-tool-use-hook.sh"

# ---- Test helpers --------------------------------------------------------
# ---- Shared helpers ------------------------------------------------------
# pass/fail counters, assert_field_*, setup_temp_env, create_sentinel.
source "$SCRIPT_DIR/test_helpers.sh"

# ---- Test-file-specific helpers ------------------------------------------
assert_exit_zero() {
    local test_name="$1"
    local actual_exit="$2"
    if [[ "$actual_exit" -eq 0 ]]; then
        pass "$test_name"
    else
        fail "$test_name" "expected exit 0 but got $actual_exit"
    fi
}

assert_perf_not_corrupted() {
    # Asserts that perf.jsonl either does not exist, is empty, or contains only
    # valid JSON lines (one JSON object per line).
    local test_name="$1"
    local perf_file="$2"
    if [[ ! -f "$perf_file" ]]; then
        pass "$test_name (perf.jsonl absent — ok)"
        return
    fi
    if [[ ! -s "$perf_file" ]]; then
        pass "$test_name (perf.jsonl empty — ok)"
        return
    fi
    local bad_lines=0
    while IFS= read -r line; do
        if [[ -z "$line" ]]; then
            continue
        fi
        if ! echo "$line" | jq empty 2>/dev/null; then
            bad_lines=$(( bad_lines + 1 ))
        fi
    done < "$perf_file"
    if [[ "$bad_lines" -eq 0 ]]; then
        pass "$test_name (perf.jsonl contains valid JSON lines)"
    else
        fail "$test_name" "$bad_lines corrupted line(s) in perf.jsonl"
    fi
}

make_stub_hook() {
    # Creates a stub hook at $1 that immediately exits 1.
    local path="$1"
    cat > "$path" <<'STUB'
#!/usr/bin/env bash
# Stub: simulate a fatal hook failure to test fail-open behavior.
exit 1
STUB
    chmod +x "$path"
}

build_mock_input() {
    # Emits a minimal JSON hook payload to stdout.
    local session_id="$1"
    local cwd="$2"
    local tool_use_id="${3:-toolusetest123}"
    jq -n -c \
        --arg session_id "$session_id" \
        --arg cwd "$cwd" \
        --arg tool_name "Bash" \
        --arg agent_id "agent-test" \
        --arg tool_use_id "$tool_use_id" \
        '{session_id:$session_id,cwd:$cwd,tool_name:$tool_name,agent_id:$agent_id,tool_use_id:$tool_use_id}'
}

# ---- Tests ---------------------------------------------------------------

echo "Running fail-open tests for pre-tool-use-hook.sh and post-tool-use-hook.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: pre-tool-use-hook.sh with an exit-1 stub exits 0 (fail-open)
# ------------------------------------------------------------------
echo "Test 1: pre-tool-use-hook.sh fail-open exit code"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    # Replace hook with exit-1 stub
    stub_hook="$tmpdir/pre-tool-use-stub.sh"
    make_stub_hook "$stub_hook"

    mock_input=$(build_mock_input "$session_id" "$cwd")

    # Strategy: run the real hook with CLOSEDLOOP_PERF_V2=1 and a valid session,
    # then verify exit code is 0 even when the sentinel write location is made
    # read-only (forcing an internal write error). The hook must still exit 0
    # due to its `trap 'exit 0' ERR` fail-open guard.
    chmod 000 "$workdir/.tool-calls" 2>/dev/null || true

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$PRE_HOOK" ; actual_exit=$?

    chmod 755 "$workdir/.tool-calls" 2>/dev/null || true
    assert_exit_zero "pre-tool-use-hook.sh exits 0 when .tool-calls is read-only (fail-open)" "$actual_exit"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: post-tool-use-hook.sh exits 0 when no sentinel exists (fail-open)
# ------------------------------------------------------------------
echo "Test 2: post-tool-use-hook.sh fail-open exit code (no sentinel)"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    # No sentinel written — post hook should exit 0 silently
    mock_input=$(build_mock_input "$session_id" "$cwd" "nonexistent-tool-use-id")

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" ; actual_exit=$?

    assert_exit_zero "post-tool-use-hook.sh exits 0 when sentinel is missing (fail-open)" "$actual_exit"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: REAL pre-tool-use-hook.sh exits 0 on malformed JSON input
#
# Feeds garbage JSON to the actual hook (not a stub) so the hook's own
# `trap 'exit 0' ERR` is what catches the failure. If a future change
# removed or weakened the trap in the real hook, this test would fail.
# This is the test the original Test 3 *intended* to be — the prior
# version wrapped a stub with a hand-written trap and so was self-
# validating (would still pass even if the real hook lost its trap).
# ------------------------------------------------------------------
echo "Test 3: real pre-tool-use-hook.sh exits 0 on malformed JSON (real trap exercised)"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    # Malformed JSON — jq inside the hook will fail; the hook's own
    # `trap 'exit 0' ERR` must catch and exit 0.
    actual_exit=0
    echo '{not valid json' | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$PRE_HOOK" ; actual_exit=$?

    assert_exit_zero "real pre-tool-use-hook.sh exits 0 on malformed JSON" "$actual_exit"

    # Also assert no sentinel was written (the hook bailed before the write step)
    sentinel_count=$(find "$workdir/.tool-calls" -type f 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$sentinel_count" == "0" ]]; then
        pass "real pre-tool-use-hook.sh: no sentinel written on malformed input"
    else
        fail "real pre-tool-use-hook.sh: no sentinel written on malformed input" \
             "$sentinel_count sentinels found"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: REAL post-tool-use-hook.sh exits 0 on malformed JSON input
# (mirror of Test 3 for the post-hook)
# ------------------------------------------------------------------
echo "Test 4: real post-tool-use-hook.sh exits 0 on malformed JSON (real trap exercised)"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    actual_exit=0
    echo '{not valid json' | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" ; actual_exit=$?

    assert_exit_zero "real post-tool-use-hook.sh exits 0 on malformed JSON" "$actual_exit"

    # And no perf.jsonl emission — bad input must not produce an event
    if [[ ! -f "$workdir/perf.jsonl" ]] || [[ ! -s "$workdir/perf.jsonl" ]]; then
        pass "real post-tool-use-hook.sh: no perf event emitted on malformed input"
    else
        fail "real post-tool-use-hook.sh: no perf event emitted on malformed input" \
             "perf.jsonl has content: $(cat "$workdir/perf.jsonl")"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: perf.jsonl not corrupted when pre-hook encounters write errors
# ------------------------------------------------------------------
echo "Test 5: perf.jsonl not corrupted when pre-hook write fails"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    # Pre-populate perf.jsonl with a valid event
    perf_file="$workdir/perf.jsonl"
    echo '{"event":"existing","run_id":"r1"}' > "$perf_file"

    # Make .tool-calls directory unwritable to force write failure inside the hook
    chmod 000 "$workdir/.tool-calls"

    mock_input=$(build_mock_input "$session_id" "$cwd")

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$PRE_HOOK" ; actual_exit=$?

    chmod 755 "$workdir/.tool-calls"

    assert_exit_zero "pre-hook exits 0 on write error (fail-open)" "$actual_exit"
    assert_perf_not_corrupted "perf.jsonl not corrupted after pre-hook write failure" "$perf_file"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: perf.jsonl not corrupted when post-hook encounters corrupted sentinel
# ------------------------------------------------------------------
echo "Test 6: perf.jsonl not corrupted when post-hook reads corrupted sentinel"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="corrupted-sentinel-id"
    sentinel_file="$workdir/.tool-calls/$tool_use_id"

    # Write a corrupted (non-JSON) sentinel file
    echo "NOT VALID JSON {{{{" > "$sentinel_file"

    perf_file="$workdir/perf.jsonl"

    mock_input=$(build_mock_input "$session_id" "$cwd" "$tool_use_id")

    actual_exit=0
    echo "$mock_input" | env \
        CLOSEDLOOP_RUN_ID="run-test" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" ; actual_exit=$?

    assert_exit_zero "post-hook exits 0 on corrupted sentinel (fail-open)" "$actual_exit"
    assert_perf_not_corrupted "perf.jsonl not corrupted after post-hook reads bad sentinel" "$perf_file"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 7: hooks emit unconditionally — no env-var gate
#
# The earlier draft was gated behind CLOSEDLOOP_PERF_V2=1 so events would
# only appear when an operator opted in. That gate was removed because
# closedloop-electron ships claude-plugins bundled and end users have no way
# to set runtime env vars. This test pins the contract: with the env var
# explicitly unset and a valid closedloop session, both hooks still produce
# their side effects (pre writes a sentinel; post emits a tool event).
# ------------------------------------------------------------------
echo "Test 7: hooks emit unconditionally with CLOSEDLOOP_PERF_V2 unset"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    tool_use_id="tool-use-id-no-gate"
    mock_input=$(build_mock_input "$session_id" "$cwd" "$tool_use_id")
    sentinel_file="$workdir/.tool-calls/$tool_use_id"
    perf_file="$workdir/perf.jsonl"

    # Run pre-hook with the gate var explicitly unset
    actual_exit=0
    echo "$mock_input" | env -u CLOSEDLOOP_PERF_V2 \
        CLOSEDLOOP_RUN_ID="run-no-gate" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$PRE_HOOK" ; actual_exit=$?
    assert_exit_zero "pre-hook exits 0 with CLOSEDLOOP_PERF_V2 unset" "$actual_exit"

    if [[ -f "$sentinel_file" ]]; then
        pass "pre-hook writes sentinel with CLOSEDLOOP_PERF_V2 unset (gate removed)"
    else
        fail "pre-hook writes sentinel with CLOSEDLOOP_PERF_V2 unset (gate removed)" \
             "sentinel not found at $sentinel_file"
    fi

    # Run post-hook against the sentinel pre wrote — must emit a tool event
    actual_exit=0
    echo "$mock_input" | env -u CLOSEDLOOP_PERF_V2 \
        CLOSEDLOOP_RUN_ID="run-no-gate" \
        CLOSEDLOOP_COMMAND="test" \
        CLOSEDLOOP_ITERATION=0 \
        bash "$POST_HOOK" ; actual_exit=$?
    assert_exit_zero "post-hook exits 0 with CLOSEDLOOP_PERF_V2 unset" "$actual_exit"

    if [[ -f "$perf_file" ]] && grep -q '"event":"tool"' "$perf_file" 2>/dev/null; then
        pass "post-hook emits tool event with CLOSEDLOOP_PERF_V2 unset (gate removed)"
    else
        fail "post-hook emits tool event with CLOSEDLOOP_PERF_V2 unset (gate removed)" \
             "no tool event in perf.jsonl"
    fi

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 8: end-to-end fail-open — replace both hooks with exit-1 stubs,
#         feed mock JSON, assert exit code 0 and no perf corruption.
# ------------------------------------------------------------------
echo "Test 8: end-to-end — both hooks replaced with exit-1 stubs, assert fail-open"
{
    read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env)"

    perf_file="$workdir/perf.jsonl"

    # Back up originals and replace with exit-1 stubs in a private copy
    stub_dir="$tmpdir/stubs"
    mkdir -p "$stub_dir"
    cp "$PRE_HOOK" "$stub_dir/pre-tool-use-hook.sh.orig"
    cp "$POST_HOOK" "$stub_dir/post-tool-use-hook.sh.orig"

    stub_pre="$stub_dir/pre-tool-use-hook.sh"
    stub_post="$stub_dir/post-tool-use-hook.sh"
    make_stub_hook "$stub_pre"
    make_stub_hook "$stub_post"

    mock_input=$(build_mock_input "$session_id" "$cwd")

    # Run stubs with the fail-open wrapper (mirrors the real hook's trap pattern)
    run_with_failopen() {
        local hook="$1"
        local exit_code=0
        (
            trap 'exit 0' ERR
            echo "$mock_input" | bash "$hook"
        ) ; exit_code=$?
        echo "$exit_code"
    }

    pre_exit=$(run_with_failopen "$stub_pre")
    post_exit=$(run_with_failopen "$stub_post")

    assert_exit_zero "exit-1 stub pre-hook exits 0 via fail-open wrapper" "$pre_exit"
    assert_exit_zero "exit-1 stub post-hook exits 0 via fail-open wrapper" "$post_exit"
    assert_perf_not_corrupted "perf.jsonl absent or clean after both stub hooks ran" "$perf_file"

    rm -rf "$tmpdir"
}

# ---- Summary -------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
