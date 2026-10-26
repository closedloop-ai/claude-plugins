"""The cl-policy direct-API write snippet prints the operation id (ISS-12714).

Runs the documented commands verbatim against canned API responses, so the
test covers what an agent copies, not a restatement of it.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

import pytest

SKILL = Path(__file__).resolve().parents[2] / "skills" / "cl-policy" / "SKILL.md"
OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991"
RECEIPT = {"operationId": OPERATION_ID, "outcome": "committed"}

# The session-side shell-claim matcher's pattern, as written in symphony-alpha
# packages/lib/harness/tool-result-facts.ts (OPERATION_ID_RE).
SHELL_CLAIM_RE = re.compile(
    r"clop_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
BASH_BLOCK_RE = re.compile(r"```bash\n(.*?)```", re.DOTALL)


def _print_commands() -> str:
    """The snippet after its curl assignment, which the test replaces."""
    blocks = [
        block for block in BASH_BLOCK_RE.findall(SKILL.read_text()) if "operationReceipt" in block
    ]
    assert len(blocks) == 1
    lines = [line.strip() for line in blocks[0].splitlines()]
    end = next(i for i, line in enumerate(lines) if line.endswith(')"'))
    assert lines[0].startswith('response="$(curl ')
    return "\n".join(lines[end + 1 :])


def _run(response: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", _print_commands()],
        capture_output=True,
        text=True,
        env={**os.environ, "response": response},
        check=False,
    )


@pytest.mark.parametrize(
    "body",
    [
        {"success": True, "data": {"id": "d1", "slug": "ISS-7", "operationReceipt": RECEIPT}},
        {"success": True, "data": {"deleted": True, "operationReceipt": RECEIPT}},
        {"id": "d1", "slug": "ISS-7", "operationReceipt": RECEIPT},
    ],
)
def test_write_response_receipt_id_is_printed_in_the_matcher_form(body: dict) -> None:
    response = json.dumps(body, indent=2)
    result = _run(response)

    assert result.returncode == 0
    assert result.stdout == response + "\n"
    assert result.stderr == OPERATION_ID + "\n"
    assert SHELL_CLAIM_RE.findall(result.stdout + result.stderr)[-1] == OPERATION_ID


@pytest.mark.parametrize(
    "body",
    [
        {"success": True, "data": {"id": "d1", "slug": "ISS-7"}},
        {"success": True, "data": [{"id": "d1"}]},
        {"success": True, "data": {"operationReceipt": {"outcome": "committed"}}},
        {"success": False, "error": "Forbidden"},
    ],
)
def test_response_without_a_receipt_prints_only_the_response(body: dict) -> None:
    response = json.dumps(body)
    result = _run(response)

    assert result.returncode == 0
    assert result.stdout == response + "\n"
    assert result.stderr == ""


def test_release_and_both_manifests_are_1083() -> None:
    plugin = SKILL.parents[2]
    for manifest in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json"):
        assert json.loads((plugin / manifest).read_text())["version"] == "1.0.83"
