#!/usr/bin/env python3
"""Build and validate the run-judges judge-input envelope.

The mapper is intentionally filesystem-driven: `run-judges --workdir <runDir>`
is the only runtime root, primary artifacts live under that directory,
supporting context lives under `.closedloop-ai/context`, and attachments live
under `.closedloop-ai/work/attachments`.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

EvaluationType = Literal["plan", "code", "prd", "feature"]

CONTEXT_DIR = Path(".closedloop-ai/context")
ATTACHMENTS_DIR = Path(".closedloop-ai/work/attachments")
SCHEMA_RELATIVE_PATH = Path("plugins/judges/schemas/judge-input.schema.json")

TASKS: dict[EvaluationType, str] = {
    "plan": "Evaluate implementation plan quality against the configured plan judge criteria.",
    "code": "Evaluate implementation code quality against the configured code judge criteria.",
    "prd": "Evaluate PRD quality against the configured PRD judge criteria.",
    "feature": "Evaluate Feature quality against the configured Feature judge criteria.",
}

PRIMARY_IDS: dict[EvaluationType, str] = {
    "plan": "primary_plan",
    "code": "primary_code_context",
    "prd": "primary_prd",
    "feature": "primary_feature",
}

PRIMARY_CANDIDATES: dict[EvaluationType, list[tuple[Path, bool]]] = {
    "prd": [(Path("prd.md"), False)],
    "feature": [(Path("feature.md"), False), (Path("prd.md"), True)],
    "plan": [
        (Path("plan.md"), False),
        (Path("plan-context.json"), True),
        (Path("plan.json"), True),
    ],
    "code": [
        (CONTEXT_DIR / "code-context.json", False),
        (Path("code-context.json"), True),
    ],
}

CONTEXT_MANIFEST_NAMES = {
    "artifacts.json",
    "context-index.json",
    "context-pack.json",
    "supporting-artifacts.json",
}

SPECIAL_CONTEXT_FILES: dict[str, tuple[str, str]] = {
    "prompt.md": ("prompt", "Prompt context"),
    "prompt.txt": ("prompt", "Prompt context"),
    "evaluation-prompt.md": ("prompt", "Prompt context"),
    "user-prompt.md": ("prompt", "Prompt context"),
    "repo-info.json": ("repo_metadata", "Repository metadata"),
    "repo-metadata.json": ("repo_metadata", "Repository metadata"),
    "repository.json": ("repo_metadata", "Repository metadata"),
    "code-evaluation-context.json": (
        "code_evaluation_context",
        "Code evaluation metadata",
    ),
    "code-evaluation-context.md": (
        "code_evaluation_context",
        "Code evaluation metadata",
    ),
    "prior-loop-summaries.json": (
        "prior_loop_summaries",
        "Prior loop summaries",
    ),
    "prior-loop-summaries.md": (
        "prior_loop_summaries",
        "Prior loop summaries",
    ),
    "prior-summaries.json": ("prior_loop_summaries", "Prior loop summaries"),
}


@dataclass(frozen=True)
class MappingResult:
    """Result of selecting the primary artifact for an evaluation mode."""

    path: Path
    fallback_reason: str

    @property
    def uses_legacy_fallback(self) -> bool:
        return bool(self.fallback_reason)


class JudgeInputMappingError(ValueError):
    """Raised when a schema-valid judge-input envelope cannot be produced."""


def sanitize_descriptor_stem(raw: str) -> str:
    """Convert arbitrary text to lowercase ASCII snake-case descriptor text."""

    ascii_text = raw.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^0-9A-Za-z]+", "_", ascii_text).strip("_").lower()
    return slug or "item"


def detect_artifact_type(path: Path) -> str:
    """Infer the descriptor content type from a materialized filename."""

    suffix = path.suffix.lower()
    if suffix == ".json":
        return "json"
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix in {".diff", ".patch"}:
        return "diff"
    if suffix in {".yaml", ".yml"}:
        return "yaml"
    return "text"


def build_judge_input(
    workdir: Path,
    artifact_type: EvaluationType,
    *,
    run_id: str | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build the judge-input envelope from the runtime workdir contract.

    Args:
        workdir: Runtime directory passed to `run-judges --workdir`.
        artifact_type: Evaluation mode being judged.
        run_id: Optional run identifier override. Defaults to the
            `CLOSEDLOOP_RUN_ID` environment variable or the workdir name.
        generated_at: Optional ISO-8601 timestamp override for deterministic
            tests. Defaults to the current UTC timestamp.

    Returns:
        A schema-shaped judge-input dictionary with relative artifact paths.

    Raises:
        JudgeInputMappingError: If no primary artifact can be selected.
    """

    workdir = workdir.resolve()
    primary = _select_primary_artifact(workdir, artifact_type)
    primary_descriptor = _descriptor(
        PRIMARY_IDS[artifact_type],
        primary.path,
        required=True,
        description=_primary_description(artifact_type, primary.path),
    )

    used_ids = {primary_descriptor["id"]}
    supporting_artifacts = _discover_supporting_artifacts(
        workdir,
        primary.path,
        used_ids,
    )

    if primary.uses_legacy_fallback:
        supporting_artifacts.extend(
            _legacy_supporting_artifacts(workdir, artifact_type, primary.path, used_ids)
        )

    source_of_truth = [
        primary_descriptor["id"],
        *[artifact["id"] for artifact in supporting_artifacts],
    ]
    fallback_artifacts: list[str] = []
    if primary.uses_legacy_fallback:
        fallback_artifacts = [
            primary_descriptor["id"],
            *[artifact["id"] for artifact in supporting_artifacts],
        ]

    return {
        "evaluation_type": artifact_type,
        "task": TASKS[artifact_type],
        "primary_artifact": primary_descriptor,
        "supporting_artifacts": supporting_artifacts,
        "source_of_truth": source_of_truth,
        "fallback_mode": {
            "active": primary.uses_legacy_fallback,
            "reason": primary.fallback_reason,
            "fallback_artifacts": fallback_artifacts,
        },
        "metadata": {
            "run_id": run_id or os.environ.get("CLOSEDLOOP_RUN_ID") or workdir.name,
            "generated_at": generated_at
            or datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        },
    }


def validate_judge_input(envelope: dict[str, Any], schema_path: Path) -> None:
    """Validate an envelope against `judge-input.schema.json`.

    The preferred path uses `jsonschema` when available from the active uv
    environment. A small built-in validator covers this repository's schema so
    the producer still enforces the checked-in contract if that optional package
    is unavailable in a runtime shell.
    """

    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        _validate_against_local_schema(envelope, schema)
        return

    errors = sorted(
        Draft7Validator(schema).iter_errors(envelope),
        key=lambda error: list(error.path),
    )
    if errors:
        first = errors[0]
        path = ".".join(str(part) for part in first.path) or "<root>"
        raise JudgeInputMappingError(f"judge-input schema invalid at {path}: {first.message}")


def write_judge_input(
    workdir: Path,
    artifact_type: EvaluationType,
    schema_path: Path,
    output_path: Path | None = None,
) -> dict[str, Any]:
    """Build, validate, and write `judge-input.json` for a run directory."""

    envelope = build_judge_input(workdir, artifact_type)
    validate_judge_input(envelope, schema_path)
    output = output_path or workdir / "judge-input.json"
    output.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return envelope


def _select_primary_artifact(workdir: Path, artifact_type: EvaluationType) -> MappingResult:
    for relative_path, is_legacy in PRIMARY_CANDIDATES[artifact_type]:
        if (workdir / relative_path).is_file():
            reason = (
                f"Using legacy {relative_path.as_posix()} fallback because the "
                "runtime contract primary artifact was not available."
                if is_legacy
                else ""
            )
            return MappingResult(relative_path, reason)

    candidates = ", ".join(path.as_posix() for path, _ in PRIMARY_CANDIDATES[artifact_type])
    raise JudgeInputMappingError(
        f"No primary artifact found for {artifact_type}; expected one of: {candidates}"
    )


def _descriptor(
    descriptor_id: str,
    relative_path: Path,
    *,
    required: bool,
    description: str,
) -> dict[str, Any]:
    return {
        "id": descriptor_id,
        "path": relative_path.as_posix(),
        "type": detect_artifact_type(relative_path),
        "required": required,
        "description": description,
    }


def _primary_description(artifact_type: EvaluationType, path: Path) -> str:
    descriptions = {
        "prd": "Primary PRD artifact",
        "feature": "Primary Feature artifact",
        "plan": "Primary implementation plan artifact",
        "code": "Primary code evaluation context",
    }
    return f"{descriptions[artifact_type]} ({path.as_posix()})"


def _discover_supporting_artifacts(
    workdir: Path,
    primary_path: Path,
    used_ids: set[str],
) -> list[dict[str, Any]]:
    context_dir = workdir / CONTEXT_DIR
    attachments_dir = workdir / ATTACHMENTS_DIR
    artifacts: list[dict[str, Any]] = []

    context_files = _all_context_files(context_dir, workdir, primary_path)
    manifest_order = _manifest_ordered_context_paths(context_dir, workdir)
    direct_refs = _ordered_direct_refs(context_files, manifest_order)
    special_files = _ordered_special_context_files(context_files)

    family_slugs: dict[str, int] = {}
    for index, relative_path in enumerate(direct_refs):
        slug = _family_slug(relative_path, family_slugs)
        descriptor_id = _ensure_unique_id(f"ref_{index:03d}_{slug}", used_ids)
        artifacts.append(
            _descriptor(
                descriptor_id,
                relative_path,
                required=True,
                description="Direct referenced context artifact",
            )
        )

    for relative_path, descriptor_id, description in special_files:
        artifacts.append(
            _descriptor(
                _ensure_unique_id(descriptor_id, used_ids),
                relative_path,
                required=True,
                description=description,
            )
        )

    attachment_slugs: dict[str, int] = {}
    for index, relative_path in enumerate(_attachment_files(attachments_dir, workdir)):
        slug = _family_slug(relative_path, attachment_slugs)
        descriptor_id = _ensure_unique_id(f"attachment_{index:03d}_{slug}", used_ids)
        artifacts.append(
            _descriptor(
                descriptor_id,
                relative_path,
                required=True,
                description="Materialized attachment",
            )
        )

    return artifacts


def _legacy_supporting_artifacts(
    workdir: Path,
    artifact_type: EvaluationType,
    primary_path: Path,
    used_ids: set[str],
) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    if artifact_type == "plan":
        for candidate in (Path("prd.md"), Path("plan.md")):
            if candidate == primary_path:
                continue
            if (workdir / candidate).is_file():
                artifacts.append(
                    _descriptor(
                        _ensure_unique_id(
                            f"ref_{len(artifacts):03d}_{sanitize_descriptor_stem(candidate.stem)}",
                            used_ids,
                        ),
                        candidate,
                        required=True,
                        description="Legacy fallback artifact",
                    )
                )
    return artifacts


def _all_context_files(
    context_dir: Path,
    workdir: Path,
    primary_path: Path,
) -> list[Path]:
    if not context_dir.is_dir():
        return []

    primary_abs = (workdir / primary_path).resolve()
    skip_legacy_artifacts = _has_explicit_context_files(context_dir)
    files: list[Path] = []
    for path in context_dir.rglob("*"):
        if not path.is_file() or path.name in CONTEXT_MANIFEST_NAMES:
            continue
        context_relative_path = path.relative_to(context_dir)
        if skip_legacy_artifacts and _is_legacy_context_artifact(context_relative_path):
            continue
        if path.resolve() == primary_abs:
            continue
        files.append(path.relative_to(workdir))
    return sorted(files, key=lambda path: path.as_posix())


def _has_explicit_context_files(context_dir: Path) -> bool:
    """Return true when FEA-585 explicit context should shadow legacy artifacts."""

    supporting_artifacts_dir = context_dir / "supporting-artifacts"
    return supporting_artifacts_dir.is_dir() and any(
        path.is_file() for path in supporting_artifacts_dir.rglob("*")
    )


def _is_legacy_context_artifact(context_relative_path: Path) -> bool:
    """Identify legacy pack.artifacts materializations under context/artifacts."""

    return bool(context_relative_path.parts) and context_relative_path.parts[0] == "artifacts"


def _manifest_ordered_context_paths(context_dir: Path, workdir: Path) -> list[Path]:
    ordered: list[Path] = []
    for manifest_name in sorted(CONTEXT_MANIFEST_NAMES):
        manifest_path = context_dir / manifest_name
        if not manifest_path.is_file():
            continue
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        ordered.extend(_extract_manifest_paths(payload, context_dir, workdir))
    return _dedupe_existing_paths(ordered, workdir)


def _extract_manifest_paths(payload: Any, context_dir: Path, workdir: Path) -> list[Path]:
    if isinstance(payload, list):
        return [_coerce_manifest_entry(item, context_dir, workdir) for item in payload]
    if isinstance(payload, dict):
        for key in (
            "supportingArtifacts",
            "referencedArtifacts",
            "directReferences",
            "artifacts",
            "files",
            "contextFiles",
        ):
            value = payload.get(key)
            if isinstance(value, list):
                return [_coerce_manifest_entry(item, context_dir, workdir) for item in value]
    return []


def _coerce_manifest_entry(item: Any, context_dir: Path, workdir: Path) -> Path:
    raw = ""
    if isinstance(item, str):
        raw = item
    elif isinstance(item, dict):
        for key in (
            "path",
            "relativePath",
            "materializedPath",
            "localPath",
            "file",
            "filename",
            "name",
        ):
            value = item.get(key)
            if isinstance(value, str) and value:
                raw = value
                break
    if not raw:
        return Path()

    path = Path(raw)
    if path.is_absolute():
        try:
            return path.resolve().relative_to(workdir.resolve())
        except ValueError:
            return Path()
    if path.parts[:2] == (".closedloop-ai", "context"):
        return path
    return CONTEXT_DIR / path


def _dedupe_existing_paths(paths: Iterable[Path], workdir: Path) -> list[Path]:
    seen: set[str] = set()
    ordered: list[Path] = []
    for path in paths:
        if not path.parts:
            continue
        key = path.as_posix()
        if key in seen or not (workdir / path).is_file():
            continue
        seen.add(key)
        ordered.append(path)
    return ordered


def _ordered_direct_refs(
    context_files: Sequence[Path],
    manifest_order: Sequence[Path],
) -> list[Path]:
    context_set = set(context_files)
    ordered: list[Path] = []
    for path in manifest_order:
        if path in context_set and not _special_descriptor_for(path):
            ordered.append(path)
    ordered_set = set(ordered)
    for path in context_files:
        if path not in ordered_set and not _special_descriptor_for(path):
            ordered.append(path)
    return ordered


def _ordered_special_context_files(
    context_files: Sequence[Path],
) -> list[tuple[Path, str, str]]:
    by_id: dict[str, list[tuple[Path, str]]] = {
        "prompt": [],
        "repo_metadata": [],
        "code_evaluation_context": [],
        "prior_loop_summaries": [],
    }
    for path in context_files:
        special = _special_descriptor_for(path)
        if special:
            descriptor_id, description = special
            by_id[descriptor_id].append((path, description))

    ordered: list[tuple[Path, str, str]] = []
    for descriptor_id in (
        "prompt",
        "repo_metadata",
        "code_evaluation_context",
        "prior_loop_summaries",
    ):
        for path, description in sorted(by_id[descriptor_id], key=lambda item: item[0].as_posix()):
            ordered.append((path, descriptor_id, description))
    return ordered


def _special_descriptor_for(path: Path) -> tuple[str, str] | None:
    return SPECIAL_CONTEXT_FILES.get(path.name)


def _attachment_files(attachments_dir: Path, workdir: Path) -> list[Path]:
    if not attachments_dir.is_dir():
        return []
    files = [
        path.relative_to(workdir)
        for path in attachments_dir.rglob("*")
        if path.is_file()
    ]
    return sorted(files, key=lambda path: path.as_posix())


def _family_slug(relative_path: Path, family_slugs: dict[str, int]) -> str:
    stem = relative_path.stem or relative_path.name
    slug = sanitize_descriptor_stem(stem)
    count = family_slugs.get(slug, 0)
    family_slugs[slug] = count + 1
    if count == 0:
        return slug
    return f"{slug}_dup{count:03d}"


def _ensure_unique_id(descriptor_id: str, used_ids: set[str]) -> str:
    if descriptor_id not in used_ids:
        used_ids.add(descriptor_id)
        return descriptor_id

    counter = 1
    while True:
        candidate = f"{descriptor_id}_dup{counter:03d}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate
        counter += 1


def _validate_against_local_schema(envelope: dict[str, Any], schema: dict[str, Any]) -> None:
    required = schema.get("required", [])
    missing = [field for field in required if field not in envelope]
    if missing:
        raise JudgeInputMappingError(f"judge-input schema invalid: missing {missing}")
    if envelope.get("evaluation_type") not in {"plan", "code", "prd", "feature"}:
        raise JudgeInputMappingError("judge-input schema invalid: invalid evaluation_type")
    if not isinstance(envelope.get("supporting_artifacts"), list):
        raise JudgeInputMappingError("judge-input schema invalid: supporting_artifacts must be an array")
    if not isinstance(envelope.get("source_of_truth"), list) or not envelope["source_of_truth"]:
        raise JudgeInputMappingError("judge-input schema invalid: source_of_truth must be a non-empty array")
    _validate_descriptor(envelope.get("primary_artifact"), "primary_artifact")
    for index, descriptor in enumerate(envelope.get("supporting_artifacts", [])):
        _validate_descriptor(descriptor, f"supporting_artifacts[{index}]")
    fallback_mode = envelope.get("fallback_mode")
    if not isinstance(fallback_mode, dict):
        raise JudgeInputMappingError("judge-input schema invalid: fallback_mode must be an object")
    for field in ("active", "reason", "fallback_artifacts"):
        if field not in fallback_mode:
            raise JudgeInputMappingError(f"judge-input schema invalid: fallback_mode.{field} missing")
    metadata = envelope.get("metadata")
    if not isinstance(metadata, dict) or not metadata.get("run_id"):
        raise JudgeInputMappingError("judge-input schema invalid: metadata.run_id missing")


def _validate_descriptor(descriptor: Any, path: str) -> None:
    if not isinstance(descriptor, dict):
        raise JudgeInputMappingError(f"judge-input schema invalid: {path} must be an object")
    for field in ("id", "path", "type", "required"):
        if field not in descriptor:
            raise JudgeInputMappingError(f"judge-input schema invalid: {path}.{field} missing")
    for field in ("id", "path", "type"):
        if not isinstance(descriptor[field], str) or not descriptor[field]:
            raise JudgeInputMappingError(
                f"judge-input schema invalid: {path}.{field} must be a non-empty string"
            )
    if not isinstance(descriptor["required"], bool):
        raise JudgeInputMappingError(f"judge-input schema invalid: {path}.required must be boolean")


def _default_schema_path(script_path: Path) -> Path:
    for parent in script_path.resolve().parents:
        candidate = parent / SCHEMA_RELATIVE_PATH
        if candidate.is_file():
            return candidate
    return script_path.resolve().parents[3] / "schemas/judge-input.schema.json"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build run-judges judge-input.json")
    parser.add_argument("--workdir", required=True, help="Runtime workdir passed to run-judges")
    parser.add_argument(
        "--artifact-type",
        choices=("plan", "code", "prd", "feature"),
        required=True,
        help="Evaluation artifact type",
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=_default_schema_path(Path(__file__)),
        help="Path to judge-input.schema.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Output path for judge-input.json (defaults to <workdir>/judge-input.json)",
    )
    args = parser.parse_args(argv)

    try:
        write_judge_input(
            Path(args.workdir),
            args.artifact_type,
            args.schema,
            args.output,
        )
    except JudgeInputMappingError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"ERROR: failed to write judge-input.json: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
