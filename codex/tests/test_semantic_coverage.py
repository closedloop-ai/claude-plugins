"""Semantic coverage tests for the Claude -> Codex plugin conversion.

Structural tests in `test_conversion_coverage.py` prove that every Claude
artifact has a Codex destination file. These tests prove the destination
*content* preserves what the conversion is supposed to preserve:

    Family 1 - Output validity:    every emitted file parses cleanly
    Family 2 - Identity:           name/description survive intact
    Family 3 - Transformation:     acplugin's rules applied correctly
    Family 4 - Body fidelity:      developer_instructions carries the body
    Family 5 - Skill frontmatter:  skill name/description preserved
    Family 6 - Cross-references:   `plugin:skill` refs still resolve

Discovery, dataclasses, and parsers live in `helpers.py`.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from helpers import (
    REPO_ROOT,
    ArtifactPair,
    CMD_PREFIX,
    Plugin,
    PLUGIN_NAMES,
    all_pairs,
    codex_skill_universe_normalized,
    pair_id,
    parse_claude_tools,
    parse_codex_agent,
    parse_yaml_frontmatter,
    parse_yaml_frontmatter_optional,
)


# ----- Discovery helpers used only by this module ------------------------


def _all_codex_agent_paths() -> list[Path]:
    return [
        path
        for plugin in Plugin
        for path in sorted(
            (REPO_ROOT / "codex" / plugin.value / ".codex" / "agents").glob("*.toml")
        )
    ]


def _all_codex_skill_paths() -> list[Path]:
    out: list[Path] = []
    for plugin in Plugin:
        skills_dir = REPO_ROOT / "codex" / plugin.value / ".agents" / "skills"
        if not skills_dir.is_dir():
            continue
        for skill_dir in sorted(skills_dir.iterdir()):
            skill_file = skill_dir / "SKILL.md"
            if skill_file.is_file():
                out.append(skill_file)
    return out


def _all_codex_manifest_paths() -> list[Path]:
    return [
        REPO_ROOT / "codex" / plugin.value / ".codex-plugin" / "plugin.json"
        for plugin in Plugin
    ]


def _normalize_ws(value: str) -> str:
    return " ".join(value.split())


# ----- Family 1: Output validity ----------------------------------------


@pytest.mark.parametrize(
    "path",
    _all_codex_agent_paths(),
    ids=lambda p: f"{p.parent.parent.parent.name}/{p.name}",
)
def test_codex_agent_toml_parses(path: Path) -> None:
    parse_codex_agent(path)  # raises on invalid TOML


@pytest.mark.parametrize(
    "path",
    _all_codex_skill_paths(),
    ids=lambda p: f"{p.parent.parent.parent.parent.parent.name}/{p.parent.name}",
)
def test_codex_skill_frontmatter_parses(path: Path) -> None:
    parse_yaml_frontmatter(path)


@pytest.mark.parametrize(
    "path", _all_codex_manifest_paths(), ids=lambda p: p.parent.parent.name
)
def test_codex_plugin_manifest_is_valid_json(path: Path) -> None:
    assert path.is_file(), f"missing manifest: {path}"
    json.loads(path.read_text(encoding="utf-8"))


# ----- Family 2: Agent identity preservation ----------------------------


_AGENT_PAIRS = all_pairs(kind="agent")


@pytest.mark.parametrize("pair", _AGENT_PAIRS, ids=pair_id)
def test_agent_name_and_description_preserved(pair: ArtifactPair) -> None:
    claude = parse_yaml_frontmatter_optional(pair.claude_path)
    if claude is None:
        pytest.skip(
            "Claude source has no YAML frontmatter (doc-shaped file in agents/); "
            "identity assertions don't apply."
        )
    codex = parse_codex_agent(pair.codex_path)
    assert codex.get("name") == claude.get("name"), (
        f"{pair_id(pair)}: name drift "
        f"(claude={claude.get('name')!r} codex={codex.get('name')!r})"
    )
    assert _normalize_ws(codex.get("description", "")) == _normalize_ws(
        claude.get("description", "")
    ), f"{pair_id(pair)}: description drift"


# ----- Family 3: Agent transformation rules -----------------------------

_WRITE_TOOLS: frozenset[str] = frozenset({"Bash", "Write", "Edit"})


@pytest.mark.parametrize("pair", _AGENT_PAIRS, ids=pair_id)
def test_agent_sandbox_mode_matches_tools(pair: ArtifactPair) -> None:
    """acplugin emits `sandbox_mode` only when Claude declares `tools`.

    Rule (observed in acplugin/src/converter/agent.ts):
      - Claude has no `tools` field         -> Codex has no `sandbox_mode`
      - tools intersects {Bash, Write, Edit} -> sandbox_mode = "workspace-write"
      - otherwise                            -> sandbox_mode = "read-only"
    """
    claude = parse_yaml_frontmatter_optional(pair.claude_path)
    if claude is None:
        pytest.skip("Claude source has no frontmatter; sandbox rule does not apply.")
    codex = parse_codex_agent(pair.codex_path)
    actual = codex.get("sandbox_mode")
    if "tools" not in claude or claude["tools"] is None:
        assert actual is None, (
            f"{pair_id(pair)}: claude has no tools, but Codex emitted "
            f"sandbox_mode={actual!r}"
        )
        return
    tools = set(parse_claude_tools(claude["tools"]))
    expected = "workspace-write" if tools & _WRITE_TOOLS else "read-only"
    assert actual == expected, (
        f"{pair_id(pair)}: sandbox_mode={actual!r} but tools={sorted(tools)} "
        f"imply {expected!r}"
    )


@pytest.mark.parametrize("pair", _AGENT_PAIRS, ids=pair_id)
def test_agent_has_model_field(pair: ArtifactPair) -> None:
    """acplugin's mapModel() always emits a `model` field (default `gpt-5.4`).

    We intentionally do NOT pin the model to a specific value here — acplugin
    may update its default. The contract we enforce is: every Codex agent
    must have a non-empty model field so the Codex runtime can dispatch it.
    """
    codex = parse_codex_agent(pair.codex_path)
    model = codex.get("model")
    assert isinstance(model, str) and model.strip(), (
        f"{pair_id(pair)}: missing or empty model field"
    )


@pytest.mark.parametrize("pair", _AGENT_PAIRS, ids=pair_id)
def test_agent_reasoning_effort_iff_claude_effort(pair: ArtifactPair) -> None:
    claude = parse_yaml_frontmatter_optional(pair.claude_path)
    if claude is None:
        pytest.skip("Claude source has no frontmatter; effort rule does not apply.")
    codex = parse_codex_agent(pair.codex_path)
    has_effort = "effort" in claude and claude["effort"] is not None
    has_codex_effort = bool(codex.get("model_reasoning_effort"))
    assert has_effort == has_codex_effort, (
        f"{pair_id(pair)}: claude effort={claude.get('effort')!r} but "
        f"codex model_reasoning_effort={codex.get('model_reasoning_effort')!r}"
    )


# ----- Family 4: Body fidelity (fuzzy) ----------------------------------


_BODY_RATIO_MIN = 0.8
_BODY_RATIO_MAX = 1.2


def _first_heading(body: str) -> str | None:
    for line in body.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped
    return None


@pytest.mark.parametrize("pair", _AGENT_PAIRS, ids=pair_id)
def test_agent_body_carried_to_developer_instructions(pair: ArtifactPair) -> None:
    claude = parse_yaml_frontmatter_optional(pair.claude_path)
    if claude is None:
        # No frontmatter -> the whole file is body; acplugin still carries it
        # over but the ratio check below is the right tool, not a skip.
        src = pair.claude_path.read_text(encoding="utf-8").strip()
    else:
        src = (claude.get("_body") or "").strip()
    codex = parse_codex_agent(pair.codex_path)
    dst = (codex.get("developer_instructions") or "").strip()
    assert src, f"{pair_id(pair)}: claude body is empty"
    assert dst, f"{pair_id(pair)}: developer_instructions is empty"

    src_words = len(src.split())
    dst_words = len(dst.split())
    ratio = dst_words / src_words if src_words else 0
    assert _BODY_RATIO_MIN <= ratio <= _BODY_RATIO_MAX, (
        f"{pair_id(pair)}: body word-count ratio {ratio:.2f} outside "
        f"[{_BODY_RATIO_MIN}, {_BODY_RATIO_MAX}] (src={src_words}, dst={dst_words})"
    )

    heading = _first_heading(src)
    if heading:
        assert heading in dst, (
            f"{pair_id(pair)}: first heading {heading!r} missing from "
            f"developer_instructions (likely truncation)"
        )


# ----- Family 5: Skill SKILL.md fidelity --------------------------------


_SKILL_PAIRS = all_pairs(kind="skill")
_COMMAND_PAIRS = all_pairs(kind="command")


@pytest.mark.parametrize("pair", _SKILL_PAIRS, ids=pair_id)
def test_skill_name_and_description_preserved(pair: ArtifactPair) -> None:
    src = parse_yaml_frontmatter(pair.claude_path)
    dst = parse_yaml_frontmatter(pair.codex_path)
    assert dst.get("name") == src.get("name"), (
        f"{pair_id(pair)}: name drift "
        f"(claude={src.get('name')!r} codex={dst.get('name')!r})"
    )
    assert _normalize_ws(str(dst.get("description", ""))) == _normalize_ws(
        str(src.get("description", ""))
    ), f"{pair_id(pair)}: description drift"


@pytest.mark.parametrize("pair", _COMMAND_PAIRS, ids=pair_id)
def test_command_body_and_naming_preserved(pair: ArtifactPair) -> None:
    """Commands convert to `cmd-<name>` skills.

    acplugin rewrites the description to a stub like
    `'Command: <name> (imported from Claude Code)'` — the original Claude
    description is *not* preserved in the Codex `description` field. The
    contract we can enforce is:

    1. The destination directory uses the mandatory `cmd-` prefix.
    2. The destination has a non-empty description (even if stubbed).
    3. The body content carries over so the converted skill is usable.
    """
    src = parse_yaml_frontmatter_optional(pair.claude_path) or {
        "_body": pair.claude_path.read_text(encoding="utf-8")
    }
    dst = parse_yaml_frontmatter(pair.codex_path)
    assert pair.codex_path.parent.name == f"{CMD_PREFIX}{pair.name}"

    dst_desc = str(dst.get("description", "")).strip()
    assert dst_desc, f"{pair_id(pair)}: codex skill description is empty"

    src_body = str(src.get("_body", "")).strip()
    dst_body = str(dst.get("_body", "")).strip()
    if src_body:
        assert dst_body, (
            f"{pair_id(pair)}: claude command had body content but codex "
            f"skill body is empty (likely truncation)"
        )


# ----- Family 6: Cross-reference resolution -----------------------------


_SKILLS_REF_SEP = re.compile(r"[,\s]+")


def _parse_skills_field(value: Any) -> list[str]:
    """Claude `skills:` frontmatter is a comma-separated string OR a YAML list
    of `plugin:skill` identifiers."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(s).strip() for s in value if str(s).strip()]
    if isinstance(value, str):
        return [s.strip() for s in _SKILLS_REF_SEP.split(value) if s.strip()]
    raise TypeError(f"unexpected skills value: {value!r}")


def _claude_skill_references() -> list[tuple[ArtifactPair, str]]:
    """Every Claude `skills:` frontmatter entry whose plugin segment is one
    of our six plugins. External plugin namespaces (e.g. `engineering:*`) are
    out of scope — they're external dependencies, not internal contracts."""
    out: list[tuple[ArtifactPair, str]] = []
    for pair in all_pairs():
        try:
            fm = parse_yaml_frontmatter(pair.claude_path)
        except (ValueError, OSError):
            continue
        for ref in _parse_skills_field(fm.get("skills")):
            if ":" not in ref:
                continue
            plugin_segment = ref.split(":", 1)[0]
            if plugin_segment in PLUGIN_NAMES:
                out.append((pair, ref))
    return out


_REF_CASES = _claude_skill_references()


@pytest.mark.parametrize(
    "pair,ref",
    _REF_CASES,
    ids=[f"{pair_id(p)}->{r}" for p, r in _REF_CASES] or ["<none>"],
)
def test_claude_skills_reference_resolves_in_codex(
    pair: ArtifactPair, ref: str
) -> None:
    universe = codex_skill_universe_normalized()
    assert ref in universe, (
        f"{pair_id(pair)} declares skill ref {ref!r} but no matching Codex "
        f"skill exists. Either the conversion dropped it or the reference is stale."
    )
