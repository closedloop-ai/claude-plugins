---
type: regex
match: contains
flags: i
pattern: 'NEXT:\s*`?(?:node\s+)?\S*plugin-version\.mjs\s+status\b(?=[^\n]*--closedloop[ =]connected\b)(?=[^\n]*--graph[ =]not-connected\b)'
---
