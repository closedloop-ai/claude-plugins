#!/bin/bash

# Test helper: loads run_judges_if_needed from run-loop.sh with stub functions
# and invokes it with the given workdir.
# Usage: bash run_judges_test_helper.sh <workdir>

set -euo pipefail

WORKDIR_ARG="$1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_LOOP_SH="$SCRIPT_DIR/../../scripts/run-loop.sh"

# Stub functions called by run_judges_if_needed.
run_timed_step() {
  echo "run_timed_step called: $*"
}

emit_skipped_step() {
  echo "emit_skipped_step: $*"
}

log_progress() {
  :
}

# Variables referenced inside run_judges_if_needed (echo -e color codes).
BLUE='\033[0;34m'
NC='\033[0m'
PROGRESS_LOG="/dev/null"

# Load CLOSEDLOOP_JUDGES_STEP constant and the two functions we need from run-loop.sh
# without executing the main loop.  We extract the declarations via awk rather than
# sourcing the whole script (which would call `main` and exit).
_extract_from_run_loop() {
  awk '
    /^readonly CLOSEDLOOP_JUDGES_STEP=/ { print; next }
    /^(has_code_changes|run_judges_if_needed)[[:space:]]*\(\)/ { in_func=1; brace_depth=0 }
    in_func {
      print
      for (i=1; i<=length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") brace_depth++
        else if (c == "}") {
          brace_depth--
          if (brace_depth == 0) { in_func=0; break }
        }
      }
    }
  ' "$RUN_LOOP_SH"
}

eval "$(_extract_from_run_loop)"

run_judges_if_needed "$WORKDIR_ARG"
