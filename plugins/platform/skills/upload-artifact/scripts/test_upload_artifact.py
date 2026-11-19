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
    args.status = None
    args.assignee_id = None
    args.repository_selection = None
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


@dataclass
class _StoredDocument:
    """A server whose version write can save and then fail the response stream."""

    latest_version: int = 4
    content_length: int = 10
    save_then_fail: bool = False
    fail_before_save: bool = False
    fail_reads: bool = False
    stored_length_delta: int = 0
    calls: list[str] = field(default_factory=list)

    async def call_tool(self, name: str, arguments: dict) -> _Result:
        self.calls.append(name)
        if name == "get-document":
            if self.fail_reads:
                raise RuntimeError("connection refused")
            body = {
                "latestVersion": self.latest_version,
                "version": {"version": self.latest_version, "contentLength": self.content_length},
            }
            return _Result(content=[_Text(json.dumps(body))])
        assert name == "create-document-version"
        if self.fail_before_save:
            raise RuntimeError("SSE stream failed: connection reset")
        self.latest_version += 1
        self.content_length = len(arguments["content"].encode("utf-16-le")) // 2 + self.stored_length_delta
        if self.save_then_fail:
            raise RuntimeError("SSE stream failed: Server-sent event exceeded the 1048576 byte limit")
        return _Result(content=[_Text(json.dumps({"id": "v", "slug": "PLN-9"}))])


def _upload_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, server: _StoredDocument, content: str
) -> dict:
    content_file = tmp_path / "plan.md"
    content_file.write_text(content, encoding="utf-8")

    @asynccontextmanager
    async def fake_connect(_args: _Args) -> AsyncIterator[_StoredDocument]:
        yield server

    monkeypatch.setattr(upload_artifact, "_connect", fake_connect)
    args = _create_args(file=str(content_file), artifact_id="PLN-9")
    args.verify = False
    return asyncio.run(upload_artifact.upload(args))


def test_a_version_saved_before_the_stream_failed_is_success_and_not_written_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = _StoredDocument(save_then_fail=True)
    # An astral character is two UTF-16 units on the server and one in Python.
    output = _upload_version(tmp_path, monkeypatch, server, "plan \U0001f600 body")

    assert output["status"] == "success"
    assert output["recovered_after_transport_error"] is True
    assert output["saved_version"] == 5
    assert server.calls.count("create-document-version") == 1
    assert server.latest_version == 5


def test_a_stream_failure_before_the_save_says_a_retry_is_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = _StoredDocument(fail_before_save=True)
    output = _upload_version(tmp_path, monkeypatch, server, "plan body")

    assert output["retry_safe"] is True
    assert "error" in output
    assert server.latest_version == 4


def test_a_stored_version_that_does_not_match_the_file_is_never_called_saved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = _StoredDocument(save_then_fail=True, stored_length_delta=-3)
    output = _upload_version(tmp_path, monkeypatch, server, "plan body")

    assert output["retry_safe"] is False
    assert "error" in output
    assert output["stored_version"] == 5


def test_a_version_without_a_transport_error_is_written_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = _StoredDocument()
    output = _upload_version(tmp_path, monkeypatch, server, "plan body")

    assert output["status"] == "success"
    assert "recovered_after_transport_error" not in output
    assert server.calls == ["get-document", "create-document-version"]


def test_create_passes_status_assignee_and_repository_selection() -> None:
    fake = _FakeSession({"id": "d1", "slug": "PLN-9"})
    args = _create_args(
        type="IMPLEMENTATION_PLAN",
        status="DRAFT",
        assignee_id="u1",
        repository_selection='{"primary": {"repository": "org/repo", "branch": "b"}}',
    )
    asyncio.run(_create_document(cast(ClientSession, fake), args, "hello"))

    sent = fake.calls[0][1]
    assert sent["status"] == "DRAFT"
    assert sent["assigneeId"] == "u1"
    assert sent["repositorySelection"] == {"primary": {"repository": "org/repo", "branch": "b"}}


def test_a_failed_baseline_read_writes_nothing_and_says_a_retry_is_safe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = _StoredDocument(fail_reads=True)
    output = _upload_version(tmp_path, monkeypatch, server, "plan body")

    assert output["retry_safe"] is True
    assert "error" in output
    assert "create-document-version" not in server.calls
