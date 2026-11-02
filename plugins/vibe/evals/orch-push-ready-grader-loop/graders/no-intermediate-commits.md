---
type: regex
target: { source: file, path: session/.git/logs/HEAD }
pattern: '^[^\n]+\n?$'
---

Only the scaffold's base commit exists. Every grader tweak stays uncommitted.
