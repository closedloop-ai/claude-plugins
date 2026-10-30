---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*\b(?:start|run|launch)\w*[^\n]{0,100}\btypecheck\b)(?=[\s\S]*\b(?:now|immediately|at once)\b)(?=[\s\S]*\bmachine\s*B\b)[\s\S]+'
---

Typecheck starts immediately on allowed machine B.
