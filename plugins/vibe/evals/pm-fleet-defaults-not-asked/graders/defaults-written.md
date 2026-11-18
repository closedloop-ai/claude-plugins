---
type: regex
match: contains
flags: i
pattern: 'RECORD:(?:[^\n]|\n(?=[ \t]*[-*]\s))*config\.env'
---
The defaults are written to config.env rather than asked for.
