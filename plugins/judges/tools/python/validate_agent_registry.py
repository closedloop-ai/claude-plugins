#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pydantic>=2.0.0",
# ]
# ///
"""
ClosedLoop Agent Registry Validation

Validates agent markdown files in the judges plugin by parsing YAML frontmatter,
checking required fields, validating model values, and cross-referencing tool
declarations against the known set of valid system tools.

Intended as a pre-flight check before judge execution.
"""

import argparse
import sys
from pathlib import Path
from typing import List, Optional

try:
    from pydantic import BaseModel, ConfigDict, Field
except ImportError:
    print("Error: pydantic is not installed. Install it with: uv pip install pydantic", file=sys.stderr)
    sys.exit(1)


# Known valid models per CLAUDE.md convention:
# opus for creative/planning, sonnet for implementation, haiku for lightweight coordination
VALID_MODELS = {"opus", "sonnet", "haiku"}

# Known valid system tools available to Claude agents
VALID_TOOLS = {
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",
    "Grep",
    "Agent",
    "Skill",
    "WebFetch",
    "WebSearch",
    "SendMessage",
    "Task",
}

# Required judge agent names per artifact type. Must stay in sync with
# JUDGE_REGISTRY in plugins/judges/skills/run-judges/scripts/validate_judge_report.py.
JUDGE_REGISTRY: dict[str, set[str]] = {
    "plan": {
        "brownfield-accuracy-judge",
        "codebase-grounding-judge",
        "code-organization-judge",
        "convention-adherence-judge",
        "custom-best-practices-judge",
        "dry-judge",
        "goal-alignment-judge",
        "kiss-judge",
        "readability-judge",
        "solid-isp-dip-judge",
        "solid-liskov-substitution-judge",
        "solid-open-closed-judge",
        "ssot-judge",
        "technical-accuracy-judge",
        "test-judge",
        "verbosity-judge",
    },
    "code": {
        "code-organization-judge",
        "custom-best-practices-judge",
        "dry-judge",
        "kiss-judge",
        "readability-judge",
        "solid-isp-dip-judge",
        "solid-liskov-substitution-judge",
        "solid-open-closed-judge",
        "ssot-judge",
        "technical-accuracy-judge",
        "test-judge",
    },
    "prd": {
        "feature-completeness-judge",
        "prd-auditor",
        "prd-dependency-judge",
        "prd-testability-judge",
        "prd-scope-judge",
    },
    "feature": {
        "feature-completeness-judge",
        "prd-testability-judge",
        "prd-dependency-judge",
    },
}

VALID_ARTIFACT_TYPES = sorted(JUDGE_REGISTRY.keys())


class AgentValidationResult(BaseModel):
    """Validation result for a single agent file."""

    model_config = ConfigDict(strict=True)

    file_path: str
    agent_name: Optional[str] = None
    model: Optional[str] = None
    tools: List[str] = Field(default_factory=list)
    skills: List[str] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return len(self.errors) == 0


class RegistryValidationResult(BaseModel):
    """Aggregated validation result for the full agent registry."""

    model_config = ConfigDict(strict=True)

    agents_dir: str
    agents: List[AgentValidationResult] = Field(default_factory=list)
    total_agents: int = 0
    valid_agents: int = 0
    invalid_agents: int = 0
    all_errors: List[str] = Field(default_factory=list)
    all_warnings: List[str] = Field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        return self.invalid_agents == 0 and len(self.all_errors) == 0


def _parse_frontmatter(content: str) -> tuple[Optional[dict], str]:
    """Extract YAML frontmatter from markdown content.

    Args:
        content: Raw markdown file content.

    Returns:
        Tuple of (frontmatter_dict or None, parse_error_message or empty string).
    """
    lines = content.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, "No YAML frontmatter found (file must start with '---')"

    end_index = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_index = i
            break

    if end_index is None:
        return None, "Frontmatter opening '---' has no closing '---'"

    frontmatter_lines = lines[1:end_index]
    frontmatter: dict = {}

    for line in frontmatter_lines:
        if not line.strip() or line.strip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value:
            frontmatter[key] = value

    return frontmatter, ""


def _parse_comma_list(raw_value: str) -> List[str]:
    """Parse a comma-separated string into a list of stripped, non-empty tokens.

    Used for both 'tools' and 'skills' frontmatter fields.

    Args:
        raw_value: Raw comma-separated string from frontmatter.

    Returns:
        List of individual token strings (stripped of whitespace).
    """
    if not raw_value:
        return []
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def validate_agent_file(file_path: Path) -> AgentValidationResult:
    """Validate a single agent markdown file.

    Parses YAML frontmatter, checks required fields (name, description, model),
    validates the model value, and cross-references declared tools against the
    known-valid tool set to catch hallucinated tool names.

    Args:
        file_path: Path to the agent markdown file.

    Returns:
        AgentValidationResult with any errors and warnings populated.
    """
    result = AgentValidationResult(file_path=str(file_path))
    errors: List[str] = []
    warnings: List[str] = []

    if not file_path.exists():
        errors.append(f"File does not exist: {file_path}")
        result.errors = errors
        return result

    try:
        content = file_path.read_text(encoding="utf-8")
    except OSError as e:
        errors.append(f"Cannot read file: {e}")
        result.errors = errors
        return result

    frontmatter, parse_error = _parse_frontmatter(content)
    if frontmatter is None:
        errors.append(f"Frontmatter parse error: {parse_error}")
        result.errors = errors
        return result

    # Validate required fields
    for required_field in ("name", "description", "model"):
        if required_field not in frontmatter or not frontmatter[required_field]:
            errors.append(f"Missing required frontmatter field: '{required_field}'")

    # Populate result fields where available
    if "name" in frontmatter:
        result.agent_name = frontmatter["name"]

    if "model" in frontmatter:
        model_value = frontmatter["model"]
        result.model = model_value
        if model_value not in VALID_MODELS:
            errors.append(
                f"Invalid model '{model_value}'. Must be one of: {', '.join(sorted(VALID_MODELS))}"
            )

    # Parse and validate tools
    if "tools" in frontmatter:
        tools = _parse_comma_list(frontmatter["tools"])
        result.tools = tools

        # Cross-reference against known valid tools
        for tool in tools:
            # Allow MCP tool names (e.g., mcp__playwright__browser_navigate)
            if tool.startswith("mcp__"):
                continue
            if tool not in VALID_TOOLS:
                errors.append(
                    f"Unknown tool '{tool}' declared. Valid tools are: "
                    f"{', '.join(sorted(VALID_TOOLS))}. "
                    "If this is an MCP tool, prefix it with 'mcp__'."
                )
    else:
        warnings.append("No 'tools' field declared in frontmatter.")

    # Parse skills (informational — no validation required beyond format)
    if "skills" in frontmatter:
        skills = _parse_comma_list(frontmatter["skills"])
        result.skills = skills

        # Warn if skill identifiers don't follow 'plugin-name:skill-name' format
        for skill in skills:
            if ":" not in skill:
                warnings.append(
                    f"Skill '{skill}' does not follow the 'plugin-name:skill-name' "
                    "format required by CLAUDE.md."
                )

    result.errors = errors
    result.warnings = warnings
    return result


def validate_agent_registry(
    agents_dir: Path, artifact_type: Optional[str] = None
) -> RegistryValidationResult:
    """Validate all agent markdown files in a directory.

    Discovers all .md files, validates each one, and aggregates results. When
    `artifact_type` is provided, also checks that every judge agent required
    for that artifact type (per JUDGE_REGISTRY) is present and valid.

    Args:
        agents_dir: Path to the directory containing agent markdown files.
        artifact_type: Optional artifact type ("plan", "code", "prd", "feature").
            When set, validation fails if any required judge is missing/invalid.

    Returns:
        RegistryValidationResult with per-agent results and aggregate counts.
    """
    registry_result = RegistryValidationResult(agents_dir=str(agents_dir))
    all_errors: List[str] = []
    all_warnings: List[str] = []

    if not agents_dir.exists():
        all_errors.append(f"Agents directory does not exist: {agents_dir}")
        registry_result.all_errors = all_errors
        return registry_result

    if not agents_dir.is_dir():
        all_errors.append(f"Agents path is not a directory: {agents_dir}")
        registry_result.all_errors = all_errors
        return registry_result

    md_files = sorted(agents_dir.glob("*.md"))
    if not md_files:
        all_warnings.append(f"No markdown files found in agents directory: {agents_dir}")

    agent_results: List[AgentValidationResult] = []
    for md_file in md_files:
        agent_result = validate_agent_file(md_file)
        agent_results.append(agent_result)

        if not agent_result.is_valid:
            all_errors.extend(f"[{md_file.name}] {e}" for e in agent_result.errors)

        all_warnings.extend(f"[{md_file.name}] {w}" for w in agent_result.warnings)

    if artifact_type is not None:
        if artifact_type not in JUDGE_REGISTRY:
            all_errors.append(
                f"Unknown artifact_type '{artifact_type}'. "
                f"Valid values: {sorted(JUDGE_REGISTRY)}"
            )
            registry_result.agents = agent_results
            registry_result.total_agents = len(md_files)
            registry_result.invalid_agents = sum(1 for a in agent_results if not a.is_valid)
            registry_result.valid_agents = len(md_files) - registry_result.invalid_agents
            registry_result.all_errors = all_errors
            registry_result.all_warnings = all_warnings
            return registry_result
        required_names = JUDGE_REGISTRY[artifact_type]
        present_names = {a.agent_name for a in agent_results if a.is_valid and a.agent_name}
        for missing in sorted(required_names - present_names):
            all_errors.append(
                f"Required judge for artifact-type '{artifact_type}' is "
                f"missing or invalid: '{missing}'"
            )

    invalid_count = sum(1 for a in agent_results if not a.is_valid)
    registry_result.agents = agent_results
    registry_result.total_agents = len(md_files)
    registry_result.valid_agents = len(md_files) - invalid_count
    registry_result.invalid_agents = invalid_count
    registry_result.all_errors = all_errors
    registry_result.all_warnings = all_warnings

    return registry_result


def _print_registry_report(
    result: RegistryValidationResult,
    artifact_type: Optional[str] = None,
    workdir: Optional[str] = None,
) -> None:
    """Print a human-readable validation report to stdout/stderr.

    Args:
        result: The aggregated registry validation result to report on.
        artifact_type: Artifact type the pre-flight check was scoped to, if any.
        workdir: Workdir context the validation ran in, if provided.
    """
    print(f"\nAgent Registry Validation: {result.agents_dir}")
    print(f"  Artifact type:       {artifact_type or 'none'}")
    print(f"  Workdir:             {workdir or 'none'}")
    print(f"  Total agents found:  {result.total_agents}")
    print(f"  Valid:               {result.valid_agents}")
    print(f"  Invalid:             {result.invalid_agents}")

    if result.all_warnings:
        print("\nWarnings:")
        for warning in result.all_warnings:
            print(f"  ! {warning}")

    if result.all_errors:
        print("\nErrors:", file=sys.stderr)
        print(f"  Artifact type: {artifact_type or 'none'}", file=sys.stderr)
        print(f"  Workdir:       {workdir or 'none'}", file=sys.stderr)
        print(f"  Agents dir:    {result.agents_dir}", file=sys.stderr)
        for error in result.all_errors:
            print(f"  ✗ {error}", file=sys.stderr)
    else:
        print(f"\n✓ All {result.total_agents} agents passed validation.")


def main() -> int:
    """Main entry point for the agent registry validation script.

    Reads the agents directory path from command-line arguments, runs validation,
    prints a human-readable report, and exits with code 0 (all valid) or 1 (any errors).

    Returns:
        0 if all agents are valid, 1 if any validation errors exist.
    """
    parser = argparse.ArgumentParser(
        description="Validate agent markdown files in the judges plugin registry."
    )
    parser.add_argument(
        "agents_dir",
        nargs="?",
        default=None,
        help=(
            "Path to the agents directory (defaults to plugins/judges/agents/ "
            "relative to the repository root, auto-detected from this script's location)."
        ),
    )
    parser.add_argument(
        "--artifact-type",
        choices=VALID_ARTIFACT_TYPES,
        default=None,
        help=(
            "Artifact type being judged. When set, validation also fails if any "
            "judge required for this artifact type (per JUDGE_REGISTRY) is missing "
            "or invalid."
        ),
    )
    parser.add_argument(
        "--workdir",
        default=None,
        help=(
            "ClosedLoop workdir for log context. Printed in the failure header so "
            "operators can correlate failures with a run; not used for validation."
        ),
    )

    args = parser.parse_args()

    if args.agents_dir:
        agents_dir = Path(args.agents_dir).resolve()
    else:
        # Auto-detect: this script lives at plugins/judges/tools/python/
        # so agents/ is at plugins/judges/agents/
        script_dir = Path(__file__).resolve().parent
        agents_dir = script_dir.parent.parent / "agents"

    try:
        result = validate_agent_registry(agents_dir, artifact_type=args.artifact_type)
    except Exception as e:
        print(f"Error: unexpected failure during validation: {e}", file=sys.stderr)
        return 1

    _print_registry_report(result, artifact_type=args.artifact_type, workdir=args.workdir)

    return 0 if result.is_valid else 1


if __name__ == "__main__":
    sys.exit(main())
