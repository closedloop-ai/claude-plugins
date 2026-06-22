#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Estimate whether judge prompts fit within the 128K context budget.

The 128K budget check in `SKILL.md` must reflect the *actual* tokens a judge will
load, not just the size of the `judge-input.json` envelope. The envelope is a thin
descriptor: it lists relative paths (`primary_artifact.path` and each
`supporting_artifacts[].path`) to the real source-of-truth artifacts the judges read.
A small envelope can therefore point at a large PRD/feature file or context bundle
that overflows the window.

This script resolves every referenced artifact relative to the workdir, sums their
byte sizes together with the preamble files, converts to a conservative token
estimate, reserves headroom for system overhead and model output, and reports
whether all judges must be skipped.

Output is a single JSON object on stdout, e.g.:

    {
      "preamble_tokens": 1200,
      "artifact_tokens": 41000,
      "estimated_tokens": 42200,
      "available_for_judge": 22000,
      "skip_all_judges": true,
      "missing_artifacts": []
    }
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _iter_referenced_paths(envelope: dict[str, Any]) -> list[str]:
    """Collect the relative artifact paths a judge will load from the envelope.

    Includes the primary artifact and every supporting artifact. Missing or
    malformed descriptors are skipped defensively so a bad entry cannot crash the
    budget check (it would simply be excluded from the estimate).
    """

    paths: list[str] = []
    primary = envelope.get("primary_artifact")
    if isinstance(primary, dict) and isinstance(primary.get("path"), str):
        paths.append(primary["path"])
    supporting = envelope.get("supporting_artifacts")
    if isinstance(supporting, list):
        for artifact in supporting:
            if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
                paths.append(artifact["path"])
    return paths


def _sum_file_bytes(paths: list[Path]) -> int:
    """Return the total byte size of the given existing files."""

    total = 0
    for path in paths:
        total += path.stat().st_size
    return total


def estimate_budget(
    *,
    workdir: Path,
    judge_input_path: Path,
    preamble_paths: list[Path],
    context_token_budget: int,
    output_reserve: int = 8000,
    chars_per_token: int = 4,
) -> dict[str, Any]:
    """Estimate the per-judge prompt size from the real mapped artifacts.

    Args:
        workdir: Run directory the envelope's relative paths resolve against.
        judge_input_path: Path to the `judge-input.json` envelope.
        preamble_paths: Preamble files prepended to every judge prompt.
        context_token_budget: Token budget available in 128K mode.
        output_reserve: Tokens reserved for system overhead and model output.
        chars_per_token: Conservative chars/token heuristic (matches the `/4`
            fallback used by context-manager-for-judges when count_tokens.py is
            unavailable).

    Returns:
        A dict describing the estimate and whether all judges must be skipped.

    Raises:
        FileNotFoundError: If the envelope itself cannot be read.
        ValueError: If the envelope is not valid JSON.
    """

    envelope = json.loads(judge_input_path.read_text(encoding="utf-8"))

    preamble_bytes = _sum_file_bytes([p for p in preamble_paths if p.is_file()])

    referenced = _iter_referenced_paths(envelope)
    missing: list[str] = []
    existing_artifacts: list[Path] = []
    for rel in referenced:
        resolved = (workdir / rel)
        if resolved.is_file():
            existing_artifacts.append(resolved)
        else:
            missing.append(rel)
    artifact_bytes = _sum_file_bytes(existing_artifacts)

    preamble_tokens = preamble_bytes // chars_per_token
    artifact_tokens = artifact_bytes // chars_per_token
    estimated_tokens = preamble_tokens + artifact_tokens

    available_for_judge = context_token_budget - output_reserve
    skip_all_judges = estimated_tokens > available_for_judge

    return {
        "preamble_tokens": preamble_tokens,
        "artifact_tokens": artifact_tokens,
        "estimated_tokens": estimated_tokens,
        "available_for_judge": available_for_judge,
        "skip_all_judges": skip_all_judges,
        "missing_artifacts": missing,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Estimate whether judge prompts fit within the 128K context budget."
    )
    parser.add_argument("--workdir", required=True, help="Run directory the envelope paths resolve against")
    parser.add_argument(
        "--judge-input",
        help="Path to judge-input.json (defaults to $WORKDIR/judge-input.json)",
    )
    parser.add_argument(
        "--preamble",
        action="append",
        default=[],
        help="Preamble file prepended to every judge prompt (repeatable)",
    )
    parser.add_argument(
        "--budget",
        type=int,
        required=True,
        help="CONTEXT_TOKEN_BUDGET available in 128K mode",
    )
    parser.add_argument(
        "--output-reserve",
        type=int,
        default=8000,
        help="Tokens reserved for system overhead and model output (default: 8000)",
    )
    parser.add_argument(
        "--chars-per-token",
        type=int,
        default=4,
        help="Chars/token heuristic (default: 4)",
    )

    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        print(f"Error: workdir does not exist: {workdir}", file=sys.stderr)
        return 1

    judge_input_path = (
        Path(args.judge_input).resolve() if args.judge_input else workdir / "judge-input.json"
    )
    if not judge_input_path.is_file():
        print(f"Error: judge-input not found: {judge_input_path}", file=sys.stderr)
        return 1

    try:
        result = estimate_budget(
            workdir=workdir,
            judge_input_path=judge_input_path,
            preamble_paths=[Path(p) for p in args.preamble],
            context_token_budget=args.budget,
            output_reserve=args.output_reserve,
            chars_per_token=args.chars_per_token,
        )
    except (ValueError, OSError) as e:
        print(f"Error: failed to estimate budget: {e}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
