#!/usr/bin/env bash
# ClosedLoop Self-Learning System - Preflight Check
# Validates all required dependencies before system use
# Exit codes: 0 = all OK, 1 = missing required, 2 = missing optional

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

REQUIRED_FAILED=0
OPTIONAL_FAILED=0

check_required() {
    local name="$1"
    local check_cmd="$2"

    if eval "$check_cmd" &> /dev/null; then
        echo -e "${GREEN}[OK]${NC} $name"
        return 0
    else
        echo -e "${RED}[MISSING]${NC} $name (required)"
        REQUIRED_FAILED=1
        return 1
    fi
}

check_optional() {
    local name="$1"
    local check_cmd="$2"

    if eval "$check_cmd" &> /dev/null; then
        echo -e "${GREEN}[OK]${NC} $name"
        return 0
    else
        echo -e "${YELLOW}[MISSING]${NC} $name (optional)"
        OPTIONAL_FAILED=1
        return 1
    fi
}

echo "ClosedLoop Self-Learning System - Preflight Check"
echo "================================================"
echo

echo "Required Dependencies:"
echo "----------------------"

# Python 3.11+
check_required "Python 3.11+" 'python3 -c "import sys; exit(0 if sys.version_info >= (3, 11) else 1)"'

# jq
check_required "jq" 'command -v jq'

# awk
check_required "awk" 'command -v awk'

# git
check_required "git" 'command -v git'

# PyYAML
check_required "PyYAML" 'python3 -c "import yaml"'

echo
echo "Optional Dependencies:"
echo "----------------------"

# tree-sitter (for AST parsing)
check_optional "tree-sitter" 'python3 -c "import tree_sitter"'

# tree-sitter-python
check_optional "tree-sitter-python" 'python3 -c "import tree_sitter_python"'

echo
echo "================================================"

if [[ $REQUIRED_FAILED -eq 1 ]]; then
    echo -e "${RED}Preflight check FAILED${NC}"
    echo "Run: ./install-dependencies.sh to install missing dependencies"
    exit 1
elif [[ $OPTIONAL_FAILED -eq 1 ]]; then
    echo -e "${YELLOW}Preflight check PASSED with warnings${NC}"
    echo "Some optional features may be unavailable"
    exit 2
else
    echo -e "${GREEN}Preflight check PASSED${NC}"
    exit 0
fi
