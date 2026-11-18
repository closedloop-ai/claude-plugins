---
type: regex
match: contains
flags: i
pattern: 'Missing tests:(?=(?:[^\n]|\n(?=[ \t]*[-*]\s))*\bDesktop\b)(?=(?:[^\n]|\n(?=[ \t]*[-*]\s))*(?:PRD-42\s+)?AC-3\b)(?:[^\n]|\n(?=[ \t]*[-*]\s))+'
---
The missing test entry names the Desktop host and existing criterion ID.
