"""Contract tests read the prompt files whole: a stub a split left behind reads as the block it names.

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
    if self.suffix == ".md" and skill_split.STUB.search(text) is not None:
        return skill_split.assembled(self)
    return text


Path.read_text = _read_text  # type: ignore[method-assign]
