"""Operation receipt output of upload_artifact.py (ISS-12714)."""

from __future__ import annotations

import asyncio
import json
import re
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

import pytest
from mcp import ClientSession

import upload_artifact
from upload_artifact import _Args, _create_document, _version_document

OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991"
RECEIPT = {"operationId": OPERATION_ID, "outcome": "committed"}

# The session-side shell-claim matcher's pattern, as written in symphony-alpha
# packages/lib/harness/tool-result-facts.ts (OPERATION_ID_RE).
SHELL_CLAIM_RE = re.compile(
    r"clop_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)

# The keys callers parsed before receipts existed, in their printed order.
CREATE_KEYS = [
    "mode",
    "artifact_id",
    "document_id",
    "slug",
    "content_length",
    "status",
    "response",
]


@dataclass
class _Text:
    text: str


@dataclass
class _Result:
    content: list[_Text]
    is_error: bool = False


@dataclass
class _FakeSession:
    body: dict
    calls: list[tuple[str, dict]] = field(default_factory=list)

    async def call_tool(self, name: str, arguments: dict) -> _Result:
        self.calls.append((name, arguments))
        return _Result(content=[_Text(json.dumps(self.body))])


def _create_args(**overrides: str) -> _Args:
    args = _Args()
    args.title = "Plan"
    args.type = "PRD"
    args.project_id = None
    args.workstream_id = None
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


def _create(body: dict) -> dict:
    session = cast(ClientSession, _FakeSession(body))
    return asyncio.run(_create_document(session, _create_args(), "hello"))


def _version(body: dict) -> dict:
    session = cast(ClientSession, _FakeSession(body))
    return asyncio.run(_version_document(session, "PRD-7", "hello"))


def test_create_prints_the_receipt_from_the_mcp_body_root() -> None:
    output = _create({"id": "d1", "slug": "PRD-7", "operationReceipt": RECEIPT})

    assert output["operationReceipt"] == RECEIPT
    assert SHELL_CLAIM_RE.findall(json.dumps(output, indent=2)) == [
        OPERATION_ID,
        OPERATION_ID,
    ]


def test_version_prints_the_receipt_from_the_mcp_body_root() -> None:
    output = _version({"id": "v1", "slug": "PRD-7", "operationReceipt": RECEIPT})

    assert output["operationReceipt"] == RECEIPT
    assert output["mode"] == "version"


def test_receipt_inside_a_data_envelope_is_printed() -> None:
    output = _create({"data": {"id": "d1", "slug": "PRD-7", "operationReceipt": RECEIPT}})

    assert output["operationReceipt"] == RECEIPT


def test_receipt_precedes_the_echoed_response() -> None:
    output = _create({"id": "d1", "slug": "PRD-7", "operationReceipt": RECEIPT})

    keys = list(output)
    assert keys.index("operationReceipt") < keys.index("response")
    assert [key for key in keys if key != "operationReceipt"] == CREATE_KEYS


@pytest.mark.parametrize(
    "body",
    [
        {"id": "d1", "slug": "PRD-7"},
        {"id": "d1", "slug": "PRD-7", "operationReceipt": {"outcome": "committed"}},
        {"id": "d1", "slug": "PRD-7", "operationReceipt": "clop_not-an-object"},
    ],
)
def test_create_output_is_unchanged_without_a_receipt(body: dict) -> None:
    output = _create(body)

    assert list(output) == CREATE_KEYS
    assert output["document_id"] == "d1"
    assert output["slug"] == "PRD-7"
    assert output["status"] == "success"


def test_version_output_is_unchanged_without_a_receipt() -> None:
    output = _version({"id": "v1", "slug": "PRD-7"})

    assert list(output) == CREATE_KEYS
    assert output["mode"] == "version"
    assert output["artifact_id"] == "PRD-7"


def test_main_prints_one_parseable_json_document_with_the_id(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    content_file = tmp_path / "plan.md"
    content_file.write_text("hello", encoding="utf-8")
    fake = _FakeSession({"id": "d1", "slug": "PRD-7", "operationReceipt": RECEIPT})

    @asynccontextmanager
    async def fake_connect(_args: _Args) -> AsyncIterator[_FakeSession]:
        yield fake

    monkeypatch.setattr(upload_artifact, "_connect", fake_connect)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "upload_artifact.py",
            "--url",
            "http://localhost:3010/mcp",
            "--api-key",
            "sk_live_test",
            "--file",
            str(content_file),
            "--title",
            "Plan",
            "--type",
            "PRD",
        ],
    )

    upload_artifact.main()

    printed = capsys.readouterr().out
    assert json.loads(printed)["operationReceipt"] == RECEIPT
    assert OPERATION_ID in SHELL_CLAIM_RE.findall(printed)
    assert fake.calls[0][0] == "create-document"
