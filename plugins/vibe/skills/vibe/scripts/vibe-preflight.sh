#!/usr/bin/env bash
# Check every prerequisite for a vibe session and print one JSON object per
# line: {"check":..., "ok":true|false, "detail":..., "fix":...}. The skill
# reads the failures and runs the fixes in references/preflight.md. Exit code
# is 0 when every check passes, 1 otherwise.
#
# Any git checkout is accepted (operator ruling, 2026-11-10: nothing is tied
# to one organization's repositories). The checkout is, in order: the one
# --repo names, the one this command runs in, else the one remembered in
# ~/.codex/vibe/config.json ({"repo": "<path>"}); a worktree resolves to the
# checkout that owns it. The one thing it writes is that remembered checkout.
# vibe-sessions.mjs records the checkout on each session, so a later session
# elsewhere never reads another one's.
#
# Repository-specific checks (a bootstrap marker, the analytics key a hosted
# environment's flag snapshot needs) run only when the conversation's bound
# provider has recipes for the repository (provider.mjs).
#
# Usage: vibe-preflight.sh [--runtime codex|claude] [--codex <CLI>] [--repo <checkout>] [--prototype]

set -uo pipefail

REPO_ARG=""
PROTOTYPE_ONLY=0
RUNTIME=codex
CODEX_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_ARG="${2:-}"; shift; if [[ $# -gt 0 ]]; then shift; fi ;;
    --prototype) PROTOTYPE_ONLY=1; shift ;;
    --runtime) RUNTIME="${2:-}"; shift; if [[ $# -gt 0 ]]; then shift; fi ;;
    --codex) CODEX_ARG="${2:-}"; shift; if [[ $# -gt 0 ]]; then shift; fi ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
case "$RUNTIME" in
  codex|claude) ;;
  *) printf 'Invalid runtime: %s\n' "$RUNTIME" >&2; exit 1 ;;
esac

CONFIG_DIR="$HOME/.codex/vibe"
CONFIG_FILE="$CONFIG_DIR/config.json"
# What vibe's own scripts need until the checkout is found; the checkout's
# package.json `engines.node` wins after.
DEFAULT_NODE_RANGE=">=22"

failures=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"; value="${value//\"/\\\"}"
  value="${value//$'\n'/ }"; value="${value//$'\t'/ }"
  printf '%s' "$value"
}

emit() {
  local check="$1" ok="$2" detail fix
  detail="$(json_escape "$3")"
  fix="$(json_escape "$4")"
  printf '{"check":"%s","ok":%s,"detail":"%s","fix":"%s"}\n' "$check" "$ok" "$detail" "$fix"
  if [[ "$ok" != "true" ]]; then
    failures=$((failures + 1))
  fi
}

have() {
  command -v "$1" >/dev/null 2>&1
}

# Claude resolves closedloop-core and vibe-core through the manifest dependencies.
# Codex installs no dependency, so it requires both explicitly installed and
# enabled before session setup: vibe-core carries vibe's hooks, and vibe ships
# none of its own. If Node is absent, the ordinary prerequisite
# checks below report its existing install fix.
if [[ "$RUNTIME" == "codex" ]] && have node; then
  codex_executable="$CODEX_ARG"
  if [[ -z "$codex_executable" ]]; then
    codex_executable="$(command -v codex 2>/dev/null)"
    if [[ -z "$codex_executable" ]]; then
      codex_executable="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
    fi
  fi
  plugins_json=""
  if [[ -x "$codex_executable" ]]; then
    plugins_json="$("$codex_executable" plugin list --json 2>/dev/null)" || plugins_json=""
  fi
  missing_plugin=0
  for required in closedloop-core vibe-core; do
    if printf '%s' "$plugins_json" | node -e '
        let input = "";
        process.stdin.on("data", chunk => { input += chunk; });
        process.stdin.on("end", () => {
          try {
            const result = JSON.parse(input);
            const enabled = Array.isArray(result.installed) && result.installed.some(
              plugin => plugin.pluginId === `${process.argv[1]}@closedloop-ai` &&
                plugin.installed === true && plugin.enabled === true
            );
            process.exit(enabled ? 0 : 1);
          } catch { process.exit(1); }
        });
      ' "$required"; then
      emit "$required" true "$required is installed and enabled" ''
    else
      emit "$required" false "$required is not installed and enabled" "$(printf '%q plugin add %s@closedloop-ai' "$codex_executable" "$required")"
      missing_plugin=1
    fi
  done
  if [[ "$missing_plugin" == "1" ]]; then
    exit 1
  fi
fi

# Reads one top-level string field from a JSON file, without needing jq.
json_field() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 1
  if have plutil; then
    plutil -extract "$key" raw -o - "$file" 2>/dev/null && return 0
  fi
  if have jq; then
    jq -er --arg key "$key" '.[$key] // empty' "$file" 2>/dev/null && return 0
  fi
  return 1
}

# Reads "engines.node" from a package.json.
engines_node() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  if have plutil; then
    plutil -extract engines.node raw -o - "$file" 2>/dev/null && return 0
  fi
  if have jq; then
    jq -er '.engines.node // empty' "$file" 2>/dev/null && return 0
  fi
  return 1
}

is_checkout() {
  [[ -n "$1" ]] && git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

# A worktree resolves to the checkout that owns it, so sessions always start
# from the main checkout.
main_checkout_of() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  dirname "$common"
}

# Remembering the checkout is optional (the search finds it again), so a refused
# write never fails the setup check. It is never silent either: Codex's sandbox
# refuses writes under ~/.codex, and the line asks for an escalated rerun.
remember_repo() {
  local error
  if error="$({ mkdir -p "$CONFIG_DIR" &&
    printf '{\n  "repo": "%s"\n}\n' "$(json_escape "$1")" >"$CONFIG_FILE.tmp" &&
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"; } 2>&1)"; then
    return 0
  fi
  if [[ "${CODEX_SANDBOX_NETWORK_DISABLED:-}" == "1" ]]; then
    printf '{"escalate":true,"justification":"Remember where your copy of the code is","error":"%s"}\n' "$(json_escape "$error")"
  else
    printf '{"check":"repo-remembered","ok":true,"detail":"%s","fix":""}\n' "$(json_escape "could not save $CONFIG_FILE: $error")"
  fi
}

repo=""
repo_detail=""
repo_fix=""

if [[ -n "$REPO_ARG" ]]; then
  if is_checkout "$REPO_ARG"; then
    repo="$(main_checkout_of "$REPO_ARG")" || repo="$REPO_ARG"
  else
    repo_detail="$REPO_ARG is not a git checkout"
    repo_fix="ask-for-repo-path"
  fi
elif is_checkout "$PWD"; then
  repo="$(main_checkout_of "$PWD")" || repo="$(git -C "$PWD" rev-parse --show-toplevel)"
else
  remembered="$(json_field "$CONFIG_FILE" repo)" || remembered=""
  if is_checkout "$remembered"; then
    repo="$(main_checkout_of "$remembered")" || repo="$remembered"
  else
    repo_detail="no git checkout was named, this command does not run in one, and none is remembered"
    repo_fix="ask-for-repo-path"
  fi
fi

if [[ -n "$repo" ]]; then
  remembered="$(json_field "$CONFIG_FILE" repo)" || remembered=""
  if [[ "$remembered" != "$repo" ]]; then
    remember_repo "$repo"
  fi
fi

# A value of the bound provider's recipes for this conversation, as JSON, or nothing when none is bound.
provider_recipe() {
  node "$SCRIPT_DIR/provider.mjs" data recipes "$1" --worktree "$repo" 2>/dev/null | grep -v '^provider: ' | grep -v '^null$'
}

# The package manager the checkout's lockfile names, or nothing.
package_manager() {
  if [[ -f "$1/pnpm-lock.yaml" ]]; then echo pnpm
  elif [[ -f "$1/yarn.lock" ]]; then echo yarn
  elif [[ -f "$1/bun.lockb" || -f "$1/bun.lock" ]]; then echo bun
  elif [[ -f "$1/package-lock.json" || -f "$1/package.json" ]]; then echo npm
  fi
}

# Compares two x.y.z versions; prints -1, 0, or 1.
version_compare() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  local pairs=("${a1:-0}" "${b1:-0}" "${a2:-0}" "${b2:-0}" "${a3:-0}" "${b3:-0}")
  local i
  for i in 0 2 4; do
    if ((10#${pairs[i]} < 10#${pairs[i + 1]})); then
      echo -1; return
    elif ((10#${pairs[i]} > 10#${pairs[i + 1]})); then
      echo 1; return
    fi
  done
  echo 0
}

# Fills a partial version (24, 24.1, 24.x) to the lowest x.y.z it covers and
# prints "<lowest> <parts given>".
expand_partial() {
  local raw="${1#v}" parts=0 major minor patch
  raw="${raw#=}"
  IFS=. read -r major minor patch <<<"$raw"
  for value in "$major" "$minor" "$patch"; do
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      parts=$((parts + 1))
    else
      break
    fi
  done
  case "$parts" in
    0) echo "0.0.0 0" ;;
    1) echo "$major.0.0 1" ;;
    2) echo "$major.$minor.0 2" ;;
    *) echo "$major.$minor.${patch%%[-+]*} 3" ;;
  esac
}

# The exclusive upper bound for ^, ~, and bare partial versions.
upper_bound() {
  local operator="$1" lowest="$2" parts="$3" major minor patch
  IFS=. read -r major minor patch <<<"$lowest"
  if [[ "$operator" == "^" ]]; then
    if ((major > 0 || parts == 1)); then
      echo "$((major + 1)).0.0"
    elif ((minor > 0 || parts == 2)); then
      echo "0.$((minor + 1)).0"
    else
      echo "0.0.$((patch + 1))"
    fi
  elif ((parts == 1)); then
    echo "$((major + 1)).0.0"
  elif ((parts == 2)) || [[ "$operator" == "~" ]]; then
    echo "$major.$((minor + 1)).0"
  else
    echo "$major.$minor.$((patch + 1))"
  fi
}

comparator_ok() {
  local version="$1" comparator="$2" operator rest expanded lowest parts
  case "$comparator" in
    "" | "*" | x | X) return 0 ;;
    ">="*) operator=">="; rest="${comparator#>=}" ;;
    "<="*) operator="<="; rest="${comparator#<=}" ;;
    ">"*) operator=">"; rest="${comparator#>}" ;;
    "<"*) operator="<"; rest="${comparator#<}" ;;
    "^"*) operator="^"; rest="${comparator#^}" ;;
    "~"*) operator="~"; rest="${comparator#\~}" ;;
    *) operator="="; rest="$comparator" ;;
  esac
  expanded="$(expand_partial "$rest")"
  lowest="${expanded% *}"
  parts="${expanded##* }"
  local low_cmp
  low_cmp="$(version_compare "$version" "$lowest")"
  case "$operator" in
    ">=") [[ "$low_cmp" != "-1" ]] ;;
    ">") [[ "$low_cmp" == "1" ]] ;;
    "<") [[ "$low_cmp" == "-1" ]] ;;
    "<=") [[ "$low_cmp" != "1" ]] ;;
    *)
      if ((parts == 3)) && [[ "$operator" == "=" ]]; then
        [[ "$low_cmp" == "0" ]]
        return
      fi
      ((parts == 0)) && return 0
      [[ "$low_cmp" != "-1" ]] &&
        [[ "$(version_compare "$version" "$(upper_bound "$operator" "$lowest" "$parts")")" == "-1" ]]
      ;;
  esac
}

# True when a version satisfies an npm-style range (such as "^1.2 || >=2" from `engines`).
version_satisfies() {
  local version="${1#v}" range="$2" alternative comparator ok
  version="${version%%[-+]*}"
  local rest="$range"
  while :; do
    alternative="${rest%%||*}"
    ok=true
    for comparator in $alternative; do
      if ! comparator_ok "$version" "$comparator"; then
        ok=false
        break
      fi
    done
    $ok && return 0
    [[ "$rest" == *"||"* ]] || return 1
    rest="${rest#*||}"
  done
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  emit macos true "$(sw_vers -productVersion 2>/dev/null)" ""
else
  emit macos false "$(uname -s)" "unsupported-os"
fi

if have brew; then
  emit homebrew true "$(brew --version 2>/dev/null | head -1)" ""
else
  emit homebrew false "not installed" "install-homebrew"
fi

if have git; then
  emit git true "$(git --version)" ""
else
  emit git false "not installed" "install-xcode-clt"
fi

node_range="$DEFAULT_NODE_RANGE"
if [[ -n "$repo" ]]; then
  node_range="$(engines_node "$repo/package.json")" || node_range="$DEFAULT_NODE_RANGE"
fi

# The node these commands run, and the node a brand-new shell would run (which
# is what every later command in the session gets).
current_node="$(command -v node 2>/dev/null)"
current_version=""
if [[ -n "$current_node" ]]; then
  current_version="$(node --version 2>/dev/null)"
fi
fresh_output="$("${SHELL:-/bin/zsh}" -lc 'printf "VIBE_NODE_PATH=%s\n" "$(command -v node)"; printf "VIBE_NODE_VERSION=%s\n" "$(node --version 2>/dev/null)"' 2>/dev/null </dev/null)"
fresh_node="$(printf '%s\n' "$fresh_output" | sed -n 's/^VIBE_NODE_PATH=//p' | tail -1)"
fresh_version="$(printf '%s\n' "$fresh_output" | sed -n 's/^VIBE_NODE_VERSION=//p' | tail -1)"

if [[ -z "$current_node" && -z "$fresh_node" ]]; then
  emit node false "not installed; needs $node_range" "install-node"
elif [[ -z "$current_version" ]] || ! version_satisfies "$current_version" "$node_range"; then
  emit node false "${current_version:-none} at ${current_node:-nowhere} is outside $node_range" "install-node"
elif [[ -z "$fresh_version" ]] || ! version_satisfies "$fresh_version" "$node_range"; then
  emit node false "a new shell runs ${fresh_version:-no node} at ${fresh_node:-nowhere}, outside $node_range" "install-node"
else
  emit node true "$current_version at $current_node (needs $node_range)" ""
fi

manager=""
if [[ -n "$repo" ]]; then
  manager="$(package_manager "$repo")"
fi
if [[ -n "$manager" ]]; then
  if have "$manager"; then
    emit package-manager true "$manager $("$manager" --version 2>/dev/null)" ""
  else
    emit package-manager false "$manager is not installed" "install-$manager"
  fi
fi


if have jq; then
  emit jq true "$(jq --version)" ""
else
  emit jq false "not installed" "brew-install-jq"
fi

if have gh; then
  if gh auth status >/dev/null 2>&1; then
    emit gh true "$(gh api user --jq .login 2>/dev/null)" ""
  else
    emit gh false "installed but not signed in" "gh-auth-login"
  fi
else
  emit gh false "not installed" "brew-install-gh"
fi

# Claude Code workers run as separate `claude` processes on the CLI's own
# stored sign-in, which can be signed out while the chat itself still works.
# Asked from the home folder so no project settings or project MCP servers
# load. The worker launcher also catches a sign-in that expired since.
if [[ "$RUNTIME" == "claude" ]] && have claude; then
  claude_status="$(cd "$HOME" && claude auth status --json 2>/dev/null </dev/null)"
  if printf '%s' "$claude_status" | node -e '
      let input = "";
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        try { process.exit(JSON.parse(input).loggedIn === false ? 1 : 0); } catch { process.exit(0); }
      });
    ' 2>/dev/null; then
    emit claude-login true "signed in" ""
  else
    emit claude-login false "the claude command on this Mac is signed out" "claude-auth-login"
  fi
fi

if [[ -n "$repo" ]]; then
  emit repo true "$repo" ""
  bootstrap="$(provider_recipe bootstrap)"
  if [[ -n "$manager" ]]; then
    if [[ -d "$repo/node_modules" ]]; then
      emit repo-bootstrap true "node_modules present" ""
    else
      bootstrap_fix="$(printf '%s' "$bootstrap" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).fix??"")}catch{}})' 2>/dev/null)"
      emit repo-bootstrap false "dependencies not installed" "${bootstrap_fix:-install-dependencies}"
    fi
  fi
  # The public PostHog key a hosted environment's flag snapshot needs, when the
  # provider's recipes name where it lives. The key itself is never printed here.
  if [[ "$PROTOTYPE_ONLY" == 0 && -n "$(provider_recipe posthog)" ]]; then
    posthog_output="$(node "$SCRIPT_DIR/posthog-key.mjs" --checkout "$repo" 2>/dev/null)"
    if [[ "$posthog_output" == *'"ok":true'* ]]; then
      posthog_host="$(printf '%s' "$posthog_output" | sed -n 's/.*"host":"\([^"]*\)".*/\1/p')"
      posthog_source="$(printf '%s' "$posthog_output" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')"
      emit posthog-key true "$posthog_host from $posthog_source" ""
    else
      posthog_error="$(printf '%s' "$posthog_output" | sed -n 's/.*"error":"\(.*\)"}.*/\1/p')"
      emit posthog-key false "${posthog_error:-the PostHog key could not be resolved}" "posthog-key-missing"
    fi
  fi
else
  emit repo false "$repo_detail" "$repo_fix"
fi

exit $((failures > 0 ? 1 : 0))
