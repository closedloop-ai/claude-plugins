#!/usr/bin/env bash
# ClosedLoop Claude Plugins - One-Line Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/closedloop-ai/claude-plugins/main/install.sh | bash
#
# What this does:
#   1. Checks prerequisites (Claude Code CLI, Python 3.11+, jq)
#   2. Registers the closedloop-ai plugin marketplace
#   3. Installs the 5 Symphony runtime plugins at user scope
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
snapshot_enabled() { grep -m1 "^$2 " "$1" 2>/dev/null | awk '{print $3}' || true; }
snapshot_plugins() {
    local destination="$1"
    if ! claude plugin list --json 2>/dev/null \
      | jq -r '.[] | .id + " " + (.version // "unknown") + " " + (if .enabled == true then "enabled" elif .enabled == false then "disabled" else "unknown" end)' \
      > "$destination" 2>/dev/null; then
        return 1
    fi
    [[ -s "$destination" ]]
}
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
PLUGINS=(code code-review judges platform self-learning)
# Symphony runtime readiness requires the plugins used by loop execution and
# review. Bootstrap is available in the marketplace for manual installation but
# is intentionally not installed or verified by this installer.
REQUIRED_PLUGINS=(code code-review judges platform self-learning)

is_required_plugin_ref() {
    local candidate="$1"
    local plugin
    for plugin in "${REQUIRED_PLUGINS[@]}"; do
        if [[ "$candidate" == "${plugin}@${MARKETPLACE_NAME}" ]]; then
            return 0
        fi
    done
    return 1
}

# ── Per-run working directory ────────────────────────────────────────────────
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/closedloop-install.XXXXXX")
chmod 700 "$WORK_DIR"
_cleanup() { rm -rf "$WORK_DIR"; }
trap _cleanup EXIT

read_plugin_list() {
    local output_file="$1"
    claude plugin list --json > "$output_file" 2>/dev/null \
      && jq -e 'type == "array"' "$output_file" >/dev/null 2>&1
}

plugin_enabled_state() {
    local list_file="$1"
    local plugin_ref="$2"
    jq -r --arg key "$plugin_ref" '
      [ .[] | select(.id == $key and .scope == "user") ] as $matches
      | if ($matches | length) == 0 then "missing"
        elif any($matches[]; .enabled == false) then "disabled"
        else "enabled"
        end
    ' "$list_file"
}

repair_project_scoped_plugins() {
    local plugin_ref="$1"
    local list_file="$2"
    local project_path

    while IFS= read -r project_path; do
        if [[ -n "$project_path" && -d "$project_path" ]]; then
            if (cd "$project_path" && claude plugin uninstall "$plugin_ref" --scope project); then
                info "Removed project-scoped duplicate: $plugin_ref ($project_path)"
            else
                warn "Could not remove project-scoped duplicate: $plugin_ref ($project_path)"
            fi
        else
            warn "Project-scoped duplicate found for $plugin_ref without a usable projectPath."
            warn "From that project directory, run: claude plugin uninstall \"$plugin_ref\" --scope project"
        fi
    done < <(jq -r --arg key "$plugin_ref" '.[] | select(.id == $key and .scope == "project") | (.projectPath // "")' "$list_file" 2>/dev/null || true)
}

ensure_user_plugin_enabled() {
    local plugin_ref="$1"
    local plugin_name="${plugin_ref%@*}"
    local list_file="$WORK_DIR/list_${plugin_name}.json"
    local state

    if ! read_plugin_list "$list_file"; then
        warn "Could not verify enabled state for: $plugin_ref"
        return 1
    fi

    state="$(plugin_enabled_state "$list_file" "$plugin_ref")" || return 1
    case "$state" in
        enabled)
            return 0
            ;;
        disabled)
            if ! claude plugin enable "$plugin_ref" --scope user; then
                warn "Could not enable user-scoped plugin: $plugin_ref"
                return 1
            fi
            if ! read_plugin_list "$list_file"; then
                warn "Could not re-read plugin state after enable: $plugin_ref"
                return 1
            fi
            state="$(plugin_enabled_state "$list_file" "$plugin_ref")" || return 1
            if [[ "$state" == "enabled" ]]; then
                info "Enabled: $plugin_name"
                return 0
            fi
            warn "Plugin remains disabled after enable: $plugin_ref"
            return 1
            ;;
        *)
            warn "User-scoped plugin missing from Claude plugin list: $plugin_ref"
            return 1
            ;;
    esac
}

registry_has_user_install() {
    local plugin_ref="$1"
    local registry="$HOME/.claude/plugins/installed_plugins.json"
    local install_path

    while IFS= read -r install_path; do
        if [[ -n "$install_path" && -e "$install_path" ]]; then
            return 0
        fi
    done < <(jq -r --arg key "$plugin_ref" '.plugins[$key][]? | select(.scope == "user") | .installPath // empty' "$registry" 2>/dev/null || true)
    return 1
}

print_scope_repair_remediation() {
    cat >&2 <<'REPAIR'
Repair ClosedLoop plugins at user scope:
for p in code code-review judges platform self-learning; do
  claude plugin uninstall "$p@closedloop-ai" --scope project
  claude plugin install "$p@closedloop-ai" --scope user
  claude plugin enable "$p@closedloop-ai" --scope user
done
claude plugin list --json
REPAIR
}

FAILED_PLUGINS=()
mark_plugin_failed() {
    local plugin_ref="$1"
    plugin_failed "$plugin_ref" && return 0
    FAILED_PLUGINS+=("$plugin_ref")
    FAILED=${#FAILED_PLUGINS[@]}
    if is_required_plugin_ref "$plugin_ref"; then
        REQUIRED_FAILED=$((REQUIRED_FAILED + 1))
    fi
}

plugin_failed() {
    local plugin_ref="$1"
    local existing
    for existing in "${FAILED_PLUGINS[@]+"${FAILED_PLUGINS[@]}"}"; do
        [[ "$existing" == "$plugin_ref" ]] && return 0
    done
    return 1
}

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

step "Refreshing closedloop-ai marketplace..."
if claude plugin marketplace update "$MARKETPLACE_NAME" 2>"$WORK_DIR/marketplace_update_err"; then
    info "Marketplace refreshed: $MARKETPLACE_NAME"
else
    err "Marketplace refresh failed:"
    sanitize_stderr "$WORK_DIR/marketplace_update_err"
    exit 1
fi

echo

# ── Install plugins ─────────────────────────────────────────────────────────
step "Installing plugins (user scope)..."

INSTALLED=0
UPDATED=0
UP_TO_DATE=0
FAILED=0
REQUIRED_FAILED=0

SNAPSHOT_PRE="$WORK_DIR/snapshot_pre"
SNAPSHOT_POST="$WORK_DIR/snapshot_post"
SNAPSHOT_READY="$WORK_DIR/snapshot_ready"
STDERR_FILE="$WORK_DIR/install_err"
ENABLE_ERR_FILE="$WORK_DIR/enable_err"

snapshot_plugins "$SNAPSHOT_PRE" || true
[[ -s "$SNAPSHOT_PRE" ]] || warn "Could not snapshot installed plugins — state detection will be approximate"

SUCCESSFUL_PLUGINS=()

for plugin in "${PLUGINS[@]}"; do
    plugin_ref="${plugin}@${MARKETPLACE_NAME}"
    LIST_BEFORE="$WORK_DIR/list_before_${plugin}.json"
    if read_plugin_list "$LIST_BEFORE"; then
        repair_project_scoped_plugins "$plugin_ref" "$LIST_BEFORE"
    else
        warn "Could not inspect project-scoped entries before install: $plugin_ref"
    fi

    if claude plugin install "$plugin_ref" --scope user 2>"$STDERR_FILE"; then
        if ensure_user_plugin_enabled "$plugin_ref"; then
            SUCCESSFUL_PLUGINS+=("$plugin_ref")
        else
            mark_plugin_failed "$plugin_ref"
        fi
    # Install failed — may already exist; try update instead
    elif claude plugin update "$plugin_ref" --scope user 2>"$STDERR_FILE"; then
        if ensure_user_plugin_enabled "$plugin_ref"; then
            SUCCESSFUL_PLUGINS+=("$plugin_ref")
        else
            mark_plugin_failed "$plugin_ref"
        fi
    else
        [[ -s "$STDERR_FILE" ]] && sanitize_stderr "$STDERR_FILE"
        warn "Could not install/update: $plugin"
        mark_plugin_failed "$plugin_ref"
    fi
done

snapshot_plugins "$SNAPSHOT_POST" || true

ENABLED=0

FINAL_LIST="$WORK_DIR/list_final.json"
FINAL_LIST_AVAILABLE=1
if ! read_plugin_list "$FINAL_LIST"; then
    warn "Could not read final Claude plugin list for enabled-state verification"
    FINAL_LIST_AVAILABLE=0
fi

for plugin in "${REQUIRED_PLUGINS[@]}"; do
    plugin_ref="${plugin}@${MARKETPLACE_NAME}"
    if ! registry_has_user_install "$plugin_ref"; then
        warn "Missing user-scoped registry entry with existing installPath: $plugin_ref"
        mark_plugin_failed "$plugin_ref"
        continue
    fi
    if [[ "$FINAL_LIST_AVAILABLE" -eq 0 ]]; then
        warn "Could not verify final enabled state for required plugin: $plugin_ref"
        mark_plugin_failed "$plugin_ref"
        continue
    fi
    if [[ "$(plugin_enabled_state "$FINAL_LIST" "$plugin_ref" 2>/dev/null || echo missing)" != "enabled" ]]; then
        warn "Missing enabled user-scoped list entry: $plugin_ref"
        mark_plugin_failed "$plugin_ref"
    fi
done

for plugin_ref in "${SUCCESSFUL_PLUGINS[@]+"${SUCCESSFUL_PLUGINS[@]}"}"; do
    if plugin_failed "$plugin_ref"; then
        continue
    fi
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

    post_enabled=$(snapshot_enabled "$SNAPSHOT_POST" "$plugin_ref")
    if [[ "$post_enabled" != "enabled" ]]; then
        if claude plugin enable "$plugin_ref" --scope user 2>"$ENABLE_ERR_FILE"; then
            ENABLED=$((ENABLED + 1))
            info "Enabled: $plugin"
        else
            [[ -s "$ENABLE_ERR_FILE" ]] && sanitize_stderr "$ENABLE_ERR_FILE"
            warn "Could not enable: $plugin"
        fi
    fi
done

snapshot_plugins "$SNAPSHOT_READY" || true
READINESS_FAILED=0
for plugin in "${REQUIRED_PLUGINS[@]}"; do
    plugin_ref="${plugin}@${MARKETPLACE_NAME}"
    ready_state=$(snapshot_enabled "$SNAPSHOT_READY" "$plugin_ref")
    if [[ "$ready_state" != "enabled" ]]; then
        err "Required plugin is not enabled: $plugin_ref"
        READINESS_FAILED=$((READINESS_FAILED + 1))
    fi
done

echo

# ── Summary ──────────────────────────────────────────────────────────────────
TOTAL=$((INSTALLED + UPDATED + UP_TO_DATE + FAILED))
echo "────────────────────────────────────"
if [[ $REQUIRED_FAILED -eq 0 && $READINESS_FAILED -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}Required plugins ready ($TOTAL plugins processed: $INSTALLED installed, $UPDATED updated, $UP_TO_DATE already up to date, $FAILED install/update failed, $ENABLED enabled).${NC}"
else
    echo -e "${YELLOW}${BOLD}$TOTAL plugins processed: $INSTALLED installed, $UPDATED updated, $UP_TO_DATE already up to date, $FAILED install/update failed, $READINESS_FAILED readiness failed.${NC}"
    print_scope_repair_remediation
    exit 1
fi

echo
echo "Plugins will auto-update when new versions are released."
echo
echo -e "${BOLD}Next steps:${NC}"
echo "  • Start a new Claude Code session to activate plugins"
echo "  • Run: claude /code:code           — to start a coding session"
echo "  • Run: claude /code-review:start   — to review code"
echo
