#!/usr/bin/env bash
# Tests for the security override mechanism in pretooluse-hook.sh.
#
# Validates that:
#   1. Default deny still blocks all categories when no override file exists
#   2. Per-category overrides selectively allow specific blocked commands
#   3. Partial overrides only unblock the specified category
#   4. Malformed override files are treated as no-override (deny)
#   5. Override works for Read/Write/Edit tool file-path rules
#   6. Cloud credentials are split into cmd vs files categories
#
# Usage:
#   bash plugins/code/hooks/tests/test_security_overrides.sh
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail

# ---- Paths ---------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRE_HOOK="$HOOKS_DIR/pretooluse-hook.sh"

# ---- Shared helpers ------------------------------------------------------
source "$SCRIPT_DIR/test_helpers.sh"

# ---- Test-specific helpers -----------------------------------------------
build_bash_input() {
    # Emits a minimal JSON PreToolUse hook payload for a Bash command.
    local command="$1"
    local session_id="${2:-nosession}"
    local cwd="${3:-/tmp}"
    jq -n -c \
        --arg cmd "$command" \
        --arg sid "$session_id" \
        --arg cwd "$cwd" \
        '{tool_name:"Bash",tool_input:{command:$cmd},session_id:$sid,cwd:$cwd}'
}

build_read_input() {
    # Emits a minimal JSON PreToolUse hook payload for a Read tool.
    local file_path="$1"
    local session_id="${2:-nosession}"
    local cwd="${3:-/tmp}"
    jq -n -c \
        --arg fp "$file_path" \
        --arg sid "$session_id" \
        --arg cwd "$cwd" \
        '{tool_name:"Read",tool_input:{file_path:$fp},session_id:$sid,cwd:$cwd}'
}

run_hook() {
    # Runs the pretooluse hook with the given input and override file.
    # Returns the hook's stdout; exit code is captured in $hook_exit.
    local input="$1"
    local overrides_file="$2"
    hook_exit=0
    echo "$input" | env CLAUDE_SECURITY_OVERRIDES="$overrides_file" bash "$PRE_HOOK" 2>/dev/null || hook_exit=$?
}

assert_denied() {
    local test_name="$1"
    local output="$2"
    local decision
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
    if [[ "$decision" == "deny" ]]; then
        pass "$test_name"
    else
        fail "$test_name" "expected deny but got: $output"
    fi
}

assert_not_denied() {
    local test_name="$1"
    local output="$2"
    local decision
    decision=$(echo "$output" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
    if [[ "$decision" == "deny" ]]; then
        fail "$test_name" "expected pass-through but got deny"
    else
        pass "$test_name"
    fi
}

# ---- Tests ---------------------------------------------------------------

echo "Running security override tests for pretooluse-hook.sh"
echo ""

# ------------------------------------------------------------------
# Test 1: Default deny — no override file
# ------------------------------------------------------------------
echo "Test 1: All categories denied when no override file exists"
{
    tmpdir=$(mktemp -d)
    no_file="$tmpdir/nonexistent.json"

    # pkill
    output=$(run_hook "$(build_bash_input "pkill node")" "$no_file")
    assert_denied "process-kill denied (no override file)" "$output"

    # gcloud auth
    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$no_file")
    assert_denied "cloud-credentials-cmd denied (no override file)" "$output"

    # aws credentials file
    output=$(run_hook "$(build_bash_input "cat ~/.aws/credentials")" "$no_file")
    assert_denied "cloud-credentials-files denied (no override file)" "$output"

    # ssh key
    output=$(run_hook "$(build_bash_input "cat ~/.ssh/id_rsa")" "$no_file")
    assert_denied "ssh-keys denied (no override file)" "$output"

    # keychain
    output=$(run_hook "$(build_bash_input "security find-generic-password -s foo")" "$no_file")
    assert_denied "keychain denied (no override file)" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 2: Per-category override allows specific command
# ------------------------------------------------------------------
echo ""
echo "Test 2: Per-category override allows specific blocked commands"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    # Enable only process-kill
    cat > "$overrides" <<'EOF'
{"overrides":{"process-kill":true}}
EOF

    output=$(run_hook "$(build_bash_input "pkill node")" "$overrides")
    assert_not_denied "process-kill allowed with override" "$output"

    # killall variant
    output=$(run_hook "$(build_bash_input "killall node")" "$overrides")
    assert_not_denied "killall allowed with override" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 3: Partial override — only the enabled category is allowed
# ------------------------------------------------------------------
echo ""
echo "Test 3: Partial override only unblocks the specified category"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    # Enable only cloud-credentials-cmd
    cat > "$overrides" <<'EOF'
{"overrides":{"cloud-credentials-cmd":true}}
EOF

    # gcloud auth command should pass
    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_not_denied "cloud-credentials-cmd allowed" "$output"

    output=$(run_hook "$(build_bash_input "gcloud auth application-default print-access-token")" "$overrides")
    assert_not_denied "gcloud auth application-default allowed" "$output"

    # cloud credential files should still be denied
    output=$(run_hook "$(build_bash_input "cat ~/.aws/credentials")" "$overrides")
    assert_denied "cloud-credentials-files still denied" "$output"

    # pkill should still be denied
    output=$(run_hook "$(build_bash_input "pkill node")" "$overrides")
    assert_denied "process-kill still denied" "$output"

    # ssh keys should still be denied
    output=$(run_hook "$(build_bash_input "cat ~/.ssh/id_rsa")" "$overrides")
    assert_denied "ssh-keys still denied" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 4: Malformed override file treated as no override
# ------------------------------------------------------------------
echo ""
echo "Test 4: Malformed override file treated as no override (deny)"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    # Write invalid JSON
    echo "this is not json" > "$overrides"

    output=$(run_hook "$(build_bash_input "pkill node")" "$overrides")
    assert_denied "process-kill denied (malformed override file)" "$output"

    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_denied "cloud-credentials-cmd denied (malformed override file)" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 5: Override works for Read/Write/Edit file-path rules
# ------------------------------------------------------------------
echo ""
echo "Test 5: Override works for Read tool file-path rules"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    # Enable cloud-credentials-files
    cat > "$overrides" <<'EOF'
{"overrides":{"cloud-credentials-files":true}}
EOF

    # Read ~/.aws/credentials should pass
    output=$(run_hook "$(build_read_input "$HOME/.aws/credentials")" "$overrides")
    assert_not_denied "Read cloud credential file allowed" "$output"

    # Read gcloud credentials.db should pass
    output=$(run_hook "$(build_read_input "$HOME/.config/gcloud/credentials.db")" "$overrides")
    assert_not_denied "Read gcloud credentials.db allowed" "$output"

    # Read SSH key should still be denied
    output=$(run_hook "$(build_read_input "$HOME/.ssh/id_rsa")" "$overrides")
    assert_denied "Read ssh key still denied" "$output"

    # Read browser cookies should still be denied
    output=$(run_hook "$(build_read_input "$HOME/Library/Application Support/Google/Chrome/Default/Cookies")" "$overrides")
    assert_denied "Read browser cookies still denied" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 6: Cloud credentials split — cmd vs files are independent
# ------------------------------------------------------------------
echo ""
echo "Test 6: Cloud credentials cmd vs files are independent categories"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    # Enable only cloud-credentials-files (not cmd)
    cat > "$overrides" <<'EOF'
{"overrides":{"cloud-credentials-files":true}}
EOF

    # File access allowed
    output=$(run_hook "$(build_bash_input "cat ~/.aws/credentials")" "$overrides")
    assert_not_denied "cloud-credentials-files Bash allowed" "$output"

    output=$(run_hook "$(build_bash_input "cat ~/.config/gcloud/application_default_credentials.json")" "$overrides")
    assert_not_denied "cloud-credentials-files gcloud ADC allowed" "$output"

    # Command still denied
    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_denied "cloud-credentials-cmd still denied" "$output"

    # Now flip: enable only cmd
    cat > "$overrides" <<'EOF'
{"overrides":{"cloud-credentials-cmd":true}}
EOF

    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_not_denied "cloud-credentials-cmd allowed" "$output"

    output=$(run_hook "$(build_bash_input "cat ~/.aws/credentials")" "$overrides")
    assert_denied "cloud-credentials-files denied when only cmd enabled" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 7: Override set to false is same as not set
# ------------------------------------------------------------------
echo ""
echo "Test 7: Override set to false is same as not set"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    cat > "$overrides" <<'EOF'
{"overrides":{"process-kill":false,"cloud-credentials-cmd":false}}
EOF

    output=$(run_hook "$(build_bash_input "pkill node")" "$overrides")
    assert_denied "process-kill denied when explicitly false" "$output"

    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_denied "cloud-credentials-cmd denied when explicitly false" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 8: Multiple overrides enabled simultaneously
# ------------------------------------------------------------------
echo ""
echo "Test 8: Multiple overrides enabled simultaneously"
{
    tmpdir=$(mktemp -d)
    overrides="$tmpdir/overrides.json"

    cat > "$overrides" <<'EOF'
{"overrides":{"process-kill":true,"cloud-credentials-cmd":true,"cloud-credentials-files":true}}
EOF

    output=$(run_hook "$(build_bash_input "pkill node")" "$overrides")
    assert_not_denied "process-kill allowed" "$output"

    output=$(run_hook "$(build_bash_input "gcloud auth print-access-token")" "$overrides")
    assert_not_denied "cloud-credentials-cmd allowed" "$output"

    output=$(run_hook "$(build_bash_input "cat ~/.aws/credentials")" "$overrides")
    assert_not_denied "cloud-credentials-files allowed" "$output"

    # Non-overridden categories still denied
    output=$(run_hook "$(build_bash_input "cat ~/.ssh/id_rsa")" "$overrides")
    assert_denied "ssh-keys still denied" "$output"

    output=$(run_hook "$(build_bash_input "security find-generic-password -s foo")" "$overrides")
    assert_denied "keychain still denied" "$output"

    rm -rf "$tmpdir"
}

# ------------------------------------------------------------------
# Test 9: Non-blocked commands pass through regardless
# ------------------------------------------------------------------
echo ""
echo "Test 9: Non-blocked commands pass through regardless"
{
    tmpdir=$(mktemp -d)
    no_file="$tmpdir/nonexistent.json"

    output=$(run_hook "$(build_bash_input "ls -la")" "$no_file")
    assert_not_denied "ls -la passes through" "$output"

    output=$(run_hook "$(build_bash_input "git status")" "$no_file")
    assert_not_denied "git status passes through" "$output"

    output=$(run_hook "$(build_read_input "/tmp/somefile.txt")" "$no_file")
    assert_not_denied "Read /tmp/somefile.txt passes through" "$output"

    rm -rf "$tmpdir"
}

# ---- Summary -------------------------------------------------------------
echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
    exit 1
fi
exit 0
