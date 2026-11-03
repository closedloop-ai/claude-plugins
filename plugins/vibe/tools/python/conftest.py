"""Contract tests read the prompt files whole: a stub a split left behind reads as the block it names."""

from __future__ import annotations

from pathlib import Path

import skill_split


def _read_text(self: Path, *args: object, **kwargs: object) -> str:
    text = skill_split._raw_read_text(self, *args, **kwargs)  # type: ignore[arg-type]
    if self.suffix == ".md" and skill_split.STUB.search(text) is not None:
        return skill_split.assembled(self)
    return text


Path.read_text = _read_text  # type: ignore[method-assign]
