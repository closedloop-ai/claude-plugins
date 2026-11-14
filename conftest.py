"""Contract tests read the prompt files whole: a stub a split left behind reads as the block it names.

Provider stubs read as the provider's text, so a contract written before that text moved still reads it; a test
of the generic session reads `skill_split.assembled(path, provider=False)`.

This applies to every pytest in the repo, so a contract test passes whether a rule is always loaded or sits behind a
stub. The exact SPLIT set in test_vibe_prompt_split_contract.py is the only guard on what is split; a placement test
must read `skill_split.raw`, never `read_text`, or it cannot tell the two apart.

Lives at the repo root, not beside the vibe tests: plugins/code-review imports `conftest` by name inside
functions, and a second nested conftest.py would shadow its module in sys.modules.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "plugins" / "vibe" / "tools" / "python"))

import skill_split  # noqa: E402  # pyright: ignore[reportMissingImports]


def _read_text(self: Path, *args: object, **kwargs: object) -> str:
    text = skill_split._raw_read_text(self, *args, **kwargs)  # type: ignore[arg-type]
    if self.suffix == ".md" and skill_split.has_stubs(text):
        return skill_split.assembled(self)
    return text


Path.read_text = _read_text  # type: ignore[method-assign]
