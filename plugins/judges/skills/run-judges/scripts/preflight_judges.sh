#!/usr/bin/env bash
# Deterministic preflight checks for judge execution.
# Checks file existence and manifest validity,
# and emits a structured JSON report with actions the LLM must execute.
#
# Usage: preflight_judges.sh <artifact-type> <workdir>
#   artifact-type: plan | code
#   workdir:       $CLOSEDLOOP_WORKDIR (absolute path)
#
# Output: writes <workdir>/.closedloop/preflight-report.json
# Exit 0 on success (even for skip/needs_action), exit 1 on usage error.

set -euo pipefail

ARTIFACT_TYPE="${1:?Usage: preflight_judges.sh <artifact-type> <workdir>}"
WORKDIR="${2:?Usage: preflight_judges.sh <artifact-type> <workdir>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MANIFEST_PATH="${PLUGIN_ROOT}/agents/judge-manifest.json"
REPORT_DIR="$WORKDIR/.closedloop"
REPORT_PATH="$REPORT_DIR/preflight-report.json"

mkdir -p "$REPORT_DIR"

# --- validate artifact type ---
if [[ "$ARTIFACT_TYPE" != "plan" && "$ARTIFACT_TYPE" != "code" ]]; then
  jq -n --arg at "$ARTIFACT_TYPE" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: ("Invalid artifact type: " + $at + ". Must be plan or code.")
  }' > "$REPORT_PATH"
  exit 0
fi

# --- file existence probes ---
has_prd=false;            [ -f "$WORKDIR/prd.md" ]             && has_prd=true
has_plan=false;           [ -f "$WORKDIR/plan.json" ]          && has_plan=true
has_inv_log=false;        [ -f "$WORKDIR/investigation-log.md" ] && has_inv_log=true
has_plan_ctx=false;       [ -f "$WORKDIR/plan-context.json" ]  && has_plan_ctx=true
has_code_ctx=false;       [ -f "$WORKDIR/code-context.json" ]  && has_code_ctx=true

# --- manifest validation ---
if [ ! -f "$MANIFEST_PATH" ]; then
  jq -n --arg at "$ARTIFACT_TYPE" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: "judge-manifest.json not found"
  }' > "$REPORT_PATH"
  exit 0
fi

manifest_category=$(jq -e ".categories[\"$ARTIFACT_TYPE\"]" "$MANIFEST_PATH" 2>/dev/null) || {
  jq -n --arg at "$ARTIFACT_TYPE" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: ("Category \"" + $at + "\" not found in judge-manifest.json")
  }' > "$REPORT_PATH"
  exit 0
}

manifest_judges=$(echo "$manifest_category" | jq -c '.judges')
manifest_output_file=$(echo "$manifest_category" | jq -r '.output_file')
manifest_suffix=$(echo "$manifest_category" | jq -r '.report_id_suffix')
judge_count=$(echo "$manifest_judges" | jq 'length')

if [ "$judge_count" -lt 1 ] || [ "$judge_count" -gt 4 ]; then
  jq -n --arg at "$ARTIFACT_TYPE" --argjson c "$judge_count" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: ("Manifest judges array has " + ($c|tostring) + " entries; expected 1-4")
  }' > "$REPORT_PATH"
  exit 0
fi

dup_count=$(echo "$manifest_judges" | jq '[.[] | if type=="string" then ascii_downcase else error("non-string judge") end] | group_by(.) | map(select(length>1)) | length') || {
  jq -n --arg at "$ARTIFACT_TYPE" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: "Manifest judges array contains non-string elements"
  }' > "$REPORT_PATH"
  exit 0
}
if [ "$dup_count" -gt 0 ]; then
  jq -n --arg at "$ARTIFACT_TYPE" '{
    status: "error",
    artifact_type: $at,
    eval_cache: {status:"n/a"},
    files: {},
    actions: [],
    manifest: null,
    skip_reason: null,
    error: "Manifest judges array contains duplicates"
  }' > "$REPORT_PATH"
  exit 0
fi

# --- plan-mode skip check ---
if [[ "$ARTIFACT_TYPE" == "plan" ]]; then
  if [[ "$has_prd" == "false" ]]; then
    jq -n \
      --argjson judges "$manifest_judges" \
      --arg of "$manifest_output_file" \
      --arg suf "$manifest_suffix" \
      --argjson f_prd "$has_prd" \
      --argjson f_plan "$has_plan" \
      --argjson f_inv "$has_inv_log" \
      --argjson f_pctx "$has_plan_ctx" \
      --argjson f_cctx "$has_code_ctx" '{
      status: "skip",
      artifact_type: "plan",
      eval_cache: {status:"n/a"},
      files: {prd_md:$f_prd, plan_json:$f_plan, investigation_log:$f_inv, plan_context:$f_pctx, code_context:$f_cctx},
      actions: [],
      manifest: {judges:$judges, output_file:$of, report_id_suffix:$suf},
      skip_reason: "prd.md not found",
      error: null
    }' > "$REPORT_PATH"
    exit 0
  fi
  if [[ "$has_plan" == "false" ]]; then
    jq -n \
      --argjson judges "$manifest_judges" \
      --arg of "$manifest_output_file" \
      --arg suf "$manifest_suffix" \
      --argjson f_prd "$has_prd" \
      --argjson f_plan "$has_plan" \
      --argjson f_inv "$has_inv_log" \
      --argjson f_pctx "$has_plan_ctx" \
      --argjson f_cctx "$has_code_ctx" '{
      status: "skip",
      artifact_type: "plan",
      eval_cache: {status:"n/a"},
      files: {prd_md:$f_prd, plan_json:$f_plan, investigation_log:$f_inv, plan_context:$f_pctx, code_context:$f_cctx},
      actions: [],
      manifest: {judges:$judges, output_file:$of, report_id_suffix:$suf},
      skip_reason: "plan.json not found",
      error: null
    }' > "$REPORT_PATH"
    exit 0
  fi
fi

# --- build actions list ---
actions="[]"

if [[ "$has_inv_log" == "false" ]]; then
  actions=$(echo "$actions" | jq --arg at "$ARTIFACT_TYPE" \
    '. + [{"action":"resolve_investigation_log","reason":"investigation-log.md not found"}]')
fi

has_ctx=false
[[ "$ARTIFACT_TYPE" == "plan" && "$has_plan_ctx" == "true" ]] && has_ctx=true
[[ "$ARTIFACT_TYPE" == "code" && "$has_code_ctx" == "true" ]] && has_ctx=true

if [[ "$has_ctx" == "false" ]]; then
  actions=$(echo "$actions" | jq --arg at "$ARTIFACT_TYPE" \
    '. + [{"action":"launch_context_manager","artifact_type":$at}]')
fi

# --- determine overall status ---
status="ready"
if [ "$(echo "$actions" | jq 'length')" -gt 0 ]; then
  status="needs_action"
fi

# --- emit report ---
jq -n \
  --arg status "$status" \
  --arg at "$ARTIFACT_TYPE" \
  --argjson f_prd "$has_prd" \
  --argjson f_plan "$has_plan" \
  --argjson f_inv "$has_inv_log" \
  --argjson f_pctx "$has_plan_ctx" \
  --argjson f_cctx "$has_code_ctx" \
  --argjson actions "$actions" \
  --argjson judges "$manifest_judges" \
  --arg of "$manifest_output_file" \
  --arg suf "$manifest_suffix" \
  '{
    status: $status,
    artifact_type: $at,
    eval_cache: {
      status: "n/a"
    },
    files: {
      prd_md: $f_prd,
      plan_json: $f_plan,
      investigation_log: $f_inv,
      plan_context: $f_pctx,
      code_context: $f_cctx
    },
    actions: $actions,
    manifest: {
      judges: $judges,
      output_file: $of,
      report_id_suffix: $suf
    },
    skip_reason: null,
    error: null
  }' > "$REPORT_PATH"
