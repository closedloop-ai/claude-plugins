---
type: regex
match: contains
flags: i
pattern: '(?:neither lane depends on e2e|(?:integration|typecheck)[^\n]{0,120}(?:independent of|no dependency on|no prerequisite to|do not wait for|need not wait for|does not depend on)[^\n]{0,60}e2e)'
---

Integration and typecheck have no dependency on e2e.
