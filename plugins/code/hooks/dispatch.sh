#!/usr/bin/env bash
# Shared library (sourced, not executed) for the code plugin's per-event hook
# scripts. hooks.json registers one command per event; that script reads stdin
# once and calls `dispatch_hooks [--parallel] "$INPUT" handler...`, which runs
# each handler script with the same input, one at a time in the order given
# (or all at once with --parallel, for handlers that share no state, as
# separate hooks.json commands ran), merges in handler order, and prints one
# result (code.claude.com/docs/en/hooks: on exit 0 stdout is read as JSON only
# when it is one object with nothing around it but whitespace).
#
# Merging the handlers that exit 0:
# - An empty object `{}` contributes nothing. When it is all there is, `{}` is printed.
# - A single contribution is printed byte for byte, so one handler firing looks
#   exactly as it did when it was its own hooks.json command.
# - Several JSON objects merge: hookSpecificOutput.permissionDecision takes the
#   highest of deny > defer > ask > allow (the order Claude Code applies across
#   PreToolUse hooks) with every reason given for it joined; a top-level
#   decision "block" wins over none with every reason joined; additionalContext
#   and systemMessage keep every value; any other field comes from the first
#   handler that set it.
# - Plain text (stdout that is not one JSON object) is printed as is when no
#   handler produced JSON, and moved to stderr otherwise, so the one JSON object
#   still parses. Claude Code reads plain stdout on these events into the debug
#   log only, as it reads stderr on exit 0.
#
# Failures keep each handler's own effect: a handler exiting 2 blocks, so the
# dispatcher prints that handler's stderr (the block reason) and exits 2. A
# handler exiting with any other nonzero code contributes nothing (its stdout
# was never parsed before either); the dispatcher exits with that code when no
# handler produced a decision, context, message or text, so the non-blocking
# error notice still appears. Otherwise every handler's stderr is passed
# through in handler order.

# shellcheck disable=SC2034
DISPATCH_MERGE_JQ='
def rank: {"deny": 4, "defer": 3, "ask": 2, "allow": 1}[.] // 0;
def joined($values; $separator): [$values[] | select(type == "string" and . != "")] | if length == 0 then null else join($separator) end;
. as $outs
| (reduce $outs[] as $out ({}; $out * .)) as $base
| ([$outs[] | .hookSpecificOutput.permissionDecision // empty] | max_by(rank)) as $decision
| (if $decision == null then $base
   else $base
     | .hookSpecificOutput.permissionDecision = $decision
     | (joined([$outs[] | select(.hookSpecificOutput.permissionDecision == $decision) | .hookSpecificOutput.permissionDecisionReason]; "\n")) as $reason
     | if $reason == null then del(.hookSpecificOutput.permissionDecisionReason) else .hookSpecificOutput.permissionDecisionReason = $reason end
   end)
| (joined([$outs[] | .hookSpecificOutput.additionalContext]; "\n\n")) as $context
| (if $context == null then . else .hookSpecificOutput.additionalContext = $context end)
| (if any($outs[]; .decision == "block") then
     .decision = "block"
     | (joined([$outs[] | select(.decision == "block") | .reason]; "\n\n")) as $reason
     | if $reason == null then del(.reason) else .reason = $reason end
   else . end)
| (joined([$outs[] | .systemMessage]; "\n\n")) as $message
| (if $message == null then . else .systemMessage = $message end)
'

dispatch_hooks() {
    local parallel=0
    if [[ "${1:-}" == "--parallel" ]]; then
        parallel=1
        shift
    fi
    local input="$1"
    shift
    local work
    work=$(mktemp -d "${TMPDIR:-/tmp}/closedloop-hook.XXXXXX") || return 0
    local count=0 handler
    for handler in "$@"; do
        count=$((count + 1))
        if [[ $parallel -eq 1 ]]; then
            _dispatch_run "$handler" "$input" "$work/$count" &
        else
            _dispatch_run "$handler" "$input" "$work/$count"
        fi
    done
    wait

    local index status output first_failure=0
    local json_files=() text_files=() blocking_errors=() all_errors=() meaningful=()
    for ((index = 1; index <= count; index++)); do
        read -r status < "$work/$index.status"
        all_errors+=("$work/$index.err")
        if [[ $status -eq 2 ]]; then
            blocking_errors+=("$work/$index.err")
            continue
        elif [[ $status -ne 0 ]]; then
            [[ $first_failure -ne 0 ]] || first_failure=$status
            continue
        fi
        output=""
        IFS= read -r -d '' output < "$work/$index.out" || true
        output="${output//[[:space:]]/}"
        if [[ -z "$output" ]]; then
            continue
        elif [[ "$output" == "{}" ]]; then
            json_files+=("$work/$index.out")
        elif jq -se 'length == 1 and (.[0] | type == "object")' "$work/$index.out" > /dev/null 2>&1; then
            json_files+=("$work/$index.out")
            meaningful+=("$work/$index.out")
        else
            text_files+=("$work/$index.out")
        fi
    done

    if [[ ${#blocking_errors[@]} -gt 0 ]]; then
        _dispatch_cat_to_stderr "${blocking_errors[@]}"
        rm -rf "$work"
        exit 2
    fi
    _dispatch_cat_to_stderr ${all_errors[@]+"${all_errors[@]}"}

    local file
    if [[ ${#meaningful[@]} -gt 0 ]]; then
        _dispatch_cat_to_stderr ${text_files[@]+"${text_files[@]}"}
        if [[ ${#meaningful[@]} -eq 1 ]]; then
            cat "${meaningful[0]}"
        else
            jq -cs "$DISPATCH_MERGE_JQ" "${meaningful[@]}"
        fi
    elif [[ ${#text_files[@]} -gt 0 ]]; then
        for file in "${text_files[@]}"; do cat "$file"; done
    elif [[ $first_failure -ne 0 ]]; then
        rm -rf "$work"
        exit "$first_failure"
    elif [[ ${#json_files[@]} -gt 0 ]]; then
        cat "${json_files[0]}"
    fi
    rm -rf "$work"
    exit 0
}

_dispatch_run() {
    local status=0
    printf '%s' "$2" | "$1" > "$3.out" 2> "$3.err" || status=$?
    printf '%s' "$status" > "$3.status"
}

_dispatch_cat_to_stderr() {
    local file
    for file in "$@"; do
        if [[ -s "$file" ]]; then cat "$file" >&2; fi
    done
}
