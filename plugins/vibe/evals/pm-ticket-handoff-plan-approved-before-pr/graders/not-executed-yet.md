---
type: regex
match: not_contains
flags: i
pattern: '(?:^|\n)\s*\d+\.\s*`?(?:mcp__[a-z_-]+__)?update[-_]document[^\n]*EXECUTED'
---
The PLN is not EXECUTED before the pull request merges.
