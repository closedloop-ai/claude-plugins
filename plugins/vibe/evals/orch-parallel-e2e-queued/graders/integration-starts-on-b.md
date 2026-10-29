---
type: regex
match: contains
flags: i
pattern: 'START_INTEGRATION:\s*(?=[^\n]*\bB\b)(?=[^\n]*\b(?:now|immediately|at once)\b)[^\n]+'
---

Integration starts immediately on allowed machine B.
