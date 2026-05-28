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

from harness.registry import get_adapter
from harness.types import (
    request_from_json,
    terminal_failure_to_json,
    turn_result_to_json,
)


def _dispatch(adapter_name: str, method_name: str, payload: dict[str, object]) -> dict[str, object]:
    """Look up the adapter, deserialize the request, call the method.

    Raises KeyError if the adapter or method is not found.
    """
    adapter_cls = get_adapter(adapter_name)
    adapter = adapter_cls()

    if method_name == "build_entry_prompt":
        raw_add_dirs = payload.get("add_dirs", [])
        add_dirs = list(raw_add_dirs) if isinstance(raw_add_dirs, list) else []
        result = adapter.build_entry_prompt(
            workdir=str(payload.get("workdir", "")),
            prompt_name=str(payload.get("prompt_name", "")),
            prd=str(payload.get("prd", "")),
            add_dirs=add_dirs,
        )
        return {"result": result}

    if method_name == "build_argv":
        request = request_from_json(payload)
        argv = adapter.build_argv(request)
        return {"argv": argv}

    if method_name == "parse_session_id":
        raw_output = str(payload.get("raw_output", ""))
        session_id = adapter.parse_session_id(raw_output)
        return {"session_id": session_id}

    if method_name == "parse_turn_result":
        raw_output = str(payload.get("raw_output", ""))
        turn_result = adapter.parse_turn_result(raw_output)
        return turn_result_to_json(turn_result)

    if method_name == "classify_terminal_failure":
        raw_output = str(payload.get("raw_output", ""))
        stderr = str(payload.get("stderr", ""))
        raw_exit = payload.get("exit_code", 1)
        exit_code = raw_exit if isinstance(raw_exit, int) else int(str(raw_exit))
        failure = adapter.classify_terminal_failure(raw_output, stderr, exit_code)
        return terminal_failure_to_json(failure)

    raise KeyError(
        f"Unknown method {method_name!r}. Supported methods: "
        "build_entry_prompt, build_argv, parse_session_id, "
        "parse_turn_result, classify_terminal_failure"
    )


def main() -> None:
    """CLI entry point: reads stdin JSON, writes stdout JSON."""
    if len(sys.argv) != 3:
        print(
            "Usage: python -m harness.cli <adapter_name> <method_name>",
            file=sys.stderr,
        )
        sys.exit(1)

    adapter_name = sys.argv[1]
    method_name = sys.argv[2]

    payload = json.loads(sys.stdin.read())
    result = _dispatch(adapter_name, method_name, payload)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
