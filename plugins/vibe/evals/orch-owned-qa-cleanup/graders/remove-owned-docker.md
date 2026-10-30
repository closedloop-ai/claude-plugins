---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*(?:remov|delet)[^\n]{0,120}container)(?=[\s\S]*volum)(?=[\s\S]*network)[\s\S]+'
---

The recorded container, volumes and network are removed, not merely stopped.
