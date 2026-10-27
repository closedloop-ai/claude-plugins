---
type: regex
match: contains
flags: i
pattern: 'REPLY:[^\n]*1\.0\.84[^\n]*1\.0\.85[^\n]*update[^\n]*(proceed|keep going)[^\n]*worse results|REPLY:[^\n]*1\.0\.84[^\n]*1\.0\.85[^\n]*worse results[^\n]*update'
---
The operator is asked to update now or proceed, and told an outdated plugin could give worse results.
