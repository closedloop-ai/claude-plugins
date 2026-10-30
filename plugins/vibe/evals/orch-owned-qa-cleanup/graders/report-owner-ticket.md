---
type: regex
match: contains
flags: i
pattern: '^(?=[\s\S]*\bstatus\b)(?=[\s\S]*\bwriter-a\b)(?=[\s\S]*\bISS-13420\b)(?=[\s\S]*(?:leftover|clean|stopp|reconcil))[\s\S]*$'
---

The fleet status names the recorded owner and ticket with the lifecycle result.
