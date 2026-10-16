"""Contract checks for how the writer's rules reach it, and how it records them.

Codex loads a skill by reading its file through shell output, and a long
output keeps its start and end and drops the middle. The vibe SKILL.md runs
to about 14,400 tokens, so a single read lost the build loop, and a context
doing the writer's work never opened the writer's definition or
`quality-loop.md`. Told to read in parts, it stopped after the first 200
lines, before the rules it needed. On main `642d235` the four visual-cues
Codex evals failed: a render with no reference image, criteria that
paraphrased the person's words without a source or result, and no
`Reference read` lines or token-mapped criteria for a reference (vibe 1.0.44
Codex baseline). Claude on 1.0.44 missed the same records in three of the
four cases.

1. The Codex harness note says to read long files to their last line in
   parts, and it sits near the top of SKILL.md, inside the part a single read
   keeps.
2. In both harnesses, whatever context does the writer's work reads the
   writer's definition and the two named sections of `quality-loop.md`
   before it plans or builds.
3. `quality-loop.md` gives the exact line shapes for a `Reference read`, a
   criterion per reference property with its token, the reference check, and
   a criterion quoting the person's words with no render; the writer points
   at them.
"""

from __future__ import annotations

from pathlib import Path

from vibe_contract_text import flat

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
VIBE_SKILL = PLUGIN_ROOT / "skills" / "vibe" / "SKILL.md"
QUALITY = PLUGIN_ROOT / "skills" / "vibe" / "references" / "quality-loop.md"
WRITER = PLUGIN_ROOT / "agents" / "vibe-change-worker.md"
NOTE = "Codex reads files through shell output"
RECORDING = "### Recording it in the table"
# A single Codex read of SKILL.md kept roughly its first 19,000 characters;
# stay well inside that so the note itself is never the part that drops.
KEPT_HEAD_CHARACTERS = 12_000


def harness_notes() -> str:
    text = VIBE_SKILL.read_text()
    start = text.index("## Harness notes\n")
    end = text.index("\n## ", start + 1)
    return flat(text[start:end])


def recording() -> str:
    text = QUALITY.read_text()
    start = text.index(RECORDING + "\n")
    end = text.index("\n### ", start + 1)
    return flat(text[start:end])


def test_the_codex_reading_note_is_in_the_part_a_single_read_keeps() -> None:
    text = VIBE_SKILL.read_text()
    assert NOTE in text
    assert text.index(NOTE) < KEPT_HEAD_CHARACTERS


def test_codex_reads_long_files_to_the_end_in_parts_never_one_cat() -> None:
    notes = harness_notes()
    for phrase in (
        "keeps the start and end of a long file and drops its middle",
        "one read of this file loses the build loop",
        "Read this file, each agent file and each reference to its last line, in parts of at most 200 lines",
        "never with one `cat`",
        "`grep -n '^#'` on a file gives a named section's lines",
    ):
        assert phrase in notes, phrase


def test_whoever_does_the_writers_work_reads_its_rules_first_in_both_harnesses() -> None:
    notes = harness_notes()
    for phrase in (
        "In both harnesses, whatever context does the writer's work, a spawned `vibe-change-worker` or this one when it is told to do that work itself",
        "reads all of `../../agents/vibe-change-worker.md`",
        '"Acceptance criteria before ready" and "Visual references" sections of `references/quality-loop.md` (both past its first 400 lines) before it plans or builds',
        "when a render is allowed",
    ):
        assert phrase in notes, phrase


def test_the_writer_reads_its_references_to_the_end_in_codex() -> None:
    writer = flat(WRITER.read_text())
    read_first = writer[writer.index("## Read first") : writer.index("## Plan before code")]
    for phrase in (
        "In Codex, read each, and this file, to its last line in parts of at most 200 lines",
        "one read of a long file loses its middle",
        '"Acceptance criteria before ready" and "Visual references", past its first 400 lines',
    ):
        assert phrase in read_first, phrase


def test_the_table_records_each_reference_read_criterion_and_check_in_one_shape() -> None:
    assert RECORDING in QUALITY.read_text()
    section = recording()
    for phrase in (
        "`Reference read <request ID>: <image path>: <what it shows>`, one per reference image on the session, every one the person gave and not only the one the latest request names (a screenshot of our page as it is now included), before any criterion or code for that request, a correction included",
        "`AC-n (source: <request ID>, reference <image path>): <one property as the reference shows it>; <the design token or catalog component that delivers it>`",
        'a shadow, a type size and a type weight are three criteria, never one "match the reference"',
        'A correction ("it still doesn\'t look like it") adds a criterion for each property the reference shows that no criterion names yet, even when a broad one such as "make ours like the second one" exists, before it fixes anything',
        # operator ruling, 2026-10-16: one reference check line per theme the surface supports.
        "reference check (<light|dark>), compared <screenshot path> with <image path> after the last edit",
        "Criterion lines sit under `## Acceptance Criteria`, above `### Checks`; only check lines go below it",
    ):
        assert phrase in section, phrase


def test_the_record_shapes_come_first_in_visual_references() -> None:
    # A Codex writer that reads "Visual references" from its first line stops
    # before the section's end often enough that the shapes must lead it.
    text = QUALITY.read_text()
    visual = text.index("## Visual references\n")
    assert visual < text.index(RECORDING) < text.index("### Saving the reference")


def test_with_no_reference_a_criterion_quotes_the_words_and_nothing_renders() -> None:
    section = recording()
    assert '`AC-n (source: <request ID>): "<their words>"`' in section
    assert "never a render" in section


def test_the_writer_records_one_property_per_criterion_in_those_shapes() -> None:
    writer = flat(WRITER.read_text())
    assert "one property per criterion, with the design token or catalog component that delivers it" in writer
    assert 'Record each line in the shapes `quality-loop.md`, "Recording it in the table", gives' in writer
