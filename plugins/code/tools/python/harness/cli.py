"""
Thin CLI entry point for the harness package.

Usage::

    python -m harness.cli <adapter_name> <method_name> < request.json

Reads a JSON request from stdin, dispatches to the named method on the
named adapter, and writes a JSON result to stdout. All harness-specific
behavior is reached through the HarnessAdapter interface.

Supported method names and their stdout JSON shape:

- ``build_entry_prompt``  -> {"result": "<prompt_string>"}
- ``build_argv``          -> {"argv": [...]}
- ``parse_session_id``    -> {"session_id": "<id>" | null}
- ``parse_turn_result``   -> TurnResult JSON (via turn_result_to_json)
- ``classify_terminal_failure`` -> TerminalFailure JSON (via terminal_failure_to_json)
"""

from __future__ import annotations

import json
import sys
from typing import NoReturn, assert_never

from harness.registry import get_adapter
from harness.types import (
    AdapterName,
    MethodName,
    adapter_name_from_str,
    method_name_from_str,
    request_from_json,
    terminal_failure_to_json,
    turn_result_to_json,
)


def _dispatch(
    adapter_name: AdapterName,
    method_name: MethodName,
    payload: dict[str, object],
) -> dict[str, object]:
    """Look up the adapter, deserialize the request, call the method.

    Both ``adapter_name`` and ``method_name`` arrive already validated as their
    respective enums (see :func:`adapter_name_from_str` /
    :func:`method_name_from_str`), so the only remaining failure mode here is a
    valid-but-unregistered adapter name.

    Raises KeyError if no adapter is registered under ``adapter_name``.
    """
    adapter_cls = get_adapter(adapter_name)
    adapter = adapter_cls()

    match method_name:
        case MethodName.BUILD_ENTRY_PROMPT:
            raw_add_dirs = payload.get("add_dirs", [])
            add_dirs = list(raw_add_dirs) if isinstance(raw_add_dirs, list) else []
            result = adapter.build_entry_prompt(
                workdir=str(payload.get("workdir", "")),
                prompt_name=str(payload.get("prompt_name", "")),
                prd=str(payload.get("prd", "")),
                add_dirs=add_dirs,
            )
            return {"result": result}

        case MethodName.BUILD_ARGV:
            request = request_from_json(payload)
            argv = adapter.build_argv(request)
            return {"argv": argv}

        case MethodName.PARSE_SESSION_ID:
            raw_output = str(payload.get("raw_output", ""))
            session_id = adapter.parse_session_id(raw_output)
            return {"session_id": session_id}

        case MethodName.PARSE_TURN_RESULT:
            raw_output = str(payload.get("raw_output", ""))
            turn_result = adapter.parse_turn_result(raw_output)
            return turn_result_to_json(turn_result)

        case MethodName.CLASSIFY_TERMINAL_FAILURE:
            raw_output = str(payload.get("raw_output", ""))
            stderr = str(payload.get("stderr", ""))
            raw_exit = payload.get("exit_code", 1)
            exit_code = raw_exit if isinstance(raw_exit, int) else int(str(raw_exit))
            failure = adapter.classify_terminal_failure(raw_output, stderr, exit_code)
            return terminal_failure_to_json(failure)

    assert_never(method_name)


def _error_exit(msg: str) -> NoReturn:
    """Print a one-line error to stderr and exit non-zero.

    Mirrors the ``error_exit`` idiom used by sibling code-plugin tool scripts
    (e.g. ``count_tokens.py``) so shell callers get a clean message instead of
    a raw Python traceback. Defined locally because the no-cross-import rule for
    tool scripts forbids importing that helper directly.
    """
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    """CLI entry point: reads stdin JSON, writes stdout JSON."""
    if len(sys.argv) != 3:
        _error_exit("Usage: python -m harness.cli <adapter_name> <method_name>")

    try:
        adapter_name = adapter_name_from_str(sys.argv[1])
        method_name = method_name_from_str(sys.argv[2])
    except ValueError as exc:
        _error_exit(str(exc))

    raw_stdin = sys.stdin.read()
    if not raw_stdin.strip():
        _error_exit("No JSON request provided on stdin.")

    try:
        payload = json.loads(raw_stdin)
    except json.JSONDecodeError as exc:
        _error_exit(f"Invalid JSON request on stdin: {exc}")

    if not isinstance(payload, dict):
        _error_exit("JSON request must be a JSON object.")

    try:
        result = _dispatch(adapter_name, method_name, payload)
    except (KeyError, ValueError, TypeError) as exc:
        # KeyError stringifies with surrounding quotes; unwrap to the bare message.
        message = exc.args[0] if exc.args else str(exc)
        _error_exit(str(message))

    print(json.dumps(result))


if __name__ == "__main__":
    main()
