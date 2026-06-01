"""Companion-Change Validator rule registry + predicates (PLN-768).

A deterministic rules engine that scans a parsed diff for "companion change"
omissions — places where one half of a cross-file invariant changed without
the other half. Runs as a helper stage before any LLM reviewer fires.

Phase 1 ships a single rule: ``schema_to_orm`` (migration adds a column but
no ORM model file in the same diff references it).

Rule descriptors live as JSON files under ``plugins/code-review/tools/companion_rules/``.
Each descriptor names a predicate function defined in this module via
``predicate``; the dispatcher binds them at load time. We use JSON rather
than YAML so this module — like every other helper — has zero non-stdlib
runtime deps.

Each predicate takes (descriptor, diff_data) and returns a list of raw
finding dicts that the caller normalizes via ``normalize_legacy_finding``.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

_RULE_DESCRIPTOR_SCHEMA_VERSION = 1

# Required top-level fields in a rule descriptor. Missing/unknown fields
# fail the loader so a malformed descriptor surfaces at startup rather
# than producing silent no-op rules at runtime.
_REQUIRED_DESCRIPTOR_FIELDS: frozenset[str] = frozenset({
    "id",
    "name",
    "severity",
    "category",
    "issue_template",
    "recommendation_template",
    "predicate",
    "schema_version",
})


def load_rules(rules_dir: Path) -> list[dict[str, Any]]:
    """Discover and validate every JSON descriptor under ``rules_dir``.

    Returns descriptors sorted by filename so iteration order is deterministic.
    Raises ``ValueError`` on the first malformed descriptor — companion-validator
    is a hard contract; silent skip would let a typo'd rule disappear.
    """
    descriptors: list[tuple[str, dict[str, Any]]] = []
    if not rules_dir.is_dir():
        return []

    for path in sorted(rules_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            raise ValueError(f"Malformed JSON in rule descriptor {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError(f"Rule descriptor {path} is not a JSON object")
        missing = _REQUIRED_DESCRIPTOR_FIELDS - data.keys()
        if missing:
            raise ValueError(
                f"Rule descriptor {path} missing required fields: {sorted(missing)}",
            )
        if data["schema_version"] != _RULE_DESCRIPTOR_SCHEMA_VERSION:
            raise ValueError(
                f"Rule descriptor {path} has unsupported schema_version "
                f"{data['schema_version']!r}; expected {_RULE_DESCRIPTOR_SCHEMA_VERSION}",
            )
        if data["predicate"] not in PREDICATES:
            raise ValueError(
                f"Rule descriptor {path} references unknown predicate "
                f"{data['predicate']!r}; registered: {sorted(PREDICATES)}",
            )
        descriptors.append((path.name, data))

    return [d for _, d in descriptors]


# ---------------------------------------------------------------------------
# Predicate: schema_to_orm
# ---------------------------------------------------------------------------

# Matches the most common ADD COLUMN syntaxes across SQL + Python/Rails ORMs.
# Group 1 captures the column name (snake_case identifier).
# Conservative for Phase 1; per-language AST extraction is a Phase 2 path.
_ADD_COLUMN_PATTERNS: tuple[re.Pattern[str], ...] = (
    # PostgreSQL / generic SQL: ALTER TABLE ... ADD COLUMN foo ...
    re.compile(r"\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)", re.IGNORECASE),
    # SQLAlchemy / Alembic: op.add_column('table', sa.Column('foo', ...))
    re.compile(r"\badd_column\s*\(\s*['\"][^'\"]+['\"]\s*,\s*(?:sa\.)?Column\s*\(\s*['\"]([a-z_][a-z0-9_]*)['\"]"),
    # Django migrations: migrations.AddField(model_name='X', name='foo', field=...)
    re.compile(r"\bAddField\s*\([^)]*name\s*=\s*['\"]([a-z_][a-z0-9_]*)['\"]"),
    # Rails / ActiveRecord: add_column :table, :foo, :type
    re.compile(r"\badd_column\s*:[a-z_][a-z0-9_]*\s*,\s*:([a-z_][a-z0-9_]*)"),
)


def _is_migration_path(filepath: str) -> bool:
    """Migration file marker. Substring match keeps the descriptor stdlib-only.

    Phase 1 supports the common Python/Rails layout (``app/migrations/...``,
    ``db/migrate/...``). Globbed ``path_match`` is a Phase 2 extension.
    """
    norm = filepath.replace("\\", "/").lower()
    return "/migrations/" in norm or "/migrate/" in norm


def _is_model_path(filepath: str) -> bool:
    """ORM model file marker. See ``_is_migration_path`` for the substring rationale."""
    norm = filepath.replace("\\", "/").lower()
    return "/models/" in norm or norm.endswith("/models.py")


def _camel_case(snake: str) -> str:
    """Convert ``snake_case`` to ``camelCase`` for cross-language symbol search."""
    parts = snake.split("_")
    if len(parts) == 1:
        return parts[0]
    return parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:])


def _model_files_mention_symbol(
    symbol: str,
    file_statuses: dict[str, str],
    patch_lines: dict[str, dict[str, dict[str, str]]],
) -> bool:
    """True if any model file's added/modified lines mention the symbol.

    We look in ``added_lines`` only — companion logic targets *new* references
    in the same PR. A pre-existing reference in an untouched model file is
    not detectable from the diff alone and is out of scope for v1.
    """
    camel = _camel_case(symbol)
    for filepath, status in file_statuses.items():
        if status not in ("added", "modified"):
            continue
        if not _is_model_path(filepath):
            continue
        added = patch_lines.get(filepath, {}).get("added_lines", {})
        for content in added.values():
            if symbol in content or (camel != symbol and camel in content):
                return True
    return False


def schema_to_orm_predicate(
    descriptor: dict[str, Any],
    diff_data: dict[str, Any],
) -> list[dict[str, Any]]:
    """Emit a finding per ADD-COLUMN in a migration that no model file mentions."""
    file_statuses: dict[str, str] = diff_data.get("file_statuses", {})
    patch_lines: dict[str, dict[str, dict[str, str]]] = diff_data.get("patch_lines", {})

    findings: list[dict[str, Any]] = []
    issue_template = descriptor["issue_template"]
    recommendation_template = descriptor["recommendation_template"]
    severity = descriptor["severity"]
    category = descriptor["category"]
    rule_id = descriptor["id"]

    for filepath, status in file_statuses.items():
        if status not in ("added", "modified"):
            continue
        if not _is_migration_path(filepath):
            continue
        added: dict[str, str] = patch_lines.get(filepath, {}).get("added_lines", {})
        # Deterministic order: sort by integer line number.
        for line_str in sorted(added, key=lambda s: int(s) if s.isdigit() else 0):
            content = added[line_str]
            for pattern in _ADD_COLUMN_PATTERNS:
                match = pattern.search(content)
                if not match:
                    continue
                symbol = match.group(1)
                if _model_files_mention_symbol(symbol, file_statuses, patch_lines):
                    continue
                findings.append({
                    "file": filepath,
                    "line": int(line_str) if line_str.isdigit() else 0,
                    "severity": severity,
                    "category": category,
                    "issue": issue_template.format(symbol=symbol),
                    "recommendation": recommendation_template.format(symbol=symbol),
                    "code_snippet": content,
                    "reviewer_trigger": {"type": "always", "evidence": rule_id},
                    "subcategory": rule_id,
                })
                break  # one finding per migration line is enough
    return findings


# ---------------------------------------------------------------------------
# Predicate registry
# ---------------------------------------------------------------------------

PredicateFn = Callable[[dict[str, Any], dict[str, Any]], list[dict[str, Any]]]

PREDICATES: dict[str, PredicateFn] = {
    "schema_to_orm": schema_to_orm_predicate,
}


def evaluate_rules(
    rules_dir: Path,
    diff_data: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Load every rule and run its predicate.

    Returns ``(raw_findings, evaluated_rule_ids)``. The caller normalizes
    raw findings via ``normalize_legacy_finding`` and adds canonical
    bookkeeping (id, source, reviewer, schema_version, …).
    """
    descriptors = load_rules(rules_dir)
    raw_findings: list[dict[str, Any]] = []
    evaluated: list[str] = []
    for descriptor in descriptors:
        predicate = PREDICATES[descriptor["predicate"]]
        raw_findings.extend(predicate(descriptor, diff_data))
        evaluated.append(descriptor["id"])
    return raw_findings, evaluated
