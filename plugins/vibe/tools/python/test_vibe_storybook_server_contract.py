"""Keep every plugin's frozen Storybook server under the owned run wrapper."""

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
PLUGIN = ROOT / "plugins" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff" / "SKILL.md"
VERIFY = PLUGIN / "agents" / "vibe-verify-worker.md"
DECOMPOSER = PLUGIN / "agents" / "vibe-storybook-decomposer.md"
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
FLEET_TEMPLATES = PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md"
STATIC_LAUNCH = re.compile(
    r"\b(?:python(?:3)?\s+-m\s+http\.server|npx\s+serve|http-server|busybox\s+httpd|serve\s+-s)\b",
    re.IGNORECASE,
)


def test_frozen_render_instructions_use_central_server_ownership() -> None:
    """The three owners never ask a worker to provide servers or their URLs."""
    for path in (HANDOFF, VERIFY, DECOMPOSER):
        text = path.read_text()
        assert "frozen-render.mjs" in text, path
        assert "verifier" in text and "run" in text, path
        assert "--base-url" not in text and "--head-url" not in text, path
        assert "verify-storybook-process.mjs start" not in text, path
    assert "prepared base worktree" in HANDOFF.read_text()
    assert "owns both servers" in DECOMPOSER.read_text()


def test_no_plugin_instruction_launches_an_ad_hoc_static_server() -> None:
    """Known static server commands must stay inside the owning wrapper."""
    for path in (ROOT / "plugins").rglob("*.md"):
        if "assets" in path.parts:
            continue
        for line in path.read_text(errors="ignore").splitlines():
            # A prohibition is not a launch instruction.
            if line.lstrip().lower().startswith(("never ", "do not ", "- never ", "- do not ")):
                continue
            assert not STATIC_LAUNCH.search(line), f"ad hoc static server instruction: {path.relative_to(ROOT)}"


def test_terminal_cleanup_response_names_foreign_resources_left_alone() -> None:
    """The cleanup reply has an explicit unrecorded resource disposition."""
    skill = FLEET.read_text()
    template = FLEET_TEMPLATES.read_text()
    assert "Every terminal PR cleanup reply uses [Lifecycle cleanup report]" in skill
    assert "State in `FOREIGN:` that any other worker's unrecorded resource is left untouched" in skill
    for field in ("ACTION:", "DOCKER:", "FOREIGN:", "STATUS:"):
        assert field in template
        assert len(re.findall(rf"^{re.escape(field)}", template, re.MULTILINE)) == 1, field
    assert "`FOREIGN: leave <resource id> untouched because <ownership reason>`" in skill
    assert "FOREIGN: leave <other worker or unrecorded resource id> untouched because <ownership reason>" in template
    assert "Pre-send audit: in the final draft" in template
    assert "must each occur exactly once with nonempty content after the colon" in skill
    assert "fill it and audit again before sending" in skill
