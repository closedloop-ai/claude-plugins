#!/bin/sh
set -eu

if [ "$#" -ne 11 ]; then
  echo "usage: run-nightly.sh <private-env> <heavy-slot> <node> <nightly-script> <clean-main-checkout> <run-root-parent> <results-store> <claude> <codex> <uv> <gh>" >&2
  exit 64
fi

private_env=$1
heavy_slot=$2
node_executable=$3
nightly_script=$4
clean_main_checkout=$5
run_root_parent=$6
results_store=$7
claude_executable=$8
codex_executable=$9
shift 9
uv_executable=$1
gh_executable=$2

log_failure() {
  printf 'VIBE_NIGHTLY_INFRA_FAILURE %s\n' "$1" >&2
}

fail_with_slack() {
  reason=$1
  code=$2
  log_failure "$reason"
  if [ -x "$node_executable" ] && [ -f "$nightly_script" ]; then
    if ! "$node_executable" --experimental-strip-types "$nightly_script" --notify-infra "$reason"; then
      echo "VIBE_NIGHTLY_SLACK_FAILURE infrastructure notification failed" >&2
    fi
  else
    echo "VIBE_NIGHTLY_SLACK_FAILURE node or nightly entrypoint unavailable" >&2
  fi
  exit "$code"
}

if [ ! -f "$private_env" ]; then
  log_failure "vibe nightly Slack credential file is missing"
  exit 78
fi

if [ -L "$private_env" ]; then
  log_failure "vibe nightly Slack credential file must not be a symlink"
  exit 78
fi

if [ ! -d "$clean_main_checkout" ]; then
  log_failure "vibe nightly clean main checkout is missing"
  exit 69
fi

case "$(uname -s)" in
  Darwin)
    file_owner=$(stat -f '%u' "$private_env")
    file_mode=$(stat -f '%Lp' "$private_env")
    ;;
  *)
    file_owner=$(stat -c '%u' "$private_env")
    file_mode=$(stat -c '%a' "$private_env")
    ;;
esac
if [ "$file_owner" != "$(id -u)" ] || [ "$file_mode" != "600" ]; then
  log_failure "vibe nightly Slack credential file must be owned by the current user with mode 0600"
  exit 78
fi

if ! private_env_real=$(realpath "$private_env") ||
   ! checkout_real=$(realpath "$clean_main_checkout"); then
  log_failure "vibe nightly could not resolve the credential file or clean main checkout"
  exit 69
fi
case "$private_env_real/" in
  "$checkout_real/"*)
    log_failure "vibe nightly Slack credential file must be outside the repository"
    exit 78
    ;;
esac

if grep -Ev '^(#.*|[[:space:]]*|SLACK_BOT_TOKEN=.*|SLACK_CHANNEL_ID=.*)$' "$private_env" | grep -q .; then
  log_failure "vibe nightly Slack credential file contains an unsupported key"
  exit 78
fi

private_value() {
  key=$1
  count=$(grep -c "^${key}=" "$private_env" || true)
  if [ "$count" -ne 1 ]; then
    log_failure "vibe nightly Slack credential file must define each required key once"
    exit 78
  fi
  value=$(grep "^${key}=" "$private_env")
  value=${value#*=}
  case "$value" in
    \'*\') value=${value#\'}; value=${value%\'} ;;
    \"*\") value=${value#\"}; value=${value%\"} ;;
  esac
  printf '%s' "$value"
}

SLACK_BOT_TOKEN=$(private_value SLACK_BOT_TOKEN)
SLACK_CHANNEL_ID=$(private_value SLACK_CHANNEL_ID)
export SLACK_BOT_TOKEN SLACK_CHANNEL_ID

if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL_ID:-}" ]; then
  log_failure "vibe nightly requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID"
  exit 78
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
