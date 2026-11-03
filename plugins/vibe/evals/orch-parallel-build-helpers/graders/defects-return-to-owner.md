---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*defect[\s\S]*(?:return|send|route)[\s\S]*ticket writer)(?=[\s\S]*helper[\s\S]*(?:never|do not|does not|cannot)[\s\S]*repair)[\s\S]+'
---

A defect in ticket writer code returns to that writer, not a helper repair.
