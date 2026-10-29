---
type: regex
match: contains
flags: i
pattern: '(?s)(?=.*one writer per branch)(?=.*(?:helper|helpers).*(?:never|do not|does not|cannot).*(?:edit|touch).*ticket branch)(?:.|\n)+'
---

Every branch has one writer, and helpers leave the ticket branch untouched.
