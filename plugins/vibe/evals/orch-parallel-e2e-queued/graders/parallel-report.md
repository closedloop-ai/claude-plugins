---
type: regex
match: contains
flags: i
pattern: 'REPORT:(?=[^\n]*(?:parallel|concurrent|at the same time))(?=[^\n]*\bintegration\b)(?=[^\n]*\btypecheck\b)(?=[^\n]*\be2e\b)(?=[^\n]*\bA\b)(?=[^\n]*\bB\b)[^\n]+'
---

The remaining work report names both machines and the parallel lanes.
