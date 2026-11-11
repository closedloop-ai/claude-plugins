"""Tests for the generic-vibe regression check and inventory (vibe_generic_scan.py)."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

import vibe_generic_scan as scan

# One sample per gating family, each written the way it once appeared in vibe's runtime files.
SAMPLES = {
    "machine": "see /Users/someone/Source/x",
    "graph": "call closedloop-graph `sync_status` first",
    "memory": "query workflow-memory before planning",
    "repo-identity": "only works in a symphony-alpha checkout",
    "artifact-root": "plans live under .closedloop-ai/vibe-plans",
    "tracker-tool": "call get-me, then update-document",
    "organization": "the ClosedLoop ticket",
    "slug": "publish the PLN for ISS-123",
    "slug-regex": r"const SLUG = /^(?:ISS|PRD|FEA)-\d+$/;",
    "repo-path": "edit apps/desktop or packages\\/design-system",
    "repo-command": "run .closedloop-ai/loops-setup.sh then pnpm test:lanes",
    "repo-workflow": "dispatch vibe-environment.yml",
    "repo-skill": "run /logical-qa and metal-andrew",
    "identity": "sign in to the Clerk org for Acme",
}


def test_every_gating_family_has_a_sample_and_catches_it() -> None:
    assert set(SAMPLES) == scan.GATING_NAMES
    for family, line in SAMPLES.items():
        assert family in scan.families(line, semantic=False), family


@pytest.mark.parametrize("line", [
    "claude plugin install vibe-core@closedloop-ai",
    "https://github.com/closedloop-ai/claude-plugins",
    "use the closedloop-core decision-table skill",
    "the repository's tracker ticket, when a provider is bound",
    "run the repository's own test command from AGENTS.md",
    "IN_REVIEW and Vercel are tracker and host words, not names",
])
def test_vibe_packaging_and_generic_words_do_not_gate(line: str) -> None:
    assert scan.families(line, semantic=False) == ()


def test_semantic_families_describe_rows_without_gating() -> None:
    row = scan.Row("p", 1, scan.families("move the ticket to IN_REVIEW on Vercel"), "x")
    assert row.families and not row.gating


@pytest.mark.parametrize(("relative", "expected"), [
    ("plugins/vibe/skills/vibe/SKILL.md", True),
    ("plugins/vibe-core/hooks/kill-guard.mjs", True),
    ("tools/vibe-workers/src/claude-worker.ts", True),
    (".claude-plugin/marketplace.json", True),
    ("plugins/vibe/skills/cl-sweep/SKILL.md", False),
    ("plugins/vibe/skills/vibe-seed-refresh/SKILL.md", False),
    ("plugins/vibe/agents/vibe-seed-fix-worker.md", False),
    ("plugins/vibe/skills/vibe/scripts/dist/claude-worker.mjs", False),
    ("plugins/vibe/skills/vibe/scripts/vibe-sessions.test.mjs", False),
    ("tools/vibe-workers/src/main-sync-test-fixtures.ts", False),
    ("plugins/vibe/skills/fleet-orchestrator/scripts/fleet-test-support.mjs", False),
    ("plugins/vibe/evals/codex/run.py", False),
    ("plugins/vibe-closedloop-provider/skills/closedloop-provider/SKILL.md", False),
])
def test_gate_scope(relative: str, expected: bool) -> None:
    assert scan.gated(relative) is expected


def write(root: Path, relative: str, text: str) -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_an_injected_forbidden_line_fails_the_gate(tmp_path: Path) -> None:
    write(tmp_path, "plugins/vibe/skills/vibe/SKILL.md", "# Vibe\n\nWorks in any repository.\n")
    write(tmp_path, ".claude-plugin/marketplace.json", '{\n  "name": "closedloop-ai",\n  "description": "generic"\n}\n')
    assert scan.findings(tmp_path) == []
    write(tmp_path, "plugins/vibe/skills/vibe/SKILL.md", "# Vibe\n\nCall closedloop-graph first.\n")
    assert scan.findings(tmp_path) == ["plugins/vibe/skills/vibe/SKILL.md:3 graph,organization: Call closedloop-graph first."]


def test_manifest_publisher_fields_pass_and_descriptions_gate(tmp_path: Path) -> None:
    write(tmp_path, "plugins/vibe/.codex-plugin/plugin.json",
          '{\n  "developerName": "ClosedLoop",\n  "description": "Vibe sessions and ClosedLoop ticket workflows"\n}\n')
    [hit] = scan.findings(tmp_path)
    assert hit.startswith("plugins/vibe/.codex-plugin/plugin.json:3 organization")


def test_snapshot_holds_digests_never_text() -> None:
    rows = [scan.Row("plugins/vibe/x.md", 4, ("machine",), "/Users/someone/Source/secret")]
    [record] = scan.snapshot(rows)
    assert "someone" not in json.dumps(record)
    assert record["digest"] == scan.text_digest("/Users/someone/Source/secret")


def test_diff_accepts_moved_and_mapped_rows_and_reports_dropped_ones(tmp_path: Path) -> None:
    before = scan.snapshot([
        scan.Row("plugins/vibe/a.md", 1, ("graph",), "Call closedloop-graph first."),
        scan.Row("plugins/vibe/b.mjs", 2, ("repo-identity",), 'const REPO = "symphony";'),
        scan.Row("plugins/vibe/c.md", 3, ("slug",), "Publish the PLN."),
    ])
    write(tmp_path, "plugins/vibe-closedloop-provider/skills/x/references/a.md", "Call  closedloop-graph first.\n")
    mapping = {scan.text_digest('const REPO = "symphony";'): "provider.json repository"}
    missing = scan.diff(before, tmp_path, mapping, scan.DIFF_TOPS)
    assert missing == [f"plugins/vibe/c.md:3 slug {scan.text_digest('Publish the PLN.')}"]


def test_an_allowed_line_passes_only_as_written_and_only_with_a_reason(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    allow = tmp_path / "allow.json"
    allow.write_text(json.dumps([{"path": "plugins/vibe/skills/vibe/scripts/a.mjs", "text": "const old = \"clerk-org-id\";",
                                  "reason": "compatibility alias"}]), encoding="utf-8")
    real = scan.allowed_lines
    monkeypatch.setattr(scan, "allowed_lines", lambda path=allow: real(path))
    write(tmp_path, "plugins/vibe/skills/vibe/scripts/a.mjs", "  const old = \"clerk-org-id\";\n")
    assert scan.findings(tmp_path) == []
    write(tmp_path, "plugins/vibe/skills/vibe/scripts/a.mjs", "  const old = \"clerk-org-id\"; // changed\n")
    assert [hit.split(" ")[0] for hit in scan.findings(tmp_path)] == ["plugins/vibe/skills/vibe/scripts/a.mjs:1"]
    write(tmp_path, "plugins/vibe/skills/vibe/scripts/b.mjs", "  const old = \"clerk-org-id\";\n")
    assert any(hit.startswith("plugins/vibe/skills/vibe/scripts/b.mjs:1") for hit in scan.findings(tmp_path)), "an entry covers one file"
    allow.write_text(json.dumps([{"path": "x", "text": "y", "reason": " "}]), encoding="utf-8")
    with pytest.raises(ValueError, match="without a reason"):
        scan.allowed_lines(allow)


def test_every_allowed_line_still_exists_and_still_needs_allowing() -> None:
    for relative, lines in scan.allowed_lines().items():
        present = {line.strip() for line in (scan.REPO / relative).read_text(encoding="utf-8").splitlines()}
        for text in lines:
            assert text in present, f"{relative}: allowed line no longer exists: {text}"
            assert scan.families(text, semantic=False), f"{relative}: allowed line no longer gates: {text}"


def test_a_tracker_key_regex_literal_gates() -> None:
    assert "slug" in scan.families(r'if (!/^ISS-\d+$/.test(request.ticket ?? "")) throw', semantic=False)


def test_the_checked_in_runtime_tree_is_generic() -> None:
    assert scan.findings() == []


SIBLING_ROOT_CALL = re.compile(r"siblingPlugin(?:Root(?:OrNull)?|Install)\(\s*([^,)]+)")


def test_the_provider_root_comes_only_from_its_binding() -> None:
    """vibe reaches the provider through the root its binding recorded, never by locating the sibling plugin."""
    calls = []
    for top in ("plugins/vibe", "plugins/vibe-core", "tools"):
        for path in (scan.REPO / top).rglob("*"):
            if (path.suffix not in {".mjs", ".js", ".ts", ".sh"} or "node_modules" in path.parts or "/dist/" in path.as_posix()
                    or ".test." in path.name):
                continue
            for match in SIBLING_ROOT_CALL.finditer(path.read_text(encoding="utf-8", errors="ignore")):
                calls.append((path.relative_to(scan.REPO).as_posix(), match.group(1).strip()))
    assert calls, "the sibling resolver is still used for vibe-core"
    named = {argument for _, argument in calls}
    assert named <= {'"vibe-core"', '"vibe"', "name"}, calls
    # A variable name reaches only the resolver itself and the startup probe that enumerates installed providers.
    assert all(path.endswith(("plugin-roots.mjs", "lib/vibe/scripts/provider.mjs")) for path, argument in calls if argument == "name"), calls


CODE_MARKERS = re.compile(r"=>|\bawait\s|\bimport\s*[{(*]|\bimport\s+\w+\s+from\b|\bfunction\s*\(|\brequire\(|\bprocess\.\w|\bconsole\.\w|\beval\(")


def _strings(value: object, where: str = "") -> list[tuple[str, str]]:
    if isinstance(value, str):
        return [(where, value)]
    if isinstance(value, dict):
        return [item for key, child in value.items() for item in _strings(child, f"{where}.{key}")]
    if isinstance(value, list):
        return [item for index, child in enumerate(value) for item in _strings(child, f"{where}[{index}]")]
    return []


def test_the_provider_ships_data_never_executable_code() -> None:
    """The provider is text and data: names, paths, commands and matrices. Code vibe runs lives in vibe's own source."""
    contract = json.loads((scan.REPO / "plugins/vibe-closedloop-provider/provider.json").read_text(encoding="utf-8"))
    code = [(where, text[:80]) for where, text in _strings(contract) if CODE_MARKERS.search(text) or text.count("\n") >= 3]
    assert code == []


def test_the_code_check_catches_a_script_in_data() -> None:
    assert CODE_MARKERS.search("const owner=await load('x.mjs');")
    assert CODE_MARKERS.search("import {readFileSync} from 'node:fs';")
    assert not CODE_MARKERS.search("pnpm --filter storybook validate:catalog")
    assert not CODE_MARKERS.search("apps/prototypes/scripts/check-catalog-imports.mjs")
    assert not CODE_MARKERS.search("--eval")
    assert not CODE_MARKERS.search(r"\b(?:ISS|PRD|PLN|FEA)-\d+\b")


RELATIVE_REFERENCE = re.compile(r"(?<![\w/.])((?:\.\./)+[\w./-]*references/[\w.-]+\.md)")


def test_every_relative_reference_in_vibe_resolves() -> None:
    """A reference that moved into the provider is named `provider:<file>`; a `../` path left behind is dangling."""
    dangling = []
    for path in (scan.REPO / "plugins/vibe").rglob("*"):
        if path.suffix not in {".md", ".mjs"} or "/dist/" in path.as_posix() or ".test." in path.name or "/evals/" in path.as_posix():
            continue
        for match in RELATIVE_REFERENCE.finditer(path.read_text(encoding="utf-8", errors="ignore")):
            # A reference file names paths from its skill's root, as SKILL.md does; any other file from its own folder.
            bases = (path.parent, path.parent.parent) if path.parent.name == "references" else (path.parent,)
            if not any((base / match.group(1)).resolve().is_file() for base in bases):
                dangling.append(f"{path.relative_to(scan.REPO)}: {match.group(1)}")
    assert dangling == []


def test_the_provider_text_names_no_ticket_and_no_machine() -> None:
    """The provider may name ClosedLoop and symphony-alpha, but like any plugin text no ticket id and no home path."""
    found = []
    for path in (scan.REPO / "plugins/vibe-closedloop-provider").rglob("*"):
        if not path.is_file():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if re.search(r"\b(?:ISS|PRD|PLN|FEA|PRO)-\d+\b", line) or {"machine"} & set(scan.families(line, semantic=False)):
                found.append(f"{path.relative_to(scan.REPO)}:{number}")
    assert found == []


def test_no_provider_specific_line_of_the_base_was_dropped() -> None:
    """Every gating line of the tree before vibe went generic is kept: in runtime text, in the provider, or in the
    mapping that names what replaced it. The snapshot holds digests only."""
    here = Path(scan.__file__).parent
    before = json.loads((here / "vibe_generic_base.json").read_text(encoding="utf-8"))
    mapping = json.loads((here / "vibe_generic_mapping.json").read_text(encoding="utf-8"))
    assert len(before) > 6000
    assert all(isinstance(reason, str) and reason.strip() for reason in mapping.values())
    assert scan.diff(before, scan.REPO, mapping, scan.DIFF_TOPS) == []
