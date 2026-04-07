#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Dependency Installer
# Usage: ./install-dependencies.sh [--yes]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REQUIREMENTS_CODE="$REPO_ROOT/plugins/code/tools/python/requirements.txt"
REQUIREMENTS_SL="$REPO_ROOT/plugins/self-learning/tools/python/requirements.txt"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

AUTO_YES=false
if [[ "$1" == "--yes" || "$1" == "-y" ]]; then
    AUTO_YES=true
fi

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

confirm() {
    if $AUTO_YES; then
        return 0
    fi
    read -p "$1 [y/N] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Yy]$ ]]
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*) echo "macos" ;;
        Linux*)  echo "linux" ;;
        MINGW*|CYGWIN*|MSYS*) echo "windows" ;;
        *) echo "unknown" ;;
    esac
}

OS=$(detect_os)
log_info "Detected OS: $OS"

# Check Python version
check_python() {
    if command -v python3 &> /dev/null; then
        PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
        MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
        if [[ "$MAJOR" -ge 3 && "$MINOR" -ge 11 ]]; then
            log_info "Python $PYTHON_VERSION found (meets 3.11+ requirement)"
            return 0
        else
            log_warn "Python $PYTHON_VERSION found but 3.11+ required"
            return 1
        fi
    else
        log_error "Python 3 not found"
        return 1
    fi
}

# Install jq
install_jq() {
    if command -v jq &> /dev/null; then
        log_info "jq already installed"
        return 0
    fi

    log_warn "jq not found"
    if ! confirm "Install jq?"; then
        return 1
    fi

    case "$OS" in
        macos)
            if command -v brew &> /dev/null; then
                brew install jq
            else
                log_error "Homebrew not found. Please install jq manually."
                return 1
            fi
            ;;
        linux)
            if command -v apt-get &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y jq
            elif command -v yum &> /dev/null; then
                sudo yum install -y jq
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y jq
            else
                log_error "Package manager not found. Please install jq manually."
                return 1
            fi
            ;;
        *)
            log_error "Please install jq manually for your OS"
            return 1
            ;;
    esac
    log_info "jq installed successfully"
}

# Verify awk availability (portable parser path; GNU awk is optional)
check_awk() {
    if command -v awk &> /dev/null; then
        log_info "awk already installed"
        return 0
    fi

    log_warn "awk not found"
    if ! confirm "Install awk (via gawk package where applicable)?"; then
        return 1
    fi

    case "$OS" in
        macos)
            if command -v brew &> /dev/null; then
                brew install gawk
            else
                log_error "Homebrew not found. Please install awk manually."
                return 1
            fi
            ;;
        linux)
            if command -v apt-get &> /dev/null; then
                sudo apt-get update && sudo apt-get install -y gawk
            elif command -v yum &> /dev/null; then
                sudo yum install -y gawk
            elif command -v dnf &> /dev/null; then
                sudo dnf install -y gawk
            else
                log_error "Package manager not found. Please install awk manually."
                return 1
            fi
            ;;
        *)
            log_error "Please install awk manually for your OS"
            return 1
            ;;
    esac
    log_info "awk installed successfully"
}

# Find or create virtual environment (only called when needed)
# Returns path via stdout, logs to stderr to avoid pollution
find_or_create_venv() {
    # Look for existing venv in repo root with working pip
    local venv_candidates=(".venv" "venv" ".env" "env")
    for candidate in "${venv_candidates[@]}"; do
        local venv_path="$REPO_ROOT/$candidate"
        if [[ -x "$venv_path/bin/pip" ]]; then
            log_info "Found existing virtual environment: $venv_path" >&2
            echo "$venv_path"
            return 0
        elif [[ -f "$venv_path/bin/activate" ]]; then
            log_warn "Found venv at $venv_path but pip is missing" >&2
        fi
    done

    # No usable venv found - offer to create one
    local default_venv="$REPO_ROOT/.venv"
    log_warn "No usable virtual environment found" >&2
    if confirm "Create virtual environment at $default_venv?"; then
        # Remove broken venv if it exists
        if [[ -d "$default_venv" ]]; then
            log_info "Removing broken venv at $default_venv" >&2
            rm -rf "$default_venv"
        fi
        if python3 -m venv "$default_venv"; then
            log_info "Created virtual environment: $default_venv" >&2
            echo "$default_venv"
            return 0
        else
            log_error "Failed to create virtual environment" >&2
            return 1
        fi
    fi

    return 1
}

# Install Python dependencies
install_python_deps() {
    # Collect existing requirements files
    local req_files=()
    [[ -f "$REQUIREMENTS_CODE" ]] && req_files+=("$REQUIREMENTS_CODE")
    [[ -f "$REQUIREMENTS_SL" ]] && req_files+=("$REQUIREMENTS_SL")

    if [[ ${#req_files[@]} -eq 0 ]]; then
        log_warn "No requirements.txt found at $REQUIREMENTS_CODE or $REQUIREMENTS_SL"
        return 1
    fi

    log_info "Installing Python dependencies from ${req_files[*]}"
    if ! confirm "Install Python dependencies?"; then
        return 1
    fi

    # Build pip install args
    local pip_args=()
    for req in "${req_files[@]}"; do
        pip_args+=(-r "$req")
    done

    # Try normal install first
    local pip_output
    pip_output=$(python3 -m pip install "${pip_args[@]}" 2>&1)
    local pip_exit=$?

    if [[ $pip_exit -eq 0 ]]; then
        log_info "Python dependencies installed successfully"
        return 0
    fi

    # Check if it failed due to externally-managed environment (PEP 668)
    if echo "$pip_output" | grep -q "externally-managed-environment"; then
        log_warn "System Python is externally managed (PEP 668)"

        VENV_PATH=$(find_or_create_venv)
        local venv_exit=$?
        if [[ $venv_exit -ne 0 || -z "$VENV_PATH" ]]; then
            log_error "Cannot install: no virtual environment available"
            log_info "Create a venv manually: python3 -m venv $REPO_ROOT/.venv"
            return 1
        fi

        # Install using the venv's pip
        log_info "Installing into virtual environment: $VENV_PATH"
        if "$VENV_PATH/bin/pip" install "${pip_args[@]}"; then
            log_info "Python dependencies installed successfully"
            log_info "Activate the venv with: source $VENV_PATH/bin/activate"
            return 0
        else
            log_error "Failed to install Python dependencies"
            return 1
        fi
    else
        # Some other pip error
        echo "$pip_output"
        log_error "Failed to install Python dependencies"
        return 1
    fi
}

# Main
main() {
    log_info "ClosedLoop Self-Learning System - Dependency Installer"
    echo

    FAILED=0

    check_python || FAILED=1
    install_jq || FAILED=1
    check_awk || FAILED=1
    install_python_deps || FAILED=1

    echo
    if [[ $FAILED -eq 0 ]]; then
        log_info "All dependencies installed successfully!"
    else
        log_warn "Some dependencies could not be installed. Please install them manually."
        exit 1
    fi
}

main
