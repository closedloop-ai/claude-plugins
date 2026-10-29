---
type: regex
match: contains
flags: i
pattern: 'WORKER:(?=[^\n]*(?:reran|narrowed))(?=[^\n]*(?:remote|CI))[^\n]*[\s\S]*ROOT:(?=[^\n]*(?:review|check))(?=[^\n]*(?:access|decision|authoriz))[^\n]*[\s\S]*BLOCKER:(?=[^\n]*(?:human|person|organization|authoriz))(?=[^\n]*(?:decision|access|credential|signing service))[^\n]*'
---
