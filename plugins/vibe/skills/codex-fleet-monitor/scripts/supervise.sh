#!/bin/sh
# Usage: supervise.sh <workDir> [intervalSeconds]. Loads <workDir>/config.env, then runs supervise.mjs,
# which loops until stopped. Start it from launchd or systemd (templates/), or by hand in a terminal.
K=$(cd "$(dirname "$0")" && pwd)
W=${1:?workDir}
set -a
if [ -f "$W/config.env" ]; then . "$W/config.env"; fi
set +a
exec node "$K/supervise.mjs" "$@"
