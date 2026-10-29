---
type: regex
match: contains
flags: i
pattern: '(?s)(?=.*proof)(?=.*(?:module|new-index))(?=.*branch.*branch)(?=.*tests/criterion-a\.test\.ts)(?=.*src/new-index/index\.ts)(?=.*src/new-index/mapper\.ts)(?=.*(?:exclusive file allowlist|non.overlap|disjoint))(?:.|\n)+'
---

Both tasks get explicit non-overlapping file allowlists on separate branches.
