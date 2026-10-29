---
type: regex
match: contains
flags: i
pattern: 'NEXT:\s*(?=[^\n]*(?:run|request|start|submit|trigger))(?=[^\n]*(?:\bCI\b|automatic check))[^\n]*'
---
