#!/usr/bin/env bash
# The code plugin's only SubagentStop hook: hooks.json registers one command per
# event. dispatch.sh runs the handlers in order and merges their results. A new
# SubagentStop handler is added here, never as another hooks.json command.
#
# loop-stop-hook.sh runs first: it reads the .agent-types/<agent_id> record that
# subagent-stop-hook.sh deletes when it finishes.

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./dispatch.sh
source "$HOOKS_DIR/dispatch.sh"

INPUT=""
IFS= read -r -d '' INPUT || true
dispatch_hooks "$INPUT" "$HOOKS_DIR/loop-stop-hook.sh" "$HOOKS_DIR/subagent-stop-hook.sh"
