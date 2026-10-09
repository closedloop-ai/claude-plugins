"""Contract checks for the repo-hardening skill.

The skill ships to more than one agent harness and is pointed at arbitrary
repositories, so it may not name a harness, vendor, model, or private path
outside its attribution notice, its links must resolve from the skill's own
folder, and its HTML plan template must render without network access.
"""

from __future__ import annotations

import base64
import hashlib
import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = PLUGIN_ROOT / "skills" / "repo-hardening"
NOTICE = SKILL_ROOT / "NOTICE.md"
HTML_TEMPLATE = SKILL_ROOT / "assets" / "plan-template.html"
MARKDOWN_LINK_RE = re.compile(r"\]\(([^)\s]+)\)")
HEADING_RE = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)
BANNED_TERMS_RE = re.compile(
    r"\b(Claude|CLAUDE|Codex|Anthropic|OpenAI|Cursor|GPT|Opus|Sonnet|Haiku|Gemini"
    r"|ClosedLoop|closedloop|symphony|poteto|Lauren Tan)\b"
)
PRIVATE_PATHS = ("${CLAUDE_SKILL_DIR}", "${CODEX_HOME}", "/Users/", "/home/", "~/")
DASH_ONLY_CHARS = frozenset("-|: ")


def skill_files() -> list[Path]:
    files = sorted(path for path in SKILL_ROOT.rglob("*") if path.is_file())
    assert files
    return files


def slug(heading: str) -> str:
    return re.sub(r"[^a-z0-9 -]", "", heading.lower()).replace(" ", "-")


def test_frontmatter_has_only_name_and_description_with_triggers() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    frontmatter = skill.split("---", 2)[1]
    keys = [line.split(":", 1)[0] for line in frontmatter.strip().splitlines()]
    assert keys == ["name", "description"]
    assert "\nname: repo-hardening\n" in frontmatter
    description = next(
        line for line in frontmatter.splitlines() if line.startswith("description: ")
    )
    for trigger in (
        "audit this repo",
        "harden this repo",
        "make agents work better here",
    ):
        assert trigger in description, trigger
    assert "Not for trivial edits" in description
    assert len(description.removeprefix("description: ")) <= 1024


def test_skill_keeps_the_plan_read_only_and_escaped() -> None:
    skill = (SKILL_ROOT / "SKILL.md").read_text()
    assert "do not change code, open pull requests, or file tickets" in skill
    assert "outside the analyzed repo's directory" in skill
    assert "no installs, builds, or test runs" in skill
    assert "Escape every string taken from the repository" in skill


def test_skill_files_stay_harness_and_vendor_neutral() -> None:
    for path in skill_files():
        text = path.read_text()
        for private_path in PRIVATE_PATHS:
            assert private_path not in text, f"{path.name}: {private_path}"
        if path == NOTICE:
            continue
        match = BANNED_TERMS_RE.search(text)
        assert match is None, f"{path.name}: {match and match.group(0)}"
        for scheme in ("http://", "https://"):
            assert scheme not in text, f"{path.name}: external URL"


def test_notice_carries_attribution_and_license() -> None:
    notice = NOTICE.read_text()
    assert "pstack by Lauren Tan" in notice
    assert "MIT License" in notice
    assert "Copyright (c) 2026 Lauren Tan" in notice
    assert "The above copyright notice and this permission notice" in notice


def test_skill_text_has_no_em_dashes_or_double_hyphens() -> None:
    for path in skill_files():
        text = path.read_text()
        assert "\u2014" not in text, f"{path.name}: em dash"
        for line in text.splitlines():
            if line.strip() and set(line) <= DASH_ONLY_CHARS:
                continue  # frontmatter fence or table separator row
            assert "--" not in line, f"{path.name}: double hyphen in {line!r}"


def test_relative_links_resolve_inside_the_skill() -> None:
    for path in SKILL_ROOT.rglob("*.md"):
        text = path.read_text()
        for target in MARKDOWN_LINK_RE.findall(text):
            if path == NOTICE and target.startswith("https://"):
                continue
            assert not target.startswith(("/", "~", "http")), f"{path.name}: {target}"
            file_part, _, anchor = target.partition("#")
            linked = (path.parent / file_part).resolve() if file_part else path
            assert linked.is_file(), f"{path.name}: {target}"
            assert linked.is_relative_to(SKILL_ROOT), f"{path.name}: {target}"
            if anchor:
                headings = {slug(h) for h in HEADING_RE.findall(linked.read_text())}
                assert anchor in headings, f"{path.name}: {target}"


def test_html_template_makes_no_network_requests() -> None:
    html = HTML_TEMPLATE.read_text()
    lowered = html.lower()
    for marker in ("http:", "https:", "src=", "<link", "@import", "url(", "//"):
        assert marker not in lowered, marker


def test_html_template_policy_pins_its_only_script() -> None:
    html = HTML_TEMPLATE.read_text()
    scripts = re.findall(r"<script>(.*?)</script>", html, re.DOTALL)
    assert len(scripts) == 1
    digest = base64.b64encode(hashlib.sha256(scripts[0].encode()).digest()).decode()
    policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', html)
    assert policy is not None
    assert "default-src 'none'" in policy.group(1)
    assert f"script-src 'sha256-{digest}'" in policy.group(1)
