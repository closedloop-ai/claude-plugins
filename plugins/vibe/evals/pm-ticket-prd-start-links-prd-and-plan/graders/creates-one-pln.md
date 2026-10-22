---
type: regex
match: contains
flags: i
pattern: '(?:^|\n)\s*\d+\.\s*`?(?:mcp__[a-z_-]+__)?create[-_]document(?![-_]version)(?=[^\n]*IMPLEMENTATION_PLAN)(?=[^\n]*PRO-88)(?=[^\n]*6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f)'
---
One implementation plan document in the ticket's project, assigned to the ticket's assignee.
