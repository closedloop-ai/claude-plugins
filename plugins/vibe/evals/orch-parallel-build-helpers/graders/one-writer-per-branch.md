---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*one writer per branch)(?=[\s\S]*(?:helper|helpers)[\s\S]*(?:never|do not|does not|cannot)[\s\S]*(?:edit|touch)[\s\S]*ticket branch)[\s\S]+'
---

Every branch has one writer, and helpers leave the ticket branch untouched.
