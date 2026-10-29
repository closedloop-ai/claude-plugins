---
type: regex
match: contains
flags: i
pattern: 'DOCKER:(?=[^\n]*(?:remov|delete))(?=[^\n]*container)(?=[^\n]*volum)(?=[^\n]*network)[^\n]+'
---

The recorded container, volumes and network are removed, not merely stopped.
