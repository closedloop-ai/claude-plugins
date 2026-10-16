"""Contract checks for the 2026-10-15 operator ruling "we're missing visual cues".

A person built UI from a reference screenshot of another product. The session
missed a drop shadow, a larger text size and bold type, and fixed each once she
pointed it out. The writer never looked at its result or at the reference as an
image: the screenshot reached it only as an optional path beside the
orchestrator's text description, reference mode was scoped to behaviors, every
criterion was "met by source trace", and the ready message said "It matches".

1. The orchestrator saves every attached image with `reference-images.mjs`,
   records it on the session and forwards the saved path, never its own
   description in place of it. The Claude launcher and Codex `take-input` carry
   the recorded paths; the writer opens each as an image and records a
   `Reference read` before building.
2. Reference mode runs on an outside-product screenshot, named or not, and
   always returns visual and UX requirements mapped to the design system.
3. Only with a reference image (operator ruling, 2026-10-15, the one exception
   to the lean loop's no-automated-visual-QA rule), before ready the writer
   screenshots each touched screen at the reference's viewport, compares the
   properties the reference shows plus regressions on the touched element,
   fixes each difference with tokens and screenshots again. With no reference
   image there is no render or compare. It is not a design review.
4. The comparison gates the ready message, and the orchestrator never says the
   result matches when it has seen a gap.
5. Handoff never silently reverts a visible change the person saw, and a
   surface without bundled tokens is logged for engineering.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import agent, flat, section

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE = PLUGIN_ROOT / "skills" / "vibe"
AGENTS = PLUGIN_ROOT / "agents"
QUALITY = VIBE / "references" / "quality-loop.md"
ENVIRONMENT = VIBE / "references" / "environment.md"
GUARDRAILS = VIBE / "references" / "guardrails.md"
VIBE_SKILL = VIBE / "SKILL.md"
HANDOFF_SKILL = PLUGIN_ROOT / "skills" / "handoff" / "SKILL.md"
DIST = VIBE / "scripts" / "dist"
HEADING = "## Visual references"
CHECK = "### The reference check before ready"
PROPERTIES = "shadow and elevation, font size, weight, color, spacing, radius, borders, alignment and icons"


def rule() -> str:
    return section(QUALITY.read_text(), HEADING)


def check() -> str:
    return section(QUALITY.read_text(), CHECK)


def assert_all(text: str, required: tuple[str, ...]) -> None:
    for phrase in required:
        assert phrase in text, phrase


def test_the_rule_is_dated_canonical_and_serves_every_person_without_asking() -> None:
    assert_all(rule(), (
        "(operator ruling, 2026-10-15: \"we're missing visual cues\")",
        "This section is the rule's one canonical statement",
        "nobody is asked which kind they are",
        "gets the reference saved, read, turned into criteria and checked against a screenshot before ready",
        "describes what they want in words gets criteria from their words, checked as before, with no render or compare",
    ))


def test_an_attached_image_is_saved_recorded_and_forwarded_as_a_path_never_a_description() -> None:
    assert_all(rule(), (
        "an image the person attaches in chat reaches it only as a saved file it opens itself",
        "`node scripts/reference-images.mjs attached --worktree \"<wt>\" --request-id <id>`",
        "`save --file <path>`",
        "record it on the session as `referenceImages`, so later turns and handoff reuse it",
        "The request to the writer names every saved path.",
        "never replaces the image with its own description as the only reference",
        "Claude Code's owned launcher adds the recorded `referenceImages`",
        "`writer-state.mjs take-input` returns them with the claimed input",
        "`local_image` input item",
        "`Read` in Claude Code, `view_image` in Codex",
    ))
    loop = section(VIBE_SKILL.read_text(), "## 5. Build loop")
    assert_all(loop, (
        "`node scripts/reference-images.mjs attached --worktree \"<wt>\" --request-id <id>`",
        "every saved reference image path",
        "Never send your own description of an image in place of its path.",
    ))
    assert "a worker never sees what the person attached in chat" in section(VIBE_SKILL.read_text(), "## Harness notes")
    assert (VIBE / "scripts" / "reference-images.mjs").is_file()


def test_the_relay_carries_the_saved_paths_in_both_harnesses() -> None:
    claude = (DIST / "claude-worker.mjs").read_text()
    assert "referenceImages" in claude
    assert '"vibe-change-worker", "vibe-requirements-worker", "vibe-verify-worker"' in claude
    assert "referenceImages" in (DIST / "writer-state.mjs").read_text()


def test_reading_the_reference_is_a_required_recorded_step() -> None:
    assert_all(rule(), (
        "Reading the reference is a required step with a recorded result.",
        "including a correction such as \"it still doesn't look like it\"",
        "A correction adds each property the reference shows that the list still lacks, before it fixes anything.",
        "appends a `Reference read` line per image to the `### Checks` log",
        "A plan or criterion written before that line exists is incomplete",
        "The orchestrator's text description of an image never stands in for that read",
    ))
    assert_all(flat(agent("vibe-change-worker")), (
        "Open every reference image path as an image before planning",
        "Never build from a description of a reference in place of the image.",
        "append a `Reference read` line per image",
    ))


def test_an_outside_product_screenshot_runs_reference_mode_with_visual_and_ux_requirements() -> None:
    assert_all(rule(), (
        "goes through the reference-product notice",
        "whether or not the person named the product",
        "reads the image itself and researches the product when it is named or identifiable",
        "Visual: elevation and shadow, type hierarchy (size and weight), color roles, spacing, radius, borders, iconography and density.",
        "interactive affordances and states visible or implied (hover, selected, disabled, empty, loading, overflow)",
        "The orchestrator never scopes the visual list out",
        "\"behaviors, not wording\" is about copy only",
        "mapped to the existing catalog component and design token that delivers it",
        "never copy pixel values or another product's markup",
        "goes to the existing missing-primitive path (`NEEDS_PRIMITIVE`",
        "Never copy the outside product's words",
    ))
    notices = section(VIBE_SKILL.read_text(), "### Notices that never wait")
    assert "gives a screenshot of another product whether or not they name it" in notices
    assert "the visual requirements are always extracted" in notices
    assert_all(section((AGENTS / "vibe-requirements-worker.md").read_text(), "## Reference mode"), (
        "Open every reference image path yourself as an image",
        "never work from someone else's description of it",
        "When the product is named or identifiable from the image",
        "Map each one to the existing catalog component and design token",
        "`no equivalent: missing primitive`",
    ))


def test_reference_requirements_become_criteria_and_only_reference_visuals_need_the_render() -> None:
    assert_all(rule(), (
        "adds each requirement to the session's `## Acceptance Criteria`",
        "source: the request ID and the reference image path",
        "A visual criterion with a reference image is met by the reference check below, never by a source trace alone.",
        "visual criteria with no reference image, are checked like every other criterion",
        "a source trace included",
    ))


def test_the_check_runs_with_a_reference_image_and_never_without_one() -> None:
    assert_all(check(), (
        "Only when the person gave a reference image",
        "(operator ruling, 2026-10-15)",
        "With no reference image there is no render and no compare.",
    ))
    lean = section(QUALITY.read_text(), "## Lean build loop")
    assert "The reference check before ready is the one exception to this rule (operator ruling, 2026-10-15), and it runs only with a reference image." in lean
    assert "- Reference check: only when the person gave a reference image" in lean
    assert "the one exception to its no-automated-visual-QA rule" in rule()
    assert "With no reference image there is no render or compare." in flat(agent("vibe-change-worker"))
    assert "With no reference image there is no render or compare" in section(VIBE_SKILL.read_text(), "## 5. Build loop")
    capture = section(ENVIRONMENT.read_text(), "## Capturing for the reference check")
    assert "Only when the session has a reference image" in capture
    assert "with none, nothing here runs" in capture
    for text in (rule(), flat(agent("vibe-change-worker")), flat(VIBE_SKILL.read_text())):
        assert "sanity look" not in text


def test_the_check_compares_the_reference_properties_and_regressions_then_recaptures() -> None:
    assert_all(check(), (
        "Before returning `DONE`, the writer takes one screenshot of each touched screen or component at the reference's viewport",
        f"looks only at the properties the reference shows ({PROPERTIES}",
        "plus regressions on the touched element: properties that were right before this change and are not now",
        "a removed tap-target minimum height",
        # operator ruling, 2026-10-16: the recapture and the DONE lines now cover each theme.
        "fixes each difference with design tokens, never arbitrary values, and takes the screenshots again until no difference remains",
        "Each comparison is a line in the `### Checks` log",
        "`DONE` on such a change carries a Reference check line per touched screen",
        "without them the `DONE` is incomplete",
    ))
    assert "plus regressions on the touched element (properties that were right before this change)" in flat(agent("vibe-change-worker"))


def test_the_check_is_not_a_design_review() -> None:
    assert_all(check(), (
        "It is not a design review: no critique of craft or hierarchy beyond the reference, and no full design pass; those stay at handoff.",
        "Never ask the person to confirm the comparison",
        "never show them the screenshots or their paths unless a real difference cannot be resolved",
    ))


def test_the_result_gates_the_ready_message_and_never_claims_a_match_over_a_seen_gap() -> None:
    assert "The result gates the ready message. A difference still visible is not ready" in check()
    says = section(QUALITY.read_text(), "### What the orchestrator says")
    assert "never tells the person the result matches the reference, or that a visible property is done, when it has seen a gap" in says
    deploy = section(VIBE_SKILL.read_text(), "## 6. Deploy each change")
    assert "When the session has a reference image, look at each touched screen beside it first" in deploy
    assert "a visible difference is not ready" in deploy
    assert "Never say it matches the reference when you have seen a gap" in deploy


def test_capture_works_in_both_harnesses_with_named_fallbacks() -> None:
    reference = section(ENVIRONMENT.read_text(), "## Capturing a reference")
    assert "`Read` on the path in Claude Code, `view_image` on the path in Codex" in reference
    assert "throwaway headless Playwright script" in reference
    assert "Never sign in to another product or type a credential." in reference
    assert_all(section(ENVIRONMENT.read_text(), "## Capturing for the reference check"), (
        "local Storybook",
        "`pnpm control up desktop --mode e2e`",
        "never `--headed`, `--allow-write`, `eval` or `eval-main`",
        "The control skill's browser is 1440 by 900.",
        "in Codex, the in-app browser's screenshot of the app tab",
        "in Claude Code, the Chrome extension's screenshot when it is connected",
        "A Claude Code session without it has no preview screenshot",
    ))
    assert "When the session recorded reference images (`referenceImages`), open each as an image" in flat(agent("vibe-verify-worker"))


def test_a_token_the_surface_lacks_is_logged_for_engineering_not_invented() -> None:
    # operator ruling, 2026-10-16: the all-or-nothing "tokens not bundled" note became per token.
    assert_all(rule(), (
        "Only a token the surface genuinely lacks",
        "`Engineering needed (token not bundled): <surface>; <token>; checked <each stylesheet and block searched>; uses <the token's exact value>`",
        "it never invents a value no token defines",
    ))


def test_a_visible_change_needing_an_outside_path_is_never_silently_reverted() -> None:
    assert_all(flat(HANDOFF_SKILL.read_text()), (
        "A removal never silently undoes a visible change the person already saw",
        "tell the person in one plain line which part will look different until engineering makes it",
        "the affected criterion goes back to `not met yet` with that reason",
        "the touched screen is rendered again in the verify worker's control mode on the final commit",
    ))
    assert_all(flat(GUARDRAILS.read_text()), (
        "The same holds for a path outside the allowed table: the writer does not edit it in the loop either.",
        "so they never accept a change the branch cannot keep (operator ruling, 2026-10-15)",
    ))
