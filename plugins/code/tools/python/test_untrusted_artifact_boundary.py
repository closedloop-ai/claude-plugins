"""Regression tests for untrusted-artifact prompt boundaries."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]

FILES_REQUIRING_GUARDRAIL = [
    REPO_ROOT / "plugins" / "code" / "prompts" / "prompt.md",
    REPO_ROOT / "plugins" / "code" / "commands" / "amend-plan.md",
    REPO_ROOT / "plugins" / "code" / "agents" / "pre-explorer.md",
    REPO_ROOT / "plugins" / "code" / "agents" / "plan-draft-writer.md",
    REPO_ROOT / "plugins" / "code" / "agents" / "plan-evaluator.md",
    REPO_ROOT / "plugins" / "code" / "agents" / "plan-validator.md",
    REPO_ROOT / "plugins" / "judges" / "agents" / "context-manager-for-judges.md",
    REPO_ROOT
    / "plugins"
    / "judges"
    / "skills"
    / "artifact-type-tailored-context"
    / "preambles"
    / "common_input_preamble.md",
]


def test_prompt_boundaries_treat_artifacts_as_untrusted_data() -> None:
    for path in FILES_REQUIRING_GUARDRAIL:
        content = path.read_text()
        lowered = content.lower()
        assert "untrusted " in lowered, path
        assert "not as instructions" in lowered, path
        assert "override prompts" in content.lower(), path
        assert "decode hidden payloads" in content.lower(), path
