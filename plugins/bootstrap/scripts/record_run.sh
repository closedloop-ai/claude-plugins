#!/bin/bash

# AUTO-GENERATED — DO NOT EDIT.
# Source: plugins/code/scripts/record_run.sh
# Run scripts/sync-shared-telemetry.sh to update.

# record_run.sh - Append a run event to perf.jsonl once per Loop.
#
# Emits exactly one `run` event containing command, repo, branch, and start
# time so every perf.jsonl record can be attributed to the slash-command that
# launched the Loop. Fails open (exits 0) on any error so the caller loop is
# unaffected.
#
# Usage:
#   bash record_run.sh [WORKDIR]
# WORKDIR defaults to $CLOSEDLOOP_WORKDIR.

# Fail open: any unexpected error exits 0 so the caller loop is unaffected.
trap 'exit 0' ERR

WORKDIR="${1:-${CLOSEDLOOP_WORKDIR:-}}"
if [[ -z "$WORKDIR" ]]; then
  exit 0
fi

PERF_FILE="$WORKDIR/perf.jsonl"

RUN_ID="${CLOSEDLOOP_RUN_ID:-unknown}"
COMMAND="${CLOSEDLOOP_COMMAND:-interactive}"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

# Helper: run git with optional timeout guard.
_git() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 5 git "$@" 2>/dev/null
  else
    git "$@" 2>/dev/null
  fi
}

# Helper: walk ancestors of a directory until a .git root is found.
# Prints the git root on success; prints nothing on failure.
_find_git_root() {
  local dir="$1"
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    if [[ -e "$dir/.git" ]]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  # Check / itself
  if [[ -e "/.git" ]]; then
    echo "/"
    return 0
  fi
  return 1
}

# Determine repo and branch with explicit precedence:
#   1. CLOSEDLOOP_REPO / CLOSEDLOOP_BRANCH env overrides (highest)
#   2. git -C "$WORKDIR" (workdir is inside project tree)
#   3. pwd ancestor walk to find a git root (workdir outside project tree)
if [[ -n "${CLOSEDLOOP_REPO:-}" || -n "${CLOSEDLOOP_BRANCH:-}" ]]; then
  REPO="${CLOSEDLOOP_REPO:-}"
  BRANCH="${CLOSEDLOOP_BRANCH:-}"
else
  REPO=$(_git -C "$WORKDIR" remote get-url origin || echo "")
  BRANCH=$(_git -C "$WORKDIR" rev-parse --abbrev-ref HEAD || echo "")

  # If WORKDIR is outside any git tree, fall back to walking pwd ancestors.
  if [[ -z "$REPO" && -z "$BRANCH" ]]; then
    # `_find_git_root` returns 1 when no ancestor has a .git, which triggers
    # the script-level `trap 'exit 0' ERR`. Append `|| true` so the failure
    # is captured by the assignment without aborting the script — empty
    # REPO/BRANCH must still produce a run event for AC-004 (matched
    # run+command_complete pair) when the command is invoked outside any
    # git tree.
    GIT_ROOT=$(_find_git_root "$(pwd)" || true)
    if [[ -n "$GIT_ROOT" ]]; then
      REPO=$(_git -C "$GIT_ROOT" remote get-url origin || echo "")
      BRANCH=$(_git -C "$GIT_ROOT" rev-parse --abbrev-ref HEAD || echo "")
    fi
  fi
fi

mkdir -p "$(dirname "$PERF_FILE")"

jq -n -c \
  --arg event "run" \
  --arg run_id "$RUN_ID" \
  --arg command "$COMMAND" \
  --arg started_at "$TIMESTAMP" \
  --arg repo "$REPO" \
  --arg branch "$BRANCH" \
  '{event:$event,run_id:$run_id,command:$command,started_at:$started_at,repo:$repo,branch:$branch}' \
  >> "$PERF_FILE"

exit 0
