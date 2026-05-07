# Shared helpers for the perf-hook bash test suite. Sourced by:
#   test_tool_event.sh, test_skill_event.sh, test_spawn_event.sh,
#   test_fail_open.sh, test_correlation.sh
#
# Provides: PASS_COUNT/FAIL_COUNT counters, pass/fail reporters,
#           assert_field_present, assert_field_equals,
#           setup_temp_env, create_sentinel.
#
# Each caller is still responsible for declaring its own per-test mock-input
# builders (build_mock_input variants) and any test-file-specific assertions
# (e.g. assert_exit_zero, assert_perf_not_corrupted live in test_fail_open.sh
# because only that file uses them).
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/test_helpers.sh"

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
    # Asserts that a JSON field exists and is non-empty in a given JSON string.
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

assert_field_equals() {
    # Asserts that a JSON field has a specific expected value.
    local test_name="$1"
    local json="$2"
    local field="$3"
    local expected="$4"
    local actual
    actual=$(echo "$json" | jq -r --arg f "$field" '.[$f] | tostring' 2>/dev/null || echo "")
    if [[ "$actual" == "$expected" ]]; then
        pass "$test_name: field '$field' = '$expected'"
    else
        fail "$test_name: field '$field' expected '$expected' but got '$actual'"
    fi
}

# ---- Setup helpers -------------------------------------------------------
setup_temp_env() {
    # Creates an isolated temp directory matching the layout the hooks expect:
    #   $TMPDIR/cwd/                         -- fake CWD passed in hook payloads
    #   $TMPDIR/cwd/.closedloop-ai/          -- state dir holding session mapping
    #   $TMPDIR/workdir/                     -- CLOSEDLOOP_WORKDIR
    #   $TMPDIR/workdir/.tool-calls/         -- sentinel directory the hooks read/write
    # Session mapping (session-{id}.workdir) is written so the hooks can
    # discover CLOSEDLOOP_WORKDIR via session_id, mirroring real Claude Code.
    #
    # Optional first arg: prefix for the session id (helps disambiguate test
    # output across files). Default is "test". $$ alone isn't unique when one
    # test file calls setup_temp_env multiple times in quick succession, so
    # $RANDOM is appended too.
    local prefix="${1:-test}"
    local tmpdir
    tmpdir=$(mktemp -d)
    local cwd="$tmpdir/cwd"
    local workdir="$tmpdir/workdir"
    local session_id="${prefix}-$$-${RANDOM}"
    local state_dir="$cwd/.closedloop-ai"

    mkdir -p "$state_dir"
    mkdir -p "$workdir/.tool-calls"
    echo "$workdir" > "$state_dir/session-$session_id.workdir"

    # Echo all four values on one line so callers can use:
    #   read -r tmpdir cwd workdir session_id <<< "$(setup_temp_env "skill")"
    echo "$tmpdir $cwd $workdir $session_id"
}

# ---- Sentinel writers ----------------------------------------------------
create_sentinel() {
    # Writes a sentinel JSON file (as pre-tool-use-hook.sh would) to the given path.
    # Used by tests that exercise post-tool-use-hook.sh in isolation; tests that
    # exercise the real pre→post correlation flow run the pre-hook itself instead.
    local sentinel_path="$1"
    local started_at="$2"
    local tool_name="$3"
    local agent_id="$4"
    local run_id="$5"
    local command="$6"
    local iteration="$7"
    jq -n -c \
        --arg started_at "$started_at" \
        --arg tool_name "$tool_name" \
        --arg agent_id "$agent_id" \
        --arg run_id "$run_id" \
        --arg command "$command" \
        --argjson iteration "$iteration" \
        '{started_at:$started_at,tool_name:$tool_name,agent_id:$agent_id,run_id:$run_id,command:$command,iteration:$iteration}' \
        > "$sentinel_path"
}
