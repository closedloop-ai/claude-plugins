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

# ── Constants ────────────────────────────────────────────────────────────────
MARKETPLACE_SOURCE="closedloop-ai/claude-plugins"
MARKETPLACE_NAME="closedloop-ai"
PLUGINS=(bootstrap code code-review judges platform self-learning)

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
    PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
    if [[ "$PY_MAJOR" -ge 3 && "$PY_MINOR" -ge 11 ]]; then
        info "Python $PY_VERSION"
    else
        warn "Python $PY_VERSION found — 3.11+ recommended for full functionality"
    fi
else
    warn "Python 3 not found — some plugin features may not work"
fi

# jq
if command -v jq &>/dev/null; then
    info "jq found"
else
    warn "jq not found — some plugin features require it"
    echo "    Install: brew install jq (macOS) / apt install jq (Linux)"
fi

echo

# ── Add marketplace ─────────────────────────────────────────────────────────
step "Registering closedloop-ai marketplace..."

if claude plugin marketplace add "$MARKETPLACE_SOURCE" 2>/dev/null; then
    info "Marketplace registered: $MARKETPLACE_SOURCE"
else
    # May already be registered — not a fatal error
    warn "Marketplace may already be registered (continuing)"
fi

echo

# ── Install plugins ─────────────────────────────────────────────────────────
step "Installing plugins (user scope)..."

INSTALLED=0
FAILED=0

for plugin in "${PLUGINS[@]}"; do
    PLUGIN_REF="${plugin}@${MARKETPLACE_NAME}"
    if claude plugin install "$PLUGIN_REF" --scope user 2>/dev/null; then
        info "Installed: $plugin"
        ((INSTALLED++))
    else
        # May already be installed — try to update instead
        if claude plugin update "$PLUGIN_REF" --scope user 2>/dev/null; then
            info "Updated: $plugin"
            ((INSTALLED++))
        else
            warn "Could not install/update: $plugin"
            ((FAILED++))
        fi
    fi
done

echo

# ── Summary ──────────────────────────────────────────────────────────────────
echo "────────────────────────────────────"
if [[ $FAILED -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All $INSTALLED plugins installed successfully!${NC}"
else
    echo -e "${YELLOW}${BOLD}$INSTALLED installed, $FAILED failed${NC}"
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
