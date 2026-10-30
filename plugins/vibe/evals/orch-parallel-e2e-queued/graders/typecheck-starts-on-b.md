---
type: regex
match: contains
flags: i
pattern: '^(?![\s\S]*\btypecheck\b[^.\n]{0,100}\b(?:wait\w*|later|after e2e)\b)(?=[\s\S]*\btypecheck\b)(?=[\s\S]*\b(?:start|run|launch)\w*\b)(?=[\s\S]*\b(?:now|immediately|at once)\b)(?=[\s\S]*\bmachine\s*B\b)[\s\S]*$'
---

Typecheck starts immediately on allowed machine B.
