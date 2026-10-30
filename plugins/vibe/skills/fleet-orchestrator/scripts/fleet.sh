#!/usr/bin/env bash
# Usage: fleet.sh <orchDir> <local|remote> session <turn|steer|last|end> <name> [codex-session.mjs options]
#        fleet.sh <orchDir> <local|remote> slot <lockName> <owner> <dir> <command...>
# A heavy slot first runs load-check.sh on that machine and refuses (exit 4) when its load per core is over MAX_LOAD_PER_CORE.
# <orchDir> is a fleet home (its active program) or a program dir; codex-fleet-monitor/scripts/work-dir.mjs
# resolves it and loads config.env (references/setup.md); without the REMOTE_* keys only `local` works.
# `remote` copies the scripts it needs, and a session's prompt file (with its <prompt>.evidence/ folder), to <REMOTE_STATE_DIR>/.fleet-orchestrator/
# on REMOTE_HOST over ssh and runs them there in REMOTE_SHELL.
set -euo pipefail

usage() {
  sed -n '2,3p' "$0" | sed 's/^# //' >&2
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

ship=(codex-fleet-monitor/scripts/liveness.mjs codex-fleet-monitor/scripts/thread-sidebar.mjs codex-fleet-monitor/scripts/work-dir.mjs fleet-orchestrator/scripts/codex-session.mjs fleet-orchestrator/scripts/skill-freshness.mjs vibe/scripts/session-record.mjs vibe/scripts/loaded-skill.mjs fleet-orchestrator/scripts/slot-lock.sh fleet-orchestrator/scripts/load-check.sh fleet-orchestrator/scripts/request-visual.mjs)
extra=()

# Runs a shell command line on REMOTE_HOST after unpacking the shipped scripts (and `extra`) into remote_dir.
run_remote() {
  local outer
  outer="mkdir -p $(printf %q "$remote_dir") && tar -C $(printf %q "$remote_dir") -xf - && ${REMOTE_SHELL:-zsh -lic} $(printf %q "$1")"
  COPYFILE_DISABLE=1 tar -cf - -C "$skills" "${ship[@]}" ${extra[@]+"${extra[@]}"} |
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
  expected_version=$(jq -er '.version' "$plugin_root/.codex-plugin/plugin.json")
  if [ "$where" = local ]; then
    local state=${LOCAL_STATE_DIR:-$orch/sessions}
    mkdir -p "$state"
    if [ -n "$prompt" ]; then
      [ -f "$prompt" ] || { echo "fleet: no prompt file $prompt" >&2; exit 2; }
      local bootstrap=()
      if [ "$command" = turn ]; then bootstrap=(--bootstrap); fi
      node "$here/skill-freshness.mjs" "$orch" "$prompt" --runtime codex --actor-state "$state/$name.json" --plugin-root "$plugin_root" --worktree "${target_cwd:-$orch}" ${bootstrap[@]+"${bootstrap[@]}"} >/dev/null
    fi
    if [ "$command" = turn ] && ! has_option --plugin-root; then args+=(--plugin-root "$plugin_root"); fi
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
  local preflight=
  if [ -n "$prompt" ]; then
    local remote_bootstrap=
    if [ "$command" = turn ]; then remote_bootstrap=--bootstrap; fi
    preflight="test -n \"\$remote_root\" && node $(printf %q "$remote_dir/fleet-orchestrator/scripts/skill-freshness.mjs") remote $(printf %q "$remote_dir/$(basename "$prompt")") --runtime codex --actor-state $(printf %q "$REMOTE_STATE_DIR/$name.json") --plugin-root \"\$remote_root\" --expected-version $(printf %q "$expected_version") --worktree $(printf %q "${target_cwd:-$orch}") $remote_bootstrap && "
  fi
  local plugin_arg=
  if [ "$command" = turn ]; then plugin_arg=' --plugin-root "$remote_root"'; fi
  run_remote "remote_root=$remote_root; ${preflight}$(printf '%q ' node "$remote_dir/fleet-orchestrator/scripts/codex-session.mjs" "$command" "$REMOTE_STATE_DIR" "$name" ${args[@]+"${args[@]}"})$plugin_arg"
}

slot() {
  [ $# -ge 4 ] || usage
  local name=$1 owner=$2 dir=$3 slots=1 check=
  shift 3
  if [ "$name" = heavy ]; then
    if [ "$where" = local ]; then slots=${HEAVY_SLOTS:-1}; else slots=${REMOTE_HEAVY_SLOTS:-1}; fi
    check=1
  fi
  if [ "$where" = local ]; then
    cd "$dir"
    if [ -n "$check" ]; then MAX_LOAD_PER_CORE=${MAX_LOAD_PER_CORE:-1.5} bash "$here/load-check.sh"; fi
    exec bash "$here/slot-lock.sh" --slots "$slots" "$name" "$owner" "$@"
  fi
  local gate=
  if [ -n "$check" ]; then gate="MAX_LOAD_PER_CORE=$(printf %q "${REMOTE_MAX_LOAD_PER_CORE:-${MAX_LOAD_PER_CORE:-1.5}}") FLEET_FORCE_HERE=$(printf %q "${FLEET_FORCE_HERE:-}") bash $(printf %q "$remote_dir/fleet-orchestrator/scripts/load-check.sh") && "; fi
  run_remote "cd $(printf %q "$dir") && $gate$(printf '%q ' bash "$remote_dir/fleet-orchestrator/scripts/slot-lock.sh" --slots "$slots" "$name" "$owner" "$@")"
}

case "$action" in
  session) session "$@" ;;
  slot) slot "$@" ;;
  *) usage ;;
esac
