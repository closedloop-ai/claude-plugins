---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*(?:PR 42|PR closed|pull request closed))(?=[\s\S]*(?:reconcil|clean|stop)[^\n]{0,80}qa-owned)(?=[\s\S]*\b(?:now|immediately|automatically)\b)[\s\S]+'
---

The terminal PR triggers owned QA cleanup without an operator reminder.
