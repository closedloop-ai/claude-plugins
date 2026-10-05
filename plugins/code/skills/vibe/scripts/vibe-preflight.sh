#!/usr/bin/env bash
# Check every prerequisite for a vibe session and print one JSON object per
# line: {"check":..., "ok":true|false, "detail":..., "fix":...}. It changes
# nothing; the skill reads the failures and runs the fixes in
# references/preflight.md. Exit code is 0 when every check passes, 1 otherwise.
#
# Usage: vibe-preflight.sh [--repo <path to symphony-alpha checkout>]

set -uo pipefail

REPO=""
if [[ "${1:-}" == "--repo" ]]; then
  REPO="${2:-}"
fi

failures=0

emit() {
  local check="$1" ok="$2" detail="$3" fix="$4"
  detail="${detail//\\/\\\\}"; detail="${detail//\"/\\\"}"; detail="${detail//$'\n'/ }"
  fix="${fix//\\/\\\\}"; fix="${fix//\"/\\\"}"
  printf '{"check":"%s","ok":%s,"detail":"%s","fix":"%s"}\n' "$check" "$ok" "$detail" "$fix"
  if [[ "$ok" != "true" ]]; then
    failures=$((failures + 1))
  fi
}

have() {
  command -v "$1" >/dev/null 2>&1
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

if have node; then
  node_version="$(node --version)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [[ "$node_major" == "24" || "$node_major" -ge 26 ]]; then
    emit node true "$node_version" ""
  else
    emit node false "$node_version is outside ^24 || >=26" "install-node"
  fi
else
  emit node false "not installed" "install-node"
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

if have docker || [[ -d /Applications/Docker.app ]]; then
  if docker info >/dev/null 2>&1; then
    emit docker true "engine running" ""
  else
    emit docker false "installed, engine not running" "start-docker"
  fi
else
  emit docker false "not installed" "install-docker"
fi

if [[ -z "$REPO" ]]; then
  for candidate in "$HOME/Source/symphony-alpha" "$HOME/src/symphony-alpha" "$HOME/code/symphony-alpha" "$HOME/symphony-alpha"; do
    if [[ -d "$candidate/.git" ]]; then
      REPO="$candidate"
      break
    fi
  done
fi

if [[ -n "$REPO" && -d "$REPO/.git" ]]; then
  remote="$(git -C "$REPO" remote get-url origin 2>/dev/null)"
  if [[ "$remote" == *"closedloop-ai/symphony-alpha"* ]]; then
    emit repo true "$REPO" ""
    if [[ -d "$REPO/node_modules" ]]; then
      emit repo-bootstrap true "node_modules present" ""
    else
      emit repo-bootstrap false "dependencies not installed" "run-loops-setup"
    fi
  else
    emit repo false "$REPO has origin $remote" "ask-for-repo-path"
  fi
else
  emit repo false "no symphony-alpha checkout found" "clone-repo"
fi

exit $((failures > 0 ? 1 : 0))
