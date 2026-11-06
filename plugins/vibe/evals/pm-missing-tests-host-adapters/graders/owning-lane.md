---
type: regex
match: contains
flags: i
pattern: 'Missing tests:(?![^\n]*(?:(?:discover|determine|find|consult|run|use)[^\n]*(?:lane|test:lanes)|(?:needs?|requires?)\s+no\s+lane|no\s+lane\s+(?:is\s+)?needed))(?=[^\n]*\bDesktop\b)(?=[^\n]*(?:PRD-42\s+)?AC-3\b)(?=[^\n]*(?:Desktop\s+test\s+lane|owning\s+(?!pnpm\s+test:lanes)[A-Za-z0-9@/_-]+(?:\s+[A-Za-z0-9@/_-]+){0,2}\s+lane|desktop-(?:e2e|unit|test)\b))[^\n]+'
---
The entry names its owning lane.
