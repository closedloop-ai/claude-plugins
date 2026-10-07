#!/usr/bin/env bash
# Check every prerequisite for a vibe session and print one JSON object per
# line: {"check":..., "ok":true|false, "detail":..., "fix":...}. The skill
# reads the failures and runs the fixes in references/preflight.md. Exit code
# is 0 when every check passes, 1 otherwise.
#
# The one thing it writes is the remembered symphony-alpha checkout,
# ~/.codex/vibe/config.json ({"repo": "<path>"}), which vibe-sessions.mjs and
# every later run read. It remembers a checkout passed with --repo, or the
# only one found under the home folder. A checkout is recognized by its git
# remote (closedloop-ai/symphony-alpha), not by its folder name.
#
# Usage: vibe-preflight.sh [--repo <path to symphony-alpha checkout>]

set -uo pipefail

REPO_ARG=""
if [[ "${1:-}" == "--repo" ]]; then
  REPO_ARG="${2:-}"
fi

CONFIG_DIR="$HOME/.codex/vibe"
CONFIG_FILE="$CONFIG_DIR/config.json"
# Used until the checkout is found; the checkout's package.json wins after.
DEFAULT_NODE_RANGE="^24 || >=26"
SEARCH_DEPTH=6
REMOTE_PATTERN='[:/]closedloop-ai/symphony-alpha(\.git)?/?$'

failures=0

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

is_symphony_checkout() {
  [[ -e "$1/.git" ]] || return 1
  git -C "$1" config --get-regexp '^remote\..*\.url$' 2>/dev/null | grep -qiE "$REMOTE_PATTERN"
}

# A worktree resolves to the checkout that owns it, so sessions always start
# from the main checkout.
main_checkout_of() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  dirname "$common"
}

remember_repo() {
  mkdir -p "$CONFIG_DIR"
  printf '{\n  "repo": "%s"\n}\n' "$(json_escape "$1")" >"$CONFIG_FILE.tmp" &&
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

# Every symphony-alpha checkout under the home folder, one per line. Folders
# macOS refused to let us read go to the file named by $1.
find_checkouts() {
  local denied_file="$1" git_entry dir main
  while IFS= read -r git_entry; do
    dir="$(dirname "$git_entry")"
    if is_symphony_checkout "$dir"; then
      main="$(main_checkout_of "$dir")" || main="$dir"
      printf '%s\n' "$main"
    fi
  done < <(
    find "$HOME" -maxdepth "$SEARCH_DEPTH" \
      \( -name .git -print -prune \) -o \
      \( -type d \( -name '.*' -o -name node_modules -o -name Library \
        -o -name Applications -o -name Pictures -o -name Music -o -name Movies \) -prune \) \
      2>"$denied_file"
  ) | sort -u
}

repo=""
repo_detail=""
repo_fix=""

if [[ -n "$REPO_ARG" ]]; then
  if is_symphony_checkout "$REPO_ARG"; then
    repo="$(main_checkout_of "$REPO_ARG")" || repo="$REPO_ARG"
  else
    repo_detail="$REPO_ARG is not a symphony-alpha checkout"
    repo_fix="ask-for-repo-path"
  fi
else
  remembered="$(json_field "$CONFIG_FILE" repo)" || remembered=""
  if [[ -n "$remembered" ]] && is_symphony_checkout "$remembered"; then
    repo="$remembered"
  else
    denied_file="$(mktemp)"
    checkouts=()
    while IFS= read -r line; do
      [[ -n "$line" ]] && checkouts+=("$line")
    done < <(find_checkouts "$denied_file")
    denied="$(grep -i 'operation not permitted' "$denied_file" | sed -E 's/^find: //; s/: Operation not permitted.*$//' | sort -u | paste -sd '|' - | sed 's/|/ | /g')"
    rm -f "$denied_file"
    if [[ ${#checkouts[@]} -eq 1 ]]; then
      repo="${checkouts[0]}"
    elif [[ ${#checkouts[@]} -gt 1 ]]; then
      repo_detail="$(printf '%s\n' "${checkouts[@]}" | paste -sd '|' - | sed 's/|/ | /g')"
      repo_fix="choose-repo"
    elif [[ -n "$denied" ]]; then
      repo_detail="macOS blocked searching: $denied"
      repo_fix="allow-folder-access"
    else
      repo_detail="no symphony-alpha checkout found under $HOME"
      repo_fix="clone-repo"
    fi
  fi
fi

if [[ -n "$repo" ]]; then
  remembered="$(json_field "$CONFIG_FILE" repo)" || remembered=""
  if [[ "$remembered" != "$repo" ]]; then
    remember_repo "$repo"
  fi
fi

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

# True when a version satisfies an npm-style range ("^24 || >=26").
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

if have pnpm; then
  emit pnpm true "$(pnpm --version 2>/dev/null)" ""
else
  emit pnpm false "not installed" "install-pnpm"
fi

if have just; then
  emit just true "$(just --version)" ""
else
  emit just false "not installed" "brew-install-just"
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

if [[ -n "$repo" ]]; then
  emit repo true "$repo" ""
  if [[ -d "$repo/node_modules" ]]; then
    emit repo-bootstrap true "node_modules present" ""
  else
    emit repo-bootstrap false "dependencies not installed" "run-loops-setup"
  fi
else
  emit repo false "$repo_detail" "$repo_fix"
fi

exit $((failures > 0 ? 1 : 0))
