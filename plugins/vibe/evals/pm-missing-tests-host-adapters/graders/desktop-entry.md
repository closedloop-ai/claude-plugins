---
type: regex
match: contains
flags: i
pattern: 'Missing tests:(?=[^\n]*\bDesktop\b)(?=[^\n]*(?:PRD-42\s+)?AC-3\b)[^\n]+'
---
The missing test entry names the Desktop host and existing criterion ID.
