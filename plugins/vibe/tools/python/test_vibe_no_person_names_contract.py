"""Contract check for the 2026-10-14 operator ruling that plugin text never names people.

Skills, agents, references, scripts, tests and comments state the rule itself;
provenance is written as "operator ruling, <date>" or "design ruling, <date>".
This scans every text file under plugins/vibe/ for the names of people the
plugin has named before, or who could be named next.

The names are stored as truncated SHA-256 digests so this file does not name
them either. To add one, append name_digest("<name>") for a name that is not an
ordinary word (matched in any case, so emails, ids and handles are caught) or
name_digest("<Name>", any_case=False) for one that is (matched only as a
capitalized word).
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[2]

ANY_CASE_NAMES = frozenset({
    "08671c5f838ebf17", "25a032559f0b687e", "26adb5dbff56511c", "3ab00f8a705f6d9a",
    "49b193fe9c8cd875", "4c5f790f58d481ca", "6177321eac992341", "6364d611bb1f31d1",
    "6e0626a779a150c6", "7c23cb88a2b95c14", "9fb2722cbd0c6753", "bd3dae5fb91f88a4",
    "c0b1eac6bb604a56", "c2e1c2c42364f093", "c3ea6a37c8213c5a", "c449e4fd0f22f245",
    "d8e259f725ff6ba5", "d979885447a413ab", "e933c8acea21982c",
})
CAPITALIZED_NAMES = frozenset({
    "02281b3b5dd57c46", "355a6bb6d0f6d14d", "3f0c9b03e8e39b03", "61d9b64257facb54",
    "84a4b19e19aa4e2a", "87ff2d3e9553ae41", "92039f1a7ad82575", "9ae4bc0e32db0e34",
    "9dc415325a95c6e2", "b5fd03dd91df1cfb", "c5355d0949a19852", "cee37055a4152e73",
    "da17c13402bca42e", "ea72c79594296e45", "ecd094c866f03424", "f2dd86e34cc18d36",
    "fb338e53da57ec89",
})

WORD = re.compile(r"[A-Za-z0-9]+")

# Identifiers owned elsewhere that the plugin must keep spelling exactly: the
# product-contract QA skill's command in the target repository, and the legacy
# repo-memory keys cl-policy still reads from older records.
EXTERNAL_IDENTIFIERS = re.compile(
    r"metal-andrew|daniel_dm_permalink_or_timestamp|daniel_dm_key|daniel_dm|Daniel-attention"
)

# Vendored third-party bundles are not plugin prose.
VENDORED = ("mermaid-11.16.0.min.js",)


def name_digest(word: str, any_case: bool = True) -> str:
    return hashlib.sha256((word.lower() if any_case else word).encode()).hexdigest()[:16]


def names_in(line: str) -> list[str]:
    found = []
    for word in WORD.findall(EXTERNAL_IDENTIFIERS.sub(" ", line)):
        if name_digest(word) in ANY_CASE_NAMES or (
            word[:1].isupper() and name_digest(word, any_case=False) in CAPITALIZED_NAMES
        ):
            found.append(word)
    return found


def test_no_person_is_named_anywhere_in_the_plugin() -> None:
    hits: list[str] = []
    for path in sorted(PLUGIN_ROOT.rglob("*")):
        if not path.is_file() or path.name in VENDORED or "__pycache__" in path.parts:
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(text.splitlines(), 1):
            hits.extend(f"{path.relative_to(PLUGIN_ROOT)}:{number}: {word}" for word in names_in(line))
    assert not hits, "person names in plugin text:\n" + "\n".join(hits)


def test_ordinary_words_and_external_identifiers_are_not_names() -> None:
    for sample in ("the eye test", "a jack plug", "matte finish", "android", "semantic", "the operator"):
        assert not names_in(sample), sample
    assert not names_in("then `/metal-andrew` reads `daniel_dm_key`")
