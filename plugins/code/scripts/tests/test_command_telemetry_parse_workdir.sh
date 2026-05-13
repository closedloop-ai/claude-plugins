#!/usr/bin/env bash
# Tests for command-telemetry-parse-workdir.sh.
#
# Covers:
#   1. --workdir <path>           — flag with separate value
#   2. --workdir=<path>           — flag with = separator
#   3. quoted path with spaces    — shlex preserves the quoted value
#   4. positional first arg       — process-learnings-style [workdir]
#   5. flag value not picked up   — --message <value> must not return <value>
#   6. empty ARGUMENTS            — returns empty
#   7. injection guard            — shell metacharacters in args do NOT execute
#   8. mixed flags + workdir      — --workdir found regardless of position
#
# Exit code: 0 if all tests pass, 1 if any test fails.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARSE_SCRIPT="$SCRIPTS_DIR/command-telemetry-parse-workdir.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  echo "  ✓ $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  echo "  ✗ $1 (expected='$2' actual='$3')"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    fail "$label" "$expected" "$actual"
  fi
}

echo "═══ command-telemetry-parse-workdir.sh tests ═══"

# Test 1: --workdir <path>
result=$(ARGUMENTS='--workdir /tmp/foo --message hi' bash "$PARSE_SCRIPT")
assert_eq "Test 1: --workdir <path>" "/tmp/foo" "$result"

# Test 2: --workdir=<path>
result=$(ARGUMENTS='--workdir=/tmp/bar --other-flag x' bash "$PARSE_SCRIPT")
assert_eq "Test 2: --workdir=<path>" "/tmp/bar" "$result"

# Test 3: quoted path with spaces (only when python3 is available)
if command -v python3 >/dev/null 2>&1; then
  result=$(ARGUMENTS='--workdir "/tmp/path with spaces" --msg "hello world"' bash "$PARSE_SCRIPT")
  assert_eq "Test 3: quoted path with spaces" "/tmp/path with spaces" "$result"
else
  echo "  (skipping Test 3 — python3 unavailable)"
fi

# Test 4: positional first arg (process-learnings style)
result=$(ARGUMENTS='/tmp/positional' bash "$PARSE_SCRIPT")
assert_eq "Test 4: positional first arg" "/tmp/positional" "$result"

# Test 5: flag value at position 1 must NOT be picked up as positional workdir
# (--message hi → "hi" is the value of --message, not a workdir)
result=$(ARGUMENTS='--message hi --no-workdir-here' bash "$PARSE_SCRIPT")
assert_eq "Test 5: flag value not picked up as positional" "" "$result"

# Test 6: empty ARGUMENTS
result=$(ARGUMENTS='' bash "$PARSE_SCRIPT")
assert_eq "Test 6: empty ARGUMENTS" "" "$result"

# Test 6b: unset ARGUMENTS
result=$(unset ARGUMENTS && bash "$PARSE_SCRIPT")
assert_eq "Test 6b: unset ARGUMENTS" "" "$result"

# Test 7: shell metacharacter in --workdir value does NOT execute
INJECTED_MARKER="/tmp/parse-workdir-injected-$$"
result=$(ARGUMENTS="--workdir /tmp; touch $INJECTED_MARKER" bash "$PARSE_SCRIPT")
# shlex splits on whitespace, so "/tmp;" is one token (because ; is preceded by no space).
# Either result is acceptable (literal "/tmp;" or splits "/tmp" + ";" + "touch" + ...);
# the only failure mode is if INJECTED_MARKER got created.
if [[ -f "$INJECTED_MARKER" ]]; then
  fail "Test 7: shell metacharacters did NOT execute" "no marker" "marker created"
  rm -f "$INJECTED_MARKER"
else
  pass "Test 7: shell metacharacters did NOT execute"
fi

# Test 8: --workdir found regardless of position in the args list
result=$(ARGUMENTS='--state-file foo --workdir /tmp/late --message bar' bash "$PARSE_SCRIPT")
assert_eq "Test 8: --workdir found mid-args" "/tmp/late" "$result"

# Test 9: when both --workdir flag and a position-0 positional are present,
# the --workdir flag wins (a user explicitly typed --workdir).
result=$(ARGUMENTS='/tmp/positional --workdir /tmp/flagged' bash "$PARSE_SCRIPT")
assert_eq "Test 9: --workdir flag wins over position-0 positional" "/tmp/flagged" "$result"

# Test 10: --workdir flag with no value (last token) — return empty, don't crash.
result=$(ARGUMENTS='--workdir' bash "$PARSE_SCRIPT")
assert_eq "Test 10: --workdir with no value" "" "$result"

# Test 11: script exit code is always 0 even on edge cases.
exit_code=0
ARGUMENTS='--workdir' bash "$PARSE_SCRIPT" >/dev/null 2>&1 || exit_code=$?
assert_eq "Test 11: script exits 0 on edge case" "0" "$exit_code"

echo ""
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
[[ "$FAIL_COUNT" -eq 0 ]] || exit 1
exit 0
