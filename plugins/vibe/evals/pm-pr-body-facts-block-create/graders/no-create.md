---
type: regex
match: contains
flags: i
pattern: 'CREATE:[^\n]*\b(no|not|never|does not|doesn.t)\b'
---
A failing facts check creates no pull request.
