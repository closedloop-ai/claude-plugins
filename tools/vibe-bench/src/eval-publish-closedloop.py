#!/usr/bin/env python3
"""Use the repository's existing ClosedLoop MCP transport for nightly tickets.

Input and output are JSON on stdin/stdout. Credentials come only from the
documented CLOSEDLOOP_API_KEY and NEXT_PUBLIC_MCP_SERVER_URL runtime contract.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main() -> None:
    request = json.load(sys.stdin)
    key = os.environ.get("CLOSEDLOOP_API_KEY", "")
    url = os.environ.get("NEXT_PUBLIC_MCP_SERVER_URL", "")
    if not key or not url:
        raise RuntimeError("eval-publish-closedloop-credentials-unavailable")
    async with httpx2.AsyncClient(
        headers={"Authorization": f"Bearer {key}"},
        timeout=httpx2.Timeout(120.0, read=300.0),
    ) as client:
        async with streamable_http_client(url, http_client=client) as (reader, writer):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                result = await session.call_tool(request["operation"], request["args"])
                if result.is_error:
                    raise RuntimeError("eval-publish-closedloop-tool-failed")
                content = next((item.text for item in result.content if hasattr(item, "text")), "")
                if not content:
                    raise RuntimeError("eval-publish-closedloop-empty-response")
                parsed = json.loads(content)
                print(json.dumps(parsed.get("data", parsed)))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as error:
        # Do not print HTTP exception details; they may contain credentials.
        print(f"eval-publish-closedloop-failed:{type(error).__name__}", file=sys.stderr)
        sys.exit(1)
