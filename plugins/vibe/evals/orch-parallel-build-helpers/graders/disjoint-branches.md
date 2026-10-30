---
type: regex
match: contains
flags: i
pattern: '(?=[\s\S]*proof)(?=[\s\S]*(?:module|new-index))(?=[\s\S]*branch[\s\S]*branch)(?=[\s\S]*tests/criterion-a\.test\.ts)(?=[\s\S]*src/new-index/index\.ts)(?=[\s\S]*src/new-index/mapper\.ts)(?=[\s\S]*(?:exclusive file allowlist|non.overlap|disjoint))[\s\S]+'
---

Both tasks get explicit non-overlapping file allowlists on separate branches.
