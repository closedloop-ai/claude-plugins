#!/usr/bin/env bash
# The code plugin's only PreToolUse hook: hooks.json registers one command per
# event. Routes each tool call to its handlers, which dispatch.sh runs and merges.
# A new PreToolUse handler is added here, never as another hooks.json command.

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./dispatch.sh
source "$HOOKS_DIR/dispatch.sh"

INPUT=""
IFS= read -r -d '' INPUT || true
TOOL_NAME=$(jq -r '.tool_name // empty' <<< "$INPUT" 2> /dev/null || true)

# Security policy, workspace auto-allow and tool learnings apply to these tools
# only (the matcher it was registered with); the tool-call sentinel applies to every tool.
HANDLERS=()
case "$TOOL_NAME" in
    Read|Bash|Write|Edit) HANDLERS+=("$HOOKS_DIR/pretooluse-hook.sh") ;;
esac
HANDLERS+=("$HOOKS_DIR/pre-tool-use-hook.sh")

dispatch_hooks --parallel "$INPUT" "${HANDLERS[@]}"
