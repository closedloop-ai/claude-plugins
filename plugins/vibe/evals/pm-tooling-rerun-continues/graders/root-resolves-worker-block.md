---
type: regex
match: contains
flags: i
pattern: '(?:ROOT:(?=[^\n]*(?:worker|writer))(?=[^\n]*(?:rerun|re-run|retry|narrow|repeat|try again|safe[^\n]*(?:paths|checks)))[^\n]*|NEXT:(?=[^\n]*(?:worker|writer))(?=[^\n]*(?:rerun|re-run|retry|narrow))[^\n]*[\s\S]*ROOT:(?=[^\n]*recoverable)(?=[^\n]*safe[^\n]*(?:paths|checks))[^\n]*)'
---
