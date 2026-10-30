---
type: regex
match: contains
flags: i
pattern: '(?:^|[.\n])(?=[^.\n]{0,240}\bintegration\b)(?=[^.\n]{0,240}\b(?:start|run|launch)\w*\b)(?=[^.\n]{0,240}\b(?:now|immediately|at once)\b)(?=[^.\n]{0,240}\bmachine\s*B\b)(?![^.\n]{0,240}\bintegration\b[^.\n]{0,100}\b(?:wait\w*|later|after e2e)\b)[^.\n]{1,240}'
---

Integration starts immediately on allowed machine B.
