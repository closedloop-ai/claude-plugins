#!/usr/bin/env bash
# Usage: fleet.sh <orchDir> <local|remote> session <turn|steer|last|end|interrupt|reload|recover-marker> <name> [codex-session.mjs options]
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
    if [ "$action" != session ] || [ "${1:-}" != recover-marker ]; then
      : "${REMOTE_HOST:?set REMOTE_HOST in $orch/config.env}" "${REMOTE_STATE_DIR:?set REMOTE_STATE_DIR in $orch/config.env}"
      remote_dir=$REMOTE_STATE_DIR/.fleet-orchestrator
    fi
    ;;
  *) usage ;;
esac

ship=(codex-fleet-monitor/scripts/liveness.mjs codex-fleet-monitor/scripts/thread-sidebar.mjs codex-fleet-monitor/scripts/work-dir.mjs fleet-orchestrator/scripts/codex-session.mjs fleet-orchestrator/scripts/fleet-remote-evidence.mjs fleet-orchestrator/scripts/skill-freshness.mjs fleet-orchestrator/scripts/writer-launch.mjs vibe/scripts/owned-state.mjs fleet-orchestrator/scripts/slot-lock.sh fleet-orchestrator/scripts/load-check.sh fleet-orchestrator/scripts/request-visual.mjs)
ship=("${ship[@]/#/skills/}")
extra=()

# Runs a shell command line on REMOTE_HOST after unpacking the shipped scripts (and `extra`) into remote_dir.
run_remote() {
  local outer stage files status=0
  outer="mkdir -p $(printf %q "$remote_dir") && tar -C $(printf %q "$remote_dir") -xf - && ${REMOTE_SHELL:-zsh -lic} $(printf %q "$1")"
  # The shipped scripts load vibe-core's modules, so both plugins go, laid out as a checkout (shared/ship-plugins.mjs).
  stage=$(node "$skills/../shared/ship-plugins.mjs" "${ship[@]}") || return 2
  files=$(cat "$stage/files")
  # shellcheck disable=SC2086 # plugin file paths have no spaces; each line is one path
  COPYFILE_DISABLE=1 tar -chf - -C "$stage" $files ${extra[@]+"${extra[@]}"} |
    ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 "$REMOTE_HOST" "$outer" || status=$?
  rm -rf "$stage"
  return "$status"
}

# An exact pre-start rejection receipt can clear an attempt; missing state alone cannot.
remote_writer_evidence() {
  local marker_name=$1 attempt=$2 state_path journal_path rejected_path preflight_path evidence_script probe
  state_path=$(printf %q "$REMOTE_STATE_DIR/$marker_name.json")
  journal_path=$(printf %q "$REMOTE_STATE_DIR/$marker_name.launch.json")
  rejected_path=$(printf %q "$REMOTE_STATE_DIR/$marker_name.preflight-rejected.json")
  preflight_path=$(printf %q "$REMOTE_STATE_DIR/$marker_name.preflight.$attempt.json")
  evidence_script=$(printf %q "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/fleet-remote-evidence.mjs")
  probe="command -v jq >/dev/null 2>&1 || exit 127; if test -f $rejected_path && jq -e --arg attempt $(printf %q "$attempt") '.attempt == \$attempt and .stage == \"preflight-rejected\"' $rejected_path >/dev/null 2>&1; then printf rejected; elif test -f $state_path && test ! -L $state_path && jq -e '(.threadId | type) == \"string\" and (.cwd | type) == \"string\" and (.threadId | length) > 0 and (.cwd | length) > 0' $state_path >/dev/null 2>&1; then printf present; elif test -e $state_path || test -L $state_path; then printf uncertain; elif test -e $journal_path || test -L $journal_path; then node $evidence_script journal $journal_path $state_path $preflight_path $(printf %q "$attempt"); else node $evidence_script preflight-probe $preflight_path $(printf %q "$attempt") $state_path $journal_path; fi"
  run_remote "$probe"
}

# Publish complete pending ownership as a final marker only after remote success or recovery.
publish_remote_marker() {
  local pending=$1 marker=$2 stage
  stage=$(mktemp "${marker}.XXXXXX") || return 1
  if ! jq -c '{host,stateDir}' "$pending" > "$stage"; then rm -f "$stage"; return 1; fi
  if ! mv "$stage" "$marker"; then rm -f "$stage"; return 1; fi
  rm "$pending"
}

# A complete pending record survives a successful remote launch even if final publication fails.
# Recover it only after checking the target's saved writer state or exact pre-start refusal.
recover_remote_marker() {
  local marker_name=$1
  local pending="$orch/sessions/$marker_name.remote.pending.json"
  local marker="$orch/sessions/$marker_name.remote.json"
  if [ -L "$pending" ] || [ ! -f "$pending" ]; then
    echo "fleet: no prepared remote marker for $marker_name" >&2
    return 2
  fi
  local owner_pid owner_started attempt actual_started
  owner_pid=$(jq -er '.owner.pid | select(type == "number" and . > 1)' "$pending") || return 2
  owner_started=$(jq -er '.owner.started | select(type == "string" and length > 0)' "$pending") || return 2
  attempt=$(jq -er '.owner.attempt | select(type == "string" and length > 0)' "$pending") || return 2
  actual_started=$(ps -o lstart= -p "$owner_pid" 2>/dev/null) || actual_started=
  if [ -n "$actual_started" ] && [ "$actual_started" = "$owner_started" ]; then
    echo "fleet: remote dispatch is still in flight for $marker_name; prepared marker retained" >&2
    return 1
  fi
  local recorded_host recorded_state_dir
  recorded_host=$(jq -er '.host | select(type == "string" and length > 0)' "$pending") || return 2
  recorded_state_dir=$(jq -er '.stateDir | select(type == "string" and startswith("/") and length > 1)' "$pending") || return 2
  local REMOTE_HOST="$recorded_host" REMOTE_STATE_DIR="$recorded_state_dir" remote_dir="$recorded_state_dir/.fleet-orchestrator"
  local state
  state=$(remote_writer_evidence "$marker_name" "$attempt") || { echo "fleet: could not check remote writer state; prepared marker retained" >&2; return 1; }
  if [ "$state" = present ]; then
    if ! publish_remote_marker "$pending" "$marker"; then
      echo "fleet: remote writer exists but local marker publication failed; retry remote session recover-marker $marker_name" >&2
      return 1
    fi
  elif [ "$state" = rejected ] || [ "$state" = prepared ] || [ "$state" = preflight-dead ]; then
    rm "$pending"
  else
    echo "fleet: remote writer state reply was not recognized; prepared marker retained" >&2
    return 1
  fi
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
  local command=$1 name=$2 i prompt= target_cwd= plugin_root expected_version locked=
  shift 2
  if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "fleet: session name must be letters, digits, dot, dash or underscore" >&2
    return 2
  fi
  if [ "${1:-}" = --fleet-remote-locked ]; then locked=1; shift; fi
  # Keep one local decision maker for this name from pending admission through
  # remote result handling. The OS releases this lock even after SIGKILL.
  if [ "$where" = remote ] && { [ "$command" = turn ] || [ "$command" = recover-marker ]; } && [ -z "$locked" ]; then
    mkdir -p "$orch/sessions"
    local lock="$orch/sessions/$name.remote.lock" lock_status
    if command -v lockf >/dev/null 2>&1; then
      if lockf -k -t 0 "$lock" bash "$0" "$orch" remote session "$command" "$name" --fleet-remote-locked "$@"; then return 0; else lock_status=$?; fi
    elif command -v flock >/dev/null 2>&1; then
      if flock -n -E 75 "$lock" bash "$0" "$orch" remote session "$command" "$name" --fleet-remote-locked "$@"; then return 0; else lock_status=$?; fi
    else
      echo "fleet: this host needs lockf or flock to serialize remote session ownership" >&2
      return 2
    fi
    if [ "$lock_status" -eq 75 ]; then
      echo "fleet: remote dispatch or recovery is still in flight for $name; prepared marker retained" >&2
    fi
    return "$lock_status"
  fi
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
  if [ "$command" = recover-marker ]; then
    if [ "$where" != remote ] || [ "${#args[@]}" -ne 0 ]; then
      echo "fleet: recover-marker needs remote session and a name only" >&2
      return 2
    fi
    recover_remote_marker "$name"
    return
  fi
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
    preflight="node $(printf %q "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/skill-freshness.mjs") remote $(printf %q "$remote_dir/$(basename "$prompt")") --runtime codex --command $(printf %q "$command") --actor-state $(printf %q "$REMOTE_STATE_DIR/$name.json") --plugin-root \"\$remote_root\" --expected-version $(printf %q "$expected_version") --worktree $(printf %q "${target_cwd:-$orch}") $remote_bootstrap"
  fi
  local plugin_arg=
  if [ "$command" = turn ] || [ "$command" = steer ]; then plugin_arg=' --plugin-root "$remote_root"'; fi
  # The remote host has no chat of this lead's, so a new writer there gets the lead's binding with the launch.
  if [ "$command" = turn ]; then
    local lead_provider
    lead_provider=$(node "$skills/vibe/scripts/provider.mjs" show) || { echo "fleet: could not read this lead's provider binding" >&2; return 2; }
    plugin_arg+=" --lead-provider $(printf %q "$lead_provider")"
  fi
  local pending= marker= legacy= attempt= owner_started= remote_command= stage=
  # Publish complete ownership atomically before a remote turn can create a writer.
  # An incomplete private staging file never claims the pending name or blocks a retry.
  if [ "$command" = turn ]; then
    mkdir -p "$orch/sessions"
    pending="$orch/sessions/$name.remote.pending.json"
    marker="$orch/sessions/$name.remote.json"
    legacy="$orch/sessions/$name.remote.pending"
    if [ -e "$legacy" ] || [ -L "$legacy" ]; then
      echo "fleet: legacy prepared remote owner exists; preserve it and audit that dispatch before another turn" >&2
      return 2
    fi
    if [ -L "$marker" ] || { [ -e "$marker" ] && [ ! -f "$marker" ]; }; then
      echo "fleet: existing remote marker is not a regular file" >&2
      return 2
    fi
    if [ -f "$marker" ] && ! jq -e --arg host "$REMOTE_HOST" --arg stateDir "$REMOTE_STATE_DIR" '.host == $host and .stateDir == $stateDir' "$marker" >/dev/null; then
      echo "fleet: existing remote marker points to a different host or state directory; preserve that writer and use another name" >&2
      return 2
    fi
    if [ -e "$pending" ] || [ -L "$pending" ]; then
      echo "fleet: prepared remote marker already exists or cannot be created; run remote session recover-marker $name" >&2
      return 2
    fi
    owner_started=$(ps -o lstart= -p "$$" 2>/dev/null) || owner_started=
    if [ -z "$owner_started" ]; then
      echo "fleet: local dispatch identity is unavailable; writer not started" >&2
      return 2
    fi
    attempt="$$-$(date +%s)-$RANDOM"
    stage=$(mktemp "$orch/sessions/.${name}.remote.pending.XXXXXX") || return 2
    if ! jq -nc --arg host "$REMOTE_HOST" --arg stateDir "$REMOTE_STATE_DIR" --argjson pid "$$" --arg started "$owner_started" --arg attempt "$attempt" '{host:$host,stateDir:$stateDir,owner:{pid:$pid,started:$started,attempt:$attempt}}' > "$stage"; then
      rm -f "$stage"
      echo "fleet: local remote owner could not be staged; writer not started" >&2
      return 2
    fi
    if ! ln "$stage" "$pending"; then
      rm -f "$stage"
      echo "fleet: prepared remote owner already exists or cannot be published; run remote session recover-marker $name" >&2
      return 2
    fi
    if [ -L "$pending" ] || [ ! -f "$pending" ] || ! jq -e --arg attempt "$attempt" '.owner.attempt == $attempt' "$pending" >/dev/null; then
      rm -f "$stage"
      echo "fleet: published pending owner did not match this attempt; writer not started" >&2
      return 2
    fi
    rm "$stage"
  fi
  remote_command="${codex_check}remote_root=$remote_root; "
  if [ "$command" = turn ]; then
    local rejected_path preflight_claim evidence_script receipt
    rejected_path=$(printf %q "$REMOTE_STATE_DIR/$name.preflight-rejected.json")
    preflight_claim=$(printf %q "$REMOTE_STATE_DIR/$name.preflight.$attempt.json")
    evidence_script=$(printf %q "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/fleet-remote-evidence.mjs")
    receipt="receipt_stage=\$(mktemp $(printf %q "$REMOTE_STATE_DIR/$name.preflight-rejected.json.XXXXXX")) || exit 1; jq -nc --arg attempt $(printf %q "$attempt") '{attempt:\$attempt,stage:\"preflight-rejected\"}' > \"\$receipt_stage\" || { rm -f \"\$receipt_stage\"; exit 1; }; mv \"\$receipt_stage\" $rejected_path || { rm -f \"\$receipt_stage\"; exit 1; }; rm -f $preflight_claim"
    remote_command="node $evidence_script preflight-begin $preflight_claim $(printf %q "$attempt") \"\$\$\" || exit 1; command -v codex >/dev/null 2>&1 || { printf 'fleet: codex CLI is missing on remote host %s (PATH=%s); install Codex CLI on that host and make it available in REMOTE_SHELL\\n' $(printf %q "$REMOTE_HOST") \"\$PATH\" >&2; $receipt; exit 127; }; remote_root=$remote_root; remote_status=\$?; if [ \"\$remote_status\" -ne 0 ] || [ -z \"\$remote_root\" ]; then $receipt; exit 2; fi; "
    if [ -n "$preflight" ]; then remote_command+="$preflight; remote_status=\$?; if [ \"\$remote_status\" -ne 0 ]; then $receipt; exit \"\$remote_status\"; fi; "; fi
    # A dead dispatch's prepared journal is safe to clear only at the next
    # admitted turn; recovery leaves it intact as repeatable no-start proof.
    local remote_state_path remote_journal_path
    remote_state_path=$(printf %q "$REMOTE_STATE_DIR/$name.json")
    remote_journal_path=$(printf %q "$REMOTE_STATE_DIR/$name.launch.json")
    remote_command+="if test ! -e $remote_state_path && test ! -L $remote_state_path && test -e $remote_journal_path && [ \"\$(node $evidence_script journal $remote_journal_path $remote_state_path '' '')\" = prepared ]; then rm $remote_journal_path || { $receipt; exit 1; }; fi; "
    remote_command+="node $evidence_script preflight-launch $preflight_claim $(printf %q "$attempt") \"\$\$\" || exit 1; exec $(printf '%q ' node "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/codex-session.mjs" "$command" "$REMOTE_STATE_DIR" "$name" ${args[@]+"${args[@]}"})$plugin_arg --fleet-claim $preflight_claim"
  else
    if [ -n "$preflight" ]; then remote_command+="test -n \"\$remote_root\" && $preflight && "; fi
    remote_command+="$(printf '%q ' node "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/codex-session.mjs" "$command" "$REMOTE_STATE_DIR" "$name" ${args[@]+"${args[@]}"})$plugin_arg"
  fi
  if run_remote "$remote_command"; then
    if [ "$command" = turn ]; then
      if ! publish_remote_marker "$pending" "$marker"; then
        echo "fleet: remote writer started but local marker publication failed; run remote session recover-marker $name" >&2
        return 1
      fi
    fi
  else
    local status=$?
    if [ "$command" = turn ]; then
      local remote_evidence=
      if remote_evidence=$(remote_writer_evidence "$name" "$attempt") && { [ "$remote_evidence" = rejected ] || [ "$remote_evidence" = prepared ] || [ "$remote_evidence" = preflight-dead ]; }; then
        rm "$pending"
      else
        echo "fleet: remote result is unconfirmed; prepared marker retained; run remote session recover-marker $name" >&2
      fi
    fi
    return "$status"
  fi
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
  if [ -n "$check" ]; then gate="MAX_LOAD_PER_CORE=$(printf %q "${REMOTE_MAX_LOAD_PER_CORE:-${MAX_LOAD_PER_CORE:-1.5}}") FLEET_FORCE_HERE=$(printf %q "${FLEET_FORCE_HERE:-}") FLEET_FORCE_REASON=$(printf %q "${FLEET_FORCE_REASON:-}") bash $(printf %q "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/load-check.sh") && "; fi
  local slot_args=(--slots "$slots")
  if [ -n "$admission_note" ]; then slot_args+=(--admission-note "$admission_note"); fi
  if [ -n "$preflight" ]; then
    local expected_version remote_root remote_gate
    expected_version=$(jq -er '.version' "$skills/../.codex-plugin/plugin.json")
    remote_root='$(codex plugin list --json | jq -er '\''.installed[] | select(.name == "vibe" and .installed == true and .enabled == true) | .source.path'\'' | head -n 1)'
    remote_gate="command -v codex >/dev/null 2>&1 && remote_root=$remote_root && test -n \"\$remote_root\" && test \"\$(jq -er .version \"\$remote_root/.codex-plugin/plugin.json\")\" = $(printf %q "$expected_version") || { printf 'fleet: remote vibe plugin is missing or not version %s; heavy build not started\\n' $(printf %q "$expected_version") >&2; exit 78; }; "
    run_remote "${remote_gate}cd $(printf %q "$dir") && $gate$(printf '%q ' bash "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/slot-lock.sh" "${slot_args[@]}")--preflight-node \"\$remote_root/skills/vibe/scripts/e2e-lock.mjs\" $(printf '%q ' "$name" "$owner" "$@")"
  else
    run_remote "cd $(printf %q "$dir") && $gate$(printf '%q ' bash "$remote_dir/plugins/vibe/skills/fleet-orchestrator/scripts/slot-lock.sh" "${slot_args[@]}" "$name" "$owner" "$@")"
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
