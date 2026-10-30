---
type: regex
match: contains
flags: i
pattern: '^(?![\s\S]*\bintegration\b[^.\n]{0,100}\b(?:wait\w*|later|after e2e)\b)(?=[\s\S]*\bintegration\b)(?=[\s\S]*\b(?:start|run|launch)\w*\b)(?=[\s\S]*\b(?:now|immediately|at once)\b)(?=[\s\S]*\bmachine\s*B\b)[\s\S]*$'
---

Integration starts immediately on allowed machine B.
