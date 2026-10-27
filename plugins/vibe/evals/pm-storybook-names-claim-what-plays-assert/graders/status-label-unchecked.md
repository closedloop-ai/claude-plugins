---
type: regex
match: contains
flags: i
pattern: 'Pull Request State[^\n]*(\bassert[^\n]*\b(open|merged|closed)\b|\b(open|merged|closed)\b[^\n]*\bassert)'
---
A status story's name claims the painted status, so the placement block names the assertion on each open, merged and closed row.
