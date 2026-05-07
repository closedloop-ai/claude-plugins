#!/usr/bin/env bash
# test-local-plugins.sh — Test locally-modified Claude Code plugins against the
# marketplace-installed versions.
#
# For every plugin changed on the current branch (relative to main):
#   1. Back up and symlink ~/.claude/plugins/cache/<owner>/<plugin>/<version>
#      to plugins/<plugin>, so all ${CLAUDE_PLUGIN_ROOT}/... paths resolve
#      to local source.
#   2. Run the plugin's own test suite (hooks/tests/*.sh, pytest tools/python/).
#   3. Smoke-test each slash command in commands/ (bootstrap-runs, file-level
#      logic, inner-script invocations).
#   4. If the plugin ships pre/post-tool-use hooks following the closedloop
#      perf-event contract (writes sentinels to $WORKDIR/.tool-calls/<id>,
#      emits tool/skill/spawn events to $WORKDIR/perf.jsonl), run synthetic
#      hook payloads and dump the emitted events. The emitted-event dump and
#      sentinel-cleanup assertion are specific to the `code` plugin's hook
#      contract; other plugins shipping hooks with different contracts will
#      see false-negative noise here and should narrow the harness or write
#      their own.
#
# Out of scope:
#   - PRD/plan parsing or spec-conformance checking. That belongs in a
#     separate spec tool, not in a smoke-tester (its output drifts when PRD
#     prose conventions drift and silently degrades to "no spec found").
#
# Usage:
#   scripts/test-local-plugins.sh                     # test all changed plugins
#   scripts/test-local-plugins.sh --plugin code       # one plugin only
#   scripts/test-local-plugins.sh --revert            # undo symlinks
#   scripts/test-local-plugins.sh --base main         # diff against a different base
#   scripts/test-local-plugins.sh --owner closedloop-ai
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
#   2 — environment problem (missing jq, python3, no installed plugins, etc.)

set -uo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

REPO_ROOT_OVERRIDE=""
BASE_BRANCH="main"
OWNER_DEFAULT="closedloop-ai"
OWNER="$OWNER_DEFAULT"
ONLY_PLUGIN=""
REVERT_MODE=0
VERBOSE=0

INSTALLED_JSON="$HOME/.claude/plugins/installed_plugins.json"
TMP_BASE="/tmp/test-local-plugins-$$"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAIL_LINES=()

# ──────────────────────────────────────────────────────────────────────────────
# Output helpers
# ──────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[1;33m'
  C_BLU=$'\033[0;34m'; C_DIM=$'\033[2m';    C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_DIM=""; C_RST=""
fi

log()      { printf '%s\n' "$*"; }
section()  { printf '\n%s━━ %s ━━%s\n' "$C_BLU" "$*" "$C_RST"; }
info()     { printf '%s•%s %s\n' "$C_DIM" "$C_RST" "$*"; }
pass()     { printf '%s✓%s %s\n' "$C_GRN" "$C_RST" "$*"; PASS_COUNT=$((PASS_COUNT+1)); }
fail()     { printf '%s✗%s %s\n' "$C_RED" "$C_RST" "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); FAIL_LINES+=("$*"); }
skip()     { printf '%s○%s %s\n' "$C_YEL" "$C_RST" "$*"; SKIP_COUNT=$((SKIP_COUNT+1)); }
warn()     { printf '%s!%s %s\n' "$C_YEL" "$C_RST" "$*"; }
debug()    { [ "$VERBOSE" = 1 ] && printf '%s  %s%s\n' "$C_DIM" "$*" "$C_RST" || true; }

die() { fail "$*"; exit 2; }

# ──────────────────────────────────────────────────────────────────────────────
# Argument parsing
# ──────────────────────────────────────────────────────────────────────────────

usage() {
  # Print the leading comment-block docstring (every `# ` line after the
  # shebang, until the first non-comment line). Resilient to docstring growth
  # — extending the header doesn't truncate --help output the way a fixed
  # `sed -n '2,30p'` range would.
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin)  ONLY_PLUGIN="$2"; shift 2 ;;
    --base)    BASE_BRANCH="$2"; shift 2 ;;
    --owner)   OWNER="$2"; shift 2 ;;
    --revert)  REVERT_MODE=1; shift ;;
    --repo-root) REPO_ROOT_OVERRIDE="$2"; shift 2 ;;
    --verbose|-v) VERBOSE=1; shift ;;
    -h|--help) usage ;;
    *)         echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve REPO_ROOT: explicit flag wins, else current git toplevel, else script-relative.
if [ -n "$REPO_ROOT_OVERRIDE" ]; then
  REPO_ROOT="$REPO_ROOT_OVERRIDE"
elif REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Environment checks
# ──────────────────────────────────────────────────────────────────────────────

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_cmd jq
require_cmd python3
require_cmd git

[ -f "$INSTALLED_JSON" ] || die "No installed plugins file at $INSTALLED_JSON. Is the marketplace installed?"
[ -d "$REPO_ROOT/plugins" ] || die "No plugins/ directory at $REPO_ROOT — run from the closedloop-ai monorepo root or pass through scripts/"

mkdir -p "$TMP_BASE"
# Preserve TMP_BASE on failure: fail() messages reference log files inside it,
# and removing the dir before the user reads them defeats the report. Clean
# up only on a fully green run.
cleanup_tmp_base() {
  if [ "$FAIL_COUNT" -eq 0 ]; then
    rm -rf "$TMP_BASE"
  else
    printf '%s(logs preserved at %s for inspection)%s\n' "$C_DIM" "$TMP_BASE" "$C_RST" >&2
  fi
}
trap cleanup_tmp_base EXIT

# ──────────────────────────────────────────────────────────────────────────────
# Core helpers
# ──────────────────────────────────────────────────────────────────────────────

# Print plugin names changed on current branch vs. base.
detect_changed_plugins() {
  cd "$REPO_ROOT" || return
  # Prefer origin/<base> over local <base>: local mains go stale fast and
  # quietly produce wrong diff bases. Best-effort fetch — if offline or no
  # remote, fall back to the local branch with a notice.
  local base_ref
  if git fetch -q origin "$BASE_BRANCH" 2>/dev/null \
      && git rev-parse --verify -q "origin/$BASE_BRANCH" >/dev/null 2>&1; then
    base_ref="origin/$BASE_BRANCH"
  elif git rev-parse --verify -q "$BASE_BRANCH" >/dev/null 2>&1; then
    base_ref="$BASE_BRANCH"
    warn "no origin/$BASE_BRANCH (offline or remote missing) — falling back to local $BASE_BRANCH (may be stale)" >&2
  else
    fail "neither origin/$BASE_BRANCH nor $BASE_BRANCH resolves" >&2
    return 1
  fi
  local merge_base
  merge_base=$(git merge-base HEAD "$base_ref" 2>/dev/null || echo "$base_ref")
  git diff --name-only "$merge_base"...HEAD -- 'plugins/*' 2>/dev/null \
    | awk -F/ 'NF>=2 && $1=="plugins" {print $2}' \
    | sort -u
}

# Look up the installed cache directory for a plugin from installed_plugins.json.
# Echoes "<installPath>|<version>" or empty if not installed.
lookup_installed() {
  local plugin="$1"
  jq -r --arg key "${plugin}@${OWNER}" '
    .plugins[$key][0] // empty
    | if . == null then empty else "\(.installPath)|\(.version)" end
  ' "$INSTALLED_JSON" 2>/dev/null
}

# Symlink ~/.claude/plugins/cache/<owner>/<plugin>/<ver> → repo's plugins/<plugin>.
# Records the prior state in a sidecar file so --revert can restore it whether
# the original was a real directory or a symlink to another worktree.
#
# Sidecar file: $install_path.test-local-plugins.prev
#   one line: "dir|<old-backup-path>"  OR  "link|<old-target>"  OR  "none"
redirect_cache_to_local() {
  local plugin="$1" install_path="$2"
  local local_path="$REPO_ROOT/plugins/$plugin"
  local prev_file="$install_path.test-local-plugins.prev"

  [ -d "$local_path" ] || { fail "[$plugin] no local plugins/$plugin dir"; return 1; }
  [ -n "$install_path" ] || { fail "[$plugin] missing install path"; return 1; }

  if [ -L "$install_path" ]; then
    local cur
    cur=$(readlink "$install_path")
    if [ "$cur" = "$local_path" ]; then
      info "[$plugin] cache already symlinked → $local_path"
      return 0
    fi
    # Existing symlink to some other location. Record it so --revert can put it back.
    if [ ! -f "$prev_file" ]; then
      printf 'link|%s\n' "$cur" > "$prev_file"
      info "[$plugin] recorded prior symlink target → $cur"
    fi
    rm "$install_path"
  elif [ -d "$install_path" ]; then
    local backup="$install_path.bak-test-local-plugins"
    if [ ! -e "$backup" ]; then
      mv "$install_path" "$backup"
      printf 'dir|%s\n' "$backup" > "$prev_file"
      info "[$plugin] backed up cache → $backup"
    elif [ ! -f "$prev_file" ]; then
      # Someone else made a backup with this name — don't blindly delete the live dir.
      warn "[$plugin] backup at $backup not made by us and no sidecar; refusing to overwrite"
      return 1
    else
      rm -rf "$install_path"
      info "[$plugin] backup already exists at $backup, removed live cache dir"
    fi
  fi

  ln -snf "$local_path" "$install_path"
  pass "[$plugin] symlinked $install_path → $local_path"
}

# Undo a previous redirect for a single plugin. Reads sidecar file to decide
# whether to restore a directory backup or re-create a symlink to a prior target.
revert_cache() {
  local plugin="$1" install_path="$2"
  local prev_file="$install_path.test-local-plugins.prev"

  if [ ! -f "$prev_file" ]; then
    if [ -L "$install_path" ]; then
      warn "[$plugin] symlink at $install_path has no sidecar — refusing to remove (would orphan the cache)"
      warn "[$plugin] inspect manually: ls -la $install_path"
    else
      info "[$plugin] no sidecar and no symlink — nothing to revert"
    fi
    return 1
  fi

  local kind value
  IFS='|' read -r kind value < "$prev_file"

  case "$kind" in
    dir)
      if [ ! -d "$value" ]; then
        warn "[$plugin] backup directory $value missing; refusing to remove symlink (would orphan the cache)"
        return 1
      fi
      if [ -L "$install_path" ]; then rm "$install_path"; fi
      if [ -e "$install_path" ]; then
        warn "[$plugin] cannot restore: $install_path still exists; backup left at $value"
        return 1
      fi
      mv "$value" "$install_path"
      rm -f "$prev_file"
      pass "[$plugin] restored directory backup → $install_path"
      ;;
    link)
      if [ -L "$install_path" ]; then rm "$install_path"; fi
      if [ -e "$install_path" ]; then
        warn "[$plugin] cannot restore symlink: $install_path still exists"
        return 1
      fi
      ln -snf "$value" "$install_path"
      rm -f "$prev_file"
      pass "[$plugin] restored prior symlink → $value"
      ;;
    *)
      # Sidecar with an unknown kind is a corrupt-state case. Don't touch the
      # symlink: removing it without knowing what to restore orphans the cache.
      warn "[$plugin] sidecar at $prev_file has unrecognized kind '$kind' — leaving symlink in place"
      warn "[$plugin] inspect manually: cat $prev_file && ls -la $install_path"
      return 1
      ;;
  esac
}

# Sanity-check that the symlink we just created actually points where we
# think it does and that plugins/<plugin>/.claude-plugin/plugin.json is
# parseable. This is not a "version compare" — both sides resolve to the
# same file via the symlink, so it would be tautological — it's just
# confirming the redirect didn't silently become a broken link.
verify_symlink_target() {
  local plugin="$1" install_path="$2"
  local local_path="$REPO_ROOT/plugins/$plugin"
  local actual_target
  actual_target=$(readlink "$install_path" 2>/dev/null || echo "")
  if [ "$actual_target" != "$local_path" ]; then
    fail "[$plugin] symlink at $install_path does not point to $local_path (points to: ${actual_target:-<not a symlink>})"
    return 1
  fi
  local local_pj="$local_path/.claude-plugin/plugin.json"
  local lver
  lver=$(jq -r '.version // ""' "$local_pj" 2>/dev/null)
  if [ -z "$lver" ]; then
    fail "[$plugin] $local_pj missing or unparseable"
    return 1
  fi
  pass "[$plugin] symlink → local plugins/$plugin (v$lver, plugin.json parses)"
}

# Run the plugin's own test suites if present.
run_plugin_tests() {
  local plugin="$1"
  local pdir="$REPO_ROOT/plugins/$plugin"

  # Bash tests under hooks/tests/
  if [ -d "$pdir/hooks/tests" ]; then
    local found=0
    for t in "$pdir"/hooks/tests/*.sh; do
      [ -f "$t" ] || continue
      found=1
      local name; name=$(basename "$t")
      if bash "$t" >"$TMP_BASE/$plugin-$name.log" 2>&1; then
        pass "[$plugin] hook test $name"
      else
        fail "[$plugin] hook test $name (log: $TMP_BASE/$plugin-$name.log)"
      fi
    done
    [ $found -eq 0 ] && info "[$plugin] no hook tests"
  fi

  # Python tests under tools/python/
  if [ -d "$pdir/tools/python" ]; then
    local pys=()
    while IFS= read -r -d '' f; do
      pys+=("$f")
    done < <(find "$pdir/tools/python" -maxdepth 1 -name 'test_*.py' -print0 2>/dev/null)
    if [ "${#pys[@]}" -gt 0 ]; then
      if (cd "$REPO_ROOT" && python3 -m pytest -q "$pdir/tools/python" \
            >"$TMP_BASE/$plugin-pytest.log" 2>&1); then
        pass "[$plugin] pytest tools/python (${#pys[@]} file(s))"
      else
        fail "[$plugin] pytest tools/python (log: $TMP_BASE/$plugin-pytest.log)"
      fi
    fi
  fi
}

# Classify a slash command by inspecting its body. Echoes "bootstrap", "file",
# "orchestrator", or "unknown".
classify_command() {
  local cmd_file="$1"
  # Bootstrap: command body kicks off a setup script via the `!`-bash directive.
  if grep -qE '^\s*!`\s*bash' "$cmd_file" 2>/dev/null; then
    echo bootstrap
    return
  fi
  # File-level: hidden-from-tool flag is the strongest signal for the small,
  # state-mutation-only commands like cancel-code.
  if grep -qE 'hide-from-slash-command-tool' "$cmd_file" 2>/dev/null; then
    echo file
    return
  fi
  # Orchestrator: explicit orchestrator role markers, agent/subagent delegation,
  # or Task( invocations in the command body.
  if grep -qiE '\*\*you are the orchestrator\*\*|^You orchestrate|^# .*[Oo]rchestrator|delegate to|subagent|Task\(|SendMessage' "$cmd_file" 2>/dev/null; then
    echo orchestrator
    return
  fi
  echo unknown
}

# Smoke-test a single command. The aim isn't full execution — it's verifying
# the pieces a human/CI can reach without burning tokens or external CLIs.
smoke_test_command() {
  local plugin="$1" cmd_file="$2"
  local cmd_name; cmd_name=$(basename "$cmd_file" .md)
  local kind; kind=$(classify_command "$cmd_file")
  local install_path="$3"

  # 1) Frontmatter syntactically valid?
  local fm
  fm=$(awk '/^---$/{c++; if(c==2) exit; next} c==1' "$cmd_file" 2>/dev/null)
  if [ -z "$fm" ]; then
    fail "[$plugin] /$plugin:$cmd_name — no YAML frontmatter"
    return
  fi
  pass "[$plugin] /$plugin:$cmd_name — frontmatter parses ($kind)"

  # 2) For bootstrap-style commands, extract the bash invocation and run it
  #    with a dry-run-ish workspace. Skip if it requires args we can't supply.
  case "$kind" in
    bootstrap)
      local bootstrap_line
      # Extract the inside of !`...` from the first matching line.
      bootstrap_line=$(grep -E '^\s*!`\s*bash' "$cmd_file" | head -1 | sed 's/^[^`]*`[[:space:]]*//; s/`.*$//')
      if [ -z "$bootstrap_line" ]; then
        info "[$plugin] /$plugin:$cmd_name — bootstrap line not parseable, skipping run"
        return
      fi
      local resolved
      resolved=$(echo "$bootstrap_line" | sed "s|\${CLAUDE_PLUGIN_ROOT}|$install_path|g; s|\$CLAUDE_PLUGIN_ROOT|$install_path|g")
      # Drop $ARGUMENTS and trailing args we can't supply meaningfully
      resolved="${resolved//\$ARGUMENTS/}"
      local wd="$TMP_BASE/wd-$plugin-$cmd_name"
      mkdir -p "$wd"
      local rc=0
      (cd "$wd" && CLAUDE_PLUGIN_ROOT="$install_path" eval "$resolved" \
            >"$TMP_BASE/$plugin-$cmd_name.log" 2>&1) || rc=$?
      if [ "$rc" = "0" ]; then
        pass "[$plugin] /$plugin:$cmd_name — bootstrap script ran cleanly"
        debug "log: $TMP_BASE/$plugin-$cmd_name.log"
      else
        # Some bootstraps require args; treat exit as informational unless --verbose.
        if [ "$VERBOSE" = 1 ]; then
          warn "[$plugin] /$plugin:$cmd_name — bootstrap exited $rc (may need args)"
          sed -n '1,8p' "$TMP_BASE/$plugin-$cmd_name.log" | sed 's/^/    /'
        fi
        info "[$plugin] /$plugin:$cmd_name — bootstrap requires args; orchestration deferred to fresh Claude session"
      fi
      ;;
    file)
      info "[$plugin] /$plugin:$cmd_name — file-level command (manual smoke test recommended)"
      ;;
    orchestrator)
      info "[$plugin] /$plugin:$cmd_name — orchestrator (drives subagents; defer to fresh Claude session)"
      ;;
    unknown)
      info "[$plugin] /$plugin:$cmd_name — uncategorized; defer to fresh Claude session"
      ;;
  esac
}

# Run synthetic hook payloads for any pre-/post-tool-use hooks the plugin ships.
# Dumps emitted perf.jsonl events to a temp file and prints them.
run_synthetic_hook_tests() {
  local plugin="$1"
  local pdir="$REPO_ROOT/plugins/$plugin"
  local pre="$pdir/hooks/pre-tool-use-hook.sh"
  local post="$pdir/hooks/post-tool-use-hook.sh"

  if [ ! -f "$pre" ] && [ ! -f "$post" ]; then
    info "[$plugin] no pre/post-tool-use hooks; skipping synthetic hook test"
    return
  fi

  local hwd="$TMP_BASE/hookwd-$plugin"
  local sid="hooktest-$$"
  mkdir -p "$hwd/.closedloop-ai"
  echo -n "$hwd/work" > "$hwd/.closedloop-ai/session-$sid.workdir"
  mkdir -p "$hwd/work"
  rm -f "$hwd/work/perf.jsonl"
  rm -rf "$hwd/work/.tool-calls"

  export CLOSEDLOOP_RUN_ID="run-test-$$"
  export CLOSEDLOOP_COMMAND="/$plugin:test-harness"
  export CLOSEDLOOP_ITERATION=1
  # NOTE: the closedloop perf hooks were originally gated behind
  # CLOSEDLOOP_PERF_V2=1, but that gate was removed (see commit be6e758,
  # "fix(code): emit tool/skill/spawn events unconditionally") because the
  # desktop ships claude-plugins bundled and end users had no way to set it.
  # Do NOT export CLOSEDLOOP_PERF_V2=1 here — it's dead-letter env. If the
  # gate is ever reintroduced, this block must be updated.

  # Test cases: tool_name, special_field (used to differentiate Skill payload variants)
  # Skill_alt exercises the post-hook's tool_input.command fallback path.
  local cases=(
    "Bash:plain"
    "Skill:skill_field"
    "Skill:command_field"
    "Agent:plain"
    "Read:fail"
  )

  local pre_fired_any=0
  local payload
  for case_spec in "${cases[@]}"; do
    local tool_name="${case_spec%:*}"
    local variant="${case_spec##*:}"
    local tuid="tool-use-$tool_name-$variant-$$"
    payload=$(jq -n -c \
      --arg sid "$sid" \
      --arg cwd "$hwd" \
      --arg tuid "$tuid" \
      --arg agent "harness" \
      --arg tn "$tool_name" \
      '{session_id:$sid, cwd:$cwd, tool_use_id:$tuid, agent_id:$agent, tool_name:$tn}'
    )
    case "$variant" in
      skill_field)   payload=$(echo "$payload" | jq -c '. + {tool_input:{skill:"plugin:fake-skill"}}') ;;
      command_field) payload=$(echo "$payload" | jq -c '. + {tool_input:{command:"plugin:fallback-skill"}}') ;;
    esac
    case "$tool_name" in
      Agent) payload=$(echo "$payload" | jq -c '. + {tool_input:{subagent_type:"plugin:fake-agent"}}') ;;
    esac

    if [ -f "$pre" ]; then
      echo "$payload" | bash "$pre" || true
      pre_fired_any=1
    fi
    # The post-hook computes duration_s from second-precision timestamps.
    # Without this 1s gap the emitted duration is always 0, which is valid
    # but masks any timestamp-handling bug. Total added latency: ~5s per
    # plugin; intentional, do not remove without replacing with sub-second
    # timestamp handling in the hooks themselves.
    sleep 1
    local post_payload
    if [ "$variant" = "fail" ]; then
      post_payload=$(echo "$payload" | jq -c '. + {tool_response:{error:"boom",success:false}}')
    else
      post_payload=$(echo "$payload" | jq -c '. + {tool_response:{success:true}}')
    fi
    if [ -f "$post" ]; then
      echo "$post_payload" | bash "$post" || true
    fi
  done

  if [ -s "$hwd/work/perf.jsonl" ]; then
    local count
    count=$(wc -l <"$hwd/work/perf.jsonl" | tr -d ' ')
    pass "[$plugin] hooks emitted $count events to perf.jsonl"
    log "  ${C_DIM}emitted events:${C_RST}"
    while IFS= read -r line; do
      log "    $line"
    done <"$hwd/work/perf.jsonl"

    # Verify the fallback skill path actually fires (skill_name extracted from
    # tool_input.command when tool_input.skill is absent).
    if [ -f "$post" ]; then
      if jq -e 'select(.event=="skill" and .skill_name=="plugin:fallback-skill")' \
            "$hwd/work/perf.jsonl" >/dev/null 2>&1; then
        pass "[$plugin] post-hook skill_name fallback (tool_input.command) works"
      else
        warn "[$plugin] post-hook skill_name fallback (tool_input.command) not exercised in output"
      fi
    fi
  else
    fail "[$plugin] hooks did not emit any events (perf.jsonl empty)"
  fi

  # Sentinel cleanup check — only meaningful if pre-hook actually fired and
  # the .tool-calls/ directory was at any point populated.
  if [ "$pre_fired_any" = "1" ] && [ -f "$pre" ]; then
    if [ ! -d "$hwd/work/.tool-calls" ]; then
      fail "[$plugin] pre-hook never created .tool-calls/ — sentinel write path broken"
    else
      local left
      left=$(find "$hwd/work/.tool-calls" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
      if [ "$left" = "0" ]; then
        pass "[$plugin] all sentinels cleaned up after post-hook"
      else
        fail "[$plugin] $left sentinel(s) left in .tool-calls/ after post-hook"
      fi
    fi
  fi

  unset CLOSEDLOOP_RUN_ID CLOSEDLOOP_COMMAND CLOSEDLOOP_ITERATION
}

# ──────────────────────────────────────────────────────────────────────────────
# Main per-plugin flow
# ──────────────────────────────────────────────────────────────────────────────

test_plugin() {
  local plugin="$1"
  section "Plugin: $plugin"

  local entry; entry=$(lookup_installed "$plugin")
  if [ -z "$entry" ]; then
    # If the user explicitly named this plugin, treat the miss as a hard failure
    # so a typo doesn't silently produce a green run. If it came from automatic
    # detection (changed plugins not yet installed via marketplace), skip.
    if [ -n "$ONLY_PLUGIN" ]; then
      fail "[$plugin] not installed via marketplace ($plugin@$OWNER) — check the plugin name and --owner"
    else
      skip "[$plugin] not installed via marketplace ($plugin@$OWNER) — symlink not applicable"
    fi
    return
  fi
  local install_path="${entry%%|*}"
  local installed_ver="${entry##*|}"
  info "[$plugin] installed v$installed_ver at $install_path"

  redirect_cache_to_local "$plugin" "$install_path" || return
  verify_symlink_target "$plugin" "$install_path" || return

  run_plugin_tests "$plugin"

  # Slash commands
  local cdir="$REPO_ROOT/plugins/$plugin/commands"
  if [ -d "$cdir" ]; then
    for cmd in "$cdir"/*.md; do
      [ -f "$cmd" ] || continue
      smoke_test_command "$plugin" "$cmd" "$install_path"
    done
  else
    info "[$plugin] no commands/ directory"
  fi

  # Hook tests
  run_synthetic_hook_tests "$plugin"
}

revert_plugin() {
  local plugin="$1"
  section "Revert: $plugin"
  local entry; entry=$(lookup_installed "$plugin")
  [ -n "$entry" ] || { skip "[$plugin] not installed; nothing to revert"; return; }
  revert_cache "$plugin" "${entry%%|*}"
}

# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────

# Pick plugin list
plugins=()
if [ -n "$ONLY_PLUGIN" ]; then
  plugins=("$ONLY_PLUGIN")
else
  while IFS= read -r p; do
    [ -n "$p" ] && plugins+=("$p")
  done < <(detect_changed_plugins)
fi

if [ "${#plugins[@]}" -eq 0 ]; then
  warn "No changed plugins detected vs $BASE_BRANCH (nothing to do)."
  exit 0
fi

section "test-local-plugins.sh — base=$BASE_BRANCH owner=$OWNER mode=$([ $REVERT_MODE = 1 ] && echo revert || echo test)"
info "Plugins: ${plugins[*]}"

for p in "${plugins[@]}"; do
  if [ "$REVERT_MODE" = 1 ]; then
    revert_plugin "$p"
  else
    test_plugin "$p"
  fi
done

# ──────────────────────────────────────────────────────────────────────────────
# Final summary
# ──────────────────────────────────────────────────────────────────────────────

section "Summary"
log "  ${C_GRN}pass${C_RST}: $PASS_COUNT"
log "  ${C_RED}fail${C_RST}: $FAIL_COUNT"
log "  ${C_YEL}skip${C_RST}: $SKIP_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  log
  log "${C_RED}Failures:${C_RST}"
  for line in "${FAIL_LINES[@]}"; do log "  - $line"; done
fi

if [ "$REVERT_MODE" = 0 ]; then
  # Enumerate active redirects (sidecar files mark them) so the user knows
  # exactly which marketplace paths now point at local source.
  active_redirects=()
  while IFS= read -r prev; do
    [ -z "$prev" ] && continue
    active_redirects+=("$(dirname "$prev")/$(basename "$prev" .test-local-plugins.prev)")
  done < <(find "$HOME/.claude/plugins/cache" -maxdepth 4 -name '*.test-local-plugins.prev' 2>/dev/null)

  if [ "${#active_redirects[@]}" -gt 0 ]; then
    log
    log "${C_YEL}╔══════════════════════════════════════════════════════════════════════════╗${C_RST}"
    log "${C_YEL}║  CACHE STILL REDIRECTED — every Claude Code session will use local source.  ${C_RST}"
    log "${C_YEL}╚══════════════════════════════════════════════════════════════════════════╝${C_RST}"
    log "${C_YEL}Active redirects:${C_RST}"
    for p in "${active_redirects[@]}"; do
      log "  $p"
    done
    log
    log "Hook scripts only register at Claude Code session startup. To verify hook"
    log "registration end-to-end, restart Claude Code in a worktree using the plugin."
    log
    log "${C_YEL}When you're done, restore the marketplace cache:${C_RST}"
    log "  $0 --revert"
  fi
fi

[ "$FAIL_COUNT" -eq 0 ] || exit 1
exit 0
