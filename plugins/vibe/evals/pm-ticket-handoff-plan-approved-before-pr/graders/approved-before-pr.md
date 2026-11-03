---
type: regex
match: contains
flags: i
pattern: '(?:^|\n)\s*\d+\.\s*`?(?:mcp__[a-z_-]+__)?update[-_]document(?=[^\n]*PLN-1450)(?=[^\n]*\WAPPROVED)(?=[^\n]*expectedStatus\W{0,4}DRAFT)'
---
The PLN moves from DRAFT to APPROVED with expectedStatus before the pull request opens.
