#!/usr/bin/env bash
# ClosedLoop Claude Plugins - One-Line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh | bash
#
# What this does:
#   1. Checks prerequisites (Claude Code CLI, Python 3.11+, jq)
#   2. Registers the closedloop-ai plugin marketplace
#   3. Installs all 6 plugins globally (user scope)
#   4. Auto-update is enabled by default — plugins stay current automatically
#
# NOTE: The BASH_VERSION check below can be bypassed by setting the BASH_VERSION
# env var before invoking under sh/dash (e.g. BASH_VERSION=x sh install.sh).
# This is a known limitation: the guard is a best-effort hint, not a security boundary.
if [ -z "${BASH_VERSION:-}" ]; then
  printf 'Error: This script requires bash. Run: bash install.sh\n  or: curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh | bash\n' >&2
  exit 1
fi
if [[ "${BASH_VERSINFO[0]:-0}" -lt 3 || ("${BASH_VERSINFO[0]:-0}" -eq 3 && "${BASH_VERSINFO[1]:-0}" -lt 2) ]]; then
  printf 'Error: Bash 3.2+ required (found %s)\n' "$BASH_VERSION" >&2
  exit 1
fi
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }
step()  { echo -e "${BLUE}[→]${NC} ${BOLD}$1${NC}"; }
snapshot_version() { grep -m1 "^$2 " "$1" 2>/dev/null | awk '{print $2}' || true; }
sanitize_stderr()  {
    # Strip ANSI color escapes, then drop non-printable control chars.
    # Uses bash ANSI-C quoting for a literal ESC so this works under BSD sed (macOS)
    # as well as GNU sed. `tr` with octal ranges is POSIX-portable across both.
    local esc=$'\033'
    sed "s/${esc}\[[0-9;]*[a-zA-Z]//g" "$1" | tr -d '\000-\010\013-\037\177' >&2
}

# ── Constants ────────────────────────────────────────────────────────────────
MARKETPLACE_SOURCE="closedloop-ai/claude-plugins"
MARKETPLACE_NAME="closedloop-ai"
PLUGINS=(bootstrap code code-review judges platform self-learning)

# ── Per-run working directory ────────────────────────────────────────────────
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/closedloop-install.XXXXXX")
chmod 700 "$WORK_DIR"
_cleanup() { rm -rf "$WORK_DIR"; }
trap _cleanup EXIT

# ── Preflight checks ────────────────────────────────────────────────────────
echo
echo -e "${BOLD}ClosedLoop Claude Plugins Installer${NC}"
echo "────────────────────────────────────"
echo

step "Checking prerequisites..."

# Claude Code CLI
if ! command -v claude &>/dev/null; then
    err "Claude Code CLI not found."
    echo "    Install it first: https://claude.ai/code"
    exit 1
fi
info "Claude Code CLI found: $(claude --version 2>/dev/null || echo 'unknown version')"

# Python 3.11+
if command -v python3 &>/dev/null; then
    PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
    PY_MAJOR="${PY_VERSION%%.*}"
    PY_MINOR="${PY_VERSION##*.}"
    if [[ "$PY_MAJOR" -gt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -ge 11 ) ]]; then
        info "Python $PY_VERSION"
    else
        warn "Python $PY_VERSION found — 3.11+ recommended for full functionality"
    fi
else
    warn "Python 3 not found — some plugin features may not work"
fi

# jq
if ! command -v jq &>/dev/null; then
    err "jq is required but not found."
    echo "    Install: brew install jq  (macOS)"
    echo "    Install: apt install jq   (Debian/Ubuntu)"
    exit 1
else
    info "jq found"
fi

echo

# ── Add marketplace ─────────────────────────────────────────────────────────
step "Registering closedloop-ai marketplace..."

_MARKETPLACE_LIST=$(claude plugin marketplace list --json 2>/dev/null)
if [[ -n "$_MARKETPLACE_LIST" ]] \
   && echo "$_MARKETPLACE_LIST" | jq -e --arg name "$MARKETPLACE_NAME" 'any(.name == $name)' &>/dev/null; then
    info "Marketplace already registered: $MARKETPLACE_NAME"
else
    [[ -z "$_MARKETPLACE_LIST" ]] && warn "Could not query marketplace list — attempting add anyway"
    if claude plugin marketplace add "$MARKETPLACE_SOURCE" 2>"$WORK_DIR/marketplace_err"; then
        info "Marketplace registered: $MARKETPLACE_SOURCE"
    else
        warn "Marketplace add failed:"
        sanitize_stderr "$WORK_DIR/marketplace_err"
    fi
fi

echo

# ── Install plugins ─────────────────────────────────────────────────────────
step "Installing plugins (user scope)..."

INSTALLED=0
UPDATED=0
UP_TO_DATE=0
FAILED=0

SNAPSHOT_PRE="$WORK_DIR/snapshot_pre"
SNAPSHOT_POST="$WORK_DIR/snapshot_post"
STDERR_FILE="$WORK_DIR/install_err"

claude plugin list --json 2>/dev/null \
  | jq -r '.[] | .id + " " + .version' > "$SNAPSHOT_PRE" 2>/dev/null || true
[[ -s "$SNAPSHOT_PRE" ]] || warn "Could not snapshot installed plugins — state detection will be approximate"

SUCCESSFUL_PLUGINS=()

for plugin in "${PLUGINS[@]}"; do
    plugin_ref="${plugin}@${MARKETPLACE_NAME}"
    if claude plugin install "$plugin_ref" --scope user 2>"$STDERR_FILE"; then
        SUCCESSFUL_PLUGINS+=("$plugin_ref")
    # Install failed — may already exist; try update instead
    elif claude plugin update "$plugin_ref" --scope user 2>"$STDERR_FILE"; then
        SUCCESSFUL_PLUGINS+=("$plugin_ref")
    else
        [[ -s "$STDERR_FILE" ]] && sanitize_stderr "$STDERR_FILE"
        warn "Could not install/update: $plugin"
        FAILED=$((FAILED + 1))
    fi
done

claude plugin list --json 2>/dev/null \
  | jq -r '.[] | .id + " " + .version' > "$SNAPSHOT_POST" 2>/dev/null || true

for plugin_ref in "${SUCCESSFUL_PLUGINS[@]+"${SUCCESSFUL_PLUGINS[@]}"}"; do
    plugin="${plugin_ref%@*}"
    pre_ver=$(snapshot_version "$SNAPSHOT_PRE" "$plugin_ref")
    post_ver=$(snapshot_version "$SNAPSHOT_POST" "$plugin_ref")
    if [[ -z "$pre_ver" || -z "$post_ver" ]]; then
        INSTALLED=$((INSTALLED + 1))
        info "Installed: $plugin"
    elif [[ "$pre_ver" == "$post_ver" ]]; then
        UP_TO_DATE=$((UP_TO_DATE + 1))
        info "Already up to date: $plugin"
    else
        UPDATED=$((UPDATED + 1))
        info "Updated: $plugin ($pre_ver -> $post_ver)"
    fi
done

echo

# ── Summary ──────────────────────────────────────────────────────────────────
TOTAL=$((INSTALLED + UPDATED + UP_TO_DATE + FAILED))
echo "────────────────────────────────────"
if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $TOTAL plugins ready ($INSTALLED installed, $UPDATED updated, $UP_TO_DATE already up to date).${NC}"
else
    echo -e "${YELLOW}${BOLD}$TOTAL plugins processed: $INSTALLED installed, $UPDATED updated, $UP_TO_DATE already up to date, $FAILED failed.${NC}"
fi

echo
echo "Plugins will auto-update when new versions are released."
echo
echo -e "${BOLD}Next steps:${NC}"
echo "  • Start a new Claude Code session to activate plugins"
echo "  • Run: claude /bootstrap:start     — to bootstrap a project"
echo "  • Run: claude /code:code           — to start a coding session"
echo "  • Run: claude /code-review:start   — to review code"
echo
