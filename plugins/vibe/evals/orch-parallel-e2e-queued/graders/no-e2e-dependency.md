---
type: regex
match: contains
flags: i
pattern: 'DEPENDENCIES:[^\n]*(?=[^\n]*e2e)(?:[^\n]*(?:independent|no dependency|no prerequisite|do not wait|need not wait))'
---

Integration and typecheck have no dependency on e2e.
