"""Tests for estimate_judge_budget.py."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from estimate_judge_budget import (  # type: ignore[import-not-found]
    estimate_budget,
)


def _write_envelope(
    workdir: Path,
    *,
    primary_path: str,
    supporting_paths: list[str] | None = None,
) -> Path:
    """Write a minimal judge-input.json envelope referencing the given paths."""
    envelope = {
        "evaluation_type": "feature",
        "primary_artifact": {"id": "primary_feature", "path": primary_path},
        "supporting_artifacts": [
            {"id": f"ref_{i}", "path": p}
            for i, p in enumerate(supporting_paths or [])
        ],
    }
    judge_input = workdir / "judge-input.json"
    judge_input.write_text(json.dumps(envelope), encoding="utf-8")
    return judge_input


def test_small_envelope_large_referenced_artifact_triggers_skip(tmp_path: Path) -> None:
    """A tiny envelope pointing at a huge artifact must trip the skip guard.

    Regression for the bug where the budget check counted only the
    judge-input.json envelope (which stays small) and missed the actual mapped
    source-of-truth artifact, letting an oversized PRD/feature file overflow the
    128K context window undetected.
    """
    # Large referenced artifact: 200,000 chars -> ~50,000 tokens at /4.
    big_file = tmp_path / "feature.md"
    big_file.write_text("x" * 200_000, encoding="utf-8")

    judge_input = _write_envelope(tmp_path, primary_path="feature.md")
    # Envelope itself is tiny, so an envelope-only estimate would pass.
    assert judge_input.stat().st_size < 1_000

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["artifact_tokens"] == 50_000
    assert result["skip_all_judges"] is True


def test_small_referenced_artifact_fits_budget(tmp_path: Path) -> None:
    """A small referenced artifact fits comfortably and judges are not skipped."""
    small_file = tmp_path / "feature.md"
    small_file.write_text("x" * 4_000, encoding="utf-8")  # ~1,000 tokens

    judge_input = _write_envelope(tmp_path, primary_path="feature.md")

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["artifact_tokens"] == 1_000
    assert result["skip_all_judges"] is False


def test_supporting_artifacts_counted(tmp_path: Path) -> None:
    """Supporting artifacts contribute to the estimate, not just the primary."""
    (tmp_path / "feature.md").write_text("x" * 4_000, encoding="utf-8")  # 1,000 tokens
    ctx_dir = tmp_path / ".closedloop-ai" / "context"
    ctx_dir.mkdir(parents=True)
    (ctx_dir / "extra.md").write_text("y" * 80_000, encoding="utf-8")  # 20,000 tokens

    judge_input = _write_envelope(
        tmp_path,
        primary_path="feature.md",
        supporting_paths=[".closedloop-ai/context/extra.md"],
    )

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["artifact_tokens"] == 21_000
    assert result["skip_all_judges"] is False


def test_preambles_counted(tmp_path: Path) -> None:
    """Preamble files are included in the prompt-size estimate."""
    (tmp_path / "feature.md").write_text("x" * 4_000, encoding="utf-8")  # 1,000 tokens
    preamble = tmp_path / "preamble.md"
    preamble.write_text("p" * 8_000, encoding="utf-8")  # 2,000 tokens

    judge_input = _write_envelope(tmp_path, primary_path="feature.md")

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[preamble],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["preamble_tokens"] == 2_000
    assert result["artifact_tokens"] == 1_000
    assert result["estimated_tokens"] == 3_000


def test_missing_referenced_artifact_is_reported(tmp_path: Path) -> None:
    """A referenced path that does not exist is reported, not silently counted."""
    (tmp_path / "feature.md").write_text("x" * 4_000, encoding="utf-8")
    judge_input = _write_envelope(
        tmp_path,
        primary_path="feature.md",
        supporting_paths=["does-not-exist.md"],
    )

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["missing_artifacts"] == ["does-not-exist.md"]
    assert result["artifact_tokens"] == 1_000


def test_output_reserve_reduces_available_budget(tmp_path: Path) -> None:
    """The output reserve is subtracted from the budget before comparison."""
    # 22,000 tokens of artifact: fits under 30K raw, but not under 30K-8K reserve... actually
    # 22,000 > (30,000 - 8,000) = 22,000 is False; use a value just over the line.
    (tmp_path / "feature.md").write_text("x" * 88_004, encoding="utf-8")  # 22,001 tokens
    judge_input = _write_envelope(tmp_path, primary_path="feature.md")

    result = estimate_budget(
        workdir=tmp_path,
        judge_input_path=judge_input,
        preamble_paths=[],
        context_token_budget=30_000,
        output_reserve=8_000,
    )

    assert result["available_for_judge"] == 22_000
    assert result["estimated_tokens"] == 22_001
    assert result["skip_all_judges"] is True
