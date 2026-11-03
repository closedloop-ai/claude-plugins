#!/bin/bash
# record_native_iteration_once.sh - Idempotently append native iteration telemetry.
#
# Usage:
#   bash record_native_iteration_once.sh [WORKDIR]
# WORKDIR defaults to $CLOSEDLOOP_WORKDIR.

set -euo pipefail

WORKDIR="${1:-${CLOSEDLOOP_WORKDIR:-}}"
if [[ -z "$WORKDIR" ]]; then
  echo "record_native_iteration_once.sh: WORKDIR required (pass as $1 or set CLOSEDLOOP_WORKDIR)" >&2
  exit 1
fi

STATE_FILE="$WORKDIR/state.json"
MARKER_FILE="$WORKDIR/.closedloop-ai/native-iteration.last"

mkdir -p "$(dirname "$MARKER_FILE")"

if [[ -f "$STATE_FILE" ]]; then
  FINGERPRINT=$(jq -r '[.phase // "", .status // "", .planStatus // "", .reason // "", .timestamp // ""] | @tsv' "$STATE_FILE" 2>/dev/null || echo "")
else
  FINGERPRINT="missing-state"
fi

if [[ -z "$FINGERPRINT" ]]; then
  FINGERPRINT="unreadable-state"
fi

if [[ -f "$MARKER_FILE" ]] && [[ "$(cat "$MARKER_FILE" 2>/dev/null || true)" == "$FINGERPRINT" ]]; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/record_iteration.sh" "$WORKDIR"
printf '%s' "$FINGERPRINT" > "$MARKER_FILE"
