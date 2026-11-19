#!/usr/bin/env python3
"""Upload a file as a ClosedLoop MCP document via Streamable HTTP transport.

Connects directly to the MCP server, authenticates with an API key,
and calls create-document or create-document-version. The CLI flag
``--artifact-id`` is preserved for backward compatibility and refers to the
same identifier the server now exposes via ``documentId``.

Reads `CLOSEDLOOP_API_KEY` and `NEXT_PUBLIC_MCP_SERVER_URL` from the current
process environment by default. `--api-key` and `--url` can still be provided
explicitly to override those values.

Usage:
    export CLOSEDLOOP_API_KEY=sk_live_...
    export NEXT_PUBLIC_MCP_SERVER_URL=https://example.com/mcp

    # List available projects:
    uv run --with 'mcp[cli]>=2,<3' scripts/upload_artifact.py \\
        --list-projects

    # Create document:
    uv run --with 'mcp[cli]>=2,<3' scripts/upload_artifact.py \\
        --file /path/to/content.md \\
        --title "My PRD" \\
        --type PRD \\
        --project-id <PROJECT_ID>

    # New version of existing document:
    uv run --with 'mcp[cli]>=2,<3' scripts/upload_artifact.py \\
        --file /path/to/content.md \\
        --artifact-id <DOCUMENT_ID_OR_SLUG>

    # Create + verify round-trip:
    uv run --with 'mcp[cli]>=2,<3' scripts/upload_artifact.py \\
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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx2
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
    status: str | None
    assignee_id: str | None
    repository_selection: str | None


_API_KEY_ENV_VAR = "CLOSEDLOOP_API_KEY"
_MCP_URL_ENV_VAR = "NEXT_PUBLIC_MCP_SERVER_URL"


def _build_http_client(api_key: str) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=httpx2.Timeout(120.0, read=300.0),
    )


@asynccontextmanager
async def _connect(args: _Args) -> AsyncIterator[ClientSession]:
    """Open an initialized MCP session over Streamable HTTP."""
    async with _build_http_client(args.api_key) as http_client:
        async with streamable_http_client(
            args.url, http_client=http_client
        ) as (read_stream, write_stream):
            async with ClientSession(read_stream, write_stream) as session:
                await session.initialize()
                yield session


def _extract_text(result) -> str:
    """Extract the first text content from an MCP tool result."""
    for c in result.content or []:
        if hasattr(c, "text"):
            return c.text
    return ""


async def list_projects(args: _Args) -> dict:
    """List all available projects."""
    try:
        async with _connect(args) as session:
            result = await session.call_tool("list-projects", {})
            if result.is_error:
                return {"error": "list-projects failed", **_error_details(result)}
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


async def _version_document(
    session: ClientSession, document_id: str, content: str
) -> dict:
    """Append a new version to an existing document."""
    result = await session.call_tool(
        "create-document-version",
        {"documentId": document_id, "content": content},
    )
    if result.is_error:
        return {"error": "create-document-version failed", **_error_details(result)}
    text = _extract_text(result)
    parsed = json.loads(text) if text else {}
    data = parsed.get("data", parsed) if isinstance(parsed, dict) else {}
    return {
        "mode": "version",
        "artifact_id": document_id,
        "document_id": document_id,
        "slug": data.get("slug", parsed.get("slug") if isinstance(parsed, dict) else None),
        **_read_operation_receipt(parsed),
        "content_length": len(content),
        "status": "success",
        "response": parsed,
    }


async def _create_document(
    session: ClientSession, args: _Args, content: str
) -> dict:
    """Create a new document."""
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
    if args.status:
        tool_args["status"] = args.status
    if args.assignee_id:
        tool_args["assigneeId"] = args.assignee_id
    if args.repository_selection:
        tool_args["repositorySelection"] = json.loads(args.repository_selection)

    result = await session.call_tool("create-document", tool_args)
    if result.is_error:
        return {"error": "create-document failed", **_error_details(result)}
    text = _extract_text(result)
    if not text:
        return {"error": "Empty response from create-document"}
    parsed = json.loads(text)
    data = parsed.get("data", parsed)
    document_id = data.get("id", parsed.get("id", "unknown"))
    return {
        "mode": "create",
        "artifact_id": document_id,
        "document_id": document_id,
        "slug": data.get("slug", parsed.get("slug")),
        **_read_operation_receipt(parsed),
        "content_length": len(content),
        "status": "success",
        "response": parsed,
    }


async def upload(args: _Args) -> dict:
    """Create or version a document from a file."""
    assert args.file is not None
    file_path = Path(args.file).expanduser().resolve()
    if not file_path.is_file():
        return {"error": f"File not found: {file_path}"}

    content = file_path.read_text(encoding="utf-8")
    if args.artifact_id:
        return await _upload_version(args, args.artifact_id, content)

    try:
        async with _connect(args) as session:
            output = await _create_document(session, args, content)

            if "error" not in output and args.verify:
                output["verify"] = await _verify_document(
                    session, output["artifact_id"], len(content)
                )

            return output
    except (Exception, ExceptionGroup) as exc:
        return _format_exception(exc)


async def _upload_version(args: _Args, document_id: str, content: str) -> dict:
    """Version a document; after a transport error, read it back before anyone retries.

    The server can save the version and still fail the response stream (an SSE
    event over its size limit), so a blind retry makes a duplicate version.
    """
    try:
        async with _connect(args) as session:
            baseline = await _latest_version(session, document_id)
    except (Exception, ExceptionGroup) as exc:
        baseline = _format_exception(exc)
    if "error" in baseline:
        # Nothing was written yet.
        return {**baseline, "retry_safe": True}
    try:
        async with _connect(args) as session:
            output = await _version_document(session, document_id, content)
            if "error" not in output and args.verify:
                output["verify"] = await _verify_document(
                    session, document_id, len(content)
                )
            return output
    except (Exception, ExceptionGroup) as exc:
        transport_error = _format_exception(exc)
    return await _read_back_version(
        args, document_id, content, baseline["latest_version"], transport_error
    )


async def _read_back_version(
    args: _Args,
    document_id: str,
    content: str,
    baseline_version: int,
    transport_error: dict,
) -> dict:
    """Decide from the stored document whether the failed write saved the content."""
    try:
        async with _connect(args) as session:
            latest = await _latest_version(session, document_id)
    except (Exception, ExceptionGroup) as exc:
        latest = _format_exception(exc)
    base = {"transport_error": transport_error["error"], "baseline_version": baseline_version}
    if "error" in latest:
        return {
            "error": "Transport error, and the document could not be read back; do not retry",
            "retry_safe": False,
            "read_back_error": latest["error"],
            **base,
        }
    expected_length = _server_length(content)
    if latest["latest_version"] == baseline_version:
        return {
            "error": "Transport error before the version was saved; a retry is safe",
            "retry_safe": True,
            **base,
        }
    if (
        latest["latest_version"] == baseline_version + 1
        and latest["content_length"] == expected_length
    ):
        return {
            "mode": "version",
            "artifact_id": document_id,
            "document_id": document_id,
            "content_length": len(content),
            "status": "success",
            "recovered_after_transport_error": True,
            "saved_version": latest["latest_version"],
            **base,
        }
    return {
        "error": "Transport error, and the stored latest version does not match this file; do not retry",
        "retry_safe": False,
        "stored_version": latest["latest_version"],
        "stored_content_length": latest["content_length"],
        "expected_content_length": expected_length,
        **base,
    }


async def _latest_version(session: ClientSession, document_id: str) -> dict:
    """The document's latest version number and that version's stored length."""
    result = await session.call_tool("get-document", {"documentId": document_id})
    if result.is_error:
        return {"error": "get-document failed", **_error_details(result)}
    text = _extract_text(result)
    parsed = json.loads(text) if text else {}
    version = parsed.get("version") if isinstance(parsed, dict) else None
    number = parsed.get("latestVersion") if isinstance(parsed, dict) else None
    if not isinstance(number, int) and isinstance(version, dict):
        number = version.get("version")
    length = version.get("contentLength") if isinstance(version, dict) else None
    if not isinstance(number, int) or not isinstance(length, int):
        return {"error": "get-document returned no latest version"}
    return {"latest_version": number, "content_length": length}


def _server_length(content: str) -> int:
    """The length the server reports: JavaScript string length, in UTF-16 code units."""
    return len(content.encode("utf-16-le")) // 2


async def _verify_document(
    session: ClientSession, document_id: str, expected_length: int
) -> dict:
    """Fetch a document back and compare content lengths."""
    fetch_max = min(expected_length, 120_000)
    result = await session.call_tool(
        "get-document",
        {
            "documentId": document_id,
            "includeContent": True,
            "contentMaxChars": fetch_max,
        },
    )
    if result.is_error:
        return {"error": "get-document failed", **_error_details(result)}
    text = _extract_text(result)
    if not text:
        return {"error": "Empty response from get-document"}
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


def _read_operation_receipt(parsed: object) -> dict:
    """The write's operation receipt, or nothing when the response has none.

    ISS-12714: printed in the result so the session that ran this script names
    the write it made (PRD-800). The MCP server puts the receipt on the body
    root and the REST API inside ``data``. It sits ahead of ``response`` so a
    transcript that keeps only the head of a long result still holds it.
    """
    if not isinstance(parsed, dict):
        return {}
    receipt = parsed.get("operationReceipt")
    if receipt is None:
        data = parsed.get("data")
        receipt = data.get("operationReceipt") if isinstance(data, dict) else None
    if isinstance(receipt, dict) and isinstance(receipt.get("operationId"), str):
        return {"operationReceipt": receipt}
    return {}


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
        description="Upload file content as a ClosedLoop MCP document."
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
    parser.add_argument("--title", help="Document title (create mode).")
    parser.add_argument(
        "--type",
        choices=["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE", "FEATURE"],
        help="Document type (create mode).",
    )
    parser.add_argument("--project-id", help="Project ID or slug (PRO-*).")
    parser.add_argument("--workstream-id", help="Workstream ID or slug (WRK-*).")
    parser.add_argument(
        "--artifact-id",
        help="Existing document ID or slug (PRD-*/PLN-*/FEA-*) (version mode).",
    )
    parser.add_argument(
        "--status", help="Initial status (create mode), for example DRAFT."
    )
    parser.add_argument("--assignee-id", help="Assignee user ID (create mode).")
    parser.add_argument(
        "--repository-selection",
        help="repositorySelection as a JSON object (create mode).",
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
