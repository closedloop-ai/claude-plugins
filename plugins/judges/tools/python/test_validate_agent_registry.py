"""Tests for validate_agent_registry.py."""

import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from validate_agent_registry import (  # type: ignore[import-not-found]
    VALID_MODELS,
    _parse_comma_list,
    _parse_frontmatter,
    main,
    validate_agent_file,
    validate_agent_registry,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write_agent(path: Path, content: str) -> Path:
    """Write an agent markdown file and return its path."""
    path.write_text(content, encoding="utf-8")
    return path


def _valid_agent_content(
    *,
    name: str = "test-agent",
    description: str = "A test agent",
    model: str = "sonnet",
    tools: str = "Read, Write",
    skills: str = "judges:quality",
) -> str:
    """Build a valid agent markdown string."""
    return (
        "---\n"
        f"name: {name}\n"
        f"description: {description}\n"
        f"model: {model}\n"
        f"tools: {tools}\n"
        f"skills: {skills}\n"
        "---\n\n"
        "# Agent body\n"
    )


# ---------------------------------------------------------------------------
# Tests for _parse_frontmatter
# ---------------------------------------------------------------------------

class TestParseFrontmatter:
    """Tests for the _parse_frontmatter helper."""

    def test_valid_frontmatter_returns_dict(self) -> None:
        """Valid YAML frontmatter is parsed into a dict."""
        content = "---\nname: my-agent\nmodel: sonnet\n---\n# Body\n"
        fm, err = _parse_frontmatter(content)
        assert err == ""
        assert fm is not None
        assert fm["name"] == "my-agent"
        assert fm["model"] == "sonnet"

    def test_all_standard_fields_extracted(self) -> None:
        """name, description, model, tools, and skills are all extracted."""
        content = (
            "---\n"
            "name: agent-x\n"
            "description: Does things\n"
            "model: haiku\n"
            "tools: Read, Bash\n"
            "skills: code:something\n"
            "---\n"
        )
        fm, err = _parse_frontmatter(content)
        assert err == ""
        assert fm is not None
        assert fm["name"] == "agent-x"
        assert fm["description"] == "Does things"
        assert fm["model"] == "haiku"
        assert fm["tools"] == "Read, Bash"
        assert fm["skills"] == "code:something"

    def test_missing_opening_delimiter_returns_error(self) -> None:
        """Content without leading '---' returns None and an error message."""
        content = "name: agent\nmodel: sonnet\n"
        fm, err = _parse_frontmatter(content)
        assert fm is None
        assert "No YAML frontmatter found" in err

    def test_empty_string_returns_error(self) -> None:
        """Empty content returns None and an error message."""
        fm, err = _parse_frontmatter("")
        assert fm is None
        assert err != ""

    def test_unclosed_frontmatter_returns_error(self) -> None:
        """Opening '---' with no closing '---' returns None and an error message."""
        content = "---\nname: agent\nmodel: sonnet\n"
        fm, err = _parse_frontmatter(content)
        assert fm is None
        assert "no closing" in err.lower() or "closing '---'" in err

    def test_blank_lines_and_comments_ignored(self) -> None:
        """Blank lines and comment lines inside frontmatter are skipped gracefully."""
        content = (
            "---\n"
            "# This is a comment\n"
            "\n"
            "name: agent-y\n"
            "model: opus\n"
            "---\n"
        )
        fm, err = _parse_frontmatter(content)
        assert err == ""
        assert fm is not None
        assert fm["name"] == "agent-y"
        assert fm["model"] == "opus"

    def test_extra_fields_are_captured(self) -> None:
        """Unknown extra fields in frontmatter are still captured in the dict."""
        content = (
            "---\n"
            "name: agent-z\n"
            "model: sonnet\n"
            "description: test\n"
            "color: blue\n"
            "---\n"
        )
        fm, err = _parse_frontmatter(content)
        assert err == ""
        assert fm is not None
        assert fm.get("color") == "blue"


# ---------------------------------------------------------------------------
# Tests for _parse_tools_field and _parse_skills_field
# ---------------------------------------------------------------------------

class TestParseCommaList:
    """Tests for _parse_comma_list (used for both tools and skills fields)."""

    def test_parses_comma_separated_values(self) -> None:
        assert _parse_comma_list("Read, Write, Edit") == ["Read", "Write", "Edit"]

    def test_strips_whitespace(self) -> None:
        assert _parse_comma_list("  Bash ,  Glob  ") == ["Bash", "Glob"]

    def test_empty_string_returns_empty_list(self) -> None:
        assert _parse_comma_list("") == []

    def test_single_value(self) -> None:
        assert _parse_comma_list("Agent") == ["Agent"]

    def test_trailing_comma_ignored(self) -> None:
        assert _parse_comma_list("Read, Write,") == ["Read", "Write"]

    def test_parses_skill_identifiers(self) -> None:
        assert _parse_comma_list("judges:quality, code:review") == ["judges:quality", "code:review"]

    def test_single_skill_identifier(self) -> None:
        assert _parse_comma_list("self-learning:toon-format") == ["self-learning:toon-format"]


# ---------------------------------------------------------------------------
# Tests for validate_agent_file
# ---------------------------------------------------------------------------

class TestValidateAgentFileMissingRequiredFields:
    """Tests for missing required frontmatter fields."""

    @pytest.mark.parametrize("missing_field", ["name", "description", "model"])
    def test_each_required_field_independently(
        self, tmp_path: Path, missing_field: str
    ) -> None:
        """Each required field omitted independently triggers its own error."""
        all_fields = {
            "name": "my-agent",
            "description": "Some agent",
            "model": "sonnet",
        }
        lines = ["---"]
        for key, val in all_fields.items():
            if key != missing_field:
                lines.append(f"{key}: {val}")
        lines += ["tools: Read", "---"]
        content = "\n".join(lines) + "\n"

        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert not result.is_valid
        assert any(missing_field in e for e in result.errors)


class TestValidateAgentFileInvalidModel:
    """Tests for invalid model values."""

    def test_error_message_lists_valid_models(self, tmp_path: Path) -> None:
        """Error message for invalid model enumerates the valid choices."""
        content = (
            "---\n"
            "name: bad-model-agent\n"
            "description: Has bad model\n"
            "model: turbo\n"
            "tools: Read\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        model_errors = [e for e in result.errors if "turbo" in e]
        assert model_errors, "Expected an error mentioning 'turbo'"
        # The error should reference at least one valid model
        combined = " ".join(model_errors)
        assert any(m in combined for m in VALID_MODELS)


class TestValidateAgentFileHallucinatedTools:
    """Tests for hallucinated / invalid tool names."""

    def test_unknown_tool_produces_error(self, tmp_path: Path) -> None:
        """A tool not in VALID_TOOLS and without 'mcp__' prefix is flagged."""
        content = (
            "---\n"
            "name: bad-tools-agent\n"
            "description: Uses unknown tool\n"
            "model: sonnet\n"
            "tools: Read, FakeTool\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert not result.is_valid
        assert any("FakeTool" in e for e in result.errors)

    def test_mcp_prefixed_tool_is_allowed(self, tmp_path: Path) -> None:
        """Tools prefixed with 'mcp__' are accepted without error."""
        content = (
            "---\n"
            "name: mcp-agent\n"
            "description: Uses MCP tool\n"
            "model: sonnet\n"
            "tools: Read, mcp__playwright__browser_navigate\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        tool_errors = [e for e in result.errors if "mcp__" in e]
        assert tool_errors == [], f"MCP tools should not produce errors: {tool_errors}"

    @pytest.mark.parametrize(
        "tool_name",
        ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent", "Skill",
         "WebFetch", "WebSearch", "SendMessage", "Task"],
    )
    def test_each_valid_tool_is_accepted(
        self, tmp_path: Path, tool_name: str
    ) -> None:
        """Each individual valid tool name does not trigger an error."""
        content = (
            "---\n"
            f"name: agent-with-{tool_name.lower()}\n"
            "description: Uses one valid tool\n"
            "model: haiku\n"
            f"tools: {tool_name}\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        tool_errors = [e for e in result.errors if tool_name in e]
        assert tool_errors == [], f"Unexpected errors for valid tool {tool_name}: {tool_errors}"

    def test_multiple_unknown_tools_each_reported(self, tmp_path: Path) -> None:
        """Each unknown tool in the list generates its own error entry."""
        content = (
            "---\n"
            "name: multi-bad-agent\n"
            "description: Uses many bad tools\n"
            "model: opus\n"
            "tools: Read, Ghost, Phantom\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert any("Ghost" in e for e in result.errors)
        assert any("Phantom" in e for e in result.errors)

    def test_no_tools_field_produces_warning_not_error(self, tmp_path: Path) -> None:
        """Absence of the 'tools' field produces a warning, not an error."""
        content = (
            "---\n"
            "name: no-tools-agent\n"
            "description: No tools declared\n"
            "model: sonnet\n"
            "---\n"
        )
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        # Should be valid (no errors), but have at least one warning
        assert result.is_valid
        assert result.warnings, "Expected at least one warning for missing tools field"


class TestValidateAgentFileValidAgents:
    """Tests for fully valid agent files."""

    def test_valid_agent_passes_with_no_errors(self, tmp_path: Path) -> None:
        """A complete, well-formed agent file produces no errors."""
        content = _valid_agent_content()
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.is_valid
        assert result.errors == []

    def test_valid_agent_name_is_captured(self, tmp_path: Path) -> None:
        """agent_name field is populated from the frontmatter name."""
        content = _valid_agent_content(name="my-specific-agent")
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.agent_name == "my-specific-agent"

    def test_valid_agent_model_is_captured(self, tmp_path: Path) -> None:
        """model field is populated correctly from the frontmatter."""
        content = _valid_agent_content(model="opus")
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.model == "opus"

    def test_valid_agent_tools_are_captured(self, tmp_path: Path) -> None:
        """tools list is populated from the frontmatter."""
        content = _valid_agent_content(tools="Read, Bash, Glob")
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.tools == ["Read", "Bash", "Glob"]

    def test_valid_agent_skills_are_captured(self, tmp_path: Path) -> None:
        """skills list is populated from the frontmatter."""
        content = _valid_agent_content(skills="judges:quality, code:review")
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.skills == ["judges:quality", "code:review"]

    def test_skill_without_colon_produces_warning(self, tmp_path: Path) -> None:
        """A skill not in 'plugin-name:skill-name' format generates a warning."""
        content = _valid_agent_content(skills="bare-skill")
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert result.is_valid  # warnings don't make the result invalid
        assert any("bare-skill" in w for w in result.warnings)

    def test_nonexistent_file_produces_error(self, tmp_path: Path) -> None:
        """Validating a path that does not exist produces an error."""
        result = validate_agent_file(tmp_path / "ghost.md")
        assert not result.is_valid
        assert any("does not exist" in e for e in result.errors)

    def test_file_path_stored_in_result(self, tmp_path: Path) -> None:
        """The file_path attribute of the result reflects the input path."""
        content = _valid_agent_content()
        agent_file = _write_agent(tmp_path / "agent.md", content)
        result = validate_agent_file(agent_file)
        assert str(agent_file) in result.file_path


# ---------------------------------------------------------------------------
# Tests for validate_agent_registry
# ---------------------------------------------------------------------------

class TestValidateAgentRegistry:
    """Tests for the directory-level validate_agent_registry function."""

    def test_all_valid_agents_pass_registry_validation(self, tmp_path: Path) -> None:
        """A directory with only valid agents results in is_valid == True."""
        for i in range(3):
            _write_agent(
                tmp_path / f"agent-{i}.md",
                _valid_agent_content(name=f"agent-{i}"),
            )
        result = validate_agent_registry(tmp_path)
        assert result.is_valid
        assert result.total_agents == 3
        assert result.valid_agents == 3
        assert result.invalid_agents == 0

    def test_one_invalid_agent_makes_registry_invalid(self, tmp_path: Path) -> None:
        """A single invalid agent causes the registry result to be invalid."""
        _write_agent(tmp_path / "good.md", _valid_agent_content(name="good-agent"))
        _write_agent(
            tmp_path / "bad.md",
            "---\nname: bad-agent\nmodel: wrong-model\ndescription: Bad\ntools: Read\n---\n",
        )
        result = validate_agent_registry(tmp_path)
        assert not result.is_valid
        assert result.invalid_agents == 1
        assert result.valid_agents == 1

    def test_nonexistent_directory_produces_error(self, tmp_path: Path) -> None:
        """Pointing at a non-existent directory returns errors."""
        result = validate_agent_registry(tmp_path / "does-not-exist")
        assert not result.is_valid
        assert result.all_errors

    def test_empty_directory_returns_warning(self, tmp_path: Path) -> None:
        """Empty directory (no .md files) issues a warning but not an error."""
        result = validate_agent_registry(tmp_path)
        assert result.is_valid  # no errors for empty directory
        assert result.total_agents == 0
        assert result.all_warnings

    def test_errors_are_prefixed_with_filename(self, tmp_path: Path) -> None:
        """Aggregated errors include the originating filename as a prefix."""
        _write_agent(
            tmp_path / "broken.md",
            "---\ndescription: No name or model\ntools: Read\n---\n",
        )
        result = validate_agent_registry(tmp_path)
        assert any("broken.md" in e for e in result.all_errors)

    def test_counts_match_agent_list_length(self, tmp_path: Path) -> None:
        """total_agents equals the number of AgentValidationResult entries."""
        for i in range(4):
            _write_agent(
                tmp_path / f"a{i}.md",
                _valid_agent_content(name=f"a{i}"),
            )
        result = validate_agent_registry(tmp_path)
        assert result.total_agents == len(result.agents)

    def test_unknown_artifact_type_returns_structured_error(
        self, tmp_path: Path
    ) -> None:
        """An invalid artifact_type returns a structured error instead of raising."""
        _write_agent(tmp_path / "agent.md", _valid_agent_content())
        result = validate_agent_registry(tmp_path, artifact_type="not-a-real-type")
        assert not result.is_valid
        assert any("Unknown artifact_type" in e for e in result.all_errors)


# ---------------------------------------------------------------------------
# Tests for JUDGE_REGISTRY drift between the two copies
# ---------------------------------------------------------------------------

class TestJudgeRegistrySync:
    """Guard against drift between the two JUDGE_REGISTRY copies."""

    def test_judge_registry_matches_validate_judge_report(self) -> None:
        """The two JUDGE_REGISTRY definitions must stay byte-for-byte equal.

        If a judge is added to one registry but not the other, the pre-flight
        check passes while post-run validation fails -- exactly what the
        pre-flight check is meant to prevent.
        """
        skill_scripts = (
            Path(__file__).resolve().parents[2]
            / "skills"
            / "run-judges"
            / "scripts"
        )
        sys.path.insert(0, str(skill_scripts))
        try:
            from validate_judge_report import (  # type: ignore[import-not-found]
                JUDGE_REGISTRY as VJR_REGISTRY,
            )
        finally:
            sys.path.remove(str(skill_scripts))

        from validate_agent_registry import (  # type: ignore[import-not-found]
            JUDGE_REGISTRY as VAR_REGISTRY,
        )

        assert VAR_REGISTRY == VJR_REGISTRY, (
            "JUDGE_REGISTRY drift detected between "
            "plugins/judges/tools/python/validate_agent_registry.py and "
            "plugins/judges/skills/run-judges/scripts/validate_judge_report.py"
        )


# ---------------------------------------------------------------------------
# Tests for the CLI main() entrypoint
# ---------------------------------------------------------------------------

class TestMainEntrypoint:
    """Tests for the CLI main() function."""

    def test_main_returns_zero_for_valid_registry(self, tmp_path: Path) -> None:
        """main() exits with code 0 when all agents are valid."""
        _write_agent(tmp_path / "agent.md", _valid_agent_content())
        with patch("sys.argv", ["validate_agent_registry", str(tmp_path)]):
            exit_code = main()
        assert exit_code == 0

    def test_main_returns_one_for_invalid_registry(self, tmp_path: Path) -> None:
        """main() exits with code 1 when at least one agent is invalid."""
        _write_agent(
            tmp_path / "bad.md",
            "---\nname: bad\ndescription: Bad model\nmodel: wrong\ntools: Read\n---\n",
        )
        with patch("sys.argv", ["validate_agent_registry", str(tmp_path)]):
            exit_code = main()
        assert exit_code == 1

    def test_main_returns_one_for_nonexistent_dir(self, tmp_path: Path) -> None:
        """main() exits with code 1 when the agents directory does not exist."""
        missing = str(tmp_path / "no-such-dir")
        with patch("sys.argv", ["validate_agent_registry", missing]):
            exit_code = main()
        assert exit_code == 1

    def test_main_prints_report_on_success(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """main() prints a summary report to stdout when validation passes."""
        _write_agent(tmp_path / "agent.md", _valid_agent_content())
        with patch("sys.argv", ["validate_agent_registry", str(tmp_path)]):
            main()
        captured = capsys.readouterr()
        assert "Agent Registry Validation" in captured.out

    def test_main_prints_errors_to_stderr_on_failure(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """main() sends error details to stderr when validation fails."""
        _write_agent(
            tmp_path / "bad.md",
            "---\nname: bad\ndescription: Bad model\nmodel: evil-model\ntools: Read\n---\n",
        )
        with patch("sys.argv", ["validate_agent_registry", str(tmp_path)]):
            main()
        captured = capsys.readouterr()
        assert "Errors" in captured.err or "evil-model" in captured.err
