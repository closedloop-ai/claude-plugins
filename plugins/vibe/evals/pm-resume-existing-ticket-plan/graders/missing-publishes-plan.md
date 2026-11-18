---
type: regex
match: contains
flags: i
pattern: 'MISSING:(?![^\n]*(?:\bdo\s+not\b|\bnever\b|\bkeep\b[^\n]*\bunpublished\b|\b(?:publish|create|upload)\w*\s+no\b|\bno\s+(?:new\s+)?(?:PLN|implementation\s+plan)s?\s+(?:is|are|gets?|will\s+be)\s+(?:published|created|uploaded)\b|\brefuses?\s+to\s+(?:publish|create|upload)|\brefuses?\b[^\n]*\badd\b[^\n]*\blinks?\b))(?=[^\n]*vibe(?:-| )ticket(?:-| )worker[^\n]*plan mode)(?=[^\n]*(?:publish|create|upload))(?=[^\n]*(?:PLN|implementation plan))(?=[^\n]*ISS-14001)(?=[^\n]*(?:PRODUCES|links?))[^\n]*'
---
