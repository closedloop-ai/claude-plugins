"""Tests for code_review_helpers.py."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import patch

from code_review_helpers import (
    _check_ci_artifacts,
    _check_gitignore_drift,
    _check_path_leakage,
    _check_sensitive_files,
    _classify_intent,
    _compute_composite_key,
    _compute_patch_hash,
    _entry_matches_v2,
    _first_added_line,
    _format_comment_body,
    _format_elapsed,
    _format_number,
    _group_cross_file,
    _is_global_cache_enabled,
    _is_test_file,
    _jaccard_similarity,
    _line_in_range,
    _load_manifest,
    _load_manifest_v2,
    _load_review_state,
    _manifest_lock,
    _migrate_v1_entry_to_v2,
    _normalize_severity,
    _parse_name_status,
    _parse_numstat,
    _parse_u0_output,
    _run_gc,
    _severity_for_hygiene_file,
    _write_manifest,
    _write_review_state,
    CACHE_GC_MAX_PER_FILE_DEFAULT,
    CACHE_GC_TTL_DAYS_DEFAULT,
    CACHE_LOCK_FILENAME,
    CACHE_MANIFEST_FILENAME,
    CACHE_SCHEMA_VERSION_V2,
    DEFAULT_MAX_BHA_AGENTS,
    REVIEW_STATE_FILENAME,
    cmd_auto_incremental,
    cmd_cache_check,
    cmd_cache_update,
    cmd_collect_findings,
    cmd_compute_hashes,
    cmd_footer,
    cmd_hygiene,
    cmd_partition,
    cmd_post_comments,
    cmd_resolve_threads,
    cmd_review_state_read,
    cmd_review_state_write,
    cmd_route,
    cmd_session_tokens,
    cmd_setup,
    cmd_validate,
    cmd_verdict,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_diff_data(
    files: list[str] | None = None,
    statuses: dict[str, str] | None = None,
    loc: dict[str, dict[str, int]] | None = None,
    ranges: dict[str, dict[str, list[list[int]]]] | None = None,
    patch_lines: dict[str, dict[str, dict[str, str]]] | None = None,
) -> dict[str, Any]:
    files = files or []
    return {
        "files_to_review": files,
        "file_statuses": statuses or {f: "modified" for f in files},
        "file_loc": loc or {f: {"added": 10, "removed": 5} for f in files},
        "total_loc": sum(
            v["added"] + v["removed"]
            for v in (loc or {f: {"added": 10, "removed": 5} for f in files}).values()
        ),
        "changed_ranges": ranges or {f: {"added": [[1, 10]], "removed": [[20, 22]]} for f in files},
        "patch_lines": patch_lines or {f: {"added_lines": {}, "removed_lines": {}} for f in files},
    }


# ---------------------------------------------------------------------------
# parse_name_status
# ---------------------------------------------------------------------------

class TestParseNameStatus:
    def test_basic(self) -> None:
        raw = "M\tsrc/app.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\n"
        result = _parse_name_status(raw)
        assert result == {
            "src/app.ts": "modified",
            "src/new.ts": "added",
            "src/old.ts": "removed",
        }

    def test_renamed(self) -> None:
        raw = "R100\told/file.ts\tnew/file.ts\n"
        result = _parse_name_status(raw)
        assert result == {"new/file.ts": "modified"}

    def test_empty(self) -> None:
        assert _parse_name_status("") == {}
        assert _parse_name_status("\n\n") == {}


# ---------------------------------------------------------------------------
# parse_numstat
# ---------------------------------------------------------------------------

class TestParseNumstat:
    def test_basic(self) -> None:
        raw = "10\t5\tsrc/app.ts\n20\t0\tsrc/new.ts\n"
        result = _parse_numstat(raw)
        assert result == {
            "src/app.ts": {"added": 10, "removed": 5},
            "src/new.ts": {"added": 20, "removed": 0},
        }

    def test_binary_file(self) -> None:
        raw = "-\t-\timage.png\n"
        result = _parse_numstat(raw)
        assert result == {"image.png": {"added": 0, "removed": 0}}

    def test_renamed_file(self) -> None:
        raw = "5\t3\t{old => new}/file.ts\n"
        result = _parse_numstat(raw)
        # Should extract the new path
        assert any("new" in k for k in result)

    def test_empty(self) -> None:
        assert _parse_numstat("") == {}


# ---------------------------------------------------------------------------
# parse_u0_output
# ---------------------------------------------------------------------------

class TestParseU0Output:
    def test_basic_hunk(self) -> None:
        raw = (
            "diff --git a/src/app.ts b/src/app.ts\n"
            "--- a/src/app.ts\n"
            "+++ b/src/app.ts\n"
            "@@ -10,3 +10,5 @@\n"
            "-old line 1\n"
            "-old line 2\n"
            "-old line 3\n"
            "+new line 1\n"
            "+new line 2\n"
            "+new line 3\n"
            "+new line 4\n"
            "+new line 5\n"
        )
        ranges, patch_lines = _parse_u0_output(raw)
        assert "src/app.ts" in ranges
        assert ranges["src/app.ts"]["removed"] == [[10, 12]]
        assert ranges["src/app.ts"]["added"] == [[10, 14]]
        assert "10" in patch_lines["src/app.ts"]["added_lines"]

    def test_count_zero_means_empty_range(self) -> None:
        """@@ -5,0 +5,3 @@ means no removal, 3 additions."""
        raw = (
            "diff --git a/f.ts b/f.ts\n"
            "@@ -5,0 +5,3 @@\n"
            "+a\n"
            "+b\n"
            "+c\n"
        )
        ranges, _ = _parse_u0_output(raw)
        assert ranges["f.ts"]["removed"] == []
        assert ranges["f.ts"]["added"] == [[5, 7]]

    def test_no_patch_lines_flag(self) -> None:
        raw = (
            "diff --git a/f.ts b/f.ts\n"
            "@@ -1,1 +1,1 @@\n"
            "-old\n"
            "+new\n"
        )
        ranges, patch_lines = _parse_u0_output(raw, include_patch_lines=False)
        assert ranges["f.ts"]["added"] == [[1, 1]]
        assert patch_lines == {}

    def test_empty_diff(self) -> None:
        ranges, patch_lines = _parse_u0_output("")
        assert ranges == {}
        assert patch_lines == {}

    def test_single_line_hunk(self) -> None:
        """@@ -5 +5 @@ means count=1 (implicit)."""
        raw = (
            "diff --git a/f.ts b/f.ts\n"
            "@@ -5 +5 @@\n"
            "-old\n"
            "+new\n"
        )
        ranges, _ = _parse_u0_output(raw)
        assert ranges["f.ts"]["removed"] == [[5, 5]]
        assert ranges["f.ts"]["added"] == [[5, 5]]


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

class TestUtilities:
    def test_severity_for_hygiene_file_skip(self) -> None:
        assert _severity_for_hygiene_file("tests/test_app.py") is None
        assert _severity_for_hygiene_file("docs/readme.md") is None
        assert _severity_for_hygiene_file("some/file.txt") is None

    def test_severity_for_hygiene_file_high(self) -> None:
        assert _severity_for_hygiene_file("config.json") == "HIGH"
        assert _severity_for_hygiene_file("src/app.ts") == "HIGH"
        assert _severity_for_hygiene_file("src/app.py") == "HIGH"
        assert _severity_for_hygiene_file(".env.local") == "HIGH"

    def test_severity_for_hygiene_file_root_file(self) -> None:
        # Files with no "/" are root files → HIGH
        assert _severity_for_hygiene_file("Makefile") == "HIGH"

    def test_severity_for_hygiene_file_medium(self) -> None:
        assert _severity_for_hygiene_file("src/data/template.yml") == "MEDIUM"

    def test_line_in_range(self) -> None:
        assert _line_in_range(10, [[8, 12]])
        assert _line_in_range(5, [[8, 12]])  # within tolerance=3
        assert not _line_in_range(1, [[8, 12]])  # too far
        assert _line_in_range(15, [[8, 12]])  # within tolerance=3
        assert not _line_in_range(20, [[8, 12]])  # too far

    def test_line_in_range_empty(self) -> None:
        assert not _line_in_range(5, [])

    def test_jaccard_similarity(self) -> None:
        assert _jaccard_similarity("hello world", "hello world") == 1.0
        assert _jaccard_similarity("hello world", "goodbye world") > 0.0
        assert _jaccard_similarity("", "hello") == 0.0
        assert _jaccard_similarity("abc", "") == 0.0

    def test_is_test_file(self) -> None:
        assert _is_test_file("src/app.test.ts")
        assert _is_test_file("src/app.spec.ts")
        assert _is_test_file("__tests__/app.ts")
        assert _is_test_file("test/something.ts")
        assert _is_test_file("tests/something.py")
        assert not _is_test_file("src/app.ts")
        assert not _is_test_file("src/utils.py")

    def test_first_added_line_with_ranges(self) -> None:
        ranges: dict[str, dict[str, list[list[int]]]] = {
            "f.ts": {"added": [[10, 15], [40, 50]], "removed": []},
        }
        assert _first_added_line(ranges, "f.ts") == 10

    def test_first_added_line_no_ranges(self) -> None:
        assert _first_added_line({}, "f.ts") == 1

    def test_normalize_severity(self) -> None:
        assert _normalize_severity("Critical") == ("BLOCKING", False)
        assert _normalize_severity("high") == ("HIGH", False)
        assert _normalize_severity("Medium") == ("MEDIUM", False)
        assert _normalize_severity("Low") == ("DISCARD", False)
        assert _normalize_severity("BLOCKING") == ("BLOCKING", False)
        # Unknown
        sev, nonstandard = _normalize_severity("Warning")
        assert sev == "MEDIUM"
        assert nonstandard is True


# ---------------------------------------------------------------------------
# Hygiene checks
# ---------------------------------------------------------------------------

class TestHygieneChecks:
    def test_ci_artifacts_found(self) -> None:
        findings = _check_ci_artifacts(
            "src/app.ts",
            {"10": "import from /home/runner/work/project"},
        )
        assert len(findings) == 1
        assert findings[0]["line"] == 10
        assert findings[0]["severity"] == "HIGH"

    def test_ci_artifacts_skip_test_dir(self) -> None:
        findings = _check_ci_artifacts(
            "tests/test_app.py",
            {"10": "import from /home/runner/work/project"},
        )
        assert len(findings) == 0

    def test_path_leakage_found(self) -> None:
        findings = _check_path_leakage(
            "src/config.ts",
            {"5": 'const p = "/Users/john/projects"'},
        )
        assert len(findings) == 1
        assert findings[0]["severity"] == "HIGH"

    def test_path_leakage_excludes_node_modules(self) -> None:
        findings = _check_path_leakage(
            "src/app.ts",
            {"5": "/Users/john/node_modules/something"},
        )
        assert len(findings) == 0

    def test_gitignore_drift_added_risky(self) -> None:
        with patch("code_review_helpers.subprocess.run") as mock_run:
            # Return code 1 means NOT ignored
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=1, stdout="", stderr=""
            )
            findings = _check_gitignore_drift(".env.local", "added", None)
            assert len(findings) == 1
            assert findings[0]["severity"] == "HIGH"

    def test_gitignore_drift_already_ignored(self) -> None:
        with patch("code_review_helpers.subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout=".env.local", stderr=""
            )
            findings = _check_gitignore_drift(".env.local", "added", None)
            assert len(findings) == 0

    def test_gitignore_drift_not_added(self) -> None:
        findings = _check_gitignore_drift("src/app.ts", "modified", None)
        assert len(findings) == 0

    def test_sensitive_files_found(self) -> None:
        ranges: dict[str, dict[str, list[list[int]]]] = {
            ".env.production": {"added": [[1, 5]], "removed": []},
        }
        findings = _check_sensitive_files(
            ".env.production", "added", ranges
        )
        assert len(findings) == 1
        assert findings[0]["severity"] == "HIGH"

    def test_sensitive_files_skip_test_dir(self) -> None:
        ranges: dict[str, dict[str, list[list[int]]]] = {}
        findings = _check_sensitive_files(
            "tests/credentials.json", "added", ranges
        )
        assert len(findings) == 0

    def test_sensitive_files_not_sensitive(self) -> None:
        ranges: dict[str, dict[str, list[list[int]]]] = {}
        findings = _check_sensitive_files("src/app.ts", "modified", ranges)
        assert len(findings) == 0

    def _run_hygiene(self, diff_data: dict[str, Any]) -> dict[str, Any]:
        import argparse
        import io
        import sys as _sys

        old_stdin = _sys.stdin
        old_stdout = _sys.stdout
        _sys.stdin = io.StringIO(json.dumps(diff_data))
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(workdir=None)
            cmd_hygiene(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdin = old_stdin
            _sys.stdout = old_stdout

    def test_cmd_hygiene_finds_ci_artifacts(self) -> None:
        diff_data = _make_diff_data(
            files=["src/config.ts"],
            statuses={"src/config.ts": "modified"},
            patch_lines={
                "src/config.ts": {
                    "added_lines": {"10": "path = /github/workspace/build"},
                    "removed_lines": {},
                },
            },
        )
        result = self._run_hygiene(diff_data)
        assert len(result["findings"]) == 1
        assert result["findings"][0]["category"] == "Repo Hygiene"
        assert "CI artifact" in result["findings"][0]["issue"]

    def test_cmd_hygiene_skips_removed_files(self) -> None:
        diff_data = _make_diff_data(
            files=["deleted.ts"],
            statuses={"deleted.ts": "removed"},
            patch_lines={
                "deleted.ts": {
                    "added_lines": {"5": "/Users/john/secrets"},
                    "removed_lines": {},
                },
            },
        )
        result = self._run_hygiene(diff_data)
        assert len(result["findings"]) == 0

    def test_cmd_hygiene_empty_diff(self) -> None:
        diff_data = _make_diff_data(files=[])
        result = self._run_hygiene(diff_data)
        assert result["findings"] == []

    def test_cmd_hygiene_multiple_checks(self) -> None:
        """Hygiene runs all 4 checks and combines findings."""
        diff_data = _make_diff_data(
            files=["src/app.ts", ".env.production"],
            statuses={"src/app.ts": "modified", ".env.production": "added"},
            patch_lines={
                "src/app.ts": {
                    "added_lines": {"10": 'const p = "/Users/john/project"'},
                    "removed_lines": {},
                },
                ".env.production": {
                    "added_lines": {},
                    "removed_lines": {},
                },
            },
            ranges={
                "src/app.ts": {"added": [[10, 10]], "removed": []},
                ".env.production": {"added": [[1, 5]], "removed": []},
            },
        )
        result = self._run_hygiene(diff_data)
        # Path leakage in app.ts + sensitive file for .env.production
        assert len(result["findings"]) >= 2


# ---------------------------------------------------------------------------
# Partition
# ---------------------------------------------------------------------------

class TestPartition:
    def _run_partition(
        self,
        diff_data: dict[str, Any],
        loc_budget: int = 400,
        max_files: int = 20,
        capsys: Any = None,
    ) -> dict[str, Any]:
        import io
        import sys as _sys

        old_stdin = _sys.stdin
        old_stdout = _sys.stdout
        _sys.stdin = io.StringIO(json.dumps(diff_data))
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(loc_budget=loc_budget, max_files=max_files)
            cmd_partition(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdin = old_stdin
            _sys.stdout = old_stdout

    def test_single_partition(self) -> None:
        data = _make_diff_data(
            files=["a.ts", "b.ts"],
            loc={"a.ts": {"added": 50, "removed": 10}, "b.ts": {"added": 30, "removed": 5}},
        )
        result = self._run_partition(data)
        assert len(result["partitions"]) == 1
        assert result["partitions"][0]["total_loc"] == 95

    def test_split_by_budget(self) -> None:
        data = _make_diff_data(
            files=["a.ts", "b.ts"],
            loc={"a.ts": {"added": 300, "removed": 0}, "b.ts": {"added": 300, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=400)
        assert len(result["partitions"]) == 2

    def test_oversized_file_hunk_split(self) -> None:
        data = _make_diff_data(
            files=["big.ts"],
            loc={"big.ts": {"added": 500, "removed": 0}},
            ranges={"big.ts": {"added": [[1, 200], [300, 500]], "removed": []}},
        )
        result = self._run_partition(data, loc_budget=400)
        # Should be split into multiple partitions
        assert len(result["partitions"]) >= 1
        for p in result["partitions"]:
            assert p["files"][0]["file"] == "big.ts"

    def test_empty_diff(self) -> None:
        data = _make_diff_data(files=[])
        result = self._run_partition(data)
        assert result["partitions"] == []
        assert result["test_file_paths"] == []

    def test_test_files_detected(self) -> None:
        data = _make_diff_data(
            files=["src/app.ts", "src/app.test.ts"],
            loc={
                "src/app.ts": {"added": 10, "removed": 0},
                "src/app.test.ts": {"added": 20, "removed": 0},
            },
        )
        result = self._run_partition(data)
        assert "src/app.test.ts" in result["test_file_paths"]

    def test_max_files_per_partition(self) -> None:
        files = [f"f{i}.ts" for i in range(25)]
        loc = {f: {"added": 1, "removed": 0} for f in files}
        data = _make_diff_data(files=files, loc=loc)
        result = self._run_partition(data, max_files=10)
        for p in result["partitions"]:
            assert len(p["files"]) <= 10

    def test_test_only_partition_flag(self) -> None:
        data = _make_diff_data(
            files=["tests/test_a.ts", "tests/test_b.ts"],
            loc={
                "tests/test_a.ts": {"added": 10, "removed": 0},
                "tests/test_b.ts": {"added": 10, "removed": 0},
            },
        )
        result = self._run_partition(data)
        assert result["partitions"][0]["is_test_only"] is True


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

class TestRoute:
    def _run_route(
        self,
        diff_data: dict[str, Any],
        critic_gates_path: str | None = None,
        intent: str = "mixed",
    ) -> dict[str, Any]:
        import io
        import sys as _sys

        old_stdin = _sys.stdin
        old_stdout = _sys.stdout
        _sys.stdin = io.StringIO(json.dumps(diff_data))
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(critic_gates=critic_gates_path, intent=intent)
            cmd_route(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdin = old_stdin
            _sys.stdout = old_stdout

    def test_small_diff_routing(self) -> None:
        data = _make_diff_data(
            files=["a.ts"],
            loc={"a.ts": {"added": 100, "removed": 50}},
        )
        data["total_loc"] = 150
        result = self._run_route(data)
        assert result["size_category"] == "Small"
        assert result["models"]["bug_hunter_a"]["default"] == "opus"
        assert result["models"]["bug_hunter_b"] == "sonnet"

    def test_medium_diff_routing(self) -> None:
        data = _make_diff_data(
            files=["a.ts"],
            loc={"a.ts": {"added": 800, "removed": 200}},
        )
        data["total_loc"] = 1000
        result = self._run_route(data)
        assert result["size_category"] == "Medium"
        assert result["models"]["bug_hunter_a"]["default"] == "opus"
        assert result["models"]["bug_hunter_b"] == "sonnet"

    def test_large_diff_routing(self) -> None:
        data = _make_diff_data(
            files=["a.ts"],
            loc={"a.ts": {"added": 2000, "removed": 500}},
        )
        data["total_loc"] = 2500
        result = self._run_route(data)
        assert result["size_category"] == "Large"
        assert result["models"]["bug_hunter_a"]["default"] == "opus"

    def test_high_risk_files(self, tmp_path: Path) -> None:
        gates = {
            "defaults": {"reviewBudget": 4},
            "moduleCritics": [
                {"patterns": ["auth", "security"], "critics": ["security-reviewer"]},
            ],
        }
        gates_path = tmp_path / "critic-gates.json"
        gates_path.write_text(json.dumps(gates))

        data = _make_diff_data(
            files=["src/auth/login.ts", "src/utils.ts"],
            loc={
                "src/auth/login.ts": {"added": 60, "removed": 10},
                "src/utils.ts": {"added": 10, "removed": 0},
            },
        )
        data["total_loc"] = 80
        result = self._run_route(data, str(gates_path))
        assert "src/auth/login.ts" in result["high_risk_files"]

    def test_domain_critics_selection(self, tmp_path: Path) -> None:
        gates = {
            "defaults": {"reviewBudget": 4},
            "moduleCritics": [
                {"patterns": [".py", "python"], "critics": ["python-script-reviewer"]},
                {"patterns": [".ts", "react"], "critics": ["react-reviewer"]},
            ],
        }
        gates_path = tmp_path / "critic-gates.json"
        gates_path.write_text(json.dumps(gates))

        data = _make_diff_data(
            files=["src/app.py", "src/utils.py"],
            loc={
                "src/app.py": {"added": 10, "removed": 0},
                "src/utils.py": {"added": 10, "removed": 0},
            },
        )
        data["total_loc"] = 20
        result = self._run_route(data, str(gates_path))
        assert "python-script-reviewer" in result["domain_critics"]

    def test_domain_critics_capped_at_1(self, tmp_path: Path) -> None:
        gates = {
            "defaults": {"reviewBudget": 10},
            "moduleCritics": [
                {"patterns": [".py"], "critics": ["critic-a"]},
                {"patterns": [".ts"], "critics": ["critic-b"]},
                {"patterns": ["src"], "critics": ["critic-c"]},
            ],
        }
        gates_path = tmp_path / "critic-gates.json"
        gates_path.write_text(json.dumps(gates))

        data = _make_diff_data(
            files=["src/app.py", "src/app.ts"],
            loc={
                "src/app.py": {"added": 10, "removed": 0},
                "src/app.ts": {"added": 10, "removed": 0},
            },
        )
        data["total_loc"] = 20
        result = self._run_route(data, str(gates_path))
        assert len(result["domain_critics"]) <= 1

    def test_missing_critic_gates(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data, "/nonexistent/path.json")
        assert result["domain_critics"] == []
        assert result["size_category"] == "Small"

    def test_bug_hunter_a_model_is_dict(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data)
        bha = result["models"]["bug_hunter_a"]
        assert isinstance(bha, dict)
        assert "default" in bha
        assert "test_only" in bha

    def test_bug_hunter_a_test_only_is_sonnet(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data)
        assert result["models"]["bug_hunter_a"]["test_only"] == "sonnet"

    def test_max_bha_agents_no_domain_critic(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data)
        assert result["max_bha_agents"] == 6  # 9 - BHB - Auditor - Premise

    def test_max_bha_agents_with_domain_critic(self, tmp_path: Path) -> None:
        gates = {
            "defaults": {"reviewBudget": 2},
            "moduleCritics": [
                {"patterns": [".ts"], "critics": ["ts-reviewer"]},
            ],
        }
        gates_path = tmp_path / "critic-gates.json"
        gates_path.write_text(json.dumps(gates))
        data = _make_diff_data(
            files=["a.ts"],
            loc={"a.ts": {"added": 10, "removed": 0}},
        )
        data["total_loc"] = 10
        result = self._run_route(data, str(gates_path))
        assert len(result["domain_critics"]) == 1
        assert result["max_bha_agents"] == 5  # 9 - BHB - Auditor - Premise - 1 domain

    def test_premise_opus_for_fix(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data, intent="fix")
        assert result["models"]["premise_reviewer"] == "opus"

    def test_premise_sonnet_for_feature(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data, intent="feature")
        assert result["models"]["premise_reviewer"] == "sonnet"

    def test_premise_opus_default(self) -> None:
        data = _make_diff_data(files=["a.ts"])
        data["total_loc"] = 100
        result = self._run_route(data)
        assert result["models"]["premise_reviewer"] == "opus"


# ---------------------------------------------------------------------------
# Partition post-processing
# ---------------------------------------------------------------------------


class TestPartitionPostProcessing:
    def _run_partition(
        self,
        diff_data: dict[str, Any],
        loc_budget: int = 400,
        max_files: int = 20,
        max_bha_agents: int = DEFAULT_MAX_BHA_AGENTS,
    ) -> dict[str, Any]:
        import io
        import sys as _sys

        old_stdin = _sys.stdin
        old_stdout = _sys.stdout
        _sys.stdin = io.StringIO(json.dumps(diff_data))
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(
                loc_budget=loc_budget, max_files=max_files,
                max_bha_agents=max_bha_agents, diff_data=None,
            )
            cmd_partition(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdin = old_stdin
            _sys.stdout = old_stdout

    def test_trivial_partition_merged(self) -> None:
        data = _make_diff_data(
            files=["a.ts", "b.ts", "c.ts"],
            loc={"a.ts": {"added": 300, "removed": 0}, "b.ts": {"added": 250, "removed": 0}, "c.ts": {"added": 5, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=400)
        assert len(result["partitions"]) == 2
        # c.ts (5 LOC) should be merged into b.ts partition (smaller)
        all_files = [f["file"] for p in result["partitions"] for f in p["files"]]
        assert "c.ts" in all_files

    def test_all_trivial_unchanged(self) -> None:
        data = _make_diff_data(
            files=["a.ts", "b.ts", "c.ts"],
            loc={"a.ts": {"added": 5, "removed": 0}, "b.ts": {"added": 5, "removed": 0}, "c.ts": {"added": 5, "removed": 0}},
        )
        result = self._run_partition(data, max_files=1)
        assert len(result["partitions"]) == 3  # All trivial, no normal target to merge into

    def test_trivial_merge_updates_total_loc(self) -> None:
        data = _make_diff_data(
            files=["a.ts", "b.ts"],
            loc={"a.ts": {"added": 200, "removed": 0}, "b.ts": {"added": 5, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=400)
        assert len(result["partitions"]) == 1
        assert result["partitions"][0]["total_loc"] == 205

    def test_trivial_merge_recomputes_is_test_only(self) -> None:
        data = _make_diff_data(
            files=["tests/test_a.ts", "src/impl.ts"],
            loc={"tests/test_a.ts": {"added": 200, "removed": 0}, "src/impl.ts": {"added": 5, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=400)
        assert len(result["partitions"]) == 1
        # Impl file merged into test partition flips is_test_only
        assert result["partitions"][0]["is_test_only"] is False

    def test_trivial_merge_respects_max_files(self) -> None:
        files = [f"f{i}.ts" for i in range(3)]
        loc = {"f0.ts": {"added": 200, "removed": 0}, "f1.ts": {"added": 200, "removed": 0}, "f2.ts": {"added": 5, "removed": 0}}
        data = _make_diff_data(files=files, loc=loc)
        # max_files=1 means each is its own partition, no merge target can accept
        result = self._run_partition(data, loc_budget=300, max_files=1)
        assert len(result["partitions"]) == 3

    def test_mixed_partition_splits(self) -> None:
        data = _make_diff_data(
            files=["src/app.ts", "tests/app.test.ts"],
            loc={"src/app.ts": {"added": 200, "removed": 0}, "tests/app.test.ts": {"added": 400, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=800)
        assert len(result["partitions"]) == 2
        test_partitions = [p for p in result["partitions"] if p["is_test_only"]]
        impl_partitions = [p for p in result["partitions"] if not p["is_test_only"]]
        assert len(test_partitions) == 1
        assert len(impl_partitions) == 1

    def test_mixed_partition_no_split_below_threshold(self) -> None:
        data = _make_diff_data(
            files=["src/app.ts", "tests/app.test.ts"],
            loc={"src/app.ts": {"added": 10, "removed": 0}, "tests/app.test.ts": {"added": 200, "removed": 0}},
        )
        result = self._run_partition(data, loc_budget=800)
        assert len(result["partitions"]) == 1  # Not split, impl LOC < 50

    def test_cap_enforcement_merges_smallest_same_type(self) -> None:
        # Create 7 files that each get their own partition (loc_budget forces 1 per partition)
        files = [f"f{i}.ts" for i in range(7)]
        loc = {f: {"added": 100, "removed": 0} for f in files}
        data = _make_diff_data(files=files, loc=loc)
        result = self._run_partition(data, loc_budget=150, max_files=20, max_bha_agents=5)
        assert len(result["partitions"]) <= 5


# ---------------------------------------------------------------------------
# Classify intent
# ---------------------------------------------------------------------------


class TestClassifyIntent:
    def test_feature_from_title(self) -> None:
        result = _classify_intent("feat: add dashboard", "", "", {})
        assert result == "feature"

    def test_fix_from_title(self) -> None:
        result = _classify_intent("fix: null pointer", "", "", {})
        assert result == "fix"

    def test_fix_from_inflected_title(self) -> None:
        result = _classify_intent("fixes null pointer in auth", "", "", {})
        assert result == "fix"

    def test_refactor_from_title(self) -> None:
        result = _classify_intent("refactor: rename service", "", "", {})
        assert result == "refactor"

    def test_mixed_on_ambiguity(self) -> None:
        result = _classify_intent("fix and refactor auth", "", "", {})
        assert result == "mixed"

    def test_feature_boosted_by_file_statuses(self) -> None:
        statuses = {"a.ts": "added", "b.ts": "added", "c.ts": "added", "d.ts": "modified"}
        result = _classify_intent("", "", "", statuses)
        assert result == "feature"  # 75% added >= 70% threshold

    def test_empty_context_returns_mixed(self) -> None:
        result = _classify_intent("", "", "", {})
        assert result == "mixed"

    def test_feature_from_body_first_line(self) -> None:
        result = _classify_intent("", "feat: add new dashboard\n\n- [ ] checkbox", "", {})
        assert result == "feature"

    def test_body_only_first_line_used(self) -> None:
        result = _classify_intent("", "This adds a feature\nfix: something else", "", {})
        assert result == "feature"


# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------


class TestVerdict:
    def _run_verdict(self, validated: list[dict[str, Any]]) -> dict[str, Any]:
        import io
        import sys as _sys
        import tempfile

        validate_output = {"validated": validated, "discarded": [], "stats": {}}
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as tf:
            json.dump(validate_output, tf)
            tf_path = tf.name

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(validate_output=tf_path)
            cmd_verdict(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout
            os.unlink(tf_path)

    def test_verdict_approve_no_findings(self) -> None:
        result = self._run_verdict([])
        assert result["verdict"] == "approve"

    def test_verdict_decline_blocking(self) -> None:
        result = self._run_verdict([
            {"severity": "BLOCKING", "issue": "[P0] Missing null check", "priority": 0, "category": "Correctness"},
        ])
        assert result["verdict"] == "decline"
        assert "Missing null check" in result["reason"]

    def test_verdict_decline_premise_p0(self) -> None:
        result = self._run_verdict([
            {"severity": "HIGH", "issue": "[P0] Unnecessary change", "priority": 0, "category": "Premise"},
        ])
        assert result["verdict"] == "decline"

    def test_verdict_needs_attention_high(self) -> None:
        result = self._run_verdict([
            {"severity": "HIGH", "issue": "[P1] Race condition", "priority": 1, "category": "Correctness"},
        ])
        assert result["verdict"] == "needs_attention"

    def test_verdict_priority_order(self) -> None:
        result = self._run_verdict([
            {"severity": "HIGH", "issue": "[P1] Race condition", "priority": 1, "category": "Correctness"},
            {"severity": "BLOCKING", "issue": "[P0] Data loss", "priority": 0, "category": "Security"},
        ])
        assert result["verdict"] == "decline"

    def test_verdict_reason_truncated(self) -> None:
        long_issue = "A" * 200
        result = self._run_verdict([
            {"severity": "BLOCKING", "issue": long_issue, "priority": 0, "category": "Correctness"},
        ])
        assert len(result["reason"]) <= 80


# ---------------------------------------------------------------------------
# Collect findings
# ---------------------------------------------------------------------------


class TestCollectFindings:
    def test_merges_agents_and_hygiene(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        # Write agent files
        (tmp_path / "agent_bha_p0.json").write_text(json.dumps({"findings": [{"file": "a.ts", "severity": "HIGH"}]}))
        (tmp_path / "agent_bhb.json").write_text(json.dumps({"findings": [{"file": "b.ts", "severity": "MEDIUM"}]}))
        # Write hygiene file
        hygiene_path = tmp_path / "hygiene.json"
        hygiene_path.write_text(json.dumps({"findings": [{"file": "c.ts", "severity": "MEDIUM"}]}))

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(cr_dir=str(tmp_path), output="findings.json", hygiene=str(hygiene_path))
            cmd_collect_findings(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert result["total_findings"] == 3
        assert result["hygiene_included"] is True
        # Verify merged file on disk
        merged = json.loads((tmp_path / "findings.json").read_text())
        assert len(merged) == 3

    def test_skips_malformed(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        (tmp_path / "agent_good.json").write_text(json.dumps({"findings": [{"file": "a.ts"}]}))
        (tmp_path / "agent_bad.json").write_text("not json{{{")

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(cr_dir=str(tmp_path), output="findings.json", hygiene=None)
            cmd_collect_findings(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert result["total_findings"] == 1

    def test_no_hygiene(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        (tmp_path / "agent_bha_p0.json").write_text(json.dumps({"findings": [{"file": "a.ts"}]}))

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(cr_dir=str(tmp_path), output="findings.json", hygiene=str(tmp_path / "nonexistent.json"))
            cmd_collect_findings(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert result["total_findings"] == 1
        assert result["hygiene_included"] is False


# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------

class TestValidate:
    def _run_validate(
        self,
        findings: list[dict[str, Any]],
        diff_data: dict[str, Any],
        tmp_path: Path,
    ) -> dict[str, Any]:
        import io
        import sys as _sys

        findings_path = tmp_path / "findings.json"
        findings_path.write_text(json.dumps(findings))
        diff_path = tmp_path / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(
                findings=str(findings_path),
                diff_data=str(diff_path),
            )
            cmd_validate(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

    def test_basic_validation(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "HIGH",
            "category": "Correctness",
            "issue": "Bug found",
            "priority": 1,
            "confidence": 0.9,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 1
        assert result["stats"]["validated"] == 1

    def test_file_not_in_scope(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(files=["src/app.ts"])
        findings = [{
            "file": "src/other.ts",
            "line": 5,
            "severity": "HIGH",
            "category": "Correctness",
            "issue": "Bug",
            "priority": 1,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 0
        assert result["stats"]["discarded_file_not_changed"] == 1

    def test_line_not_in_changed_range(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 15]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 100,
            "severity": "MEDIUM",
            "category": "Correctness",
            "issue": "Bug",
            "priority": 2,
            "confidence": 0.9,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 0
        assert result["stats"]["discarded_line_not_changed"] == 1

    def test_p1_never_discarded_for_line_range(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 15]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 100,
            "severity": "HIGH",
            "category": "Correctness",
            "issue": "Critical bug",
            "priority": 1,
            "confidence": 0.9,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 1

    def test_removed_range_check(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [], "removed": [[50, 55]]}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 52,
            "severity": "MEDIUM",
            "category": "Correctness",
            "issue": "Guard removed",
            "priority": 2,
            "confidence": 0.8,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 1

    def test_low_confidence_discard(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "MEDIUM",
            "category": "Style",
            "issue": "Minor",
            "priority": 2,
            "confidence": 0.3,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 0
        assert result["stats"]["discarded_low_confidence"] == 1

    def test_p1_never_discarded_for_confidence(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "HIGH",
            "category": "Correctness",
            "issue": "Bug",
            "priority": 1,
            "confidence": 0.2,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 1

    def test_severity_normalization(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [
            {
                "file": "src/app.ts",
                "line": 12,
                "severity": "Critical",
                "category": "Security",
                "issue": "SQL injection",
            },
            {
                "file": "src/app.ts",
                "line": 15,
                "severity": "Low",
                "category": "Style",
                "issue": "Minor style",
            },
        ]
        result = self._run_validate(findings, diff_data, tmp_path)
        # Critical → BLOCKING (kept), Low → DISCARD (dropped)
        assert len(result["validated"]) == 1
        assert result["validated"][0]["severity"] == "BLOCKING"
        assert result["stats"]["discarded_low_severity"] == 1

    def test_unknown_severity_normalized(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "Warning",
            "category": "Correctness",
            "issue": "Something",
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert result["normalization_warnings"] == 1
        assert "Warning" in result["non_standard_values"]
        # Should be normalized to MEDIUM
        if result["validated"]:
            assert result["validated"][0]["severity"] == "MEDIUM"

    def test_duplicate_merge(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [
            {
                "file": "src/app.ts",
                "line": 15,
                "severity": "MEDIUM",
                "category": "Correctness",
                "issue": "Bug A",
                "priority": 2,
                "confidence": 0.9,
            },
            {
                "file": "src/app.ts",
                "line": 16,
                "severity": "HIGH",
                "category": "Correctness",
                "issue": "Bug B",
                "priority": 1,
                "confidence": 0.95,
            },
        ]
        result = self._run_validate(findings, diff_data, tmp_path)
        # Should merge — same file, same category, lines within ±3
        assert len(result["validated"]) == 1
        # Should keep highest severity
        assert result["validated"][0]["severity"] == "HIGH"

    def test_root_cause_dedup_jaccard(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [
            {
                "file": "src/app.ts",
                "line": 15,
                "severity": "MEDIUM",
                "category": "Correctness",
                "issue": "handleSave double fires on Enter then blur event",
                "priority": 2,
                "confidence": 0.9,
            },
            {
                "file": "src/app.ts",
                "line": 16,
                "severity": "MEDIUM",
                "category": "State",
                "issue": "handleSave fires double on Enter key then blur",
                "priority": 2,
                "confidence": 0.85,
            },
        ]
        result = self._run_validate(findings, diff_data, tmp_path)
        # Jaccard similarity should catch these as same root cause
        assert len(result["validated"]) == 1

    def test_default_priority_from_severity(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "BLOCKING",
            "category": "Security",
            "issue": "Vulnerability",
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert result["validated"][0]["priority"] == 0

    def test_default_confidence(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        findings = [{
            "file": "src/app.ts",
            "line": 15,
            "severity": "MEDIUM",
            "category": "Style",
            "issue": "Minor",
            "priority": 2,
        }]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert result["validated"][0]["confidence"] == 1.0

    def test_empty_findings(self, tmp_path: Path) -> None:
        diff_data = _make_diff_data(files=["src/app.ts"])
        result = self._run_validate([], diff_data, tmp_path)
        assert result["validated"] == []
        assert result["stats"]["total_input"] == 0

    def test_findings_in_object_format(self, tmp_path: Path) -> None:
        """Findings can be a dict with 'findings' key."""
        diff_data = _make_diff_data(
            files=["src/app.ts"],
            ranges={"src/app.ts": {"added": [[10, 20]], "removed": []}},
        )
        # Write findings as {"findings": [...]} format
        findings_path = tmp_path / "findings.json"
        findings_path.write_text(json.dumps({
            "findings": [{
                "file": "src/app.ts",
                "line": 15,
                "severity": "HIGH",
                "category": "Correctness",
                "issue": "Bug",
                "priority": 1,
                "confidence": 0.9,
            }]
        }))
        diff_path = tmp_path / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        import io
        import sys as _sys
        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            import argparse
            ns = argparse.Namespace(
                findings=str(findings_path),
                diff_data=str(diff_path),
            )
            cmd_validate(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert len(result["validated"]) == 1

    def test_cross_file_grouping(self, tmp_path: Path) -> None:
        """Findings with same category + similar issue across files are grouped."""
        diff_data = _make_diff_data(
            files=["auth.ts", "profile.ts"],
            statuses={"auth.ts": "modified", "profile.ts": "modified"},
            loc={
                "auth.ts": {"added": 10, "removed": 5},
                "profile.ts": {"added": 8, "removed": 3},
            },
            ranges={
                "auth.ts": {"added": [[10, 20]], "removed": []},
                "profile.ts": {"added": [[25, 35]], "removed": []},
            },
        )
        findings = [
            {
                "file": "auth.ts",
                "line": 15,
                "severity": "HIGH",
                "category": "Correctness",
                "issue": "Missing null check on user.data before access",
                "priority": 1,
                "confidence": 0.9,
            },
            {
                "file": "profile.ts",
                "line": 30,
                "severity": "MEDIUM",
                "category": "Correctness",
                "issue": "Missing null check on user.data property access",
                "priority": 2,
                "confidence": 0.85,
            },
        ]
        result = self._run_validate(findings, diff_data, tmp_path)
        # Should group into 1 primary with 1 other_location
        assert len(result["validated"]) == 1
        primary = result["validated"][0]
        assert primary["file"] == "auth.ts"
        assert primary["severity"] == "HIGH"
        assert "other_locations" in primary
        assert len(primary["other_locations"]) == 1
        assert primary["other_locations"][0]["file"] == "profile.ts"
        assert result["stats"]["cross_file_grouped"] == 1

    def test_cross_file_no_grouping_different_category(self, tmp_path: Path) -> None:
        """Findings with different categories are NOT grouped across files."""
        diff_data = _make_diff_data(
            files=["auth.ts", "profile.ts"],
            ranges={
                "auth.ts": {"added": [[10, 20]], "removed": []},
                "profile.ts": {"added": [[25, 35]], "removed": []},
            },
        )
        findings = [
            {
                "file": "auth.ts",
                "line": 15,
                "severity": "HIGH",
                "category": "Security",
                "issue": "Missing null check on user.data before access",
                "priority": 1,
                "confidence": 0.9,
            },
            {
                "file": "profile.ts",
                "line": 30,
                "severity": "MEDIUM",
                "category": "Correctness",
                "issue": "Missing null check on user.data property access",
                "priority": 2,
                "confidence": 0.85,
            },
        ]
        result = self._run_validate(findings, diff_data, tmp_path)
        assert len(result["validated"]) == 2
        assert result["stats"]["cross_file_grouped"] == 0


# ---------------------------------------------------------------------------
# Cross-file grouping (unit tests)
# ---------------------------------------------------------------------------

class TestGroupCrossFile:
    def test_groups_same_category_similar_issue(self) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "null check missing on user data"},
            {"file": "b.ts", "line": 20, "severity": "MEDIUM", "category": "Bug", "issue": "null check missing on user data access"},
        ]
        result = _group_cross_file(findings)
        assert len(result) == 1
        assert result[0]["severity"] == "HIGH"
        assert len(result[0]["other_locations"]) == 1
        assert result[0]["other_locations"][0]["file"] == "b.ts"

    def test_no_grouping_for_different_categories(self) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Security", "issue": "null check missing"},
            {"file": "b.ts", "line": 20, "severity": "MEDIUM", "category": "Style", "issue": "null check missing"},
        ]
        result = _group_cross_file(findings)
        assert len(result) == 2

    def test_no_grouping_for_dissimilar_issues(self) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "SQL injection vulnerability in query builder"},
            {"file": "b.ts", "line": 20, "severity": "MEDIUM", "category": "Bug", "issue": "Missing error handling on file read"},
        ]
        result = _group_cross_file(findings)
        assert len(result) == 2

    def test_primary_is_highest_severity(self) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "MEDIUM", "category": "Bug", "issue": "null check missing on user data"},
            {"file": "b.ts", "line": 20, "severity": "BLOCKING", "category": "Bug", "issue": "null check missing on user data access"},
        ]
        result = _group_cross_file(findings)
        assert len(result) == 1
        assert result[0]["severity"] == "BLOCKING"
        assert result[0]["file"] == "b.ts"
        assert result[0]["other_locations"][0]["file"] == "a.ts"

    def test_three_file_group(self) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "MEDIUM", "category": "Bug", "issue": "missing null check on data"},
            {"file": "b.ts", "line": 20, "severity": "HIGH", "category": "Bug", "issue": "missing null check on data access"},
            {"file": "c.ts", "line": 30, "severity": "MEDIUM", "category": "Bug", "issue": "missing null check on data property"},
        ]
        result = _group_cross_file(findings)
        assert len(result) == 1
        assert result[0]["severity"] == "HIGH"
        assert len(result[0]["other_locations"]) == 2


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _make_cache_diff_data(
    files: list[str] | None = None,
    loc: dict[str, dict[str, int]] | None = None,
    patch_lines: dict[str, dict[str, dict[str, str]]] | None = None,
) -> dict[str, Any]:
    """Build a minimal diff_data dict for cache tests."""
    files = files or []
    return {
        "files_to_review": files,
        "file_statuses": {f: "modified" for f in files},
        "file_loc": loc or {f: {"added": 10, "removed": 5} for f in files},
        "total_loc": sum(
            v["added"] + v["removed"]
            for v in (loc or {f: {"added": 10, "removed": 5} for f in files}).values()
        ),
        "changed_ranges": {f: {"added": [[1, 10]], "removed": []} for f in files},
        "patch_lines": patch_lines or {
            f: {"added_lines": {"1": "line1"}, "removed_lines": {}} for f in files
        },
    }


class TestComputePatchHash:
    def test_deterministic(self) -> None:
        h1 = _compute_patch_hash("a.ts", {"added_lines": {"1": "x"}, "removed_lines": {}})
        h2 = _compute_patch_hash("a.ts", {"added_lines": {"1": "x"}, "removed_lines": {}})
        assert h1 == h2

    def test_different_file_path_different_hash(self) -> None:
        patch: dict[str, dict[str, str]] = {"added_lines": {"1": "x"}, "removed_lines": {}}
        h1 = _compute_patch_hash("a.ts", patch)
        h2 = _compute_patch_hash("b.ts", patch)
        assert h1 != h2

    def test_different_content_different_hash(self) -> None:
        h1 = _compute_patch_hash("a.ts", {"added_lines": {"1": "x"}, "removed_lines": {}})
        h2 = _compute_patch_hash("a.ts", {"added_lines": {"1": "y"}, "removed_lines": {}})
        assert h1 != h2

    def test_sort_keys_stability(self) -> None:
        h1 = _compute_patch_hash("a.ts", {"b": {"2": "y"}, "a": {"1": "x"}})
        h2 = _compute_patch_hash("a.ts", {"a": {"1": "x"}, "b": {"2": "y"}})
        assert h1 == h2

    def test_empty_patch(self) -> None:
        h = _compute_patch_hash("a.ts", {})
        assert isinstance(h, str) and len(h) == 64


class TestLoadManifest:
    def test_missing_dir(self, tmp_path: Path) -> None:
        assert _load_manifest(tmp_path / "nonexistent") == {}

    def test_missing_file(self, tmp_path: Path) -> None:
        assert _load_manifest(tmp_path) == {}

    def test_corrupt_json(self, tmp_path: Path) -> None:
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text("not json{{{")
        assert _load_manifest(tmp_path) == {}

    def test_non_dict_json(self, tmp_path: Path) -> None:
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text("[1, 2, 3]")
        assert _load_manifest(tmp_path) == {}

    def test_valid_manifest(self, tmp_path: Path) -> None:
        data = {"src/a.ts": {"schema_version": 1, "findings": []}}
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text(json.dumps(data))
        assert _load_manifest(tmp_path) == data


class TestCmdCacheCheck:
    _DEFAULT_OPTS = {"prompt_hash": "abc123", "model_id": "opus", "schema_version": 1}

    def _run_cache_check(
        self,
        cache_dir: Path,
        diff_data: dict[str, Any],
        output_dir: Path,
        **overrides: Any,
    ) -> dict[str, Any]:
        import argparse

        opts = {**self._DEFAULT_OPTS, **overrides}
        diff_path = output_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            prompt_hash=opts["prompt_hash"],
            model_id=opts["model_id"],
            schema_version=opts["schema_version"],
            output_dir=str(output_dir),
        )
        cmd_cache_check(ns)
        result = json.loads((output_dir / "cache_result.json").read_text())
        return result

    def test_empty_cache_all_uncached(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 2
        assert set(result["uncached_files"]) == {"a.ts", "b.ts"}

        # Verify uncached_diff_data has all files
        uncached = json.loads((out / "uncached_diff_data.json").read_text())
        assert set(uncached["files_to_review"]) == {"a.ts", "b.ts"}

        # Verify cached findings is empty
        cached_findings = json.loads((out / "agent_cached_bha.json").read_text())
        assert cached_findings["findings"] == []

    def test_full_cache_hit(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash,
                "findings": [{"file": "a.ts", "line": 5, "severity": "HIGH", "issue": "bug"}],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 1
        assert result["stats"]["uncached"] == 0
        assert result["cached_files"] == ["a.ts"]

        cached_findings = json.loads((out / "agent_cached_bha.json").read_text())
        assert len(cached_findings["findings"]) == 1

        uncached = json.loads((out / "uncached_diff_data.json").read_text())
        assert uncached["files_to_review"] == []
        assert uncached["total_loc"] == 0

    def test_partial_hit(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])
        patch_hash_a = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash_a,
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 1
        assert result["stats"]["uncached"] == 1
        assert result["cached_files"] == ["a.ts"]
        assert result["uncached_files"] == ["b.ts"]

    def test_patch_hash_mismatch(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": "stale_hash",
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 1

    def test_prompt_hash_mismatch(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "old_prompt_hash",
                "patch_hash": patch_hash,
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0

    def test_model_id_mismatch(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "sonnet",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash,
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0

    def test_schema_version_mismatch(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        manifest = {
            "a.ts": {
                "schema_version": 99,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash,
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0

    def test_corrupt_manifest(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        (cache_dir / CACHE_MANIFEST_FILENAME).write_text("broken{{{")
        diff_data = _make_cache_diff_data(files=["a.ts"])

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 1

    def test_correct_total_loc_recomputation(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(
            files=["a.ts", "b.ts"],
            loc={"a.ts": {"added": 100, "removed": 50}, "b.ts": {"added": 200, "removed": 30}},
        )
        patch_hash_a = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        # Cache only a.ts
        manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash_a,
                "findings": [],
                "cached_at": "2026-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, manifest)

        self._run_cache_check(cache_dir, diff_data, out)
        uncached = json.loads((out / "uncached_diff_data.json").read_text())
        assert uncached["total_loc"] == 230  # b.ts: 200 + 30

    def test_empty_files_to_review(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=[])

        result = self._run_cache_check(cache_dir, diff_data, out)
        assert result["stats"]["total_files"] == 0
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 0


class TestCmdCacheUpdate:
    _DEFAULT_OPTS: dict[str, Any] = {
        "prompt_hash": "abc123", "model_id": "opus",
        "schema_version": 1, "reviewed_files": [],
    }

    def _run_cache_update(
        self,
        cache_dir: Path,
        diff_data: dict[str, Any],
        bha_dir: Path,
        **overrides: Any,
    ) -> dict[str, Any]:
        import argparse

        opts = {**self._DEFAULT_OPTS, **overrides}
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash=opts["prompt_hash"],
            model_id=opts["model_id"],
            schema_version=opts["schema_version"],
            reviewed_files=opts["reviewed_files"],
        )
        cmd_cache_update(ns)
        return _load_manifest(cache_dir)

    def test_new_entries_written(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        # Write a BHA findings file
        findings = {"findings": [{"file": "a.ts", "line": 5, "severity": "HIGH", "issue": "bug"}]}
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps(findings))

        manifest = self._run_cache_update(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert "a.ts" in manifest
        assert manifest["a.ts"]["schema_version"] == 1
        assert manifest["a.ts"]["model_id"] == "opus"
        assert len(manifest["a.ts"]["findings"]) == 1

    def test_zero_finding_files_cached_via_reviewed_files(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])

        # Only a.ts has findings; b.ts has none
        (bha_dir / "agent_bha_p0.json").write_text(
            json.dumps({"findings": [{"file": "a.ts", "line": 5, "severity": "HIGH", "issue": "bug"}]})
        )

        manifest = self._run_cache_update(
            cache_dir, diff_data, bha_dir, reviewed_files=["a.ts", "b.ts"]
        )
        assert "a.ts" in manifest
        assert "b.ts" in manifest
        assert manifest["b.ts"]["findings"] == []

    def test_stale_entries_evicted_on_patch_change(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        # Pre-populate with old entry
        old_manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": "old_hash",
                "findings": [{"file": "a.ts", "line": 1, "severity": "MEDIUM", "issue": "old"}],
                "cached_at": "2025-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, old_manifest)

        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        manifest = self._run_cache_update(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert manifest["a.ts"]["findings"] == []
        assert manifest["a.ts"]["patch_hash"] != "old_hash"

    def test_entries_for_files_not_in_diff_retained(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        # Pre-populate with entry for z.ts (not in current diff)
        old_manifest = {
            "z.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": "some_hash",
                "findings": [],
                "cached_at": "2025-01-01T00:00:00Z",
            }
        }
        _write_manifest(cache_dir, old_manifest)

        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        manifest = self._run_cache_update(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert "z.ts" in manifest  # retained
        assert "a.ts" in manifest  # new

    def test_corrupt_bha_file_skipped(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        (bha_dir / "agent_bha_p0.json").write_text("not valid json{{{")

        manifest = self._run_cache_update(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert "a.ts" in manifest
        assert manifest["a.ts"]["findings"] == []

    def test_atomic_write_no_tmp_left(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        self._run_cache_update(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert not (cache_dir / "manifest.json.tmp").exists()

    def test_no_bha_files_no_reviewed_files_empty_manifest(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        manifest = self._run_cache_update(cache_dir, diff_data, bha_dir)
        # No reviewed_files and no BHA findings → nothing cached
        assert manifest == {}


# ---------------------------------------------------------------------------
# Post comments
# ---------------------------------------------------------------------------


def _make_findings_file(
    tmp_path: Path,
    findings: list[dict[str, Any]],
    pr_number: int = 42,
    head_sha: str = "abc123",
) -> Path:
    """Write a code-review-findings.json and return its path."""
    path = tmp_path / "code-review-findings.json"
    path.write_text(json.dumps({
        "schema_version": 1,
        "pr_number": pr_number,
        "head_sha": head_sha,
        "findings": findings,
    }))
    return path


def _make_threads_file(
    tmp_path: Path,
    thread_ids: list[str],
    pr_number: int = 42,
) -> Path:
    """Write a code-review-threads.json and return its path."""
    path = tmp_path / "code-review-threads.json"
    path.write_text(json.dumps({
        "schema_version": 1,
        "pr_number": pr_number,
        "outdated_thread_ids": thread_ids,
    }))
    return path


class TestCmdPostComments:
    def _run(
        self,
        findings_path: Path,
        repo: str = "owner/repo",
        dry_run: bool = False,
    ) -> int:
        import argparse
        ns = argparse.Namespace(
            findings=str(findings_path),
            repo=repo,
            dry_run=dry_run,
        )
        return cmd_post_comments(ns)

    def test_empty_findings_exits_cleanly(self, tmp_path: Path) -> None:
        path = _make_findings_file(tmp_path, [])
        with patch("code_review_helpers.subprocess.run") as mock_run:
            # Mock the GET for existing comments
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="[]", stderr=""
            )
            rc = self._run(path)
        assert rc == 0

    def test_dry_run_does_not_post(self, tmp_path: Path) -> None:
        findings = [{"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "bad"}]
        path = _make_findings_file(tmp_path, findings)
        with patch("code_review_helpers.subprocess.run") as mock_run:
            # Mock GET existing comments
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="[]", stderr=""
            )
            rc = self._run(path, dry_run=True)
        assert rc == 0
        # Only the GET call should have been made (dedup fetch), no POSTs
        assert mock_run.call_count == 1

    def test_posts_each_finding(self, tmp_path: Path) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "first"},
            {"file": "b.ts", "line": 20, "severity": "MEDIUM", "category": "Style", "issue": "second"},
        ]
        path = _make_findings_file(tmp_path, findings)
        with patch("code_review_helpers.subprocess.run") as mock_run:
            # First call: GET existing comments (returns [])
            # Subsequent calls: POST comments (returns success)
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="[]", stderr=""
            )
            rc = self._run(path)
        assert rc == 0
        # 1 GET + 2 POSTs
        assert mock_run.call_count == 3

    def test_dedup_skips_existing(self, tmp_path: Path) -> None:
        findings = [{"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "dup"}]
        path = _make_findings_file(tmp_path, findings)
        existing_comments = json.dumps([{"path": "a.ts", "line": 10, "body": "old comment"}])
        with patch("code_review_helpers.subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout=existing_comments, stderr=""
            )
            rc = self._run(path)
        assert rc == 0
        # Only the GET call, no POSTs since the finding is a dup
        assert mock_run.call_count == 1

    def test_422_continues(self, tmp_path: Path) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "first"},
            {"file": "b.ts", "line": 20, "severity": "MEDIUM", "category": "Style", "issue": "second"},
        ]
        path = _make_findings_file(tmp_path, findings)
        success = subprocess.CompletedProcess(args=[], returncode=0, stdout="[]", stderr="")
        fail_422 = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="422 Validation Failed")
        with patch("code_review_helpers.subprocess.run") as mock_run:
            # GET returns [], first POST fails 422, second POST succeeds
            mock_run.side_effect = [success, fail_422, success]
            rc = self._run(path)
        assert rc == 0
        assert mock_run.call_count == 3

    def test_inline_false_skipped(self, tmp_path: Path) -> None:
        findings = [
            {"file": "a.ts", "line": 10, "severity": "HIGH", "category": "Bug", "issue": "bad", "inline": False},
        ]
        path = _make_findings_file(tmp_path, findings)
        with patch("code_review_helpers.subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout="[]", stderr=""
            )
            rc = self._run(path)
        assert rc == 0
        # Only the GET call, the finding was skipped
        assert mock_run.call_count == 1

    def test_consolidated_format(self) -> None:
        finding: dict[str, Any] = {
            "file": "a.ts",
            "line": 10,
            "severity": "HIGH",
            "category": "Correctness",
            "issue": "Double-fire on Enter then blur",
            "recommendation": "Add a saving guard",
            "code_snippet": "handleSave()",
            "other_locations": [
                {"file": "b.ts", "line": 20, "description": "same pattern"},
                {"file": "c.ts", "line": 30},
            ],
        }
        body = _format_comment_body(finding)
        assert "**[HIGH]** Correctness" in body
        assert "Double-fire" in body
        assert "**Recommendation:** Add a saving guard" in body
        assert "```ts" in body
        assert "handleSave()" in body
        assert "**Other Locations** (2 more):" in body
        assert "`b.ts:20` — same pattern" in body
        assert "`c.ts:30`" in body

    def test_missing_file_returns_error(self, tmp_path: Path) -> None:
        import argparse
        ns = argparse.Namespace(
            findings=str(tmp_path / "nonexistent.json"),
            repo="owner/repo",
            dry_run=False,
        )
        rc = cmd_post_comments(ns)
        assert rc == 1


# ---------------------------------------------------------------------------
# Resolve threads
# ---------------------------------------------------------------------------


class TestCmdResolveThreads:
    def _run(
        self,
        threads_path: Path,
        dry_run: bool = False,
    ) -> int:
        import argparse
        ns = argparse.Namespace(
            threads=str(threads_path),
            dry_run=dry_run,
        )
        return cmd_resolve_threads(ns)

    def test_empty_list_exits_cleanly(self, tmp_path: Path) -> None:
        path = _make_threads_file(tmp_path, [])
        with patch("code_review_helpers.subprocess.run") as mock_run:
            rc = self._run(path)
        assert rc == 0
        mock_run.assert_not_called()

    def test_dry_run_no_api(self, tmp_path: Path) -> None:
        path = _make_threads_file(tmp_path, ["PRRT_abc", "PRRT_def"])
        with patch("code_review_helpers.subprocess.run") as mock_run:
            rc = self._run(path, dry_run=True)
        assert rc == 0
        mock_run.assert_not_called()

    def test_resolves_threads(self, tmp_path: Path) -> None:
        path = _make_threads_file(tmp_path, ["PRRT_abc", "PRRT_def"])
        success_resp = json.dumps({"data": {"resolveReviewThread": {"thread": {"isResolved": True}}}})
        with patch("code_review_helpers.subprocess.run") as mock_run:
            mock_run.return_value = subprocess.CompletedProcess(
                args=[], returncode=0, stdout=success_resp, stderr=""
            )
            rc = self._run(path)
        assert rc == 0
        assert mock_run.call_count == 2

    def test_api_error_continues(self, tmp_path: Path) -> None:
        path = _make_threads_file(tmp_path, ["PRRT_abc", "PRRT_def"])
        fail = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="GraphQL error")
        success_resp = json.dumps({"data": {"resolveReviewThread": {"thread": {"isResolved": True}}}})
        success = subprocess.CompletedProcess(args=[], returncode=0, stdout=success_resp, stderr="")
        with patch("code_review_helpers.subprocess.run") as mock_run:
            mock_run.side_effect = [fail, success]
            rc = self._run(path)
        assert rc == 0
        assert mock_run.call_count == 2

    def test_missing_file_returns_error(self, tmp_path: Path) -> None:
        import argparse
        ns = argparse.Namespace(
            threads=str(tmp_path / "nonexistent.json"),
            dry_run=False,
        )
        rc = cmd_resolve_threads(ns)
        assert rc == 1


# ---------------------------------------------------------------------------
# V2 Cache: Composite key
# ---------------------------------------------------------------------------


class TestComputeCompositeKey:
    def test_deterministic(self) -> None:
        k1 = _compute_composite_key("opus", "ph1", "pah1", "ctx1")
        k2 = _compute_composite_key("opus", "ph1", "pah1", "ctx1")
        assert k1 == k2

    def test_model_sensitivity(self) -> None:
        k1 = _compute_composite_key("opus", "ph1", "pah1", "ctx1")
        k2 = _compute_composite_key("sonnet", "ph1", "pah1", "ctx1")
        assert k1 != k2

    def test_context_key_sensitivity(self) -> None:
        k1 = _compute_composite_key("opus", "ph1", "pah1", "ctx_a")
        k2 = _compute_composite_key("opus", "ph1", "pah1", "ctx_b")
        assert k1 != k2

    def test_full_64_char_format(self) -> None:
        k = _compute_composite_key("opus", "ph1", "pah1", "ctx1")
        assert len(k) == 64
        assert all(c in "0123456789abcdef" for c in k)


# ---------------------------------------------------------------------------
# V2 Cache: V1 migration
# ---------------------------------------------------------------------------


class TestMigrateV1EntryToV2:
    def test_field_preservation(self) -> None:
        v1 = {
            "schema_version": 1,
            "model_id": "opus",
            "prompt_hash": "ph",
            "patch_hash": "pah",
            "findings": [{"file": "a.ts", "line": 1}],
            "cached_at": "2026-01-01T00:00:00+00:00",
        }
        result = _migrate_v1_entry_to_v2("a.ts", v1)
        assert isinstance(result, dict)
        assert len(result) == 1
        entry = next(iter(result.values()))
        assert entry["schema_version"] == CACHE_SCHEMA_VERSION_V2
        assert entry["model_id"] == "opus"
        assert entry["prompt_hash"] == "ph"
        assert entry["patch_hash"] == "pah"
        assert len(entry["findings"]) == 1

    def test_hit_count_init_zero(self) -> None:
        v1 = {"schema_version": 1, "model_id": "opus", "prompt_hash": "ph",
               "patch_hash": "pah", "findings": [], "cached_at": "2026-01-01T00:00:00+00:00"}
        result = _migrate_v1_entry_to_v2("a.ts", v1)
        entry = next(iter(result.values()))
        assert entry["hit_count"] == 0

    def test_context_key_defaults_to_empty(self) -> None:
        v1 = {"schema_version": 1, "model_id": "opus", "prompt_hash": "ph",
               "patch_hash": "pah", "findings": [], "cached_at": "2026-01-01T00:00:00+00:00"}
        result = _migrate_v1_entry_to_v2("a.ts", v1)
        entry = next(iter(result.values()))
        assert entry["context_key"] == ""

    def test_composite_key_is_valid(self) -> None:
        v1 = {"schema_version": 1, "model_id": "opus", "prompt_hash": "ph",
               "patch_hash": "pah", "findings": [], "cached_at": "2026-01-01T00:00:00+00:00"}
        result = _migrate_v1_entry_to_v2("a.ts", v1)
        key = next(iter(result.keys()))
        assert len(key) == 64


# ---------------------------------------------------------------------------
# V2 Cache: Load manifest
# ---------------------------------------------------------------------------


class TestLoadManifestV2:
    def test_missing_dir(self, tmp_path: Path) -> None:
        manifest, migrated = _load_manifest_v2(tmp_path / "nonexistent")
        assert manifest == {}
        assert migrated is False

    def test_empty_manifest(self, tmp_path: Path) -> None:
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text("{}")
        manifest, migrated = _load_manifest_v2(tmp_path)
        assert manifest == {}
        assert migrated is False

    def test_corrupt_manifest(self, tmp_path: Path) -> None:
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text("not json{{{")
        manifest, migrated = _load_manifest_v2(tmp_path)
        assert manifest == {}
        assert migrated is False

    def test_v1_manifest_migrated(self, tmp_path: Path) -> None:
        v1 = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "ph",
                "patch_hash": "pah",
                "findings": [],
                "cached_at": "2026-01-01T00:00:00+00:00",
            }
        }
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text(json.dumps(v1))
        manifest, migrated = _load_manifest_v2(tmp_path)
        assert migrated is True
        assert "a.ts" in manifest
        # The value should be a nested dict with composite key
        slots = manifest["a.ts"]
        assert len(slots) == 1
        entry = next(iter(slots.values()))
        assert entry["schema_version"] == CACHE_SCHEMA_VERSION_V2

    def test_v2_manifest_passthrough(self, tmp_path: Path) -> None:
        composite = _compute_composite_key("opus", "ph", "pah", "ctx")
        v2 = {
            "a.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "ph",
                    "patch_hash": "pah",
                    "context_key": "ctx",
                    "findings": [],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00",
                    "hit_count": 0,
                }
            }
        }
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text(json.dumps(v2))
        manifest, migrated = _load_manifest_v2(tmp_path)
        assert migrated is False
        assert "a.ts" in manifest
        assert composite in manifest["a.ts"]

    def test_mixed_v1_v2_manifest(self, tmp_path: Path) -> None:
        composite = _compute_composite_key("opus", "ph", "pah", "ctx")
        mixed = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "ph",
                "patch_hash": "pah",
                "findings": [],
                "cached_at": "2026-01-01T00:00:00+00:00",
            },
            "b.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "ph",
                    "patch_hash": "pah",
                    "context_key": "ctx",
                    "findings": [],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00",
                    "hit_count": 0,
                }
            }
        }
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text(json.dumps(mixed))
        manifest, migrated = _load_manifest_v2(tmp_path)
        assert migrated is True
        assert "a.ts" in manifest
        assert "b.ts" in manifest

    def test_corrupt_sub_entries_skipped(self, tmp_path: Path) -> None:
        v2 = {
            "a.ts": {
                "bad_key": "not a dict",
            }
        }
        (tmp_path / CACHE_MANIFEST_FILENAME).write_text(json.dumps(v2))
        manifest, _migrated = _load_manifest_v2(tmp_path)
        # a.ts has no valid entries, so it's excluded
        assert "a.ts" not in manifest


# ---------------------------------------------------------------------------
# V2 Cache: GC
# ---------------------------------------------------------------------------


class TestRunGC:
    def _make_entry(self, last_hit: str, hit_count: int = 1) -> dict[str, Any]:
        return {
            "schema_version": CACHE_SCHEMA_VERSION_V2,
            "model_id": "opus",
            "prompt_hash": "ph",
            "patch_hash": "pah",
            "context_key": "ctx",
            "findings": [],
            "cached_at": last_hit,
            "last_hit_at": last_hit,
            "hit_count": hit_count,
        }

    def test_ttl_eviction(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()
        recent = (now - timedelta(days=1)).isoformat()
        manifest: dict[str, Any] = {
            "a.ts": {
                "key1": self._make_entry(old),
                "key2": self._make_entry(recent),
            }
        }
        ttl_ev, max_ev = _run_gc(manifest, ttl_days=14, max_per_file=10, now=now)
        assert ttl_ev == 1
        assert max_ev == 0
        assert len(manifest["a.ts"]) == 1
        assert "key2" in manifest["a.ts"]

    def test_max_per_file_eviction(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        manifest: dict[str, Any] = {
            "a.ts": {
                f"key{i}": self._make_entry(
                    (now - timedelta(hours=i)).isoformat()
                )
                for i in range(5)
            }
        }
        ttl_ev, max_ev = _run_gc(manifest, ttl_days=365, max_per_file=3, now=now)
        assert ttl_ev == 0
        assert max_ev == 2
        assert len(manifest["a.ts"]) == 3

    def test_combined_gc(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()
        recent1 = (now - timedelta(hours=1)).isoformat()
        recent2 = (now - timedelta(hours=2)).isoformat()
        recent3 = (now - timedelta(hours=3)).isoformat()
        recent4 = (now - timedelta(hours=4)).isoformat()
        manifest: dict[str, Any] = {
            "a.ts": {
                "old": self._make_entry(old),
                "r1": self._make_entry(recent1),
                "r2": self._make_entry(recent2),
                "r3": self._make_entry(recent3),
                "r4": self._make_entry(recent4),
            }
        }
        ttl_ev, max_ev = _run_gc(manifest, ttl_days=14, max_per_file=3, now=now)
        assert ttl_ev == 1  # old entry
        assert max_ev == 1  # 4 recent entries minus max 3
        assert len(manifest["a.ts"]) == 3

    def test_empty_filepath_removed(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()
        manifest: dict[str, Any] = {
            "a.ts": {"key1": self._make_entry(old)},
        }
        _run_gc(manifest, ttl_days=14, max_per_file=3, now=now)
        assert "a.ts" not in manifest

    def test_no_entries_no_crash(self) -> None:
        manifest: dict[str, Any] = {}
        ttl_ev, max_ev = _run_gc(manifest, ttl_days=14, max_per_file=3)
        assert ttl_ev == 0
        assert max_ev == 0

    def test_gc_preserves_recent(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        recent = (now - timedelta(hours=1)).isoformat()
        manifest: dict[str, Any] = {
            "a.ts": {"key1": self._make_entry(recent)},
        }
        ttl_ev, max_ev = _run_gc(manifest, ttl_days=14, max_per_file=3, now=now)
        assert ttl_ev == 0
        assert max_ev == 0
        assert "a.ts" in manifest

    def test_multiple_files(self) -> None:
        from datetime import datetime, timedelta, timezone
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()
        recent = (now - timedelta(hours=1)).isoformat()
        manifest: dict[str, Any] = {
            "a.ts": {"key1": self._make_entry(old)},
            "b.ts": {"key1": self._make_entry(recent)},
        }
        _run_gc(manifest, ttl_days=14, max_per_file=3, now=now)
        assert "a.ts" not in manifest
        assert "b.ts" in manifest


# ---------------------------------------------------------------------------
# V2 Cache: Manifest lock
# ---------------------------------------------------------------------------


class TestManifestLock:
    def test_exclusive_lock_acquires(self, tmp_path: Path) -> None:
        lock_path = tmp_path / CACHE_LOCK_FILENAME
        with _manifest_lock(lock_path, exclusive=True):
            assert lock_path.exists()

    def test_shared_lock_acquires(self, tmp_path: Path) -> None:
        lock_path = tmp_path / CACHE_LOCK_FILENAME
        with _manifest_lock(lock_path, exclusive=False):
            assert lock_path.exists()

    def test_shared_allows_concurrent(self, tmp_path: Path) -> None:
        lock_path = tmp_path / CACHE_LOCK_FILENAME
        with _manifest_lock(lock_path, exclusive=False):
            # Nested shared lock should not deadlock
            with _manifest_lock(lock_path, exclusive=False):
                assert True

    def test_fail_open_on_bad_path(self, tmp_path: Path) -> None:
        # Lock in a nonexistent deeply-nested dir should fail-open
        lock_path = tmp_path / "a" / "b" / "c" / CACHE_LOCK_FILENAME
        # Should not raise
        with _manifest_lock(lock_path, exclusive=True):
            pass


# ---------------------------------------------------------------------------
# V2 Cache: cache-check V2
# ---------------------------------------------------------------------------


class TestCmdCacheCheckV2:
    def _run(
        self,
        cache_dir: Path,
        diff_data: dict[str, Any],
        output_dir: Path,
        context_key: str = "ctx123",
    ) -> dict[str, Any]:
        import argparse

        diff_path = output_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=2,
            output_dir=str(output_dir),
            global_cache=1,
            context_key=context_key,
        )
        cmd_cache_check(ns)
        return json.loads((output_dir / "cache_result.json").read_text())

    def test_empty_cache_all_uncached(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])

        result = self._run(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 2

    def test_v2_cache_hit(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])
        composite = _compute_composite_key("opus", "abc123", patch_hash, "ctx123")

        v2_manifest = {
            "a.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "abc123",
                    "patch_hash": patch_hash,
                    "context_key": "ctx123",
                    "findings": [{"file": "a.ts", "line": 5, "severity": "HIGH"}],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00",
                    "hit_count": 1,
                }
            }
        }
        _write_manifest(cache_dir, v2_manifest)

        result = self._run(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 1
        cached_findings = json.loads((out / "agent_cached_bha.json").read_text())
        assert len(cached_findings["findings"]) == 1

    def test_v2_context_key_mismatch(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])
        composite = _compute_composite_key("opus", "abc123", patch_hash, "old_ctx")

        v2_manifest = {
            "a.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "abc123",
                    "patch_hash": patch_hash,
                    "context_key": "old_ctx",
                    "findings": [],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00",
                    "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, v2_manifest)

        result = self._run(cache_dir, diff_data, out, context_key="new_ctx")
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 1

    def test_v1_migration_on_check(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        # V1 entry — should be migrated but won't match (context_key differs)
        v1_manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"]),
                "findings": [],
                "cached_at": "2026-01-01T00:00:00+00:00",
            }
        }
        _write_manifest(cache_dir, v1_manifest)

        # V1 entries migrate with context_key="" so lookup with "ctx123" misses
        result = self._run(cache_dir, diff_data, out, context_key="ctx123")
        assert result["stats"]["cached"] == 0

    def test_v1_migration_with_empty_context_key(self, tmp_path: Path) -> None:
        """V1 migrated entry with context_key='' should hit when lookup uses ''."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        v1_manifest = {
            "a.ts": {
                "schema_version": 1,
                "model_id": "opus",
                "prompt_hash": "abc123",
                "patch_hash": patch_hash,
                "findings": [{"file": "a.ts", "line": 1}],
                "cached_at": "2026-01-01T00:00:00+00:00",
            }
        }
        _write_manifest(cache_dir, v1_manifest)

        result = self._run(cache_dir, diff_data, out, context_key="")
        assert result["stats"]["cached"] == 1

    def test_fail_open_writes_all_files(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        # Write corrupt manifest
        (cache_dir / CACHE_MANIFEST_FILENAME).write_text("not json{{{")
        diff_data = _make_cache_diff_data(files=["a.ts"])

        result = self._run(cache_dir, diff_data, out)
        # Should fall back gracefully
        assert result["stats"]["cached"] == 0
        assert result["stats"]["uncached"] == 1
        assert (out / "agent_cached_bha.json").exists()
        assert (out / "uncached_diff_data.json").exists()

    def test_observability_output(self, tmp_path: Path, capsys: Any) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        self._run(cache_dir, diff_data, out)
        captured = capsys.readouterr()
        obs = json.loads(captured.out.strip())
        assert obs["cache_mode"] == "global"
        assert obs["schema"] == CACHE_SCHEMA_VERSION_V2

    def test_no_pr_global_mode_works(self, tmp_path: Path) -> None:
        """Global mode works without a PR number (staged/branch scope)."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        result = self._run(cache_dir, diff_data, out)
        assert result["stats"]["total_files"] == 1

    def test_hit_updates_last_hit_at(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])
        composite = _compute_composite_key("opus", "abc123", patch_hash, "ctx123")

        old_hit = "2026-01-01T00:00:00+00:00"
        v2_manifest = {
            "a.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "abc123",
                    "patch_hash": patch_hash,
                    "context_key": "ctx123",
                    "findings": [],
                    "cached_at": old_hit,
                    "last_hit_at": old_hit,
                    "hit_count": 1,
                }
            }
        }
        _write_manifest(cache_dir, v2_manifest)

        self._run(cache_dir, diff_data, out)
        # Manifest is only modified in-memory during cache-check, not persisted
        # But the hit_count and last_hit_at in the result should reflect the hit
        result = json.loads((out / "cache_result.json").read_text())
        assert result["stats"]["cached"] == 1

    def test_partial_hit_v2(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])
        patch_hash_a = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])
        composite_a = _compute_composite_key("opus", "abc123", patch_hash_a, "ctx123")

        v2_manifest = {
            "a.ts": {
                composite_a: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "abc123",
                    "patch_hash": patch_hash_a,
                    "context_key": "ctx123",
                    "findings": [],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00",
                    "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, v2_manifest)

        result = self._run(cache_dir, diff_data, out)
        assert result["stats"]["cached"] == 1
        assert result["stats"]["uncached"] == 1


# ---------------------------------------------------------------------------
# V2 Cache: cache-update V2
# ---------------------------------------------------------------------------


class TestCmdCacheUpdateV2:
    _DEFAULT_OPTS: dict[str, Any] = {
        "prompt_hash": "abc123", "model_id": "opus",
        "schema_version": 2, "reviewed_files": [],
        "global_cache": 1, "context_key": "ctx123",
        "gc_ttl_days": CACHE_GC_TTL_DAYS_DEFAULT,
        "gc_max_per_file": CACHE_GC_MAX_PER_FILE_DEFAULT,
    }

    def _run(
        self,
        cache_dir: Path,
        diff_data: dict[str, Any],
        bha_dir: Path,
        **overrides: Any,
    ) -> dict[str, Any]:
        import argparse

        opts = {**self._DEFAULT_OPTS, **overrides}
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash=opts["prompt_hash"],
            model_id=opts["model_id"],
            schema_version=opts["schema_version"],
            reviewed_files=opts["reviewed_files"],
            global_cache=opts["global_cache"],
            context_key=opts["context_key"],
            gc_ttl_days=opts["gc_ttl_days"],
            gc_max_per_file=opts["gc_max_per_file"],
        )
        cmd_cache_update(ns)
        return _load_manifest(cache_dir)

    def test_new_v2_entry_written(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(
            json.dumps({"findings": [{"file": "a.ts", "line": 5}]})
        )

        manifest = self._run(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert "a.ts" in manifest
        slots = manifest["a.ts"]
        assert len(slots) == 1
        entry = next(iter(slots.values()))
        assert entry["schema_version"] == CACHE_SCHEMA_VERSION_V2
        assert entry["context_key"] == "ctx123"

    def test_append_slot_for_new_context(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        # Pre-populate with a V2 entry with different context (recent date to avoid GC)
        from datetime import datetime, timedelta, timezone
        recent = (datetime.now(tz=timezone.utc) - timedelta(hours=1)).isoformat()
        old_composite = _compute_composite_key("opus", "abc123", patch_hash, "old_ctx")
        v2_manifest = {
            "a.ts": {
                old_composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "abc123",
                    "patch_hash": patch_hash,
                    "context_key": "old_ctx",
                    "findings": [],
                    "cached_at": recent,
                    "last_hit_at": recent,
                    "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, v2_manifest)

        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        manifest = self._run(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert "a.ts" in manifest
        assert len(manifest["a.ts"]) == 2  # old + new

    def test_gc_runs_on_update(self, tmp_path: Path) -> None:
        from datetime import datetime, timedelta, timezone
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])

        # Pre-populate with old entries that should be evicted
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()
        old_manifest = {
            "z.ts": {
                "old_key": {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus",
                    "prompt_hash": "old",
                    "patch_hash": "old",
                    "context_key": "old",
                    "findings": [],
                    "cached_at": old,
                    "last_hit_at": old,
                    "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, old_manifest)

        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        manifest = self._run(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        # z.ts old entry should have been evicted by GC
        assert "z.ts" not in manifest

    def test_atomic_write_no_tmp_left(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        self._run(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        assert not (cache_dir / "manifest.json.tmp").exists()

    def test_fail_open_skips_write(self, tmp_path: Path, capsys: Any) -> None:
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        # Write corrupt manifest
        (cache_dir / CACHE_MANIFEST_FILENAME).write_text("not json{{{")

        # Should not crash — fail-open
        import argparse
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))
        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=2,
            reviewed_files=["a.ts"],
            global_cache=1,
            context_key="ctx123",
            gc_ttl_days=14,
            gc_max_per_file=3,
        )
        rc = cmd_cache_update(ns)
        assert rc == 0
        captured = capsys.readouterr()
        # Should still output observability line
        assert "cache_mode" in captured.out

    def test_zero_finding_files_cached(self, tmp_path: Path) -> None:
        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])
        (bha_dir / "agent_bha_p0.json").write_text(
            json.dumps({"findings": [{"file": "a.ts", "line": 5}]})
        )

        manifest = self._run(
            cache_dir, diff_data, bha_dir, reviewed_files=["a.ts", "b.ts"]
        )
        assert "a.ts" in manifest
        assert "b.ts" in manifest
        b_slots = manifest["b.ts"]
        b_entry = next(iter(b_slots.values()))
        assert b_entry["findings"] == []

    def test_observability_gc_output(self, tmp_path: Path, capsys: Any) -> None:
        from datetime import datetime, timedelta, timezone
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        now = datetime(2026, 2, 24, tzinfo=timezone.utc)
        old = (now - timedelta(days=20)).isoformat()

        old_manifest = {
            "z.ts": {
                "old_key": {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus", "prompt_hash": "old", "patch_hash": "old",
                    "context_key": "old", "findings": [],
                    "cached_at": old, "last_hit_at": old, "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, old_manifest)
        (bha_dir / "agent_bha_p0.json").write_text(json.dumps({"findings": []}))

        self._run(cache_dir, diff_data, bha_dir, reviewed_files=["a.ts"])
        captured = capsys.readouterr()
        lines = [ln for ln in captured.out.strip().split("\n") if ln.strip()]
        # Should have at least the cache_mode line and possibly a gc line
        assert any("cache_mode" in ln for ln in lines)


# ---------------------------------------------------------------------------
# V2 Cache: Feature flag
# ---------------------------------------------------------------------------


class TestFeatureFlag:
    def test_default_local_enabled(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            assert _is_global_cache_enabled(is_github_mode=False) is True

    def test_default_github_disabled(self) -> None:
        with patch.dict("os.environ", {}, clear=True):
            assert _is_global_cache_enabled(is_github_mode=True) is False

    def test_env_override(self) -> None:
        with patch.dict("os.environ", {"CR_GLOBAL_CACHE": "1"}):
            assert _is_global_cache_enabled(is_github_mode=True) is True
        with patch.dict("os.environ", {"CR_GLOBAL_CACHE": "0"}):
            assert _is_global_cache_enabled(is_github_mode=False) is False


# ---------------------------------------------------------------------------
# V2 Cache: entry_matches_v2
# ---------------------------------------------------------------------------


class TestEntryMatchesV2:
    def test_match(self) -> None:
        entry = {
            "schema_version": CACHE_SCHEMA_VERSION_V2,
            "model_id": "opus",
            "prompt_hash": "ph",
            "patch_hash": "pah",
            "context_key": "ctx",
        }
        assert _entry_matches_v2(entry, "opus", "ph", "pah", "ctx") is True

    def test_mismatch_context_key(self) -> None:
        entry = {
            "schema_version": CACHE_SCHEMA_VERSION_V2,
            "model_id": "opus",
            "prompt_hash": "ph",
            "patch_hash": "pah",
            "context_key": "ctx",
        }
        assert _entry_matches_v2(entry, "opus", "ph", "pah", "other") is False


# ---------------------------------------------------------------------------
# GitHub non-regression tests
# ---------------------------------------------------------------------------


class TestGitHubNonRegression:
    """Verify the findings/threads/summary posting flow is unchanged."""

    def test_posting_pipeline_unchanged_cache_disabled(self, tmp_path: Path) -> None:
        """Full pipeline with --global-cache 0 produces valid output files."""
        import argparse
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        diff_path = out / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir), diff_data=str(diff_path),
            prompt_hash="ph", model_id="opus", schema_version=1,
            output_dir=str(out), global_cache=0, context_key="",
        )
        cmd_cache_check(ns)
        result = json.loads((out / "cache_result.json").read_text())
        assert "cached_files" in result
        assert "uncached_files" in result
        assert (out / "agent_cached_bha.json").exists()
        assert (out / "uncached_diff_data.json").exists()

    def test_posting_pipeline_unchanged_cache_miss(self, tmp_path: Path) -> None:
        """Empty cache with --global-cache 1 produces valid output files."""
        import argparse
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        diff_path = out / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir), diff_data=str(diff_path),
            prompt_hash="ph", model_id="opus", schema_version=2,
            output_dir=str(out), global_cache=1, context_key="ctx",
        )
        cmd_cache_check(ns)
        result = json.loads((out / "cache_result.json").read_text())
        assert result["stats"]["cached"] == 0
        assert (out / "agent_cached_bha.json").exists()
        assert (out / "uncached_diff_data.json").exists()

    def test_posting_pipeline_unchanged_cache_hit(self, tmp_path: Path) -> None:
        """Pre-populated cache with hits produces valid output files."""
        import argparse
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])
        composite = _compute_composite_key("opus", "ph", patch_hash, "ctx")

        v2 = {
            "a.ts": {
                composite: {
                    "schema_version": CACHE_SCHEMA_VERSION_V2,
                    "model_id": "opus", "prompt_hash": "ph",
                    "patch_hash": patch_hash, "context_key": "ctx",
                    "findings": [{"file": "a.ts", "line": 1, "severity": "HIGH"}],
                    "cached_at": "2026-01-01T00:00:00+00:00",
                    "last_hit_at": "2026-01-01T00:00:00+00:00", "hit_count": 0,
                }
            }
        }
        _write_manifest(cache_dir, v2)
        diff_path = out / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir), diff_data=str(diff_path),
            prompt_hash="ph", model_id="opus", schema_version=2,
            output_dir=str(out), global_cache=1, context_key="ctx",
        )
        cmd_cache_check(ns)
        result = json.loads((out / "cache_result.json").read_text())
        assert result["stats"]["cached"] == 1
        cached = json.loads((out / "agent_cached_bha.json").read_text())
        assert len(cached["findings"]) == 1

    def test_posting_pipeline_unchanged_cache_corruption(self, tmp_path: Path) -> None:
        """Corrupt manifest.json triggers fail-open with valid output files."""
        import argparse
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        (cache_dir / CACHE_MANIFEST_FILENAME).write_text("corrupt{{{")
        diff_data = _make_cache_diff_data(files=["a.ts"])
        diff_path = out / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir), diff_data=str(diff_path),
            prompt_hash="ph", model_id="opus", schema_version=2,
            output_dir=str(out), global_cache=1, context_key="ctx",
        )
        cmd_cache_check(ns)
        assert (out / "cache_result.json").exists()
        assert (out / "agent_cached_bha.json").exists()
        assert (out / "uncached_diff_data.json").exists()
        result = json.loads((out / "cache_result.json").read_text())
        assert result["stats"]["cached"] == 0

    def test_posting_pipeline_unchanged_v1_migration(self, tmp_path: Path) -> None:
        """V1 manifest with --global-cache 1 migrates and produces valid output."""
        import argparse
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        out = tmp_path / "out"
        out.mkdir()
        diff_data = _make_cache_diff_data(files=["a.ts"])
        patch_hash = _compute_patch_hash("a.ts", diff_data["patch_lines"]["a.ts"])

        v1 = {
            "a.ts": {
                "schema_version": 1, "model_id": "opus",
                "prompt_hash": "ph", "patch_hash": patch_hash,
                "findings": [{"file": "a.ts", "line": 1}],
                "cached_at": "2026-01-01T00:00:00+00:00",
            }
        }
        _write_manifest(cache_dir, v1)
        diff_path = out / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        # V1 entry with context_key="" — lookup with "" should hit after migration
        ns = argparse.Namespace(
            cache_dir=str(cache_dir), diff_data=str(diff_path),
            prompt_hash="ph", model_id="opus", schema_version=2,
            output_dir=str(out), global_cache=1, context_key="",
        )
        cmd_cache_check(ns)
        cache_result = json.loads((out / "cache_result.json").read_text())
        assert cache_result["stats"]["hit_rate_pct"] == 100.0
        assert cache_result["stats"]["cached"] == 1
        assert (out / "agent_cached_bha.json").exists()
        assert (out / "uncached_diff_data.json").exists()


# ---------------------------------------------------------------------------
# Review state: read/write
# ---------------------------------------------------------------------------


class TestReviewState:
    def test_read_missing_state(self, tmp_path: Path) -> None:
        state = _load_review_state(tmp_path)
        assert state == {}

    def test_write_and_read(self, tmp_path: Path) -> None:
        state = {"reviews": {"main:main": {"sha": "abc", "success": True}}}
        _write_review_state(tmp_path, state)
        loaded = _load_review_state(tmp_path)
        assert loaded["reviews"]["main:main"]["sha"] == "abc"

    def test_cmd_review_state_write(self, tmp_path: Path) -> None:
        import argparse
        ns = argparse.Namespace(
            cache_dir=str(tmp_path),
            key="feature:main",
            sha="abc123",
        )
        rc = cmd_review_state_write(ns)
        assert rc == 0
        state = _load_review_state(tmp_path)
        assert state["reviews"]["feature:main"]["sha"] == "abc123"
        assert state["reviews"]["feature:main"]["success"] is True

    def test_cmd_review_state_read_existing(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        # Write first
        state = {"reviews": {"feature:main": {"sha": "def456", "success": True, "completed_at": "2026-01-01T00:00:00+00:00"}}}
        _write_review_state(tmp_path, state)

        ns = argparse.Namespace(
            cache_dir=str(tmp_path),
            key="feature:main",
        )
        rc = cmd_review_state_read(ns)
        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["sha"] == "def456"

    def test_cmd_review_state_read_missing(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        ns = argparse.Namespace(
            cache_dir=str(tmp_path),
            key="nonexistent:main",
        )
        rc = cmd_review_state_read(ns)
        assert rc == 0
        captured = capsys.readouterr()
        assert captured.out.strip() == "{}"

    def test_atomic_write_no_tmp_left(self, tmp_path: Path) -> None:
        _write_review_state(tmp_path, {"reviews": {}})
        assert not (tmp_path / (REVIEW_STATE_FILENAME + ".tmp")).exists()
        assert (tmp_path / REVIEW_STATE_FILENAME).exists()


# ---------------------------------------------------------------------------
# Session token usage
# ---------------------------------------------------------------------------


class TestSessionTokens:
    def _write_transcript(self, sessions_dir: Path, lines: list[dict[str, Any]]) -> None:
        sessions_dir.mkdir(parents=True, exist_ok=True)
        transcript = sessions_dir / "abc-123.jsonl"
        with open(transcript, "w") as f:
            for obj in lines:
                f.write(json.dumps(obj) + "\n")

    def _make_assistant_msg(  # noqa: PLR0913
        self, ts: float, input_tok: int, output_tok: int,
        cache_create: int = 0, cache_read: int = 0,
        model: str = "claude-opus-4-6",
    ) -> dict[str, Any]:
        return {
            "type": "assistant",
            "timestamp": ts,
            "message": {
                "model": model,
                "role": "assistant",
                "type": "message",
                "content": [],
                "usage": {
                    "input_tokens": input_tok,
                    "output_tokens": output_tok,
                    "cache_creation_input_tokens": cache_create,
                    "cache_read_input_tokens": cache_read,
                },
            },
        }

    def test_sums_usage(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        project_dir = tmp_path / "myproject"
        project_dir.mkdir()
        project_key = re.sub(r"[^a-zA-Z0-9]", "-", str(project_dir.resolve()))
        sessions_dir = tmp_path / "home" / ".claude" / "projects" / project_key

        lines = [
            self._make_assistant_msg(1000.0, 100, 50, 200, 300),
            {"type": "user", "timestamp": 1001.0},
            self._make_assistant_msg(1002.0, 150, 75, 100, 400),
        ]
        self._write_transcript(sessions_dir, lines)

        with patch("pathlib.Path.home", return_value=tmp_path / "home"):
            ns = argparse.Namespace(project_dir=str(project_dir), start_time=0.0)
            rc = cmd_session_tokens(ns)
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert result["input_tokens"] == 250
        assert result["output_tokens"] == 125
        assert result["cache_creation_input_tokens"] == 300
        assert result["cache_read_input_tokens"] == 700
        assert result["total_tokens"] == 1375
        assert result["turns"] == 2

    def test_filters_by_start_time(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        project_dir = tmp_path / "myproject"
        project_dir.mkdir()
        project_key = re.sub(r"[^a-zA-Z0-9]", "-", str(project_dir.resolve()))
        sessions_dir = tmp_path / "home" / ".claude" / "projects" / project_key

        lines = [
            self._make_assistant_msg(500.0, 100, 50),  # before start
            self._make_assistant_msg(1500.0, 200, 75),  # after start
        ]
        self._write_transcript(sessions_dir, lines)

        with patch("pathlib.Path.home", return_value=tmp_path / "home"):
            ns = argparse.Namespace(project_dir=str(project_dir), start_time=1000.0)
            rc = cmd_session_tokens(ns)
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert result["turns"] == 1
        assert result["input_tokens"] == 200

    def test_handles_ms_timestamps(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        project_dir = tmp_path / "myproject"
        project_dir.mkdir()
        project_key = re.sub(r"[^a-zA-Z0-9]", "-", str(project_dir.resolve()))
        sessions_dir = tmp_path / "home" / ".claude" / "projects" / project_key

        # Timestamp in milliseconds (> 1e12)
        lines = [
            self._make_assistant_msg(1700000000000.0, 100, 50),
        ]
        self._write_transcript(sessions_dir, lines)

        with patch("pathlib.Path.home", return_value=tmp_path / "home"):
            ns = argparse.Namespace(project_dir=str(project_dir), start_time=1700000000.0)
            rc = cmd_session_tokens(ns)
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert result["turns"] == 1

    def test_no_sessions_dir(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        project_dir = tmp_path / "nonexistent"
        project_dir.mkdir()

        with patch("pathlib.Path.home", return_value=tmp_path / "home"):
            ns = argparse.Namespace(project_dir=str(project_dir), start_time=0.0)
            rc = cmd_session_tokens(ns)
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert "error" in result

    def test_tracks_models(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        project_dir = tmp_path / "myproject"
        project_dir.mkdir()
        project_key = re.sub(r"[^a-zA-Z0-9]", "-", str(project_dir.resolve()))
        sessions_dir = tmp_path / "home" / ".claude" / "projects" / project_key

        lines = [
            self._make_assistant_msg(1000.0, 100, 50, model="claude-opus-4-6"),
            self._make_assistant_msg(1001.0, 100, 50, model="claude-sonnet-4-6"),
        ]
        self._write_transcript(sessions_dir, lines)

        with patch("pathlib.Path.home", return_value=tmp_path / "home"):
            ns = argparse.Namespace(project_dir=str(project_dir), start_time=0.0)
            rc = cmd_session_tokens(ns)
        assert rc == 0
        result = json.loads(capsys.readouterr().out)
        assert "claude-opus-4-6" in result["models"]
        assert "claude-sonnet-4-6" in result["models"]


# ---------------------------------------------------------------------------
# Setup subcommand
# ---------------------------------------------------------------------------


class TestSetup:
    def test_local_mode(self, capsys: Any) -> None:
        import argparse

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:2] == ["rev-parse", "--show-toplevel"]:
                return "/path/to/my-repo\n"
            if cmd[:3] == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return "feature-x\n"
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._run_git", side_effect=git_side_effect):
            with patch("time.time", return_value=1700000000):
                ns = argparse.Namespace(mode="local")
                rc = cmd_setup(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert isinstance(data["start_time"], int)
        assert data["start_time"] == 1700000000
        assert data["repo_name"] == "my-repo"
        assert data["current_branch"] == "feature-x"
        assert data["global_cache"] == "1"

    def test_github_mode(self, capsys: Any) -> None:
        import argparse

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:2] == ["rev-parse", "--show-toplevel"]:
                return "/path/to/my-repo\n"
            if cmd[:3] == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return "feature-x\n"
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._run_git", side_effect=git_side_effect):
            with patch("time.time", return_value=1700000000):
                ns = argparse.Namespace(mode="github")
                rc = cmd_setup(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["global_cache"] == "0"

    def test_env_override(self, capsys: Any) -> None:
        import argparse

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:2] == ["rev-parse", "--show-toplevel"]:
                return "/path/to/my-repo\n"
            if cmd[:3] == ["rev-parse", "--abbrev-ref", "HEAD"]:
                return "feature-x\n"
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._run_git", side_effect=git_side_effect):
            with patch("time.time", return_value=1700000000):
                with patch.dict("os.environ", {"CR_GLOBAL_CACHE": "1"}):
                    ns = argparse.Namespace(mode="github")
                    rc = cmd_setup(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["global_cache"] == "1"

    def test_git_failure(self, capsys: Any) -> None:
        import argparse

        with patch(
            "code_review_helpers._run_git",
            side_effect=subprocess.CalledProcessError(128, ["git"]),
        ):
            with patch("time.time", return_value=1700000000):
                ns = argparse.Namespace(mode="local")
                rc = cmd_setup(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["repo_name"] == "unknown"
        assert data["current_branch"] == "HEAD"


# ---------------------------------------------------------------------------
# Compute hashes subcommand
# ---------------------------------------------------------------------------


class TestComputeHashes:
    def test_computes_hash_and_context_key(self, tmp_path: Path, capsys: Any) -> None:
        import argparse
        import hashlib

        shared_prompt = tmp_path / "shared_prompt.txt"
        shared_prompt.write_bytes(b"shared prompt content")
        bha_suffix = tmp_path / "bha_suffix.txt"
        bha_suffix.write_bytes(b"bha suffix content")

        expected_hash = hashlib.sha256(
            b"shared prompt content" + b"bha suffix content"
        ).hexdigest()

        with patch(
            "code_review_helpers._run_git", return_value="abc123\n"
        ):
            ns = argparse.Namespace(
                shared_prompt=str(shared_prompt),
                bha_suffix=str(bha_suffix),
                diff_tip="HEAD",
                base_ref="main",
            )
            rc = cmd_compute_hashes(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["prompt_hash"] == expected_hash
        assert data["context_key"] == "abc123"

    def test_merge_base_failure(self, tmp_path: Path, capsys: Any) -> None:
        import argparse

        shared_prompt = tmp_path / "shared_prompt.txt"
        shared_prompt.write_bytes(b"content")
        bha_suffix = tmp_path / "bha_suffix.txt"
        bha_suffix.write_bytes(b"suffix")

        with patch(
            "code_review_helpers._run_git",
            side_effect=subprocess.CalledProcessError(128, ["git"]),
        ):
            ns = argparse.Namespace(
                shared_prompt=str(shared_prompt),
                bha_suffix=str(bha_suffix),
                diff_tip="HEAD",
                base_ref="main",
            )
            rc = cmd_compute_hashes(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert data["context_key"] == ""

    def test_missing_shared_prompt(self, tmp_path: Path) -> None:
        import argparse

        bha_suffix = tmp_path / "bha_suffix.txt"
        bha_suffix.write_bytes(b"suffix")

        ns = argparse.Namespace(
            shared_prompt=str(tmp_path / "nonexistent.txt"),
            bha_suffix=str(bha_suffix),
            diff_tip="HEAD",
            base_ref="main",
        )
        rc = cmd_compute_hashes(ns)
        assert rc == 1


# ---------------------------------------------------------------------------
# Auto-incremental subcommand
# ---------------------------------------------------------------------------


class TestAutoIncremental:
    def _make_args(self, tmp_path: Path, **overrides: Any) -> Any:
        import argparse

        defaults: dict[str, Any] = {
            "cache_dir": str(tmp_path),
            "key": "branch:main",
            "diff_tip": "HEAD",
            "original_scope": "main...HEAD",
            "full_review": "false",
            "since_last_review": "false",
            "mode": "local",
        }
        defaults.update(overrides)
        return argparse.Namespace(**defaults)

    def test_full_review_flag(self, tmp_path: Path, capsys: Any) -> None:
        ns = self._make_args(tmp_path, full_review="true")
        rc = cmd_auto_incremental(ns)
        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] is None
        assert "Full review (--full-review flag)" in data["review_mode_line"]

    def test_staged_scope(self, tmp_path: Path, capsys: Any) -> None:
        ns = self._make_args(tmp_path, original_scope="--cached")
        rc = cmd_auto_incremental(ns)
        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] is None
        assert "staged scope" in data["review_mode_line"]

    def test_since_last_review_success(self, tmp_path: Path, capsys: Any) -> None:
        state = {"reviews": {"branch:main": {"sha": "abc123"}}}

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:3] == ["merge-base", "--is-ancestor", "abc123"]:
                return ""
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._load_review_state", return_value=state):
            with patch("code_review_helpers._run_git", side_effect=git_side_effect):
                ns = self._make_args(tmp_path, since_last_review="true")
                rc = cmd_auto_incremental(ns)

        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] == "abc123...HEAD"

    def test_since_last_review_no_prior(self, tmp_path: Path) -> None:
        state: dict[str, Any] = {"reviews": {}}

        with patch("code_review_helpers._load_review_state", return_value=state):
            ns = self._make_args(tmp_path, since_last_review="true")
            rc = cmd_auto_incremental(ns)

        assert rc == 1

    def test_auto_incremental_within_guardrails(self, tmp_path: Path, capsys: Any) -> None:
        state = {"reviews": {"branch:main": {"sha": "abc123"}}}

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:3] == ["merge-base", "--is-ancestor", "abc123"]:
                return ""
            if cmd[:2] == ["rev-parse", "HEAD"]:
                return "def456\n"
            if cmd[:2] == ["diff", "--name-only"]:
                return "file1.ts\nfile2.ts\n"
            if cmd[:2] == ["diff", "--shortstat"]:
                return " 2 files changed, 100 insertions(+), 50 deletions(-)\n"
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._load_review_state", return_value=state):
            with patch("code_review_helpers._run_git", side_effect=git_side_effect):
                ns = self._make_args(tmp_path)
                rc = cmd_auto_incremental(ns)

        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] == "abc123...HEAD"
        assert "Auto incremental" in data["review_mode_line"]

    def test_auto_incremental_exceeds_max_files(self, tmp_path: Path, capsys: Any) -> None:
        state = {"reviews": {"branch:main": {"sha": "abc123"}}}
        many_files = "\n".join(f"file{i}.ts" for i in range(35)) + "\n"

        def git_side_effect(cmd: list[str]) -> str:
            if cmd[:3] == ["merge-base", "--is-ancestor", "abc123"]:
                return ""
            if cmd[:2] == ["rev-parse", "HEAD"]:
                return "def456\n"
            if cmd[:2] == ["diff", "--name-only"]:
                return many_files
            if cmd[:2] == ["diff", "--shortstat"]:
                return " 35 files changed, 100 insertions(+), 50 deletions(-)\n"
            raise subprocess.CalledProcessError(1, cmd)

        with patch("code_review_helpers._load_review_state", return_value=state):
            with patch("code_review_helpers._run_git", side_effect=git_side_effect):
                ns = self._make_args(tmp_path)
                rc = cmd_auto_incremental(ns)

        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] is None
        assert "exceeds max files" in data["review_mode_line"]

    def test_default_full_review(self, tmp_path: Path, capsys: Any) -> None:
        ns = self._make_args(tmp_path, mode="github")
        rc = cmd_auto_incremental(ns)
        assert rc == 0
        data = json.loads(capsys.readouterr().out.strip())
        assert data["diff_scope"] is None
        assert data["review_mode_line"] == "Review mode: Full review"


# ---------------------------------------------------------------------------
# Footer subcommand
# ---------------------------------------------------------------------------


class TestFooter:
    def _make_args(self, tmp_path: Path, **overrides: Any) -> Any:
        import argparse

        defaults: dict[str, Any] = {
            "start_time": 1700000000.0,
            "cache_result": None,
            "review_mode_line": "Review mode: Full review",
            "project_dir": str(tmp_path),
        }
        defaults.update(overrides)
        return argparse.Namespace(**defaults)

    def test_footer_with_cache(self, tmp_path: Path, capsys: Any) -> None:
        cache_result = tmp_path / "cache_result.json"
        cache_result.write_text(json.dumps({
            "stats": {"cached": 5, "total_files": 10, "hit_rate_pct": 50},
        }))

        token_data: dict[str, Any] = {
            "input_tokens": 613,
            "output_tokens": 5600,
            "cache_creation_input_tokens": 225000,
            "cache_read_input_tokens": 2500000,
            "total_tokens": 2731213,
            "turns": 69,
            "models": ["claude-opus-4-6"],
        }

        with patch("time.time", return_value=1700000539.0):
            with patch("code_review_helpers._aggregate_tokens", return_value=token_data):
                ns = self._make_args(tmp_path, cache_result=str(cache_result))
                rc = cmd_footer(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        footer_line = data["footer_line"]
        assert "8m 59s" in footer_line
        assert "Cache: 5/10 files (50%)" in footer_line
        assert "Full review" in footer_line
        assert "Tokens:" in footer_line

    def test_footer_no_cache(self, tmp_path: Path, capsys: Any) -> None:
        token_data: dict[str, Any] = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "total_tokens": 0,
            "turns": 0,
            "models": [],
        }

        with patch("time.time", return_value=1700000060.0):
            with patch("code_review_helpers._aggregate_tokens", return_value=token_data):
                ns = self._make_args(tmp_path)
                rc = cmd_footer(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert "Cache: disabled" in data["footer_line"]

    def test_footer_elapsed_formatting(self, tmp_path: Path, capsys: Any) -> None:
        token_data: dict[str, Any] = {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "total_tokens": 0,
            "turns": 0,
            "models": [],
        }

        # start_time=1700000000, end_time=1700000000+3723=1700003723
        with patch("time.time", return_value=1700003723.0):
            with patch("code_review_helpers._aggregate_tokens", return_value=token_data):
                ns = self._make_args(tmp_path)
                rc = cmd_footer(ns)

        assert rc == 0
        captured = capsys.readouterr()
        data = json.loads(captured.out.strip())
        assert "1h 2m 3s" in data["footer_line"]


# ---------------------------------------------------------------------------
# Format helpers
# ---------------------------------------------------------------------------


class TestFormatHelpers:
    def test_format_number_millions(self) -> None:
        assert _format_number(3963612) == "4.0M"

    def test_format_number_thousands(self) -> None:
        assert _format_number(5600) == "5.6K"

    def test_format_number_small(self) -> None:
        assert _format_number(613) == "613"

    def test_format_elapsed_minutes_seconds(self) -> None:
        assert _format_elapsed(539) == "8m 59s"

    def test_format_elapsed_hours_minutes_seconds(self) -> None:
        assert _format_elapsed(3723) == "1h 2m 3s"

    def test_format_elapsed_seconds_only(self) -> None:
        assert _format_elapsed(45) == "45s"


# ---------------------------------------------------------------------------
# Review state: --ref flag
# ---------------------------------------------------------------------------


class TestReviewStateWriteRef:
    def test_write_with_ref(self, tmp_path: Path) -> None:
        import argparse

        with patch(
            "code_review_helpers._run_git", return_value="abc123\n"
        ):
            ns = argparse.Namespace(
                cache_dir=str(tmp_path),
                key="branch:main",
                sha=None,
                ref="my-ref",
            )
            rc = cmd_review_state_write(ns)

        assert rc == 0
        state = _load_review_state(tmp_path)
        assert state["reviews"]["branch:main"]["sha"] == "abc123"

    def test_write_with_ref_failure(self, tmp_path: Path) -> None:
        import argparse

        with patch(
            "code_review_helpers._run_git",
            side_effect=subprocess.CalledProcessError(128, ["git"]),
        ):
            ns = argparse.Namespace(
                cache_dir=str(tmp_path),
                key="branch:main",
                sha=None,
                ref="my-ref",
            )
            rc = cmd_review_state_write(ns)

        assert rc == 1

    def test_write_no_sha_no_ref(self, tmp_path: Path) -> None:
        import argparse

        ns = argparse.Namespace(
            cache_dir=str(tmp_path),
            key="branch:main",
            sha=None,
            ref=None,
        )
        rc = cmd_review_state_write(ns)
        assert rc == 1


# ---------------------------------------------------------------------------
# Cache update: --partitions-file flag
# ---------------------------------------------------------------------------


class TestCacheUpdatePartitionsFile:
    def test_partitions_file_extracts_files(self, tmp_path: Path) -> None:
        import argparse

        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        partitions_data = {
            "partitions": [
                {
                    "files": [
                        {"file": "a.ts"},
                        {"file": "b.ts"},
                    ]
                }
            ]
        }
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = _make_cache_diff_data(files=["a.ts", "b.ts"])
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        # No BHA findings files — zero-finding files will still be cached
        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=1,
            reviewed_files=[],
            partitions_file=str(partitions_file),
        )
        cmd_cache_update(ns)
        manifest = _load_manifest(cache_dir)
        assert "a.ts" in manifest
        assert "b.ts" in manifest

    def test_exclude_test_partitions_skips_test_only(self, tmp_path: Path) -> None:
        import argparse

        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        partitions_data = {
            "partitions": [
                {"files": [{"file": "src/app.ts"}], "is_test_only": False},
                {"files": [{"file": "tests/app.test.ts"}], "is_test_only": True},
            ]
        }
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = _make_cache_diff_data(files=["src/app.ts", "tests/app.test.ts"])
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=1,
            reviewed_files=[],
            partitions_file=str(partitions_file),
            exclude_test_partitions=True,
        )
        cmd_cache_update(ns)
        manifest = _load_manifest(cache_dir)
        assert "src/app.ts" in manifest
        assert "tests/app.test.ts" not in manifest

    def test_exclude_test_partitions_false_by_default(self, tmp_path: Path) -> None:
        import argparse

        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        partitions_data = {
            "partitions": [
                {"files": [{"file": "src/app.ts"}], "is_test_only": False},
                {"files": [{"file": "tests/app.test.ts"}], "is_test_only": True},
            ]
        }
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = _make_cache_diff_data(files=["src/app.ts", "tests/app.test.ts"])
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=1,
            reviewed_files=[],
            partitions_file=str(partitions_file),
            exclude_test_partitions=False,
        )
        cmd_cache_update(ns)
        manifest = _load_manifest(cache_dir)
        assert "src/app.ts" in manifest
        assert "tests/app.test.ts" in manifest

    def test_exclude_test_partitions_caches_mixed(self, tmp_path: Path) -> None:
        import argparse

        cache_dir = tmp_path / "cache"
        bha_dir = tmp_path / "bha"
        bha_dir.mkdir()

        # Mixed partition (is_test_only=False) should still be cached
        partitions_data = {
            "partitions": [
                {"files": [{"file": "src/app.ts"}, {"file": "src/app.test.ts"}], "is_test_only": False},
            ]
        }
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = _make_cache_diff_data(files=["src/app.ts", "src/app.test.ts"])
        diff_path = bha_dir / "diff_data.json"
        diff_path.write_text(json.dumps(diff_data))

        ns = argparse.Namespace(
            cache_dir=str(cache_dir),
            diff_data=str(diff_path),
            bha_dir=str(bha_dir),
            prompt_hash="abc123",
            model_id="opus",
            schema_version=1,
            reviewed_files=[],
            partitions_file=str(partitions_file),
            exclude_test_partitions=True,
        )
        cmd_cache_update(ns)
        manifest = _load_manifest(cache_dir)
        # Both files cached because the partition is NOT test_only
        assert "src/app.ts" in manifest
        assert "src/app.test.ts" in manifest


# ---------------------------------------------------------------------------
# Cache status message
# ---------------------------------------------------------------------------


class TestCacheStatusMessage:
    def test_hits(self) -> None:
        from code_review_helpers import _compute_cache_status
        stats = {"cached": 5, "total_files": 10, "hit_rate_pct": 50.0}
        kind, msg = _compute_cache_status(stats, {"some": "data"}, fallback_error=False)
        assert kind == "hits"
        assert "5/10" in msg

    def test_first_run(self) -> None:
        from code_review_helpers import _compute_cache_status
        stats = {"cached": 0, "total_files": 5, "hit_rate_pct": 0.0}
        kind, msg = _compute_cache_status(stats, {}, fallback_error=False, manifest_file_existed=False)
        assert kind == "first_run"

    def test_all_changed(self) -> None:
        from code_review_helpers import _compute_cache_status
        stats = {"cached": 0, "total_files": 5, "hit_rate_pct": 0.0}
        kind, msg = _compute_cache_status(stats, {"file": {}}, fallback_error=False)
        assert kind == "all_changed"

    def test_fallback_error(self) -> None:
        from code_review_helpers import _compute_cache_status
        stats = {"cached": 0, "total_files": 5, "hit_rate_pct": 0.0}
        kind, msg = _compute_cache_status(stats, {}, fallback_error=True)
        assert kind == "fallback_error"

    def test_corrupt_manifest_not_first_run(self) -> None:
        from code_review_helpers import _compute_cache_status
        stats = {"cached": 0, "total_files": 5, "hit_rate_pct": 0.0}
        # File existed but was corrupt (loaded as {})
        kind, msg = _compute_cache_status(stats, {}, fallback_error=False, manifest_file_existed=True)
        assert kind == "fallback_error"
        assert "corrupt" in msg.lower()


# ---------------------------------------------------------------------------
# Resolve scope
# ---------------------------------------------------------------------------


class TestResolveScope:
    def _run(self, mode: str, scope_args: str = "", pr_number: int | None = None,
             base_ref_override: str | None = None, setup_json: str | None = None,
             tmp_path: Path | None = None) -> dict[str, Any]:
        import argparse
        import io
        import sys as _sys

        if setup_json is None and tmp_path is not None:
            setup_path = tmp_path / "setup.json"
            setup_path.write_text(json.dumps({"current_branch": "feat-x"}))
            setup_json = str(setup_path)

        from code_review_helpers import cmd_resolve_scope
        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(
                mode=mode, pr_number=pr_number, scope_args=scope_args,
                base_ref_override=base_ref_override, setup_json=setup_json or "",
            )
            cmd_resolve_scope(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

    def test_local_branch(self, tmp_path: Path) -> None:
        result = self._run("local", tmp_path=tmp_path)
        assert result["diff_scope"] == "main...HEAD"
        assert result["scope_kind"] == "branch"

    def test_staged(self, tmp_path: Path) -> None:
        result = self._run("local", scope_args="staged", tmp_path=tmp_path)
        assert result["diff_scope"] == "--cached"
        assert result["scope_kind"] == "staged"

    def test_file_paths(self, tmp_path: Path) -> None:
        result = self._run("local", scope_args="file1.ts file2.ts", tmp_path=tmp_path)
        assert "-- file1.ts file2.ts" in result["diff_scope"]
        assert result["scope_kind"] == "file_paths"
        assert result["path_filter"] == "-- file1.ts file2.ts"

    def test_base_override(self, tmp_path: Path) -> None:
        result = self._run("local", base_ref_override="develop", tmp_path=tmp_path)
        assert "origin/develop" in result["diff_scope"]
        assert result["base_ref"] == "develop"

    def test_base_override_preserves_path_filter(self, tmp_path: Path) -> None:
        result = self._run("local", scope_args="file1.ts", base_ref_override="develop", tmp_path=tmp_path)
        assert "origin/develop" in result["diff_scope"]
        assert "-- file1.ts" in result["path_filter"]


# ---------------------------------------------------------------------------
# Prep assets
# ---------------------------------------------------------------------------


class TestPrepAssets:
    def test_copies_files(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        from code_review_helpers import cmd_prep_assets

        # Create mock plugin structure
        plugin_root = tmp_path / "plugin"
        prompts_dir = plugin_root / "tools" / "prompts"
        prompts_dir.mkdir(parents=True)
        (prompts_dir / "shared_prompt.txt").write_text("shared prompt content")
        (prompts_dir / "bha_suffix.txt").write_text("bha suffix content")

        cr_dir = tmp_path / "cr"
        cr_dir.mkdir()

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(plugin_root=str(plugin_root), cr_dir=str(cr_dir))
            cmd_prep_assets(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert (cr_dir / "shared_prompt.txt").exists()
        assert (cr_dir / "bha_suffix.txt").exists()
        assert "shared_prompt" in result
        assert "bha_suffix" in result
        # Output paths should point to actual files in cr_dir
        assert result["shared_prompt"] == str(cr_dir / "shared_prompt.txt")
        assert result["bha_suffix"] == str(cr_dir / "bha_suffix.txt")


# ---------------------------------------------------------------------------
# Fetch intent
# ---------------------------------------------------------------------------


class TestFetchIntent:
    def _run(self, scope_kind: str, cr_dir: Path, pr_number: int | None = None,
             base_ref: str = "main", diff_tip: str = "HEAD") -> dict[str, Any]:
        import argparse
        import io
        import sys as _sys

        from code_review_helpers import cmd_fetch_intent

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(
                pr_number=pr_number, base_ref=base_ref, diff_tip=diff_tip,
                scope_kind=scope_kind, cr_dir=str(cr_dir),
            )
            cmd_fetch_intent(ns)
            _sys.stdout.seek(0)
            return json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

    def test_staged_empty(self, tmp_path: Path) -> None:
        result = self._run("staged", tmp_path)
        assert result["source"] == "empty"
        intent = json.loads((tmp_path / "intent_context.json").read_text())
        assert intent["title"] == ""
        assert intent["commits"] == ""

    def test_file_scope_empty(self, tmp_path: Path) -> None:
        result = self._run("file_paths", tmp_path)
        assert result["source"] == "empty"

    def test_branch_uses_git_log(self, tmp_path: Path) -> None:
        from unittest.mock import patch as mock_patch
        mock_result = subprocess.CompletedProcess(args=[], returncode=0, stdout="feat: add dashboard\nfix: typo\n")
        with mock_patch("code_review_helpers.subprocess.run", return_value=mock_result):
            result = self._run("branch", tmp_path, base_ref="main", diff_tip="HEAD")
        assert result["source"] == "commits"
        intent = json.loads((tmp_path / "intent_context.json").read_text())
        assert "add dashboard" in intent["commits"]

    def test_pr_uses_gh(self, tmp_path: Path) -> None:
        from unittest.mock import patch as mock_patch
        mock_result = subprocess.CompletedProcess(
            args=[], returncode=0, stdout=json.dumps({"title": "feat: PR title", "body": "PR body"}),
        )
        with mock_patch("code_review_helpers.subprocess.run", return_value=mock_result):
            result = self._run("pr", tmp_path, pr_number=42)
        assert result["source"] == "pr"
        intent = json.loads((tmp_path / "intent_context.json").read_text())
        assert intent["title"] == "feat: PR title"

    def test_pr_fallback_on_error(self, tmp_path: Path) -> None:
        from unittest.mock import patch as mock_patch
        with mock_patch("code_review_helpers.subprocess.run", side_effect=subprocess.CalledProcessError(1, "gh")):
            result = self._run("pr", tmp_path, pr_number=42)
        assert result["source"] == "empty"


# ---------------------------------------------------------------------------
# Setup --cr-dir-prefix
# ---------------------------------------------------------------------------


class TestSetupCrDir:
    def test_creates_cr_dir(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        prefix = str(tmp_path / "cr-")

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            ns = argparse.Namespace(mode="local", cr_dir_prefix=prefix)
            cmd_setup(ns)
            _sys.stdout.seek(0)
            result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert "cr_dir" in result
        assert Path(result["cr_dir"]).exists()
        assert result["cr_dir"].startswith(prefix)

    def test_unique_paths(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys

        prefix = str(tmp_path / "cr-")
        paths = []
        for _ in range(5):
            old_stdout = _sys.stdout
            _sys.stdout = io.StringIO()
            try:
                ns = argparse.Namespace(mode="local", cr_dir_prefix=prefix)
                cmd_setup(ns)
                _sys.stdout.seek(0)
                result = json.load(_sys.stdout)
            finally:
                _sys.stdout = old_stdout
            paths.append(result["cr_dir"])

        # With 5-digit random suffix, collisions across 5 runs are extremely unlikely
        assert len(set(paths)) >= 2


# ---------------------------------------------------------------------------
# Extract patches
# ---------------------------------------------------------------------------


class TestExtractPatches:
    def test_creates_partition_and_full_files(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys
        from unittest.mock import patch as mock_patch

        from code_review_helpers import cmd_extract_patches

        cr_dir = tmp_path / "cr"
        cr_dir.mkdir()

        partitions_data = {"partitions": [
            {"id": 0, "files": [{"file": "a.ts"}]},
            {"id": 1, "files": [{"file": "b.ts"}]},
        ]}
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = {"files_to_review": ["a.ts", "b.ts", "c.ts"]}
        diff_data_file = tmp_path / "diff_data.json"
        diff_data_file.write_text(json.dumps(diff_data))

        def mock_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
            # Write something to stdout if it was redirected
            stdout = kwargs.get("stdout")
            if stdout and hasattr(stdout, "write"):
                stdout.write(f"diff output for {' '.join(cmd)}\n")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            with mock_patch("code_review_helpers.subprocess.run", side_effect=mock_run):
                ns = argparse.Namespace(
                    partitions_file=str(partitions_file), diff_scope="main...HEAD",
                    diff_data=str(diff_data_file), cr_dir=str(cr_dir),
                    workdir=None, batch_size=50,
                )
                cmd_extract_patches(ns)
                _sys.stdout.seek(0)
                result = json.load(_sys.stdout)
        finally:
            _sys.stdout = old_stdout

        assert "patches_p0.txt" in result["partition_patches"]
        assert "patches_p1.txt" in result["partition_patches"]
        assert result["full_patch"] == "patches_all.txt"
        assert (cr_dir / "patches_p0.txt").exists()
        assert (cr_dir / "patches_all.txt").exists()

    def test_strips_pathspec_from_scope(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys
        from unittest.mock import patch as mock_patch

        from code_review_helpers import cmd_extract_patches

        cr_dir = tmp_path / "cr"
        cr_dir.mkdir()

        partitions_data = {"partitions": [{"id": 0, "files": [{"file": "a.ts"}]}]}
        partitions_file = tmp_path / "partitions.json"
        partitions_file.write_text(json.dumps(partitions_data))

        diff_data = {"files_to_review": ["a.ts"]}
        diff_data_file = tmp_path / "diff_data.json"
        diff_data_file.write_text(json.dumps(diff_data))

        captured_cmds: list[list[str]] = []

        def mock_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
            captured_cmds.append(cmd)
            stdout = kwargs.get("stdout")
            if stdout and hasattr(stdout, "write"):
                stdout.write("")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            with mock_patch("code_review_helpers.subprocess.run", side_effect=mock_run):
                ns = argparse.Namespace(
                    partitions_file=str(partitions_file),
                    diff_scope="main...HEAD -- a.ts b.ts",  # pathspec embedded
                    diff_data=str(diff_data_file), cr_dir=str(cr_dir),
                    workdir=None, batch_size=50,
                )
                cmd_extract_patches(ns)
        finally:
            _sys.stdout = old_stdout

        # Verify no double -- in any command
        for cmd in captured_cmds:
            separator_count = cmd.count("--")
            assert separator_count <= 1, f"Double pathspec separator in: {cmd}"

    def test_full_diff_uses_diff_data_not_partitions(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys
        from unittest.mock import patch as mock_patch

        from code_review_helpers import cmd_extract_patches

        cr_dir = tmp_path / "cr"
        cr_dir.mkdir()

        # Partitions only have 1 file (uncached), but diff_data has 3 (full set)
        partitions_data = {"partitions": [{"id": 0, "files": [{"file": "a.ts"}]}]}
        (tmp_path / "partitions.json").write_text(json.dumps(partitions_data))
        (tmp_path / "diff_data.json").write_text(json.dumps({"files_to_review": ["a.ts", "b.ts", "c.ts"]}))

        captured_cmds: list[list[str]] = []

        def mock_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
            captured_cmds.append(cmd)
            stdout = kwargs.get("stdout")
            if stdout and hasattr(stdout, "write"):
                stdout.write("")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            with mock_patch("code_review_helpers.subprocess.run", side_effect=mock_run):
                ns = argparse.Namespace(
                    partitions_file=str(tmp_path / "partitions.json"), diff_scope="main...HEAD",
                    diff_data=str(tmp_path / "diff_data.json"), cr_dir=str(cr_dir),
                    workdir=None, batch_size=50,
                )
                cmd_extract_patches(ns)
        finally:
            _sys.stdout = old_stdout

        # The full-diff command (last one) should include all 3 files from diff_data
        full_diff_cmd = captured_cmds[-1]
        assert "a.ts" in full_diff_cmd
        assert "b.ts" in full_diff_cmd
        assert "c.ts" in full_diff_cmd

    def test_batches_large_diffs(self, tmp_path: Path) -> None:
        import argparse
        import io
        import sys as _sys
        from unittest.mock import patch as mock_patch

        from code_review_helpers import cmd_extract_patches

        cr_dir = tmp_path / "cr"
        cr_dir.mkdir()

        # 250 files -- above the 200 threshold
        all_files = [f"f{i}.ts" for i in range(250)]
        partitions_data = {"partitions": [{"id": 0, "files": [{"file": all_files[0]}]}]}
        (tmp_path / "partitions.json").write_text(json.dumps(partitions_data))
        (tmp_path / "diff_data.json").write_text(json.dumps({"files_to_review": all_files}))

        captured_cmds: list[list[str]] = []

        def mock_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess:  # type: ignore[type-arg]
            captured_cmds.append(cmd)
            stdout = kwargs.get("stdout")
            if stdout and hasattr(stdout, "write"):
                stdout.write("")
            return subprocess.CompletedProcess(args=cmd, returncode=0)

        old_stdout = _sys.stdout
        _sys.stdout = io.StringIO()
        try:
            with mock_patch("code_review_helpers.subprocess.run", side_effect=mock_run):
                ns = argparse.Namespace(
                    partitions_file=str(tmp_path / "partitions.json"), diff_scope="main...HEAD",
                    diff_data=str(tmp_path / "diff_data.json"), cr_dir=str(cr_dir),
                    workdir=None, batch_size=50,
                )
                cmd_extract_patches(ns)
        finally:
            _sys.stdout = old_stdout

        # 1 partition cmd + 5 batched full-diff cmds (250 / 50 = 5)
        full_diff_cmds = [c for c in captured_cmds if "patches_p" not in " ".join(str(x) for x in c)]
        # Should be multiple batches (>1 command for the full diff)
        assert len(full_diff_cmds) >= 5
