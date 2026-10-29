---
type: regex
match: contains
flags: i
pattern: 'STATUS:(?=[^\n]*writer-a)(?=[^\n]*ISS-13420)(?=[^\n]*(?:leftover|clean|stopp|reconcil))[^\n]+'
---

The fleet status names the recorded owner and ticket with the lifecycle result.
