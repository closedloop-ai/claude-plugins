#!/usr/bin/env bash
# Usage: fleet.sh <orchDir> <local|remote> session <turn|steer|last|end|interrupt|reload> <name> [codex-session.mjs options]
#        fleet.sh <orchDir> <local|remote> slot <lockName> <owner> <dir> <command...>
#        fleet.sh <orchDir> <local|remote> cleanup
# A heavy slot first runs load-check.sh on that machine and refuses (exit 4) when its load per core is over MAX_LOAD_PER_CORE.
# <orchDir> is a fleet home (its active program) or a program dir; codex-fleet-monitor/scripts/work-dir.mjs
# resolves it and loads config.env (references/setup.md); without the REMOTE_* keys only `local` works.
# `remote` copies the scripts it needs, and a session's prompt file (with its <prompt>.evidence/ folder), to <REMOTE_STATE_DIR>/.fleet-orchestrator/
# on REMOTE_HOST over ssh and runs them there in REMOTE_SHELL.
set -euo pipefail

usage() {
  sed -n '2,4p' "$0" | sed 's/^# //' >&2
  exit 2
}

[ $# -ge 3 ] || usage
orch=$1 where=$2 action=$3
shift 3
[ -d "$orch" ] || { echo "fleet: no orchestration dir $orch" >&2; exit 2; }
here=$(cd "$(dirname "$0")" && pwd)
skills=$(cd "$here/../.." && pwd)
env_lines=$(node "$skills/codex-fleet-monitor/scripts/work-dir.mjs" sh "$orch") || exit 2
eval "$env_lines"
orch=$W
case "$where" in
  local) ;;
  remote)
    : "${REMOTE_HOST:?set REMOTE_HOST in $orch/config.env}" "${REMOTE_STATE_DIR:?set REMOTE_STATE_DIR in $orch/config.env}"
    remote_dir=$REMOTE_STATE_DIR/.fleet-orchestrator
    ;;
  *) usage ;;
esac

ship=(codex-fleet-monitor/scripts/liveness.mjs codex-fleet-monitor/scripts/thread-sidebar.mjs codex-fleet-monitor/scripts/work-dir.mjs fleet-orchestrator/scripts/codex-session.mjs fleet-orchestrator/scripts/skill-freshness.mjs vibe/scripts/plugin-script-references.mjs vibe/scripts/session-record.mjs vibe/scripts/loaded-skill.mjs vibe/scripts/owned-state.mjs fleet-orchestrator/scripts/slot-lock.sh fleet-orchestrator/scripts/slot-lock-child.mjs fleet-orchestrator/scripts/load-check.sh fleet-orchestrator/scripts/request-visual.mjs)
ship=("${ship[@]/#/skills/}" shared/process-identity.mjs)
extra=()

# Runs a shell command line on REMOTE_HOST after unpacking the shipped scripts (and `extra`) into remote_dir.
run_remote() {
  local outer
  outer="mkdir -p $(printf %q "$remote_dir") && tar -C $(printf %q "$remote_dir") -xf - && ${REMOTE_SHELL:-zsh -lic} $(printf %q "$1")"
  COPYFILE_DISABLE=1 tar -cf - -C "$skills/.." "${ship[@]}" ${extra[@]+"${extra[@]}"} |
    ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 "$REMOTE_HOST" "$outer"
}

has_option() {
  local word
  for word in ${args[@]+"${args[@]}"}; do
    case "$word" in "$1" | "$1"=*) return 0 ;; esac
  done
  return 1
}

session() {
  [ $# -ge 2 ] || usage
  local command=$1 name=$2 i prompt= target_cwd= plugin_root expected_version
  shift 2
  args=("$@")
  if [ "$command" = turn ]; then
    if [ -n "${CODEX_MODEL:-}" ] && ! has_option --model; then args+=(--model "$CODEX_MODEL"); fi
    if [ -n "${CODEX_EFFORT:-}" ] && ! has_option --effort; then args+=(--effort "$CODEX_EFFORT"); fi
  fi
  for i in "${!args[@]}"; do
    case "${args[$i]}" in
      --prompt-file) prompt=${args[$((i + 1))]:-} ;;
      --prompt-file=*) prompt=${args[$i]#--prompt-file=} ;;
      --cwd) target_cwd=${args[$((i + 1))]:-} ;;
      --cwd=*) target_cwd=${args[$i]#--cwd=} ;;
    esac
  done
  plugin_root=$(cd "$skills/.." && pwd)
  if has_option --plugin-root; then
    echo "fleet: --plugin-root is bound to the target host installation, not a session override" >&2
    exit 2
  fi
  expected_version=$(jq -er '.version' "$plugin_root/.codex-plugin/plugin.json")
  if [ "$where" = local ]; then
    local state=${LOCAL_STATE_DIR:-$orch/sessions}
    mkdir -p "$state"
    if [ -n "$prompt" ]; then
      [ -f "$prompt" ] || { echo "fleet: no prompt file $prompt" >&2; exit 2; }
      local bootstrap=()
      if [ "$command" = turn ]; then bootstrap=(--bootstrap); fi
      node "$here/skill-freshness.mjs" "$orch" "$prompt" --runtime codex --command "$command" --actor-state "$state/$name.json" --plugin-root "$plugin_root" --worktree "${target_cwd:-$orch}" ${bootstrap[@]+"${bootstrap[@]}"} >/dev/null
    fi
    if [ "$command" = turn ] || [ "$command" = steer ]; then args+=(--plugin-root "$plugin_root"); fi
    exec node "$here/codex-session.mjs" "$command" "$state" "$name" ${args[@]+"${args[@]}"}
  fi
  # fleet-home.mjs check reports a remote session in sessions.txt without this marker as started outside fleet.sh.
  if [ "$command" = turn ]; then
    mkdir -p "$orch/sessions"
    printf '{"host":"%s","stateDir":"%s"}\n' "$REMOTE_HOST" "$REMOTE_STATE_DIR" > "$orch/sessions/$name.remote.json"
  fi
  if [ -n "$prompt" ]; then
    extra=(-C "$(cd "$(dirname "$prompt")" && pwd)" "$(basename "$prompt")")
    # finding-brief.mjs puts a finding's evidence in <prompt>.evidence/, which the writer must be able to open.
    if [ -d "$prompt.evidence" ]; then extra+=("$(basename "$prompt").evidence"); fi
    for i in "${!args[@]}"; do
      case "${args[$i]}" in
        --prompt-file) args[$((i + 1))]=$remote_dir/$(basename "$prompt") ;;
        --prompt-file=*) args[$i]=--prompt-file=$remote_dir/$(basename "$prompt") ;;
      esac
    done
  fi
  # The standing and program rulings are a shared spec, not resume-log status. Mirror
  # both whenever work is sent to another host.
  if [ -f "$orch/rulings.md" ]; then extra+=("-C" "$orch" "rulings.md"); fi
  if [ -n "$FLEET_HOME" ] && [ -f "$FLEET_HOME/standing-rulings.md" ]; then extra+=("-C" "$FLEET_HOME" "standing-rulings.md"); fi
  local remote_root='$(codex plugin list --json | jq -er '\''.installed[] | select(.name == "vibe" and .installed == true and .enabled == true) | .source.path'\'' | head -n 1)'
  # Check the target shell before its plugin lookup, so a missing CLI cannot be
  # hidden by a later mocked or successful node command.
  local codex_check="command -v codex >/dev/null 2>&1 || { printf 'fleet: codex CLI is missing on remote host %s (PATH=%s); install Codex CLI on that host and make it available in REMOTE_SHELL\\n' $(printf %q "$REMOTE_HOST") \"\$PATH\" >&2; exit 127; }; "
  local preflight=
  if [ -n "$prompt" ]; then
    local remote_bootstrap=
    if [ "$command" = turn ]; then remote_bootstrap=--bootstrap; fi
    preflight="test -n \"\$remote_root\" && node $(printf %q "$remote_dir/skills/fleet-orchestrator/scripts/skill-freshness.mjs") remote $(printf %q "$remote_dir/$(basename "$prompt")") --runtime codex --command $(printf %q "$command") --actor-state $(printf %q "$REMOTE_STATE_DIR/$name.json") --plugin-root \"\$remote_root\" --expected-version $(printf %q "$expected_version") --worktree $(printf %q "${target_cwd:-$orch}") $remote_bootstrap && "
  fi
  local plugin_arg=
  if [ "$command" = turn ] || [ "$command" = steer ]; then plugin_arg=' --plugin-root "$remote_root"'; fi
  run_remote "${codex_check}remote_root=$remote_root; ${preflight}$(printf '%q ' node "$remote_dir/skills/fleet-orchestrator/scripts/codex-session.mjs" "$command" "$REMOTE_STATE_DIR" "$name" ${args[@]+"${args[@]}"})$plugin_arg"
}

slot() {
  [ $# -ge 4 ] || usage
  local name=$1 owner=$2 dir=$3 slots=1 check= typed= preflight=
  shift 3
  if [ "${1:-}" = "--containerized-e2e-build" ]; then typed=1; shift; fi
  [ $# -ge 1 ] || usage
  if [ -n "$typed" ] || node "$skills/vibe/scripts/e2e-lock.mjs" intent "$@" >/dev/null; then preflight=1; fi
  if [ "$name" = heavy ]; then
    if [ "$where" = local ]; then slots=${HEAVY_SLOTS:-1}; else slots=${REMOTE_HEAVY_SLOTS:-1}; fi
    check=1
  fi
  local admission_note=
  if [ "${FLEET_FORCE_HERE:-}" = 1 ] && [ -n "${FLEET_FORCE_REASON:-}" ]; then
    admission_note="force reason: ${FLEET_FORCE_REASON:-}"
  fi
  if [ "$where" = local ]; then
    cd "$dir"
    if [ -n "$check" ]; then MAX_LOAD_PER_CORE=${MAX_LOAD_PER_CORE:-1.5} bash "$here/load-check.sh"; fi
    local slot_args=(--slots "$slots")
    if [ -n "$admission_note" ]; then slot_args+=(--admission-note "$admission_note"); fi
    if [ -n "$preflight" ]; then slot_args+=(--preflight-node "$skills/vibe/scripts/e2e-lock.mjs"); fi
    exec bash "$here/slot-lock.sh" "${slot_args[@]}" "$name" "$owner" "$@"
  fi
  local gate=
  if [ -n "$check" ]; then gate="MAX_LOAD_PER_CORE=$(printf %q "${REMOTE_MAX_LOAD_PER_CORE:-${MAX_LOAD_PER_CORE:-1.5}}") FLEET_FORCE_HERE=$(printf %q "${FLEET_FORCE_HERE:-}") FLEET_FORCE_REASON=$(printf %q "${FLEET_FORCE_REASON:-}") bash $(printf %q "$remote_dir/skills/fleet-orchestrator/scripts/load-check.sh") && "; fi
  local slot_args=(--slots "$slots")
  if [ -n "$admission_note" ]; then slot_args+=(--admission-note "$admission_note"); fi
  if [ -n "$preflight" ]; then
    local expected_version remote_root remote_gate
    expected_version=$(jq -er '.version' "$skills/../.codex-plugin/plugin.json")
    remote_root='$(codex plugin list --json | jq -er '\''.installed[] | select(.name == "vibe" and .installed == true and .enabled == true) | .source.path'\'' | head -n 1)'
    remote_gate="command -v codex >/dev/null 2>&1 && remote_root=$remote_root && test -n \"\$remote_root\" && test \"\$(jq -er .version \"\$remote_root/.codex-plugin/plugin.json\")\" = $(printf %q "$expected_version") || { printf 'fleet: remote vibe plugin is missing or not version %s; heavy build not started\\n' $(printf %q "$expected_version") >&2; exit 78; }; "
    run_remote "${remote_gate}cd $(printf %q "$dir") && $gate$(printf '%q ' bash "$remote_dir/skills/fleet-orchestrator/scripts/slot-lock.sh" "${slot_args[@]}")--preflight-node \"\$remote_root/skills/vibe/scripts/e2e-lock.mjs\" $(printf '%q ' "$name" "$owner" "$@")"
  else
    run_remote "cd $(printf %q "$dir") && $gate$(printf '%q ' bash "$remote_dir/skills/fleet-orchestrator/scripts/slot-lock.sh" "${slot_args[@]}" "$name" "$owner" "$@")"
  fi
}

cleanup() {
  [ $# -eq 0 ] || usage
  [ -f "$orch/board.json" ] || { echo "fleet: no board.json in $orch" >&2; exit 2; }
  if [ "$where" = local ]; then
    exec node "$skills/vibe/scripts/e2e-lock.mjs" cleanup-sweep sweep --orch-dir "$orch" --where local --state-dir "${LOCAL_STATE_DIR:-$orch/sessions}"
  fi
  extra+=("-C" "$orch" "board.json")
  local expected_version remote_root
  expected_version=$(jq -er '.version' "$skills/../.codex-plugin/plugin.json")
  remote_root='$(codex plugin list --json | jq -er '\''.installed[] | select(.name == "vibe" and .installed == true and .enabled == true) | .source.path'\'' | head -n 1)'
  run_remote "command -v codex >/dev/null 2>&1 && remote_root=$remote_root && test -n \"\$remote_root\" && test \"\$(jq -er .version \"\$remote_root/.codex-plugin/plugin.json\")\" = $(printf %q "$expected_version") && node \"\$remote_root/skills/vibe/scripts/e2e-lock.mjs\" cleanup-sweep sweep --orch-dir $(printf %q "$remote_dir") --where remote --state-dir $(printf %q "$REMOTE_STATE_DIR")"
}

case "$action" in
  session) session "$@" ;;
  slot) slot "$@" ;;
  cleanup) cleanup "$@" ;;
  *) usage ;;
esac
