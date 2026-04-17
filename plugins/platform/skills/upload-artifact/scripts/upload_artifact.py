#!/usr/bin/env python3
"""Upload a file as a ClosedLoop MCP artifact via Streamable HTTP transport.

Connects directly to the MCP server, authenticates with an API key,
and calls create-artifact or create-artifact-version.

Reads `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` from the current
process environment by default. `--api-key` and `--url` can still be provided
explicitly to override those values.

Usage:
    export CLOSEDLOOP_API_KEY=sk_live_...
    export NEXT_PUBLIC_MCP_SERVER_URL=https://example.com/mcp

    # List available projects:
    uv run --with 'mcp[cli]' scripts/upload_artifact.py \\
        --list-projects

    # Create artifact:
    uv run --with 'mcp[cli]' scripts/upload_artifact.py \\
        --file /path/to/content.md \\
        --title "My PRD" \\
        --type PRD \\
        --project-id <PROJECT_ID>

    # New version of existing artifact:
    uv run --with 'mcp[cli]' scripts/upload_artifact.py \\
        --file /path/to/content.md \\
        --artifact-id <ARTIFACT_ID>

    # Create + verify round-trip:
    uv run --with 'mcp[cli]' scripts/upload_artifact.py \\
        --file /path/to/content.md \\
        --title "My PRD" \\
        --type PRD \\
        --project-id <PROJECT_ID> \\
        --verify
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


class _Args(argparse.Namespace):
    """Typed namespace for CLI arguments."""

    url: str
    api_key: str
    list_projects: bool
    file: str | None
    title: str | None
    type: str | None
    project_id: str | None
    workstream_id: str | None
    artifact_id: str | None
    verify: bool


_API_KEY_ENV_VAR = "CLOSEDLOOP_API_KEY"
_MCP_URL_ENV_VAR = "NEXT_PUBLIC_MCP_SERVER_URL"


def _build_http_client(api_key: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=httpx.Timeout(120.0, read=300.0),
    )


def _extract_text(result) -> str:
    """Extract the first text content from an MCP tool result."""
    for c in result.content or []:
        if hasattr(c, "text"):
            return c.text
    return ""


async def list_projects(args: _Args) -> dict:
    """List all available projects."""
    http_client = _build_http_client(args.api_key)
    try:
        async with http_client, streamable_http_client(
            args.url, http_client=http_client
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                result = await session.call_tool("list-projects", {})
                if result.isError:
                    return {
                        "error": "list-projects failed",
                        "details": [
                            getattr(c, "text", str(c))
                            for c in (result.content or [])
                        ],
                    }
                text = _extract_text(result)
                if not text:
                    return {"error": "Empty response from list-projects"}
                return json.loads(text)
    except (Exception, ExceptionGroup) as exc:
        return _format_exception(exc)


def _error_details(result: object) -> dict:
    """Build an error dict from an MCP tool result."""
    content = getattr(result, "content", None) or []
    return {"details": [getattr(c, "text", str(c)) for c in content]}


async def _version_artifact(
    session: ClientSession, artifact_id: str, content: str
) -> dict:
    """Create a new version of an existing artifact."""
    result = await session.call_tool(
        "create-artifact-version",
        {"artifactId": artifact_id, "content": content},
    )
    if result.isError:
        return {"error": "create-artifact-version failed", **_error_details(result)}
    text = _extract_text(result)
    parsed = json.loads(text) if text else {}
    return {
        "mode": "version",
        "artifact_id": artifact_id,
        "content_length": len(content),
        "status": "success",
        "response": parsed,
    }


async def _create_artifact(
    session: ClientSession, args: _Args, content: str
) -> dict:
    """Create a new artifact."""
    assert args.title is not None
    assert args.type is not None
    tool_args: dict[str, str] = {
        "title": args.title,
        "type": args.type,
        "content": content,
    }
    if args.project_id:
        tool_args["projectId"] = args.project_id
    if args.workstream_id:
        tool_args["workstreamId"] = args.workstream_id

    result = await session.call_tool("create-artifact", tool_args)
    if result.isError:
        return {"error": "create-artifact failed", **_error_details(result)}
    text = _extract_text(result)
    if not text:
        return {"error": "Empty response from create-artifact"}
    parsed = json.loads(text)
    data = parsed.get("data", parsed)
    return {
        "mode": "create",
        "artifact_id": data.get("id", parsed.get("id", "unknown")),
        "content_length": len(content),
        "status": "success",
        "response": parsed,
    }


async def upload(args: _Args) -> dict:
    """Create or version an artifact from a file."""
    assert args.file is not None
    file_path = Path(args.file).expanduser().resolve()
    if not file_path.is_file():
        return {"error": f"File not found: {file_path}"}

    content = file_path.read_text(encoding="utf-8")

    http_client = _build_http_client(args.api_key)
    try:
        async with http_client, streamable_http_client(
            args.url, http_client=http_client
        ) as (read_stream, write_stream, _):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()

                if args.artifact_id:
                    output = await _version_artifact(session, args.artifact_id, content)
                else:
                    output = await _create_artifact(session, args, content)

                if "error" not in output and args.verify:
                    output["verify"] = await _verify_artifact(
                        session, output["artifact_id"], len(content)
                    )

                return output
    except (Exception, ExceptionGroup) as exc:
        return _format_exception(exc)


async def _verify_artifact(
    session: ClientSession, artifact_id: str, expected_length: int
) -> dict:
    """Fetch an artifact back and compare content lengths."""
    fetch_max = min(expected_length, 120_000)
    result = await session.call_tool(
        "get-artifact",
        {
            "artifactId": artifact_id,
            "includeContent": True,
            "contentMaxChars": fetch_max,
        },
    )
    if result.isError:
        return {
            "error": "get-artifact failed",
            "details": [
                getattr(c, "text", str(c)) for c in (result.content or [])
            ],
        }
    text = _extract_text(result)
    if not text:
        return {"error": "Empty response from get-artifact"}
    parsed = json.loads(text)
    version_data = parsed.get("version", {})
    actual_length = version_data.get("contentLength", 0)
    returned_content = version_data.get("content", "")
    returned_length = len(returned_content) if returned_content else 0
    return {
        "expected_length": expected_length,
        "stored_content_length": actual_length,
        "returned_content_length": returned_length,
        "content_max_chars": fetch_max,
        "stored_match": actual_length == expected_length,
        "returned_match": returned_length == expected_length,
    }


def _format_exception(exc: Exception | ExceptionGroup) -> dict:  # type: ignore[type-arg]
    """Format an exception (including ExceptionGroups) for JSON output."""
    import traceback

    if isinstance(exc, ExceptionGroup):
        details = []
        for sub in exc.exceptions:
            details.append(
                "".join(
                    traceback.format_exception(type(sub), sub, sub.__traceback__)
                )
            )
        return {"error": str(exc), "sub_exceptions": details}
    return {"error": str(exc), "traceback": traceback.format_exc()}


def _require_arg_or_env(
    parser: argparse.ArgumentParser,
    *,
    value: str | None,
    flag: str,
    env_var: str,
) -> str:
    """Return a CLI/env value or exit with a clear parser error."""
    if value:
        return value
    parser.error(
        f"{flag} is required. Set {env_var} in the current environment "
        f"or pass {flag} explicitly."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Upload file content as a ClosedLoop MCP artifact."
    )
    parser.add_argument(
        "--url",
        default=os.environ.get(_MCP_URL_ENV_VAR),
        help=(
            "MCP server URL. Defaults to the "
            f"{_MCP_URL_ENV_VAR} environment variable."
        ),
    )
    parser.add_argument(
        "--api-key",
        default=os.environ.get(_API_KEY_ENV_VAR),
        help=(
            "ClosedLoop API key (sk_live_...). Defaults to the "
            f"{_API_KEY_ENV_VAR} environment variable."
        ),
    )
    parser.add_argument(
        "--list-projects",
        action="store_true",
        help="List available projects and exit.",
    )
    parser.add_argument("--file", help="Path to content file.")
    parser.add_argument("--title", help="Artifact title (create mode).")
    parser.add_argument(
        "--type",
        choices=["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"],
        help="Artifact type (create mode).",
    )
    parser.add_argument("--project-id", help="Project ID.")
    parser.add_argument("--workstream-id", help="Workstream ID.")
    parser.add_argument(
        "--artifact-id", help="Existing artifact ID (version mode)."
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="After upload, fetch the artifact back and verify content length.",
    )
    args = parser.parse_args(namespace=_Args())
    args.url = _require_arg_or_env(
        parser,
        value=args.url,
        flag="--url",
        env_var=_MCP_URL_ENV_VAR,
    )
    args.api_key = _require_arg_or_env(
        parser,
        value=args.api_key,
        flag="--api-key",
        env_var=_API_KEY_ENV_VAR,
    )

    if args.list_projects:
        result = asyncio.run(list_projects(args))
        print(json.dumps(result, indent=2))
        sys.exit(0 if "error" not in result else 1)

    if not args.file:
        parser.error("--file is required for upload.")
    if not args.artifact_id and not (args.title and args.type):
        parser.error(
            "Provide --title and --type for create, or --artifact-id for version."
        )

    result = asyncio.run(upload(args))
    print(json.dumps(result, indent=2))
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
