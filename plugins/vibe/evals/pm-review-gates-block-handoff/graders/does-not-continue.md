---
type: regex
match: contains
flags: i
pattern: 'CONTINUE:[^\n]*\b(no|not)\b'
---
Handoff does not move on while the finding blocks or with a placeholder line.
