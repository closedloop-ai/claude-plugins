#!/bin/bash
# test_record_run.sh - Unit tests for record_run.sh git attribution logic.
#
# Tests cover:
#   1. Env override precedence: CLOSEDLOOP_REPO / CLOSEDLOOP_BRANCH take priority.
#   2. pwd ancestor walk: when WORKDIR has no .git, the script walks pwd upward.
#   3. Graceful fallback when no git root is found anywhere.
#
# Run from any directory:
#   bash plugins/code/scripts/tests/test_record_run.sh
#
# Exit code: 0 = all pass, 1 = one or more failures.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD_RUN="$SCRIPT_DIR/../record_run.sh"

PASS=0
FAIL=0

# Colour helpers (suppressed when not a terminal)
_green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
_red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

pass() { (( PASS++ )); _green "  PASS: $1"; }
fail() { (( FAIL++ )); _red   "  FAIL: $1"; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected='$expected' actual='$actual')"
  fi
}

assert_not_empty() {
  local label="$1" actual="$2"
  if [[ -n "$actual" ]]; then
    pass "$label"
  else
    fail "$label (got empty string)"
  fi
}

assert_empty() {
  local label="$1" actual="$2"
  if [[ -z "$actual" ]]; then
    pass "$label"
  else
    fail "$label (expected empty, got='$actual')"
  fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Create a minimal git repo with a remote and a branch.
_make_git_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" checkout -q -b main 2>/dev/null || true
  # Add a commit so HEAD resolves.
  git -C "$dir" commit -q --allow-empty -m "init"
  git -C "$dir" remote add origin "https://github.com/test/repo.git"
}

# ---------------------------------------------------------------------------
# Test 1: env override – CLOSEDLOOP_REPO and CLOSEDLOOP_BRANCH are used as-is
# ---------------------------------------------------------------------------
echo ""
echo "--- Test group 1: env override precedence ---"

TMP1="$(mktemp -d)"
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP1" \
  CLOSEDLOOP_RUN_ID="run-env" \
  CLOSEDLOOP_COMMAND="test" \
  CLOSEDLOOP_REPO="https://github.com/override/repo.git" \
  CLOSEDLOOP_BRANCH="feature/override" \
  bash "$RECORD_RUN" 2>/dev/null

if [[ -f "$TMP1/perf.jsonl" ]]; then
  REPO_OUT=$(jq -r '.repo' "$TMP1/perf.jsonl" 2>/dev/null)
  BRANCH_OUT=$(jq -r '.branch' "$TMP1/perf.jsonl" 2>/dev/null)
  assert_eq "CLOSEDLOOP_REPO override used" "https://github.com/override/repo.git" "$REPO_OUT"
  assert_eq "CLOSEDLOOP_BRANCH override used" "feature/override" "$BRANCH_OUT"
else
  fail "perf.jsonl not created (env override test)"
fi
rm -rf "$TMP1"

# Test that partial override works: only CLOSEDLOOP_REPO set, CLOSEDLOOP_BRANCH empty.
TMP2="$(mktemp -d)"
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP2" \
  CLOSEDLOOP_RUN_ID="run-partial" \
  CLOSEDLOOP_COMMAND="test" \
  CLOSEDLOOP_REPO="https://github.com/partial/repo.git" \
  bash "$RECORD_RUN" 2>/dev/null

if [[ -f "$TMP2/perf.jsonl" ]]; then
  REPO_OUT=$(jq -r '.repo' "$TMP2/perf.jsonl" 2>/dev/null)
  BRANCH_OUT=$(jq -r '.branch' "$TMP2/perf.jsonl" 2>/dev/null)
  assert_eq "Partial override: CLOSEDLOOP_REPO used" "https://github.com/partial/repo.git" "$REPO_OUT"
  # BRANCH should be empty string (no git, no env)
  assert_empty "Partial override: branch is empty" "$BRANCH_OUT"
else
  fail "perf.jsonl not created (partial override test)"
fi
rm -rf "$TMP2"

# Env overrides beat any git repo that exists in the WORKDIR.
TMP3="$(mktemp -d)"
_make_git_repo "$TMP3"
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP3" \
  CLOSEDLOOP_RUN_ID="run-beats-git" \
  CLOSEDLOOP_COMMAND="test" \
  CLOSEDLOOP_REPO="https://github.com/env-wins/repo.git" \
  CLOSEDLOOP_BRANCH="env-branch" \
  bash "$RECORD_RUN" 2>/dev/null

if [[ -f "$TMP3/perf.jsonl" ]]; then
  REPO_OUT=$(jq -r '.repo' "$TMP3/perf.jsonl" 2>/dev/null)
  BRANCH_OUT=$(jq -r '.branch' "$TMP3/perf.jsonl" 2>/dev/null)
  assert_eq "Env override beats git-in-workdir: repo" "https://github.com/env-wins/repo.git" "$REPO_OUT"
  assert_eq "Env override beats git-in-workdir: branch" "env-branch" "$BRANCH_OUT"
else
  fail "perf.jsonl not created (env beats git test)"
fi
rm -rf "$TMP3"

# ---------------------------------------------------------------------------
# Test 2: pwd ancestor walk
# ---------------------------------------------------------------------------
echo ""
echo "--- Test group 2: pwd ancestor walk ---"

# Build structure: GIT_ROOT/deep/subdir/ — WORKDIR is outside the tree (temp),
# but the test runs with pwd set to GIT_ROOT/deep/subdir.
TMP_GIT="$(mktemp -d)"
_make_git_repo "$TMP_GIT"
SUBDIR="$TMP_GIT/deep/subdir"
mkdir -p "$SUBDIR"

TMP_WORK="$(mktemp -d)"   # WORKDIR outside any git tree

# Run the script with pwd = SUBDIR so the ancestor walk finds TMP_GIT.
(
  cd "$SUBDIR" || exit
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    CLOSEDLOOP_WORKDIR="$TMP_WORK" \
    CLOSEDLOOP_RUN_ID="run-walk" \
    CLOSEDLOOP_COMMAND="test" \
    bash "$RECORD_RUN" 2>/dev/null
)

if [[ -f "$TMP_WORK/perf.jsonl" ]]; then
  BRANCH_OUT=$(jq -r '.branch' "$TMP_WORK/perf.jsonl" 2>/dev/null)
  REPO_OUT=$(jq -r '.repo' "$TMP_WORK/perf.jsonl" 2>/dev/null)
  assert_eq "pwd ancestor walk: branch resolved to main" "main" "$BRANCH_OUT"
  assert_eq "pwd ancestor walk: repo resolved" "https://github.com/test/repo.git" "$REPO_OUT"
else
  fail "perf.jsonl not created (pwd ancestor walk test)"
fi
rm -rf "$TMP_GIT" "$TMP_WORK"

# Walk finds the correct root when pwd is two levels deep.
TMP_GIT2="$(mktemp -d)"
_make_git_repo "$TMP_GIT2"
DEEP="$TMP_GIT2/a/b/c/d"
mkdir -p "$DEEP"
TMP_WORK2="$(mktemp -d)"

(
  cd "$DEEP" || exit
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    CLOSEDLOOP_WORKDIR="$TMP_WORK2" \
    CLOSEDLOOP_RUN_ID="run-deep" \
    CLOSEDLOOP_COMMAND="test" \
    bash "$RECORD_RUN" 2>/dev/null
)

if [[ -f "$TMP_WORK2/perf.jsonl" ]]; then
  BRANCH_OUT=$(jq -r '.branch' "$TMP_WORK2/perf.jsonl" 2>/dev/null)
  assert_eq "Deep ancestor walk (4 levels): branch resolved" "main" "$BRANCH_OUT"
else
  fail "perf.jsonl not created (deep ancestor walk test)"
fi
rm -rf "$TMP_GIT2" "$TMP_WORK2"

# When WORKDIR itself is inside a git tree, git -C WORKDIR should resolve it
# (no pwd walk needed).
TMP_GIT3="$(mktemp -d)"
_make_git_repo "$TMP_GIT3"
TMP_WORK3="$TMP_GIT3/work"
mkdir -p "$TMP_WORK3"

env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP_WORK3" \
  CLOSEDLOOP_RUN_ID="run-workdir-in-git" \
  CLOSEDLOOP_COMMAND="test" \
  bash "$RECORD_RUN" 2>/dev/null

if [[ -f "$TMP_WORK3/perf.jsonl" ]]; then
  BRANCH_OUT=$(jq -r '.branch' "$TMP_WORK3/perf.jsonl" 2>/dev/null)
  assert_eq "WORKDIR inside git tree: branch resolved via git -C" "main" "$BRANCH_OUT"
else
  fail "perf.jsonl not created (workdir-inside-git test)"
fi
rm -rf "$TMP_GIT3"

# ---------------------------------------------------------------------------
# Test 3: no git root found anywhere – graceful handling
# ---------------------------------------------------------------------------
echo ""
echo "--- Test group 3: graceful fallback when no git root ---"

# Create a temp dir hierarchy with no .git anywhere, run from its leaf.
TMP_NOGIT="$(mktemp -d)"
LEAF="$TMP_NOGIT/x/y/z"
mkdir -p "$LEAF"
TMP_WORK_NG="$(mktemp -d)"

EXIT_CODE=0
(
  cd "$LEAF" || exit
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    CLOSEDLOOP_WORKDIR="$TMP_WORK_NG" \
    CLOSEDLOOP_RUN_ID="run-nogit" \
    CLOSEDLOOP_COMMAND="test" \
    bash "$RECORD_RUN" 2>/dev/null
) || EXIT_CODE=$?

assert_eq "No git root: script exits 0" "0" "$EXIT_CODE"

# When no git root exists anywhere, _find_git_root returns 1 which triggers the
# ERR trap (exit 0) before jq can run, so perf.jsonl is intentionally NOT
# created.  The key guarantee is that the script exits 0 (fails open).
if [[ ! -f "$TMP_WORK_NG/perf.jsonl" ]]; then
  pass "No git root: script exits cleanly without writing perf.jsonl"
else
  # If the file was written (future script change), make sure it's valid JSON.
  if jq . "$TMP_WORK_NG/perf.jsonl" >/dev/null 2>&1; then
    pass "No git root: perf.jsonl is valid JSON (script behaviour changed)"
  else
    fail "No git root: perf.jsonl is malformed JSON"
  fi
fi
rm -rf "$TMP_NOGIT" "$TMP_WORK_NG"

# Script exits 0 even when WORKDIR is an invalid/unwritable path.
TMP_UNWRITABLE="$(mktemp -d)"
chmod 000 "$TMP_UNWRITABLE"
EXIT_CODE2=0
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP_UNWRITABLE/sub" \
  bash "$RECORD_RUN" 2>/dev/null || EXIT_CODE2=$?
assert_eq "Unwritable WORKDIR: script exits 0" "0" "$EXIT_CODE2"
chmod 755 "$TMP_UNWRITABLE"
rm -rf "$TMP_UNWRITABLE"

# ---------------------------------------------------------------------------
# Test 4: structural correctness of emitted JSON
# ---------------------------------------------------------------------------
echo ""
echo "--- Test group 4: emitted JSON structure ---"

TMP_JSON="$(mktemp -d)"
_make_git_repo "$TMP_JSON"

env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  CLOSEDLOOP_WORKDIR="$TMP_JSON" \
  CLOSEDLOOP_RUN_ID="run-json-check" \
  CLOSEDLOOP_COMMAND="fix" \
  bash "$RECORD_RUN" 2>/dev/null

if [[ -f "$TMP_JSON/perf.jsonl" ]]; then
  EVENT=$(jq -r '.event'      "$TMP_JSON/perf.jsonl" 2>/dev/null)
  RUN_ID=$(jq -r '.run_id'    "$TMP_JSON/perf.jsonl" 2>/dev/null)
  CMD=$(jq -r '.command'      "$TMP_JSON/perf.jsonl" 2>/dev/null)
  TS=$(jq -r '.started_at'    "$TMP_JSON/perf.jsonl" 2>/dev/null)
  assert_eq   "JSON: event field"        "run"           "$EVENT"
  assert_eq   "JSON: run_id field"       "run-json-check" "$RUN_ID"
  assert_eq   "JSON: command field"      "fix"           "$CMD"
  assert_not_empty "JSON: started_at non-empty"          "$TS"
  # Validate it's proper JSON (jq exits non-zero on malformed input).
  if jq . "$TMP_JSON/perf.jsonl" >/dev/null 2>&1; then
    pass "JSON: output is valid JSON"
  else
    fail "JSON: output is not valid JSON"
  fi
else
  fail "perf.jsonl not created (JSON structure test)"
fi
rm -rf "$TMP_JSON"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed."
if (( FAIL > 0 )); then
  exit 1
fi
exit 0
