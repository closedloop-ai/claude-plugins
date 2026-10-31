#!/bin/sh
set -eu

if [ "$#" -ne 10 ]; then
  echo "usage: run-nightly.sh <heavy-slot> <node> <nightly-script> <clean-main-checkout> <run-root-parent> <results-store> <claude> <codex> <uv> <gh>" >&2
  exit 64
fi

heavy_slot=$1
node_executable=$2
nightly_script=$3
clean_main_checkout=$4
run_root_parent=$5
results_store=$6
claude_executable=$7
codex_executable=$8
uv_executable=$9
shift 9
gh_executable=$1

log_failure() {
  printf 'VIBE_NIGHTLY_INFRA_FAILURE %s\n' "$1" >&2
}

fail_with_slack() {
  reason=$1
  code=$2
  log_failure "$reason"
  if [ -x "$node_executable" ] && [ -f "$nightly_script" ]; then
    if ! "$node_executable" --experimental-strip-types "$nightly_script" \
      --notify-infra "$claude_executable" "$reason"; then
      echo "VIBE_NIGHTLY_SLACK_FAILURE infrastructure notification failed" >&2
    fi
  else
    echo "VIBE_NIGHTLY_SLACK_FAILURE node or nightly entrypoint unavailable" >&2
  fi
  exit "$code"
}

if [ ! -d "$clean_main_checkout" ]; then
  fail_with_slack "vibe nightly clean main checkout is missing" 69
fi

for executable_spec in \
  "heavy slot:$heavy_slot" \
  "Node:$node_executable" \
  "Claude:$claude_executable" \
  "Codex:$codex_executable" \
  "uv:$uv_executable" \
  "gh:$gh_executable"
do
  executable_name=${executable_spec%%:*}
  executable_path=${executable_spec#*:}
  if [ ! -x "$executable_path" ]; then
    fail_with_slack "vibe nightly executable is missing or not executable: $executable_name" 69
  fi
done

if [ ! -f "$nightly_script" ]; then
  fail_with_slack "vibe nightly TypeScript entrypoint is missing" 69
fi

exec "$heavy_slot" vibe-eval-nightly \
  "$node_executable" --experimental-strip-types "$nightly_script" \
  "$clean_main_checkout" "$run_root_parent" "$results_store" \
  "$claude_executable" "$codex_executable" "$uv_executable" "$gh_executable"
