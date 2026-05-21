#!/usr/bin/env bash
# Check if build validation can be skipped (no code changes since last pass).
# Usage: check_build_cache.sh <WORKDIR> [stamp]
#
# Modes:
#   check_build_cache.sh <WORKDIR>        — Check if build cache is valid
#   check_build_cache.sh <WORKDIR> stamp  — Stamp the cache after a successful build
#
# Output (check mode, stdout, machine-parseable):
#   BUILD_CACHE_HIT
#
#   — or —
#
#   BUILD_CACHE_MISS
#   reason: <why the cache is stale or missing>

set -euo pipefail

WORKDIR="${1:?Usage: check_build_cache.sh <WORKDIR> [stamp]}"
MODE="${2:-check}"

CACHE_FILE="$WORKDIR/.build-passed"

# --- stamp mode: record current state after build passes ---
if [ "$MODE" = "stamp" ]; then
  current_hash=$(git diff HEAD 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  echo "$current_hash $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CACHE_FILE"
  echo "BUILD_CACHE_STAMPED"
  exit 0
fi

# --- check mode ---
if [ ! -f "$CACHE_FILE" ]; then
  echo "BUILD_CACHE_MISS"
  echo "reason: no build cache found (.build-passed missing)"
  exit 0
fi

stored_hash=$(head -1 "$CACHE_FILE" 2>/dev/null | cut -d' ' -f1)
if [ -z "$stored_hash" ]; then
  echo "BUILD_CACHE_MISS"
  echo "reason: build cache file is empty or malformed"
  exit 0
fi

current_hash=$(git diff HEAD 2>/dev/null | shasum -a 256 | cut -d' ' -f1)

if [ "$current_hash" != "$stored_hash" ]; then
  echo "BUILD_CACHE_MISS"
  echo "reason: code changed since last successful build (git diff hash mismatch)"
  exit 0
fi

echo "BUILD_CACHE_HIT"
