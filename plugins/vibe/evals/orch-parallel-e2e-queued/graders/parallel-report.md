---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*(?:parallel|concurrent|at the same time))(?=[\s\S]*\bintegration\b)(?=[\s\S]*\btypecheck\b)(?=[\s\S]*\be2e\b)(?=[\s\S]*\bmachine\s*A\b)(?=[\s\S]*\bmachine\s*B\b)[\s\S]+'
---

The remaining work report names both machines and the parallel lanes.
