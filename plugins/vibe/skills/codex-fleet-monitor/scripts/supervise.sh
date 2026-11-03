#!/bin/sh
# Usage: supervise.sh <workDir> [intervalSeconds]. Resolves <workDir> and loads its config.env (work-dir.mjs), then runs supervise.mjs,
# which loops until stopped. Start it from launchd or systemd (templates/), or by hand in a terminal.
K=$(cd "$(dirname "$0")" && pwd)
env_lines=$(node "$K/work-dir.mjs" sh "${1:?workDir}") || exit 2
set -a
eval "$env_lines"
set +a
shift
exec node "$K/supervise.mjs" "$W" "$@"
