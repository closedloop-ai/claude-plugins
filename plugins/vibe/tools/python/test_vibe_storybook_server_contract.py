"""Keep every plugin's frozen Storybook server under the owned run wrapper."""

import re
from pathlib import Path

from vibe_contract_text import flat


ROOT = Path(__file__).resolve().parents[4]
PLUGIN = ROOT / "plugins" / "vibe"
HANDOFF = PLUGIN / "skills" / "handoff" / "SKILL.md"
VERIFY = PLUGIN / "agents" / "vibe-verify-worker.md"
DECOMPOSER = PLUGIN / "agents" / "vibe-storybook-decomposer.md"
FLEET = PLUGIN / "skills" / "fleet-orchestrator" / "SKILL.md"
FLEET_TEMPLATES = PLUGIN / "skills" / "fleet-orchestrator" / "references" / "templates.md"
CLEANUP_PROMPT = PLUGIN / "evals" / "orch-owned-qa-cleanup" / "prompt.md"
STATIC_LAUNCH = re.compile(
    r"\b(?:python(?:3(?:\.\d+)?)?\s+-m\s+(?:http\.server|SimpleHTTPServer)|"
    r"(?:npx|pnpm\s+dlx|yarn\s+dlx|bunx)\s+(?:(?:--yes|-y)\s+)?"
    r"(?:serve|sirv(?:-cli)?|http-server)|http-server|sirv|php\s+-S|busybox\s+httpd|serve\s+-s)\b",
    re.IGNORECASE,
)


def find_ad_hoc_static_servers(root_or_paths: Path | list[Path] | tuple[Path, ...]) -> list[str]:
    """Return every plugin instruction line that launches an unowned static server."""
    if isinstance(root_or_paths, Path):
        paths = root_or_paths.rglob("*.md") if root_or_paths.is_dir() else [root_or_paths]
    else:
        paths = root_or_paths
    findings: list[str] = []
    for path in sorted(paths):
        if "assets" in path.parts:
            continue
        for number, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
            if STATIC_LAUNCH.search(line):
                findings.append(f"ad hoc static server instruction: {path}:{number}")
    return findings


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
    assert find_ad_hoc_static_servers(ROOT / "plugins") == []


def test_static_server_detector_covers_runner_variants_even_in_prohibitions() -> None:
    """A negative example can still copy a launch command into a worker turn."""
    for line in (
        "python3 -m http.server 3000", "npx serve", "npx --yes serve",
        "npx sirv-cli", "pnpm dlx serve", "http-server", "busybox httpd",
        "serve -s build", "sirv build", "php -S 127.0.0.1:8000",
        "python -m SimpleHTTPServer", "Never run npx --yes serve",
    ):
        assert STATIC_LAUNCH.search(line), line


def test_instruction_scan_never_skips_prohibitions() -> None:
    """The production scanner also catches prohibited commands in negative prose."""
    assert find_ad_hoc_static_servers(PLUGIN) == []


def test_instruction_scanner_uses_the_same_path_for_never_fixture(tmp_path: Path) -> None:
    """Filtering leading prohibitions cannot bypass the production scanner."""
    fixture = tmp_path / "fixture.md"
    fixture.write_text("Never run python -m SimpleHTTPServer here.\n")
    assert find_ad_hoc_static_servers([fixture]) == [f"ad hoc static server instruction: {fixture}:1"]


def test_terminal_cleanup_response_names_foreign_resources_left_alone() -> None:
    """The cleanup reply has an explicit unrecorded resource disposition."""
    skill = FLEET.read_text()
    template = FLEET_TEMPLATES.read_text()
    early = skill.split("## Principles\n", 1)[1].split("\n## Setup", 1)[0]
    assert "Every terminal PR cleanup reply uses [Lifecycle cleanup report]" in early
    assert "foreign or unrecorded resources left untouched and why" in early
    for fact in ("recorded helper reconciled now", "container, volumes and network removed or retained",
                 "other worker's unrecorded resources left untouched", "status with owner and ticket"):
        assert fact in template, fact
    assert "Audit every fact before sending" in early
    assert skill.count("Every terminal PR cleanup reply uses [Lifecycle cleanup report]") == 1
    assert next(i for i, line in enumerate(skill.splitlines(), 1) if "Every terminal PR cleanup reply uses" in line) < 100


def test_monitor_events_reconcile_terminal_pr_before_status_reply() -> None:
    """A terminal PR event must trigger owned cleanup rather than only describe a capability."""
    monitoring = FLEET.read_text().split("## Monitoring\n", 1)[1].split("\n## ", 1)[0]
    template = FLEET_TEMPLATES.read_text()
    for phrase in (
        "every PR merged or closed monitor event",
        "reconcile recorded leftovers for that PR",
        "exact recorded identities",
        "foreign or unrecorded resources untouched",
        "recorded helper reconciled now",
        "Docker outcome",
        "untouched foreign resources",
        "status with owner and ticket",
    ):
        assert phrase in monitoring, phrase
    prompt = flat(CLEANUP_PROMPT.read_text())
    assert '"Monitoring" section' in prompt
    assert '"Lifecycle cleanup report" template' in prompt
    assert "including terminal PR changes, `STOP` and `ORPHAN`" in FLEET.read_text()
    assert "--ending pr-terminal" in FLEET.read_text()
    assert "helpers.mjs <orchDir> resources" in FLEET.read_text()
    assert "--ending pr-terminal" in template
    assert "helpers.mjs resources" in template
