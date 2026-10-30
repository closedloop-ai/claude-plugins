---
type: regex
match: contains
flags: i
pattern: '^(?![\s\S]*(?:integration|typecheck)[^.\n]{0,100}(?:wait\w* for|after)\s+e2e)(?=[\s\S]*\be2e\b)(?=[\s\S]*(?:no prerequisite|no dependency|independent of|does not depend on|neither[^\n]{0,80}(?:depends on|has[^\n]{0,30}prerequisite)|(?:do not|does not|need not|no need to) wait|nothing[^.\n]{0,60}waits?[^.\n]{0,60}prerequisite|lanes?[^.\n]{0,60}(?:are|remain) independent))[\s\S]*$'
---

Integration and typecheck have no dependency on e2e.
