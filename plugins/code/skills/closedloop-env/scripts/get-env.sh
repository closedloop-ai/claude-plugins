#!/bin/bash
# Reads ClosedLoop config and outputs environment variables
# Usage: get-env.sh <CLOSEDLOOP_WORKDIR>

WORKDIR="${1:-.}"
CONFIG_FILE="$WORKDIR/.closedloop/config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Config file not found at $CONFIG_FILE" >&2
    exit 1
fi

# Source the config and output as structured data
source "$CONFIG_FILE"

cat << EOF
CLOSEDLOOP_WORKDIR=$CLOSEDLOOP_WORKDIR
CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT
CLOSEDLOOP_PRD_FILE=$CLOSEDLOOP_PRD_FILE
CLOSEDLOOP_PLAN_FILE=$CLOSEDLOOP_PLAN_FILE
CLOSEDLOOP_MAX_ITERATIONS=$CLOSEDLOOP_MAX_ITERATIONS
PLAN_SCHEMA_PATH=$CLAUDE_PLUGIN_ROOT/schemas/plan-schema.json
PLAN_FILE_PATH=$CLOSEDLOOP_WORKDIR/plan.json
EOF
