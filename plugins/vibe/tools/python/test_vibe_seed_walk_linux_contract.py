"""Contract checks for the 2026-10-13 operator ruling that the seed refresh runs its own full screen walk on a Mac.

1. On macOS the seed-fix worker runs the full web and Desktop walk with
   `pnpm vibe walk-linux --out <file in the fix worktree's private area>`
   (symphony-alpha #8792) instead of the native up, walk, down sequence, and
   treats its result as the walk evidence. Linux keeps the native sequence.
2. The walk keeps its timeouts and assertions. A refused run (Docker VM too
   small, the `cl-ai-stage` sign-in expired, another run active) is BLOCKED
   with the tool's exact message, never a pass and never worked around.
3. The walk evidence (web and Desktop counts, result file) reaches the seed
   PR's Test plan and the ticket's loop.
"""

from __future__ import annotations

import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]
FIX_WORKER = PLUGIN_ROOT / "agents" / "vibe-seed-fix-worker.md"
PR_WORKER = PLUGIN_ROOT / "agents" / "vibe-seed-pr-worker.md"
SKILL = PLUGIN_ROOT / "skills" / "vibe-seed-refresh" / "SKILL.md"
RESULT_FILE = ".control/vibe/seed-walk-result.json"


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def section(text: str, heading: str) -> str:
    """The section under `heading`, up to the next heading of the same or a higher level, flattened."""
    level = len(heading.split(" ", 1)[0])
    start = text.index(heading)
    rest = text[start + len(heading) :]
    ends = [match.start() for match in re.finditer(r"\n(#{1,%d}) " % level, rest)]
    return flat(rest[: ends[0]] if ends else rest)


def walk_rule() -> str:
    return section(FIX_WORKER.read_text(), "## The screen walk")


def test_a_mac_walks_in_the_linux_container_and_linux_keeps_the_native_sequence() -> None:
    rule = walk_rule()
    mac, linux = rule.split("- `Linux`:", 1)
    assert "`Darwin` (macOS): `pnpm vibe walk-linux --out .control/vibe/seed-walk-result.json`" in mac
    assert "Never run the native `pnpm vibe up --ci` / `pnpm vibe walk` / `pnpm vibe down` sequence on a Mac" in mac
    assert "`.control/` is gitignored); never commit it" in rule
    assert f"`pnpm vibe walk --out {RESULT_FILE}`" in linux
    assert "`pnpm vibe down` even when the walk fails" in linux
    checks = section(FIX_WORKER.read_text(), "## Fix mode")
    assert "the full screen walk below" in checks
    assert "it is required, never skipped and never left to CI" in checks
    assert "`pnpm vibe walk`, then `pnpm vibe down` even when the walk fails)" not in checks


def test_the_walk_result_is_the_evidence_and_only_ok_with_exit_0_passes() -> None:
    rule = walk_rule()
    for required in (
        "Exit 0 and `\"ok\":true` mean the walk passed and its cleanup is proven",
        "`down.stopped`, `down.cleaned`, `ownedDatabases` 0, `containerRemoved`",
        "`walkResult` (`visited.web`, `visited.desktop`, `failures`), the `--out` file, and `runDir`",
        "Anything other than `\"ok\":true` with exit 0 is not a pass",
    ):
        assert required in rule, required


def test_the_walk_keeps_its_timeouts_and_assertions() -> None:
    rule = walk_rule()
    assert "keeps the walk's own timeouts and assertions" in rule
    assert "never edit the walk, its specs or its limits to make a run pass" in rule
    assert "A failing walk (`failures` listed) is a seed defect: fix the seed and run the walk again" in rule


def test_a_refused_run_is_blocked_with_the_exact_message_and_never_worked_around() -> None:
    rule = walk_rule()
    for required in (
        "A refused Mac run is `BLOCKED`, never a pass, and never worked around",
        "`{\"ok\":false,\"error\":...}`",
        "VM too small", "`aws sso login --profile cl-ai-stage` sign-in expired",
        "another `walk-linux` run active",
        "return `BLOCKED` with that `error` text exactly as printed",
        "Do not resize Docker, sign in to AWS, stop or wait out the other run, delete its lock, "
        "fall back to the native sequence or a web-only walk, or report the other checks as enough",
        "whose cleanup is not proven is also `BLOCKED`",
    ):
        assert required in rule, required
    skill = section(SKILL.read_text(), "## 3. Fix")
    assert "reported with the tool's exact message, never as a pass and never worked around" in skill


def test_the_walk_evidence_reaches_the_pr_test_plan_and_the_state() -> None:
    returned = section(FIX_WORKER.read_text(), "## Return (under 150 words)")
    assert ("`Walk: <walk-linux|native>, web <visited.web> screens, Desktop <visited.desktop> screens, "
            "<n> failures, result <result file path>`") in returned
    assert "a refused walk quotes the tool's `error` exactly" in returned

    skill = SKILL.read_text()
    assert '"drift", "walk" }' in skill
    fix = section(skill, "## 3. Fix")
    for required in ("on a Mac through `pnpm vibe walk-linux`",
                     "Save its worktree, branch and `Walk:` evidence line",
                     "A `DONE` without a `Walk:` line is not done"):
        assert required in fix, required
    assert "the `Walk:` evidence line, which goes into the PR's Test plan" in section(skill, "## 4. Pull request")
    assert "save its new `Walk:` line in state and pass it to push" in section(skill, "## 5. On each wake-up")

    modes = section(PR_WORKER.read_text(), "## Modes")
    for required in ("with the walk evidence as its own line",
                     "web and Desktop screen counts, failures, and the result file",
                     "with no `Walk:` line, return `BLOCKED` instead of opening the PR",
                     "replace the Test plan's walk line in the PR body with it"):
        assert required in modes, required
