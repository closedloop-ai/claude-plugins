#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build judge-input.json deterministically based on available files and mode.

Constructs the judge input envelope following the contract defined in
skills/run-judges/references/judge-input-contract.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import Enum
from pathlib import Path
from typing import Any


class ArtifactType(Enum):
    PLAN = "plan"
    CODE = "code"


@dataclass
class ArtifactDescriptor:
    id: str
    path: str
    type: str
    required: bool
    description: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "type": self.type,
            "required": self.required,
            "description": self.description,
        }


@dataclass
class FallbackMode:
    active: bool
    reason: str
    fallback_artifacts: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "active": self.active,
            "reason": self.reason,
            "fallback_artifacts": self.fallback_artifacts,
        }


def _maybe_append_investigation_log(
    workdir: Path,
    supporting: list[ArtifactDescriptor],
    source_of_truth: list[str],
) -> None:
    """Append investigation-log.md to supporting and source_of_truth if present."""
    inv_log = workdir / "investigation-log.md"
    if inv_log.is_file():
        supporting.append(
            ArtifactDescriptor(
                id="investigation_log",
                path=str(inv_log),
                type="markdown",
                required=False,
                description="Prior discovery findings and codebase evidence",
            )
        )
        source_of_truth.append("investigation_log")


def _build_plan_normal(workdir: Path) -> dict[str, Any]:
    """Build judge-input for plan mode with plan-context.json available."""
    primary = ArtifactDescriptor(
        id="plan_context",
        path=str(workdir / "plan-context.json"),
        type="json",
        required=True,
        description="Compressed plan context bundle",
    )
    supporting: list[ArtifactDescriptor] = []
    source_of_truth = ["plan_context"]
    _maybe_append_investigation_log(workdir, supporting, source_of_truth)

    return {
        "primary_artifact": primary.to_dict(),
        "supporting_artifacts": [s.to_dict() for s in supporting],
        "source_of_truth": source_of_truth,
        "fallback_mode": FallbackMode(
            active=False, reason="", fallback_artifacts=[]
        ).to_dict(),
    }


def _build_plan_compatibility(workdir: Path) -> dict[str, Any]:
    """Build judge-input for plan mode using raw plan.json + prd.md fallback."""
    primary = ArtifactDescriptor(
        id="plan_json",
        path=str(workdir / "plan.json"),
        type="json",
        required=True,
        description="Raw implementation plan (compatibility fallback)",
    )
    supporting = [
        ArtifactDescriptor(
            id="prd",
            path=str(workdir / "prd.md"),
            type="markdown",
            required=True,
            description="Product requirements document",
        )
    ]
    source_of_truth = ["plan_json", "prd"]
    _maybe_append_investigation_log(workdir, supporting, source_of_truth)

    return {
        "primary_artifact": primary.to_dict(),
        "supporting_artifacts": [s.to_dict() for s in supporting],
        "source_of_truth": source_of_truth,
        "fallback_mode": FallbackMode(
            active=True,
            reason="plan-context.json unavailable; using raw plan.json + prd.md",
            fallback_artifacts=["plan_json", "prd"],
        ).to_dict(),
    }


def _build_code(workdir: Path) -> dict[str, Any]:
    """Build judge-input for code mode with code-context.json."""
    primary = ArtifactDescriptor(
        id="code_context",
        path=str(workdir / "code-context.json"),
        type="json",
        required=True,
        description="Compressed code context bundle",
    )
    source_of_truth = ["code_context"]

    return {
        "primary_artifact": primary.to_dict(),
        "supporting_artifacts": [],
        "source_of_truth": source_of_truth,
        "fallback_mode": FallbackMode(
            active=False, reason="", fallback_artifacts=[]
        ).to_dict(),
    }


TASK_DESCRIPTIONS: dict[ArtifactType, str] = {
    ArtifactType.PLAN: (
        "Evaluate the implementation plan for quality, completeness, "
        "and adherence to design principles."
    ),
    ArtifactType.CODE: (
        "Evaluate the implemented code for quality, correctness, "
        "and adherence to design and SOLID principles."
    ),
}


def build_judge_input(
    artifact_type: ArtifactType,
    workdir: Path,
    compatibility_mode: bool = False,
) -> dict[str, Any]:
    """Construct the judge-input.json envelope.

    Returns the envelope dict on success.
    Raises FileNotFoundError if required artifacts are missing.
    """
    run_id = os.environ.get("CLOSEDLOOP_RUN_ID", workdir.name)

    match artifact_type:
        case ArtifactType.PLAN:
            plan_ctx = workdir / "plan-context.json"
            if plan_ctx.is_file() and not compatibility_mode:
                artifacts = _build_plan_normal(workdir)
            elif compatibility_mode:
                plan_json = workdir / "plan.json"
                prd_md = workdir / "prd.md"
                if not plan_json.is_file():
                    raise FileNotFoundError(
                        f"Compatibility mode requires plan.json: {plan_json}"
                    )
                if not prd_md.is_file():
                    raise FileNotFoundError(
                        f"Compatibility mode requires prd.md: {prd_md}"
                    )
                artifacts = _build_plan_compatibility(workdir)
            else:
                raise FileNotFoundError(
                    f"plan-context.json not found at {plan_ctx}. "
                    "Use --compatibility-mode for raw plan.json + prd.md fallback."
                )
        case ArtifactType.CODE:
            code_ctx = workdir / "code-context.json"
            if not code_ctx.is_file():
                raise FileNotFoundError(
                    f"code-context.json not found at {code_ctx}. "
                    "Context preparation is required for code judges."
                )
            artifacts = _build_code(workdir)

    envelope: dict[str, Any] = {
        "evaluation_type": artifact_type.value,
        "task": TASK_DESCRIPTIONS[artifact_type],
        **artifacts,
        "metadata": {
            "run_id": run_id,
            "generated_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
    }

    for art in [envelope["primary_artifact"]] + envelope.get("supporting_artifacts", []):
        if art.get("required") and not Path(art["path"]).is_file():
            raise FileNotFoundError(
                f"Required artifact missing: {art['id']} at {art['path']}"
            )

    return envelope


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build judge-input.json for judge execution"
    )
    parser.add_argument(
        "--artifact-type",
        choices=["plan", "code"],
        default="plan",
        help="Artifact category to evaluate (default: plan)",
    )
    parser.add_argument(
        "--workdir",
        required=True,
        help="Path to CLOSEDLOOP_WORKDIR",
    )
    parser.add_argument(
        "--compatibility-mode",
        action="store_true",
        default=False,
        help="Use raw plan.json + prd.md instead of plan-context.json",
    )
    args = parser.parse_args()

    workdir = Path(args.workdir).resolve()
    if not workdir.is_dir():
        print(f"ERROR: workdir does not exist: {workdir}", file=sys.stderr)
        sys.exit(1)

    artifact_type = ArtifactType(args.artifact_type)

    try:
        envelope = build_judge_input(
            artifact_type=artifact_type,
            workdir=workdir,
            compatibility_mode=args.compatibility_mode,
        )
    except FileNotFoundError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    output_path = workdir / "judge-input.json"
    output_path.write_text(json.dumps(envelope, indent=2) + "\n")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
