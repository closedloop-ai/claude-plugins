#!/usr/bin/env bash
# Resolve investigation-log.md availability and emit orchestrator instructions.
#
# Usage: resolve_investigation_log.sh <workdir> [--pre-explorer-failed]
#
# Call once to get the first action. If the orchestrator's attempt fails,
# call again with --pre-explorer-failed to get the fallback action.
#
# Output (stdout JSON):
#   resolution: already_exists | try_pre_explorer | internal_fallback | continue_without
#   instructions: human-readable instruction for the orchestrator
#   canonical_sections: (only for internal_fallback) section headers to use
#
# Exit 0 always (best-effort, never blocks).

set -euo pipefail

WORKDIR="${1:?Usage: resolve_investigation_log.sh <workdir> [--pre-explorer-failed]}"
PRE_EXPLORER_FAILED=false
if [[ "${2:-}" == "--pre-explorer-failed" ]]; then
  PRE_EXPLORER_FAILED=true
fi

TARGET="$WORKDIR/investigation-log.md"

# --- file already exists ---
if [ -f "$TARGET" ]; then
  jq -n '{
    resolution: "already_exists",
    instructions: "investigation-log.md found. No action needed.",
    canonical_sections: null
  }'
  exit 0
fi

# --- pre-explorer not yet attempted ---
if [[ "$PRE_EXPLORER_FAILED" == "false" ]]; then
  jq -n --arg w "$WORKDIR" '{
    resolution: "try_pre_explorer",
    instructions: ("Launch @code:pre-explorer with WORKDIR=" + $w + ". Re-run this script with --pre-explorer-failed if it fails or is unavailable."),
    canonical_sections: null
  }'
  exit 0
fi

# --- pre-explorer failed, check if it produced the file anyway ---
if [ -f "$TARGET" ]; then
  jq -n '{
    resolution: "already_exists",
    instructions: "investigation-log.md appeared after pre-explorer attempt. No further action needed.",
    canonical_sections: null
  }'
  exit 0
fi

# --- prd.md available for internal fallback? ---
if [ -f "$WORKDIR/prd.md" ]; then
  jq -n --arg w "$WORKDIR" '{
    resolution: "internal_fallback",
    instructions: ("Generate a lightweight investigation-log.md at " + $w + "/investigation-log.md. Read prd.md, extract top entities/actions as search seeds, run Glob/Grep for implementation files, and write findings. Keep it fast — no external web research. If generation fails, continue without blocking."),
    canonical_sections: ["## Search Strategy", "## Files Discovered", "## Key Findings", "## Requirements Mapping", "## Uncertainties"]
  }'
  exit 0
fi

# --- nothing we can do ---
jq -n '{
  resolution: "continue_without",
  instructions: "Neither pre-explorer nor internal fallback available. Continue judge execution without investigation-log.md.",
  canonical_sections: null
}'
