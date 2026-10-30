---
type: regex
match: contains
flags: i
pattern: '(?![\s\S]*(?:reconcil\w*|stop\w*|clean\w*)[^.\n]{0,80}\bqa-owned\b[^.\n]{0,80}\b(?:later|afterward|eventually|tomorrow)\b)(?=[\s\S]*(?:\bPR\s*42\b[\s\S]{0,100}\b(?:closed|merged)\b|\b(?:closed|merged)\b[\s\S]{0,100}\bPR\s*42\b))(?=[\s\S]*(?:(?:reconcil\w*|stop\w*|clean\w*)[^.\n]{0,100}(?:\bqa-owned\b[^.\n]{0,60}\b(?:now|immediately|automatically)\b|\b(?:now|immediately|automatically)\b[.\s]{0,60}\bqa-owned\b)|\bqa-owned\b[^.\n]{0,100}(?:reconcil\w*|stop\w*|clean\w*)[^.\n]{0,60}\b(?:now|immediately|automatically)\b|\b(?:now|immediately|automatically)\b[^.\n;]{0,50}(?:reconcil\w*|stop\w*|clean\w*)[^.\n]{0,80}\bqa-owned\b))[\s\S]+'
---

The terminal PR triggers owned QA cleanup without an operator reminder.
