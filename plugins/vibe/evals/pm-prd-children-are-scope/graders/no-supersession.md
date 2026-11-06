---
type: regex
match: contains
flags: i
pattern: '^(?![\s\S]*SUPERSEDE:[^\n]*(?:\n[\s\S]*)?SUPERSEDE:)[\s\S]*(?:^|\n)SUPERSEDE:\s*(?:None\.?|no[^\n]*(?:human|ruling|authority)[^\n]*)\s*(?:\n|$)'
---
No child is superseded without a human ruling.
