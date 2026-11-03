---
type: regex
match: contains
flags: i
pattern: '^(?![\s\S]*\bqa-owned\b[^.\n]{0,100}\b(?:later|afterward|eventually|tomorrow)\b)(?=[\s\S]*(?:\bPR\s*42\b|#42\b))(?=[\s\S]*\b(?:closed|merged|closure)\b)(?=[\s\S]*\bqa-owned\b)(?=[\s\S]*\b(?:reconcil\w*|stop\w*|clean\w*)\b)(?=[\s\S]*\b(?:now|immediately|automatically)\b)[\s\S]*$'
---

The terminal PR triggers owned QA cleanup without an operator reminder.
