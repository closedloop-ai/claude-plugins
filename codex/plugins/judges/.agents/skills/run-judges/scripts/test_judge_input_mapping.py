"""Tests for judge_input_mapping.py."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from judge_input_mapping import (  # type: ignore[import-not-found]
    JudgeInputMappingError,
    build_judge_input,
    main,
    sanitize_descriptor_stem,
    validate_judge_input,
)


SCRIPT_DIR = Path(__file__).parent
REPO_ROOT = SCRIPT_DIR.parents[4]
SCHEMA_PATH = REPO_ROOT / "plugins/judges/schemas/judge-input.schema.json"


def _write(path: Path, content: str = "content") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _assert_schema_valid(envelope: dict) -> None:
    validate_judge_input(envelope, SCHEMA_PATH)


def _ids(envelope: dict) -> list[str]:
    return [item["id"] for item in envelope["supporting_artifacts"]]


def _paths(envelope: dict) -> list[str]:
    return [item["path"] for item in envelope["supporting_artifacts"]]


def _build(workdir: Path, artifact_type: str) -> dict:
    return build_judge_input(
        workdir,
        artifact_type,  # type: ignore[arg-type]
        run_id="run-test",
        generated_at="2026-05-13T00:00:00Z",
    )


def test_sanitizes_descriptor_stems_to_lowercase_ascii_snake_case() -> None:
    assert sanitize_descriptor_stem("Feature Ref.md") == "feature_ref_md"
    assert sanitize_descriptor_stem("  ###  ") == "item"
    assert sanitize_descriptor_stem("A+B/C") == "a_b_c"


def test_prd_mapping_uses_runtime_contract_order_and_schema(tmp_path: Path) -> None:
    _write(tmp_path / "prd.md", "# PRD")
    context_dir = tmp_path / ".closedloop-ai/context"
    _write(context_dir / "ref B.md", "# ref b")
    _write(context_dir / "ref A.md", "# ref a")
    _write(
        context_dir / "supporting-artifacts.json",
        json.dumps(
            [
                { "path": ".closedloop-ai/context/ref B.md" },
                { "path": ".closedloop-ai/context/ref A.md" },
            ]
        ),
    )
    _write(context_dir / "prompt.md", "# prompt")
    _write(context_dir / "repo-info.json", "{}")
    _write(context_dir / "code-evaluation-context.json", "{}")
    _write(context_dir / "prior-loop-summaries.json", "[]")
    _write(tmp_path / ".closedloop-ai/work/attachments/zeta.txt", "z")
    _write(tmp_path / ".closedloop-ai/work/attachments/alpha.txt", "a")

    envelope = _build(tmp_path, "prd")

    assert envelope["primary_artifact"]["id"] == "primary_prd"
    assert envelope["primary_artifact"]["path"] == "prd.md"
    assert _ids(envelope) == [
        "ref_000_ref_b",
        "ref_001_ref_a",
        "prompt",
        "repo_metadata",
        "code_evaluation_context",
        "prior_loop_summaries",
        "attachment_000_alpha",
        "attachment_001_zeta",
    ]
    assert _paths(envelope) == [
        ".closedloop-ai/context/ref B.md",
        ".closedloop-ai/context/ref A.md",
        ".closedloop-ai/context/prompt.md",
        ".closedloop-ai/context/repo-info.json",
        ".closedloop-ai/context/code-evaluation-context.json",
        ".closedloop-ai/context/prior-loop-summaries.json",
        ".closedloop-ai/work/attachments/alpha.txt",
        ".closedloop-ai/work/attachments/zeta.txt",
    ]
    assert envelope["source_of_truth"] == [
        "primary_prd",
        *_ids(envelope),
    ]
    assert envelope["fallback_mode"] == {
        "active": False,
        "reason": "",
        "fallback_artifacts": [],
    }
    _assert_schema_valid(envelope)


def test_feature_mapping_prefers_feature_primary_and_supporting_prd(tmp_path: Path) -> None:
    _write(tmp_path / "feature.md", "# Feature")
    _write(tmp_path / ".closedloop-ai/context/supporting-prd.md", "# PRD")

    envelope = _build(tmp_path, "feature")

    assert envelope["primary_artifact"]["id"] == "primary_feature"
    assert envelope["primary_artifact"]["path"] == "feature.md"
    assert _ids(envelope) == ["ref_000_supporting_prd"]
    assert envelope["source_of_truth"] == ["primary_feature", "ref_000_supporting_prd"]
    _assert_schema_valid(envelope)


def test_plan_mapping_keeps_prompt_before_prior_summaries(tmp_path: Path) -> None:
    _write(tmp_path / "plan.md", "# Plan")
    _write(tmp_path / ".closedloop-ai/context/prompt.md", "# prompt")
    _write(tmp_path / ".closedloop-ai/context/prior-loop-summaries.json", "[]")

    envelope = _build(tmp_path, "plan")

    assert envelope["primary_artifact"]["id"] == "primary_plan"
    assert envelope["primary_artifact"]["path"] == "plan.md"
    assert _ids(envelope) == ["prompt", "prior_loop_summaries"]
    assert envelope["source_of_truth"] == [
        "primary_plan",
        "prompt",
        "prior_loop_summaries",
    ]
    _assert_schema_valid(envelope)


def test_code_mapping_uses_context_code_context_as_primary(tmp_path: Path) -> None:
    _write(tmp_path / ".closedloop-ai/context/code-context.json", "{}")
    _write(tmp_path / "code-context.json", '{"legacy": true}')
    _write(tmp_path / ".closedloop-ai/context/direct-ref.md", "# direct")
    _write(tmp_path / ".closedloop-ai/context/repo-metadata.json", "{}")
    _write(tmp_path / ".closedloop-ai/context/code-evaluation-context.json", "{}")
    _write(tmp_path / ".closedloop-ai/work/attachments/changes.patch", "diff")

    envelope = _build(tmp_path, "code")

    assert envelope["primary_artifact"]["id"] == "primary_code_context"
    assert envelope["primary_artifact"]["path"] == ".closedloop-ai/context/code-context.json"
    assert _ids(envelope) == [
        "ref_000_direct_ref",
        "repo_metadata",
        "code_evaluation_context",
        "attachment_000_changes",
    ]
    assert ".closedloop-ai/context/code-context.json" not in _paths(envelope)
    assert envelope["fallback_mode"]["active"] is False
    _assert_schema_valid(envelope)


def test_code_mapping_uses_root_code_context_only_as_legacy_fallback(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "code-context.json", "{}")

    envelope = _build(tmp_path, "code")

    assert envelope["primary_artifact"]["id"] == "primary_code_context"
    assert envelope["primary_artifact"]["path"] == "code-context.json"
    assert envelope["supporting_artifacts"] == []
    assert envelope["source_of_truth"] == ["primary_code_context"]
    assert envelope["fallback_mode"]["active"] is True
    assert envelope["fallback_mode"]["fallback_artifacts"] == ["primary_code_context"]
    _assert_schema_valid(envelope)


def test_explicit_supporting_artifacts_shadow_legacy_context_artifacts(
    tmp_path: Path,
) -> None:
    _write(tmp_path / "prd.md", "# PRD")
    _write(tmp_path / ".closedloop-ai/context/artifacts/prd-primary.md", "# legacy primary")
    _write(tmp_path / ".closedloop-ai/context/artifacts/prd-ref-a.md", "# legacy ref")
    _write(
        tmp_path / ".closedloop-ai/context/supporting-artifacts/prd-ref-a.md",
        "# explicit ref",
    )
    _write(tmp_path / ".closedloop-ai/context/prompt.md", "# prompt")

    envelope = _build(tmp_path, "prd")

    assert envelope["primary_artifact"]["id"] == "primary_prd"
    assert _ids(envelope) == ["ref_000_prd_ref_a", "prompt"]
    assert _paths(envelope) == [
        ".closedloop-ai/context/supporting-artifacts/prd-ref-a.md",
        ".closedloop-ai/context/prompt.md",
    ]
    assert not any("/artifacts/" in path for path in _paths(envelope))
    assert envelope["source_of_truth"] == [
        "primary_prd",
        "ref_000_prd_ref_a",
        "prompt",
    ]
    _assert_schema_valid(envelope)


def test_duplicate_descriptor_suffixes_get_deterministic_dup_ordinals(tmp_path: Path) -> None:
    _write(tmp_path / "prd.md", "# PRD")
    _write(tmp_path / ".closedloop-ai/context/a b.md", "# one")
    _write(tmp_path / ".closedloop-ai/context/a-b.md", "# two")
    _write(tmp_path / ".closedloop-ai/work/attachments/log.txt", "one")
    _write(tmp_path / ".closedloop-ai/work/attachments/nested/log.txt", "two")

    envelope = _build(tmp_path, "prd")

    assert _ids(envelope) == [
        "ref_000_a_b",
        "ref_001_a_b_dup001",
        "attachment_000_log",
        "attachment_001_log_dup001",
    ]
    assert envelope["source_of_truth"] == [
        "primary_prd",
        "ref_000_a_b",
        "ref_001_a_b_dup001",
        "attachment_000_log",
        "attachment_001_log_dup001",
    ]
    _assert_schema_valid(envelope)


def test_feature_legacy_prd_primary_is_schema_valid_fallback(tmp_path: Path) -> None:
    _write(tmp_path / "prd.md", "# Legacy feature path")

    envelope = _build(tmp_path, "feature")

    assert envelope["primary_artifact"]["id"] == "primary_feature"
    assert envelope["primary_artifact"]["path"] == "prd.md"
    assert envelope["fallback_mode"]["active"] is True
    assert envelope["fallback_mode"]["fallback_artifacts"] == ["primary_feature"]
    assert envelope["source_of_truth"] == ["primary_feature"]
    _assert_schema_valid(envelope)


def test_plan_legacy_plan_json_fallback_includes_prd_when_present(tmp_path: Path) -> None:
    _write(tmp_path / "plan.json", "{}")
    _write(tmp_path / "prd.md", "# PRD")

    envelope = _build(tmp_path, "plan")

    assert envelope["primary_artifact"]["path"] == "plan.json"
    assert envelope["fallback_mode"]["active"] is True
    assert _ids(envelope) == ["ref_000_prd"]
    assert envelope["source_of_truth"] == ["primary_plan", "ref_000_prd"]
    assert envelope["fallback_mode"]["fallback_artifacts"] == [
        "primary_plan",
        "ref_000_prd",
    ]
    _assert_schema_valid(envelope)


def test_missing_primary_artifact_fails_without_writing(tmp_path: Path) -> None:
    with pytest.raises(JudgeInputMappingError, match="No primary artifact found"):
        _build(tmp_path, "prd")

    assert not (tmp_path / "judge-input.json").exists()


def test_cli_writes_schema_valid_judge_input_json(tmp_path: Path) -> None:
    _write(tmp_path / "prd.md", "# PRD")

    result = main(
        [
            "--workdir",
            str(tmp_path),
            "--artifact-type",
            "prd",
            "--schema",
            str(SCHEMA_PATH),
        ]
    )

    assert result == 0
    payload = json.loads((tmp_path / "judge-input.json").read_text(encoding="utf-8"))
    assert payload["primary_artifact"]["id"] == "primary_prd"
    _assert_schema_valid(payload)


def test_descriptor_paths_resolve_inside_runtime_workdir(tmp_path: Path) -> None:
    _write(tmp_path / "prd.md", "# PRD")
    _write(tmp_path / ".closedloop-ai/context/ref.md", "# ref")
    _write(tmp_path / ".closedloop-ai/work/attachments/file.txt", "file")

    envelope = _build(tmp_path, "prd")

    for descriptor in [
        envelope["primary_artifact"],
        *envelope["supporting_artifacts"],
    ]:
        resolved = (tmp_path / descriptor["path"]).resolve()
        assert resolved.is_file()
        assert resolved.is_relative_to(tmp_path.resolve())
