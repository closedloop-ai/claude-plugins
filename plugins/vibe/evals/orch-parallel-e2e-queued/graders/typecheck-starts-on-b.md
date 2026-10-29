---
type: regex
match: contains
flags: i
pattern: 'START_TYPECHECK:\s*(?=[^\n]*\bB\b)(?=[^\n]*\b(?:now|immediately|at once)\b)[^\n]+'
---

Typecheck starts immediately on allowed machine B.
