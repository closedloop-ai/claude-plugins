"""Fail-closed adapter for the two ISS-13760 deterministic child graders."""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess

EVALS = Path(__file__).absolute().parents[1]


def _run_protocol(path: Path, payload: dict) -> dict:
    node = shutil.which("node")
    if node is None:
        raise CheckerInfrastructureError("eval-checker-node-missing")
    try:
        completed = subprocess.run([node, str(path)], input=json.dumps(payload), text=True,
            capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CheckerInfrastructureError("eval-checker-execution-failed") from error
    if completed.returncode != 0 or completed.stderr or len(completed.stdout) > 16_384:
        raise CheckerInfrastructureError("eval-checker-execution-failed")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise CheckerInfrastructureError("eval-checker-output-invalid") from error
    if not isinstance(value, dict):
        raise CheckerInfrastructureError("eval-checker-output-invalid")
    return value


class CheckerInfrastructureError(RuntimeError):
    """A checker installation/protocol fault, never a model case failure."""


def reply_checker(case_id: str, grader_name: str) -> Path | None:
    """Resolve a declared checker without reading its manifest for unrelated cases."""
    key = (case_id, grader_name)
    if case_id != "pm-prd-children-are-scope":
        return None
    plugin_root = EVALS.parent
    if plugin_root.is_symlink() or EVALS.is_symlink() or EVALS.resolve().parent != plugin_root.resolve():
        raise CheckerInfrastructureError("eval-checker-root-invalid")
    root = (EVALS / "checkers").resolve()
    if (EVALS / "checkers").is_symlink():
        raise CheckerInfrastructureError("eval-checker-root-invalid")
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file() or manifest_path.is_symlink():
        raise CheckerInfrastructureError("eval-checker-manifest-missing")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise CheckerInfrastructureError("eval-checker-manifest-invalid") from error
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or not isinstance(
        manifest.get("entries"), list
    ):
        raise CheckerInfrastructureError("eval-checker-manifest-invalid")
    module = root / "iss-13760-reply-format.mjs"
    if not module.is_file() or module.is_symlink() or module.resolve().parent != root:
        raise CheckerInfrastructureError("eval-checker-module-invalid")
    try:
        validated = _run_protocol(module, {"operation": "validate-manifest", "manifest": manifest})
    except CheckerInfrastructureError as error:
        raise CheckerInfrastructureError("eval-checker-manifest-invalid") from error
    if validated != {"valid": True}:
        raise CheckerInfrastructureError("eval-checker-manifest-invalid")
    mappings: dict[tuple[str, str], str] = {}
    for item in manifest["entries"]:
        if not isinstance(item, dict) or set(item) != {"caseId", "graderName", "checker"}:
            raise CheckerInfrastructureError("eval-checker-manifest-invalid")
        entry_key = (item.get("caseId"), item.get("graderName"))
        checker = item.get("checker")
        if (
            not all(isinstance(value, str) for value in entry_key)
            or not isinstance(checker, str)
            or not re.fullmatch(r"[a-z0-9-]+\.mjs", checker)
            or entry_key in mappings
        ):
            raise CheckerInfrastructureError("eval-checker-manifest-invalid")
        mappings[entry_key] = checker
    if key not in mappings:
        return None
    path = root / mappings[key]
    if not path.is_file() or path.is_symlink() or path.resolve().parent != root:
        raise CheckerInfrastructureError("eval-checker-module-invalid")
    return path.resolve()


def run_reply_checker(path: Path, case_id: str, grader_name: str, reply: str) -> tuple[bool, str]:
    """Invoke the shared Node checker and fail closed on protocol or identity drift."""
    value = _run_protocol(path, {"caseId": case_id, "graderName": grader_name, "reply": reply})
    if (
        not isinstance(value, dict)
        or set(value) != {"caseId", "graderName", "passed", "reason"}
        or value.get("caseId") != case_id
        or value.get("graderName") != grader_name
        or not isinstance(value.get("passed"), bool)
        or not isinstance(value.get("reason"), str)
        or not value["reason"]
    ):
        raise CheckerInfrastructureError("eval-checker-output-invalid")
    return value["passed"], value["reason"]
