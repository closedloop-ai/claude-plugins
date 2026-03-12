#!/usr/bin/env python3
"""
ClosedLoop Stream Formatter

Reads Claude stream-json lines from stdin and prints human-readable text
to stdout. Designed for use in a pipeline:

  claude --output-format stream-json -p "..." \
    | grep --line-buffered '^{' \
    | tee output.jsonl \
    | tee -a claude-output.jsonl \
    | python3 stream_formatter.py
"""

import json
import sys

# ANSI colors
DIM = "\033[2m"
RESET = "\033[0m"
BOLD = "\033[1m"
CYAN = "\033[36m"
GREEN = "\033[32m"
RED = "\033[31m"
MAGENTA = "\033[35m"

# Max lines to show for tool results
RESULT_PREVIEW_LINES = 5
# Max chars to show for thinking blocks
THINKING_PREVIEW_CHARS = 200
# Max chars for bash command preview
BASH_CMD_CHARS = 80
# Max chars for result text
RESULT_TEXT_CHARS = 200

# Tools that use file_path as their key context
_FILE_PATH_TOOLS = frozenset(("Read", "Edit", "Write"))

# Map tool name -> input key for simple single-field context
_SIMPLE_CONTEXT: dict[str, str] = {
    "Glob": "pattern",
    "Grep": "pattern",
    "WebFetch": "url",
    "WebSearch": "query",
    "Skill": "skill",
}


def _tool_context(name: str, inp: dict[str, object]) -> str:
    """Extract a short context string for a tool call."""
    if name in _FILE_PATH_TOOLS:
        path = str(inp.get("file_path", ""))
        return path.rsplit("/", 1)[-1] if "/" in path else path

    if name in _SIMPLE_CONTEXT:
        return str(inp.get(_SIMPLE_CONTEXT[name], ""))

    if name == "Bash":
        cmd = str(inp.get("command", "")).replace("\n", " ")
        return cmd[:BASH_CMD_CHARS] + "..." if len(cmd) > BASH_CMD_CHARS else cmd

    if name == "Task":
        agent = str(inp.get("subagent_type", ""))
        desc = str(inp.get("description", ""))
        return f"[{agent}] {desc}" if agent else desc

    return ""


def _format_result_preview(content: str) -> str:
    """Format a tool result as a short preview."""
    lines = content.split("\n")
    total = len(lines)
    preview = lines[:RESULT_PREVIEW_LINES]
    text = "\n    ".join(preview)
    if total > RESULT_PREVIEW_LINES:
        text += f"\n    {DIM}... ({total - RESULT_PREVIEW_LINES} more lines){RESET}"
    return text


def _format_assistant(msg: object) -> str | None:
    """Format an assistant event."""
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if not isinstance(content, list):
        return None

    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")

        if btype == "text":
            text = block.get("text", "")
            if text:
                parts.append(str(text))

        elif btype == "thinking":
            thinking = str(block.get("thinking", ""))
            if thinking:
                preview = thinking[:THINKING_PREVIEW_CHARS].replace("\n", " ")
                if len(thinking) > THINKING_PREVIEW_CHARS:
                    preview += "..."
                parts.append(f"{DIM}[thinking] {preview}{RESET}")

        elif btype == "tool_use":
            name = str(block.get("name", "?"))
            inp = block.get("input", {})
            if not isinstance(inp, dict):
                inp = {}
            ctx = _tool_context(name, inp)
            if ctx:
                parts.append(f"{CYAN}{name}{RESET} {DIM}{ctx}{RESET}")
            else:
                parts.append(f"{CYAN}{name}{RESET}")

    return "\n".join(parts) if parts else None


def _extract_tool_result_text(block: dict[str, object]) -> tuple[str, bool]:
    """Extract text and error status from a tool_result block."""
    raw = block.get("content", "")
    is_error = bool(block.get("is_error", False))
    if isinstance(raw, list):
        text_parts = [
            str(item.get("text", ""))
            for item in raw
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        return "\n".join(text_parts), is_error
    return str(raw), is_error


def _format_user(msg: object) -> str | None:
    """Format a user event (tool results)."""
    if not isinstance(msg, dict):
        return None
    content = msg.get("content")
    if not isinstance(content, list):
        return None

    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") != "tool_result":
            continue

        text, is_error = _extract_tool_result_text(block)
        if not text.strip():
            continue

        preview = _format_result_preview(text)
        if is_error:
            parts.append(f"  {RED}ERR{RESET} {preview}")
        else:
            parts.append(f"  {DIM}{preview}{RESET}")

    return "\n".join(parts) if parts else None


def _format_system(event: dict[str, object]) -> str | None:
    """Format a system event."""
    subtype = event.get("subtype", "")
    hook = event.get("hook_name") or event.get("hook_event", "")
    label = str(subtype) if subtype else ""
    if hook:
        label = f"{label}: {hook}" if label else str(hook)
    if label:
        return f"{MAGENTA}[system] {label}{RESET}"
    return None


def _format_result(event: dict[str, object]) -> str | None:
    """Format a final result event."""
    result = event.get("result", "")
    if not result:
        return None
    text = str(result)
    if len(text) > RESULT_TEXT_CHARS:
        text = text[:RESULT_TEXT_CHARS] + "..."
    return f"\n{GREEN}{BOLD}Result:{RESET} {text}"


def format_event(event: dict[str, object]) -> str | None:
    """Format a single stream-json event into readable text."""
    etype = event.get("type")
    if etype == "assistant":
        return _format_assistant(event.get("message"))
    if etype == "user":
        return _format_user(event.get("message"))
    if etype == "system":
        return _format_system(event)
    if etype == "result":
        return _format_result(event)
    return None


def _accumulate_usage(
    tokens_by_model: dict[str, dict[str, int]],
    event: dict[str, object],
) -> None:
    """Accumulate token usage from an assistant event into tokens_by_model."""
    msg = event.get("message")
    if not isinstance(msg, dict):
        return
    usage = msg.get("usage")
    if not isinstance(usage, dict):
        return
    model = str(msg.get("model", "unknown"))
    if model not in tokens_by_model:
        tokens_by_model[model] = {
            "input": 0,
            "output": 0,
            "cache_creation": 0,
            "cache_read": 0,
        }
    entry = tokens_by_model[model]
    entry["input"] += int(usage.get("input_tokens", 0))
    entry["output"] += int(usage.get("output_tokens", 0))
    entry["cache_creation"] += int(usage.get("cache_creation_input_tokens", 0))
    entry["cache_read"] += int(usage.get("cache_read_input_tokens", 0))


def _print_usage_summary(tokens_by_model: dict[str, dict[str, int]]) -> None:
    """Print a token usage summary in the format the harness expects."""
    if not tokens_by_model:
        return
    total_input = 0
    total_output = 0
    for model, usage in sorted(tokens_by_model.items()):
        parts = [
            f"Model: {model}",
            f"Input: {usage['input']}",
            f"Output: {usage['output']}",
        ]
        if usage.get("cache_creation"):
            parts.append(f"Cache creation: {usage['cache_creation']}")
        if usage.get("cache_read"):
            parts.append(f"Cache read: {usage['cache_read']}")
        print("  ".join(parts), flush=True)
        total_input += usage["input"]
        total_output += usage["output"]
    print(f"Total input tokens: {total_input}", flush=True)
    print(f"Total output tokens: {total_output}", flush=True)


def main() -> int:
    """Read JSONL from stdin, print formatted text to stdout."""
    tokens_by_model: dict[str, dict[str, int]] = {}
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if event.get("type") == "assistant":
                _accumulate_usage(tokens_by_model, event)

            formatted = format_event(event)
            if formatted:
                print(formatted, flush=True)

    except KeyboardInterrupt:
        pass
    except BrokenPipeError:
        return 0

    _print_usage_summary(tokens_by_model)

    return 0


if __name__ == "__main__":
    sys.exit(main())
