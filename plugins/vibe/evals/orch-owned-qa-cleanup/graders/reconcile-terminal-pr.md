---
type: regex
match: contains
flags: i
pattern: 'ACTION:(?=[^\n]*(?:now|immediately|automatically))(?=[^\n]*(?:reconcil|clean|stop))(?=[^\n]*qa-owned)[^\n]+'
---

The terminal PR triggers owned QA cleanup without an operator reminder.
